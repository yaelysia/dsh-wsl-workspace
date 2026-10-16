/** Trusted bootstrap for the read-only search transport; Python 3 standard library only. */
export const SEARCH_WORKER_BOOTSTRAP = 'import sys;exec(bytes.fromhex(sys.stdin.buffer.readline(262145).decode("ascii")))'

/** Preserve the guest locale before Python's startup locale coercion can change it. */
export const SEARCH_WORKER_LAUNCH = 'DSH_SEARCH_LC_CTYPE="${LC_CTYPE-}" DSH_SEARCH_HAS_LC_CTYPE="${LC_CTYPE+x}" exec python3 -I -S -u -c "$1"'

/**
 * Requests are JSON lines; responses are a JSON byte-length header followed by raw
 * stdout/stderr. Each search owns a Linux process group. The input thread remains
 * available for cancellation while bounded reader threads drain both output pipes.
 * SCRIPTS is installed by the host before this program starts, never by a request.
 */
export const SEARCH_WORKER_SCRIPT = String.raw`
import json, os, selectors, signal, subprocess, sys, threading, time

if os.environ.pop('DSH_SEARCH_HAS_LC_CTYPE', '') == 'x':
    os.environ['LC_CTYPE'] = os.environ.pop('DSH_SEARCH_LC_CTYPE', '')
else:
    os.environ.pop('DSH_SEARCH_LC_CTYPE', None)
    os.environ.pop('LC_CTYPE', None)

MAX_REQUEST = 1048576
MAX_OUTPUT = 67108864
MAX_JOBS = 4
jobs = {}
lock = threading.Lock()
output_lock = threading.Lock()
stopping = threading.Event()

def emit(header, stdout=b'', stderr=b''):
    header.update(outBytes=len(stdout), errBytes=len(stderr))
    with output_lock:
        sys.stdout.buffer.write(json.dumps(header, ensure_ascii=True).encode('ascii') + b'\n')
        sys.stdout.buffer.write(stdout)
        sys.stdout.buffer.write(stderr)
        sys.stdout.buffer.flush()

def kill_group(proc):
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass

def run(request, cancelled):
    proc = None
    streams = None
    out = bytearray()
    err = bytearray()
    aborted = False
    overflow = False
    failure = None
    deadline = time.monotonic() + request['timeoutMs'] / 1000
    try:
        if cancelled.is_set() or stopping.is_set():
            aborted = True
        else:
            proc = subprocess.Popen(
                ['bash', '-c', SCRIPTS[request['op']], 'dsh'] + request['args'],
                cwd=request['cwd'], stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            streams = selectors.DefaultSelector()
            streams.register(proc.stdout, selectors.EVENT_READ, out)
            streams.register(proc.stderr, selectors.EVENT_READ, err)
            killed_at = None
            while streams.get_map():
                now = time.monotonic()
                if cancelled.is_set() or stopping.is_set() or now >= deadline:
                    aborted = True
                if (aborted or overflow) and killed_at is None:
                    kill_group(proc)
                    killed_at = now
                # A descendant escaping the group must not hold the response open.
                if killed_at is not None and now - killed_at > 1:
                    break
                for key, _ in streams.select(min(0.05, max(0, deadline - now)) if killed_at is None else 0.05):
                    data = os.read(key.fileobj.fileno(), 65536)
                    if not data:
                        streams.unregister(key.fileobj)
                        continue
                    target = key.data
                    limit = request['maxBytes'] if target is out else 1048576
                    room = max(0, limit - len(target))
                    target.extend(data[:room])
                    if len(data) > room:
                        overflow = True
            if proc.poll() is None:
                kill_group(proc)
            proc.wait(timeout=2)
    except Exception as error:
        failure = str(error)[:256]
    finally:
        if streams is not None:
            streams.close()
        if proc is not None:
            # Kill remaining descendants too, before another request can reuse this worker.
            kill_group(proc)
            if proc.stdout is not None:
                proc.stdout.close()
            if proc.stderr is not None:
                proc.stderr.close()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                failure = 'search process group did not terminate'
        code = None if proc is None else proc.returncode
        header = dict(id=request['id'], code=code, aborted=aborted, overflow=overflow, error=failure)
        with lock:
            jobs.pop(request['id'], None)
        try:
            emit(header, out, err)
        except (BrokenPipeError, OSError):
            stopping.set()

def main():
    emit(dict(ready=1, pid=os.getpid(), maxJobs=MAX_JOBS))
    try:
        while not stopping.is_set():
            line = sys.stdin.buffer.readline(MAX_REQUEST + 1)
            if not line:
                break
            if len(line) > MAX_REQUEST or not line.endswith(b'\n'):
                raise ValueError('search request exceeds protocol limit')
            request = json.loads(line)
            if 'cancel' in request:
                with lock:
                    job = jobs.get(request['cancel'])
                    if job is not None:
                        job[0].set()
                continue
            ident = request.get('id')
            valid = (type(ident) is int and ident > 0
                and request.get('op') in SCRIPTS
                and isinstance(request.get('cwd'), str) and request['cwd'].startswith('/')
                and '\0' not in request['cwd']
                and isinstance(request.get('args'), list)
                and len(request['args']) <= 4096
                and all(isinstance(arg, str) and '\0' not in arg for arg in request['args'])
                and type(request.get('timeoutMs')) is int and 0 < request['timeoutMs'] <= 600000
                and type(request.get('maxBytes')) is int and 0 < request['maxBytes'] <= MAX_OUTPUT)
            if not valid:
                raise ValueError('invalid search request')
            with lock:
                if ident in jobs or len(jobs) >= MAX_JOBS:
                    raise ValueError('search worker capacity exceeded')
                cancelled = threading.Event()
                thread = threading.Thread(target=run, args=(request, cancelled))
                jobs[ident] = (cancelled, thread)
                thread.start()
    finally:
        stopping.set()
        with lock:
            current = list(jobs.values())
            for cancel, _ in current:
                cancel.set()
        for _, thread in current:
            thread.join()

if __name__ == '__main__':
    # Graceful shutdown is stdin EOF; TERM also passes through the same cleanup.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    main()
`
