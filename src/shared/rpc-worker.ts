/** Read-only worker: fixed search scripts, JSON-lines over pipes, Python standard library only. */
import { GREP_SCRIPT, GLOB_SCRIPT } from './search-scripts.ts'

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
lock = threading.RLock()
output_lock = threading.Lock()
active = {}
executor = concurrent.futures.ThreadPoolExecutor(max_workers=4)

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
    deadline = received + req["timeoutMs"] / 1000
    try:
        if cancelled.is_set() or time.monotonic() >= deadline:
            return {"aborted": True, "code": None, "stdout": "", "stderr": ""}
        argv = ([sys.executable, "-I", "-S", "-c", METADATA] if req["op"] == "fs.metadata"
                else ["bash", "-c", SCRIPTS[req["op"]], "dsh"]) + req["args"]
        proc = subprocess.Popen(
            argv,
            cwd=req["cwd"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, start_new_session=True)
        streams.register(proc.stdout, selectors.EVENT_READ, out)
        streams.register(proc.stderr, selectors.EVENT_READ, err)
        while streams.get_map():
            if cancelled.is_set() or time.monotonic() >= deadline:
                aborted = True
                break
            for key, _ in streams.select(min(0.05, max(0, deadline - time.monotonic()))):
                data = os.read(key.fd, 65536)
                if not data:
                    streams.unregister(key.fileobj)
                    continue
                dest = key.data
                cap = req["maxBytes"] + 1 if dest is out else LIMIT
                previous = len(dest)
                dest.extend(data[:max(0, cap - previous)])
                if dest is err and previous + len(data) > cap:
                    raise RuntimeError("search stderr exceeded 1 MiB")
                if len(out) > req["maxBytes"]:
                    # Preserve acceptRun's overflow witness before killing the process group.
                    kill_group(proc)
                    return {"aborted": False, "code": 0, "stdout": base64.b64encode(out).decode(), "stderr": base64.b64encode(err).decode()}
        if aborted:
            kill_group(proc)
        else:
            try:
                proc.wait(timeout=max(0.001, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                aborted = True
                kill_group(proc)
        return {"aborted": aborted, "code": proc.returncode,
                "stdout": base64.b64encode(out).decode(), "stderr": base64.b64encode(err).decode()}
    finally:
        streams.close()
        if proc is not None:
            # Search scripts are finite; no background descendants may survive any result or EOF.
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
        and (req["op"] != "fs.metadata" or (0 < len(req["args"]) <= 64
            and all(os.path.isabs(x) for x in req["args"])))
        and type(req.get("timeoutMs")) is int and 0 < req["timeoutMs"] <= 86400000
        and type(req.get("maxBytes")) is int and 0 < req["maxBytes"] <= 67108864)

METHODS = ["grep", "glob", "fs.metadata"]
emit({"ready": 2, "pid": os.getpid(), "methods": METHODS})
try:
    while True:
        line = sys.stdin.buffer.readline(LIMIT + 1)
        if not line:
            break
        if len(line) > LIMIT or not line.endswith(b"\n"):
            raise ValueError("search request exceeded 1 MiB or was incomplete")
        req = json.loads(line)
        if not isinstance(req, dict) or type(req.get("id")) is not int or req["id"] <= 0:
            raise ValueError("invalid search request identity")
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
`

/** Single-line ASCII launch code; search arguments are never embedded in it. */
export function rpcWorkerCode(): string {
  const scripts = Buffer.from(JSON.stringify({ grep: GREP_SCRIPT, glob: GLOB_SCRIPT })).toString('base64')
  const program = `import base64, json\nMETADATA=${JSON.stringify(METADATA)}\nSCRIPTS=json.loads(base64.b64decode("${scripts}"))\n${PROGRAM}`
  return `exec(__import__('base64').b64decode('${Buffer.from(program).toString('base64')}'))`
}
