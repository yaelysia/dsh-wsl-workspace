/** Fixed RPC methods over stdio; searches and native file transactions share one owner-scoped worker. */
import { GREP_SCRIPT, GLOB_SCRIPT } from './search-scripts.ts'
import { NATIVE_FILE_PROGRAM } from './native-file-worker.ts'
import { deflateSync } from 'node:zlib'

// Keep this program self-contained: -I excludes user site/PYTHONPATH and no files are installed.
// Arguments cross stdin as JSON, not Windows' command-line parser. Only the bundled method allow-list runs.
const METADATA = String.raw`
import errno, json, os, stat, sys
rows = []
for path in sys.argv[1:]:
    try:
        info = os.lstat(path)
        target = os.stat(path)
        rows.append({"path": path, "realpath": os.path.realpath(path),
            "kind": "file" if stat.S_ISREG(target.st_mode) else "directory" if stat.S_ISDIR(target.st_mode) else "other",
            "symlink": stat.S_ISLNK(info.st_mode), "size": target.st_size,
            "mtimeNs": str(target.st_mtime_ns), "device": str(target.st_dev), "inode": str(target.st_ino)})
    except OSError as error:
        rows.append({"path": path, "error": errno.errorcode.get(error.errno, "EIO")})
print(json.dumps(rows, ensure_ascii=True, separators=(",", ":")))
`

const PROGRAM = String.raw`
import base64, concurrent.futures, json, os, selectors, signal, subprocess, sys, threading, time

if sys.platform != "linux" or sys.version_info < (3, 8):
    raise RuntimeError("search worker requires Linux Python 3.8+")

LIMIT = 1048576
FILE_LIMIT = 32 * LIMIT
FILE_METHODS = ["fs.resolve", "fs.stat", "fs.lstat", "fs.read", "fs.range", "fs.list", "fs.write", "fs.edit"]
lock = threading.RLock()
output_lock = threading.Lock()
active = {}
executor = concurrent.futures.ThreadPoolExecutor(max_workers=4)
file_lock = threading.Lock()
file_workers, file_idle = set(), []

# Reuse Python parsing/imports as well as the Windows-to-WSL connection. These
# executors are private children of this worker, not another Windows-side pool.
def close_file(proc):
    with file_lock:
        file_workers.discard(proc)
    kill_group(proc)
    for pipe in (proc.stdin, proc.stdout, proc.stderr):
        pipe.close()

def acquire_file():
    with file_lock:
        while file_idle:
            proc = file_idle.pop()
            if proc.poll() is None: return proc
            file_workers.discard(proc)
            for pipe in (proc.stdin, proc.stdout, proc.stderr): pipe.close()
        proc = subprocess.Popen([sys.executable, '-I', '-S', '-u', '-c', FILE_PROGRAM, '--persistent'],
            cwd='/', stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True)
        os.set_blocking(proc.stdin.fileno(), False)
        file_workers.add(proc)
        return proc


def emit(value):
    data = (json.dumps(value, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")
    with output_lock:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()

def kill_group(proc):
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait()

def search(req, cancelled, received):
    started = time.monotonic()
    result = execute(req, cancelled, received)
    result["timing"] = {"queueMs": (started - received) * 1000,
                        "executionMs": (time.monotonic() - started) * 1000}
    return result

def execute(req, cancelled, received):
    if cancelled.is_set():
        return {"aborted": True, "code": None, "stdout": "", "stderr": ""}
    proc = None
    streams = selectors.DefaultSelector()
    out, err = bytearray(), bytearray()
    aborted = False
    mutation = req["op"] in ("fs.write", "fs.edit")
    file_call = req["op"] in FILE_METHODS
    cancel_at = None
    keep_file = False
    frame_complete = False
    input_bytes = (json.dumps({'op': req['op'], 'payload': req['args'][0], 'cwd': req['cwd']},
        ensure_ascii=False, separators=(',', ':')) + "\n").encode('utf-8') if file_call else b""
    input_offset = 0
    deadline = received + req["timeoutMs"] / 1000
    try:
        if cancelled.is_set() or time.monotonic() >= deadline:
            return {"aborted": True, "code": None, "stdout": "", "stderr": ""}
        if file_call:
            proc = acquire_file()
            streams.register(proc.stdin, selectors.EVENT_WRITE, "input")
        else:
            argv = ([sys.executable, "-I", "-S", "-c", METADATA] if req["op"] == "fs.metadata"
                    else ["bash", "-c", SCRIPTS[req["op"]], "dsh"]) + req["args"]
            proc = subprocess.Popen(argv, cwd=req["cwd"], stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        streams.register(proc.stdout, selectors.EVENT_READ, out)
        streams.register(proc.stderr, selectors.EVENT_READ, err)
        while streams.get_map() and not frame_complete:
            if cancelled.is_set() or time.monotonic() >= deadline:
                if not mutation:
                    aborted = True
                    break
                # A mutation must acknowledge cancellation or report its committed receipt.
                # Never manufacture "aborted" after a write may have been published.
                if cancel_at is None:
                    cancel_at = time.monotonic()
                    try: os.killpg(proc.pid, signal.SIGTERM)
                    except ProcessLookupError: pass
                elif time.monotonic() - cancel_at > 0.75:
                    raise RuntimeError("file mutation result unknown after cancellation; re-read before retrying")
            for key, _ in streams.select(0.02):
                if key.data == "input":
                    try: input_offset += os.write(key.fd, memoryview(input_bytes)[input_offset:input_offset + 65536])
                    except BlockingIOError: continue
                    except BrokenPipeError: input_offset = len(input_bytes)
                    if input_offset == len(input_bytes):
                        streams.unregister(key.fileobj)
                        # The next request reuses this input pipe.
                    continue
                data = os.read(key.fd, 65536)
                if not data:
                    streams.unregister(key.fileobj)
                    continue
                dest = key.data
                cap = req["maxBytes"] + (2 if file_call else 1) if dest is out else LIMIT
                previous = len(dest)
                dest.extend(data[:max(0, cap - previous)])
                if dest is err and previous + len(data) > cap:
                    raise RuntimeError("search stderr exceeded 1 MiB")
                if len(out) > req["maxBytes"] + (1 if file_call else 0):
                    if mutation: raise RuntimeError("file mutation result exceeded its budget; re-read before retrying")
                    # Preserve acceptRun's overflow witness before killing the process group.
                    kill_group(proc)
                    return {"aborted": False, "code": 0, "stdout": base64.b64encode(memoryview(out)[1:] if file_call else out).decode(), "stderr": base64.b64encode(err).decode()}
                if file_call and dest is out and 10 in data:
                    if data[-1:] != b"\n" or out.count(10) != 1:
                        raise RuntimeError("invalid native executor response frame; re-read before retrying")
                    frame_complete = True
        if file_call and not aborted:
            if not frame_complete or out[:1] not in (b"0", b"1"):
                raise RuntimeError("native executor closed without a receipt; re-read before retrying")
            code = out[0] - 48
            keep_file = cancel_at is None and not cancelled.is_set() and proc.poll() is None
            return {"aborted": False, "code": code, "stdout": base64.b64encode(memoryview(out)[1:]).decode(),
                    "stderr": base64.b64encode(err).decode()}
        if aborted:
            kill_group(proc)
        else:
            try:
                proc.wait(timeout=0.75 if cancel_at is not None else max(0.001, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                if mutation: raise RuntimeError("file mutation result unknown after timeout; re-read before retrying")
                aborted = True
                kill_group(proc)
        if mutation and proc.returncode < 0:
            raise RuntimeError("file mutation terminated without a receipt; re-read before retrying")
        return {"aborted": aborted, "code": proc.returncode,
                "stdout": base64.b64encode(out).decode(), "stderr": base64.b64encode(err).decode()}
    finally:
        streams.close()
        if proc is not None:
            if file_call:
                if keep_file:
                    with file_lock: file_idle.append(proc)
                else:
                    close_file(proc)
            else:
                # Search scripts are finite; no background descendants may survive a result.
                kill_group(proc)
                proc.stdout.close()
                proc.stderr.close()

def completed(request_id, future):
    try:
        result = future.result()
    except concurrent.futures.CancelledError:
        result = {"aborted": True, "code": None, "stdout": "", "stderr": ""}
    except Exception as error:
        result = {"error": str(error)[:4096]}
    with lock:
        active.pop(request_id, None)
    try:
        emit(dict(result, id=request_id))
    except (BrokenPipeError, OSError):
        pass

def valid(req):
    return (req.get("op") in METHODS and isinstance(req.get("cwd"), str)
        and os.path.isabs(req["cwd"]) and "\0" not in req["cwd"]
        and isinstance(req.get("args"), list) and len(req["args"]) <= 256
        and all(isinstance(x, str) and "\0" not in x for x in req["args"])
        and (req["op"] not in FILE_METHODS or len(req["args"]) == 1)
        and (req["op"] != "fs.metadata" or (0 < len(req["args"]) <= 64
            and all(os.path.isabs(x) for x in req["args"])))
        and type(req.get("timeoutMs")) is int and 0 < req["timeoutMs"] <= 86400000
        and type(req.get("maxBytes")) is int and 0 < req["maxBytes"] <= 67108864)

METHODS = ["grep", "glob", "fs.metadata"] + FILE_METHODS
emit({"ready": 3, "pid": os.getpid(), "methods": METHODS})
try:
    while True:
        line = sys.stdin.buffer.readline(FILE_LIMIT + 1)
        if not line:
            break
        if len(line) > FILE_LIMIT or not line.endswith(b"\n"):
            raise ValueError("search request exceeded 1 MiB or was incomplete")
        req = json.loads(line)
        if not isinstance(req, dict) or type(req.get("id")) is not int or req["id"] <= 0:
            raise ValueError("invalid search request identity")
        if req.get("op") not in FILE_METHODS and len(line) > LIMIT:
            raise ValueError("non-file RPC request exceeded 1 MiB")
        request_id = req["id"]
        if req.get("op") == "cancel":
            with lock:
                entry = active.get(request_id)
            if entry:
                entry[0].set()
                entry[1].cancel()
            continue
        with lock:
            if request_id in active or len(active) >= 16 or not valid(req):
                emit({"id": request_id, "error": "invalid or excess search request"})
                continue
            cancel = threading.Event()
            future = executor.submit(search, req, cancel, time.monotonic())
            active[request_id] = (cancel, future)
            future.add_done_callback(lambda f, i=request_id: completed(i, f))
finally:
    with lock:
        entries = list(active.values())
    for cancel, future in entries:
        cancel.set()
        future.cancel()
    executor.shutdown(wait=True)
    for proc in list(file_workers): close_file(proc)
`

/** Single-line ASCII launch code; search arguments are never embedded in it. */
// Cache immutable bundled code only, never user input, file data or a worker.
let cachedBootstrap: string | undefined
export function rpcWorkerCode(): string {
  if (cachedBootstrap !== undefined) return cachedBootstrap
  const scripts = Buffer.from(JSON.stringify({ grep: GREP_SCRIPT, glob: GLOB_SCRIPT })).toString('base64')
  const program = `import base64, json\nMETADATA=${JSON.stringify(METADATA)}\nFILE_PROGRAM=${JSON.stringify(NATIVE_FILE_PROGRAM)}\nSCRIPTS=json.loads(base64.b64decode("${scripts}"))\n${PROGRAM}`
  const encoded = deflateSync(Buffer.from(program)).toString('base64')
  if (encoded.length > 24_000) throw new Error('WSL RPC bootstrap exceeds its Windows command-line budget')
  return cachedBootstrap = `exec(__import__('zlib').decompress(__import__('base64').b64decode('${encoded}')))`
}
