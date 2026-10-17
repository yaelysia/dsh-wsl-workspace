import { n as RpcMetrics, t as RPC_METHODS } from "./rpc-metrics-3odf69pY.js";
import { t as decodeWslOutput } from "./wsl-CWw3IAkU.js";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { deflateSync } from "node:zlib";
//#region src/shared/search-scripts.ts
/** Fixed Bash scripts: all model-controlled values are argv, never interpolated code. */
/**
* GNU grep emits path\0line:text records. Optional arguments 5 onward are conservative
* basename hints for directory searches only; the host remains the exact matcher.
* Hints retain the original hidden-file rule; explicit file targets stay visible.
* The cap is enforced in Linux and PIPESTATUS preserves grep's exit status.
*/
const GREP_SCRIPT = [
	"set -u",
	"pattern=$1; include=$2; target=$3; cap=$4",
	"[ -n \"$target\" ] || target=.",
	"if [ -d \"$target\" ]; then",
	"  target=$(cd -- \"$target\" && pwd -P)",
	"  dir=1",
	"else",
	"  case $target in /*) ;; *) target=$PWD/$target ;; esac",
	"  dir=0",
	"fi",
	"if ! grep --version 2>/dev/null | head -n 1 | grep -q GNU; then",
	"  printf \"grep is not GNU grep: %s\\n\" \"$(grep --version 2>/dev/null | head -n 1)\" >&2",
	"  exit 3",
	"fi",
	"if [ \"$dir\" = 1 ] && [ -z \"$include\" ] && [ \"$#\" -gt 4 ]; then",
	"  printf -v include \"%s\\n\" \"${@:5}\"",
	"fi",
	"opts=(-rnIEH -Z)",
	"if [ \"$dir\" = 1 ]; then",
	"  opts+=(--exclude-dir=node_modules)",
	"  case ${target##*/} in .*) ;; *) opts+=(--exclude-dir=\".*\") ;; esac",
	"  [ -n \"$include\" ] || opts+=(--include=\"[!.]*\")",
	"fi",
	"if [ -n \"$include\" ]; then",
	"  while IFS= read -r one; do [ -n \"$one\" ] && opts+=(--include=\"$one\"); done <<<\"$include\"",
	"fi",
	"grep \"${opts[@]}\" --regexp=\"$pattern\" -- \"$target\" | head -c \"$cap\"",
	"exit \"${PIPESTATUS[0]}\""
].join("\n");
/**
* List files with GNU find's mtime (plain NUL listing on non-GNU find).
* Optional basename hints are OR-ed; VCS pruning and symlink traversal stay unchanged.
* Filter before the byte cap, preserving both the root header and record framing.
*/
const GLOB_SCRIPT = [
	"set -u",
	"target=$1; cap=$2; shift 2",
	"names=()",
	"if [ \"$#\" -gt 0 ]; then",
	"  names=(\"(\")",
	"  for name in \"$@\"; do names+=(-name \"$name\" -o); done",
	"  unset 'names[-1]'",
	"  names+=(\")\")",
	"fi",
	"[ -n \"$target\" ] || target=.",
	"if [ -d \"$target\" ]; then target=$(cd -- \"$target\" && pwd -P); else",
	"  case $target in /*) ;; *) target=$PWD/$target ;; esac",
	"fi",
	"prune=(-name .git -o -name .hg -o -name .svn -o -name .bzr -o -name .jj -o -name .sl)",
	"if find --version 2>/dev/null | head -n 1 | grep -q GNU; then",
	"  { printf 'G%s\\0' \"$target\"; find \"$target\" \\( \"${prune[@]}\" \\) -prune -o -type f \"${names[@]}\" -printf '%T@\\t%p\\0'; } | head -c \"$cap\"",
	"else",
	"  { printf 'P%s\\0' \"$target\"; find \"$target\" \\( \"${prune[@]}\" \\) -prune -o -type f \"${names[@]}\" -print0; } | head -c \"$cap\"",
	"fi",
	"exit \"${PIPESTATUS[0]}\""
].join("\n");
//#endregion
//#region src/shared/native-file-worker.ts
/** Linux file transactions. Mirrors the pinned dsh-fs-local text/guard contract (MIT; see NOTICE). */
const NATIVE_FILE_PROGRAM = String.raw`
import base64, errno, fcntl, json, os, signal, stat, sys, uuid
from collections import deque

MAX_CONTENT = 16 * 1024 * 1024
MAX_WIRE = 32 * 1024 * 1024
committed = False
cleaning = False

class Failure(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)

def fail(code, message):
    raise Failure(code, message)

def cancel(signum, frame):
    if not committed and not cleaning:
        fail('FS_ABORTED', 'file operation cancelled before publication')

signal.signal(signal.SIGTERM, cancel)

def info(s, nofollow=False):
    kind = ('symlink' if nofollow and stat.S_ISLNK(s.st_mode) else
            'file' if stat.S_ISREG(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'other')
    return {'version': '%s:%s:%s:%s:%s' % (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns),
            'type': kind, 'size': s.st_size}

def canonical(path, missing=True):
    # Resolve physically, not normpath first: link/.. traverses the link target's parent.
    if not isinstance(path, str) or not path.startswith('/') or '\0' in path:
        fail('FS_IO_ERROR', 'expected an absolute Linux path')
    todo, done, hops = deque(path.split('/')), [], 0
    while todo:
        part = todo.popleft()
        if part in ('', '.'):
            continue
        if part == '..':
            if done: done.pop()
            continue
        candidate = '/' + '/'.join(done + [part])
        try:
            s = os.lstat(candidate)
        except FileNotFoundError:
            if not missing: raise
            rest = [p for p in todo if p not in ('', '.')]
            if '..' in rest:
                fail('FS_NOT_FOUND', 'parent traversal crosses a missing directory')
            return '/' + '/'.join(done + [part] + rest)
        if stat.S_ISLNK(s.st_mode):
            hops += 1
            if hops > 40: fail('FS_IO_ERROR', 'too many symbolic links')
            link = os.readlink(candidate)
            if link.startswith('/'): done = []
            todo.extendleft(reversed(link.split('/')))
        else:
            if any(p not in ('', '.') for p in todo) and not stat.S_ISDIR(s.st_mode):
                fail('FS_NOT_FOUND', 'a parent path segment is not a directory')
            done.append(part)
    return '/' + '/'.join(done)

def probe(path, follow=True):
    try: return os.stat(path, follow_symlinks=follow)
    except (FileNotFoundError, NotADirectoryError): return None

def within(path, root):
    return path == root or root == '/' or path.startswith(root.rstrip('/') + '/')

def authorize(path, policy):
    if policy is None: return
    mode = policy.get('mode')
    if mode == 'danger-full-access': return
    if mode == 'workspace-write' and any(within(path, canonical(r)) for r in policy.get('roots', [])):
        return
    fail('FS_SANDBOX_DENIED', 'file access denied under %s mode' % mode)

def parent_fd(path, create, policy):
    # Pin every traversed directory without following links after authorization.
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        parts = path.rsplit('/', 1)[0].split('/')
        for part in parts:
            if not part: continue
            try:
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if not create: raise
                current = os.readlink('/proc/self/fd/%d' % fd)
                authorize(current.rstrip('/') + '/' + part, policy)
                try: os.mkdir(part, 0o777, dir_fd=fd)
                except FileExistsError: pass
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise

def regular(path):
    # O_NONBLOCK prevents a replaced FIFO from blocking before we can reject its type.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode): fail('FS_NOT_REGULAR_FILE', 'not a regular file')
        return fd, s
    except BaseException:
        os.close(fd)
        raise

def read_bytes(path, cap, offset=None, expected=None):
    fd, before = regular(path)
    try:
        if expected is not None and info(before)['version'] != expected:
            fail('FS_STALE_VERSION', 'file changed during read')
        if offset is None and before.st_size > cap:
            fail('FS_TOO_LARGE', 'file exceeds the byte limit')
        if offset is not None: os.lseek(fd, offset, os.SEEK_SET)
        data = bytearray()
        limit = cap + 1 if offset is None else cap
        while len(data) < limit:
            chunk = os.read(fd, min(65536, limit - len(data)))
            if not chunk: break
            data.extend(chunk)
        if len(data) > cap: fail('FS_TOO_LARGE', 'file grew beyond the byte limit')
        if info(before)['version'] != info(os.fstat(fd))['version']:
            fail('FS_STALE_VERSION', 'file changed during read')
        return bytes(data)
    finally: os.close(fd)

def text(raw, all_binary=False):
    if b'\0' in (raw if all_binary else raw[:8192]): fail('FS_NOT_TEXT', 'binary file')
    try: return raw.decode('utf-8-sig')
    except UnicodeDecodeError: fail('FS_NOT_TEXT', 'invalid UTF-8 text')

def normalized(value): return value.replace('\r\n', '\n')

def guarded(existing, req, edit=False):
    expected = req.get('expected')
    if existing is not None and not stat.S_ISREG(existing.st_mode):
        fail('FS_NOT_REGULAR_FILE', 'not a regular file')
    if edit and existing is None: fail('FS_STALE_VERSION', 'file no longer exists')
    if expected is None: return
    if expected.get('kind') == 'createIfAbsent':
        if existing is not None: fail('FS_NOT_OBSERVED', 'read the existing file before overwriting')
    elif expected.get('kind') == 'replaceIfVersion':
        if existing is None or info(existing)['version'] != expected.get('version'):
            fail('FS_STALE_VERSION', 'file changed since it was read')
    else: fail('FS_IO_ERROR', 'invalid write intent')

def atomic(path, req, editing=False):
    global committed, cleaning
    authorize(path, req.get('policy'))
    parent = parent_fd(path, not editing, req.get('policy'))
    stage = None
    staging_fd = temp_fd = None
    try:
        # Advisory directory lock serializes cooperating writers across pools/processes,
        # including creation and inode-replacing rename; it leaves no lock file behind.
        fcntl.flock(parent, fcntl.LOCK_EX)
        if os.readlink('/proc/self/fd/%d' % parent) != (path.rsplit('/', 1)[0] or '/'):
            fail('FS_STALE_VERSION', 'target directory moved while waiting for its lock')
        name = path.rsplit('/', 1)[1]
        if not name: fail('FS_NOT_REGULAR_FILE', 'cannot replace a filesystem root')
        def current():
            try: return os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError: return None
        existing = current()
        guarded(existing, req, editing)
        before = None
        if editing:
            raw = read_bytes(path, MAX_CONTENT, expected=info(existing)['version'])
            original = text(raw, True)
            before = normalized(original)
            old, new = normalized(req['oldString']), normalized(req['newString'])
            if not old: fail('FS_EDIT_NOT_FOUND', 'old_string must be a non-empty string')
            count = before.count(old)
            if count == 0: fail('FS_EDIT_NOT_FOUND', 'old_string was not found')
            if count > 1 and not req['replaceAll']: fail('FS_AMBIGUOUS_EDIT', 'old_string matched more than once')
            after = before.replace(old, new)
            sample = original.encode('utf-16-le', 'surrogatepass')[:8192].decode('utf-16-le', 'surrogatepass')
            crlf = sample.count('\r\n') > sample.count('\n') - sample.count('\r\n')
            data = (normalized(after).replace('\n', '\r\n') if crlf else after).encode('utf-8')
        else:
            data = base64.b64decode(req['content'], validate=True)
            # The JS provider supplies valid UTF-8, including explicit NULs for writes.
            after = normalized(data.decode('utf-8'))
            diff_limit = min(req['diffBasisMaxBytes'], MAX_CONTENT + 1)
            if existing is not None and len(data) < diff_limit and existing.st_size < diff_limit:
                try: before = normalized(text(read_bytes(path, diff_limit - 1, expected=info(existing)['version']), True))
                except Failure as error:
                    if error.code == 'FS_ABORTED': raise
                    before = None
                except OSError: before = None
        if len(data) > MAX_CONTENT: fail('FS_TOO_LARGE', 'native write/edit exceeds 16 MiB')
        outcome = {'version': '', 'before': before, 'after': after}
        if not editing: outcome['operation'] = 'create' if existing is None else 'update'
        # Check the complete reply budget BEFORE publication, not after a successful mutation.
        if len(json.dumps(outcome, ensure_ascii=False).encode('utf-8')) + 1024 > req['replyLimit']:
            fail('FS_TOO_LARGE', 'write/edit outcome exceeds its response budget')
        stage = '.dsh-write-' + uuid.uuid4().hex
        os.mkdir(stage, 0o700, dir_fd=parent)
        staging_fd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        os.fchmod(staging_fd, 0o700)
        temp_fd = os.open('content', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=staging_fd)
        os.fchmod(temp_fd, 0o600)
        view = memoryview(data)
        while view:
            count = os.write(temp_fd, view[:65536])
            view = view[count:]
        if existing is not None:
            staged_info = os.fstat(temp_fd)
            if (staged_info.st_uid, staged_info.st_gid) != (existing.st_uid, existing.st_gid):
                os.fchown(temp_fd, existing.st_uid, existing.st_gid)
            os.fchmod(temp_fd, stat.S_IMODE(existing.st_mode) & 0o777)
            # Preserve ACLs and extended attributes; a copy failure aborts, never broadens access.
            source_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                for attr in os.listxattr(source_fd):
                    os.setxattr(temp_fd, attr, os.getxattr(source_fd, attr))
            finally: os.close(source_fd)
        os.fsync(temp_fd)
        now = current()
        if (None if now is None else info(now)['version']) != (None if existing is None else info(existing)['version']):
            fail('FS_NOT_OBSERVED' if (req.get('expected') or {}).get('kind') == 'createIfAbsent' else 'FS_STALE_VERSION',
                 'target changed before publication')
        actual_parent = os.readlink('/proc/self/fd/%d' % parent)
        if actual_parent != (path.rsplit('/', 1)[0] or '/'):
            fail('FS_STALE_VERSION', 'target directory moved before publication')
        authorize(actual_parent.rstrip('/') + '/' + name, req.get('policy'))
        # The irreversible boundary: defer cancellation while publishing and building the receipt.
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})
        try:
            if signal.SIGTERM in signal.sigpending(): fail('FS_ABORTED', 'cancelled before publication')
            if existing is None:
                try: os.link('content', name, src_dir_fd=staging_fd, dst_dir_fd=parent, follow_symlinks=False)
                except FileExistsError:
                    fail('FS_NOT_OBSERVED' if (req.get('expected') or {}).get('kind') == 'createIfAbsent' else 'FS_STALE_VERSION',
                         'another writer created the target')
                committed = True
                os.unlink('content', dir_fd=staging_fd)
            else:
                os.replace('content', name, src_dir_fd=staging_fd, dst_dir_fd=parent)
                committed = True
            # Descriptor stat observes the inode we published, not a concurrent external replacement.
            outcome['version'] = info(os.fstat(temp_fd))['version']
            try: os.fsync(parent)
            except OSError: pass  # Publication succeeded; a durability issue must not invite a retry.
        finally: signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        return outcome
    finally:
        cleaning = True
        if temp_fd is not None: os.close(temp_fd)
        if staging_fd is not None:
            try: os.unlink('content', dir_fd=staging_fd)
            except FileNotFoundError: pass
            finally: os.close(staging_fd)
        if stage is not None:
            try: os.rmdir(stage, dir_fd=parent)
            except OSError: pass
        os.close(parent)

def run(op, req):
    path = req['path']
    if op == 'fs.resolve': return {'path': canonical(path)}
    if op == 'fs.lstat':
        parent, name = path.rsplit('/', 1)
        path = canonical(parent or '/').rstrip('/') + '/' + name
        s = probe(path, False)
        return None if s is None else info(s, True)
    path = canonical(path)
    if op == 'fs.stat':
        s = probe(path)
        return None if s is None else info(s)
    if op in ('fs.read', 'fs.range'):
        cap = req.get('maxBytes', MAX_CONTENT)
        if type(cap) is not int or cap < 0 or cap > MAX_CONTENT: fail('FS_TOO_LARGE', 'invalid native byte limit')
        offset = req.get('offset') if op == 'fs.range' else None
        if offset is not None and (type(offset) is not int or offset < 0): fail('FS_IO_ERROR', 'invalid range offset')
        data = read_bytes(path, cap, offset, req.get('version'))
        return {'data': base64.b64encode(data).decode('ascii')}
    if op == 'fs.list':
        s = probe(path)
        if s is None: fail('FS_NOT_FOUND', 'directory not found')
        if not stat.S_ISDIR(s.st_mode): fail('FS_NOT_DIRECTORY', 'not a directory')
        result = []
        with os.scandir(path) as entries:
            for entry in entries:
                resolved = canonical(entry.path)
                s = probe(resolved)
                row = {'name': entry.name, 'path': resolved, 'type': 'other'}
                if s is not None: row.update(info(s))
                result.append(row)
                if len(result) > 100000: fail('FS_TOO_LARGE', 'directory exceeds 100000 entries')
        return result
    if op == 'fs.write': return atomic(path, req)
    if op == 'fs.edit': return atomic(path, req, True)
    fail('FS_IO_ERROR', 'unknown file operation')

try:
    raw = sys.stdin.buffer.read(MAX_WIRE + 1)
    if len(raw) > MAX_WIRE: fail('FS_TOO_LARGE', 'native request exceeded its byte limit')
    req = json.loads(raw)
    value = run(sys.argv[1], req)
    result = {'ok': True, 'committed': committed, 'value': value}
    code = 0
except Failure as error:
    result = {'ok': False, 'committed': committed, 'code': error.code, 'message': error.message}
    code = 1
except OSError as error:
    kind = ('FS_NOT_FOUND' if error.errno in (errno.ENOENT, errno.ENOTDIR) else
            'FS_PERMISSION_DENIED' if error.errno in (errno.EACCES, errno.EPERM) else 'FS_IO_ERROR')
    result = {'ok': False, 'committed': committed, 'code': kind, 'message': errno.errorcode.get(error.errno, 'EIO')}
    code = 1
except Exception as error:
    result = {'ok': False, 'committed': committed, 'code': 'FS_IO_ERROR', 'message': str(error)[:1024]}
    code = 1
sys.stdout.buffer.write((json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8'))
sys.stdout.buffer.flush()
sys.exit(code)
`;
//#endregion
//#region src/shared/rpc-worker.ts
/** Fixed RPC methods over stdio; searches and native file transactions share one owner-scoped worker. */
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
`;
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
    input_bytes = req["args"][0].encode("utf-8") if file_call else b""
    input_offset = 0
    deadline = received + req["timeoutMs"] / 1000
    try:
        if cancelled.is_set() or time.monotonic() >= deadline:
            return {"aborted": True, "code": None, "stdout": "", "stderr": ""}
        argv = ([sys.executable, "-I", "-S", "-c", FILE_PROGRAM, req["op"]] if file_call else
                ([sys.executable, "-I", "-S", "-c", METADATA] if req["op"] == "fs.metadata"
                 else ["bash", "-c", SCRIPTS[req["op"]], "dsh"]) + req["args"])
        proc = subprocess.Popen(
            argv,
            cwd=req["cwd"], stdin=subprocess.PIPE if file_call else subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, start_new_session=True)
        if file_call:
            os.set_blocking(proc.stdin.fileno(), False)
            streams.register(proc.stdin, selectors.EVENT_WRITE, "input")
        streams.register(proc.stdout, selectors.EVENT_READ, out)
        streams.register(proc.stderr, selectors.EVENT_READ, err)
        while streams.get_map():
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
                    try: input_offset += os.write(key.fd, input_bytes[input_offset:input_offset + 65536])
                    except BlockingIOError: continue
                    except BrokenPipeError: input_offset = len(input_bytes)
                    if input_offset == len(input_bytes):
                        streams.unregister(key.fileobj)
                        key.fileobj.close()
                    continue
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
                    if mutation: raise RuntimeError("file mutation result exceeded its budget; re-read before retrying")
                    # Preserve acceptRun's overflow witness before killing the process group.
                    kill_group(proc)
                    return {"aborted": False, "code": 0, "stdout": base64.b64encode(out).decode(), "stderr": base64.b64encode(err).decode()}
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
            # Search scripts are finite; no background descendants may survive any result or EOF.
            kill_group(proc)
            proc.stdout.close()
            proc.stderr.close()
            if proc.stdin is not None: proc.stdin.close()

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
`;
/** Single-line ASCII launch code; search arguments are never embedded in it. */
function rpcWorkerCode() {
	const scripts = Buffer.from(JSON.stringify({
		grep: GREP_SCRIPT,
		glob: GLOB_SCRIPT
	})).toString("base64");
	const program = `import base64, json\nMETADATA=${JSON.stringify(METADATA)}\nFILE_PROGRAM=${JSON.stringify(NATIVE_FILE_PROGRAM)}\nSCRIPTS=json.loads(base64.b64decode("${scripts}"))\n${PROGRAM}`;
	const encoded = deflateSync(Buffer.from(program)).toString("base64");
	if (encoded.length > 24e3) throw new Error("WSL RPC bootstrap exceeds its Windows command-line budget");
	return `exec(__import__('zlib').decompress(__import__('base64').b64decode('${encoded}')))`;
}
//#endregion
//#region src/shared/rpc-transport.ts
/** Shared, bounded WSL RPC lifecycle. Only versioned, bundled methods are accepted; dispatched mutations are never replayed. */
const abortedRun = () => ({
	code: null,
	stdout: Buffer.alloc(0),
	stderr: Buffer.alloc(0),
	aborted: true,
	signal: null
});
const MAX_REQUEST = 1048576;
const MAX_FILE_REQUEST = 32 * MAX_REQUEST;
const mutationUnknown = (message) => new RpcTransportError(`file mutation result unknown: ${message}; re-read before retrying`, "request", "RPC_MUTATION_UNKNOWN");
const MAX_PENDING = 16;
const MAX_BYTES = 67108864;
const PROTOCOL_SLACK = 2097152;
var RpcTransportError = class extends Error {
	stage;
	code;
	constructor(message, stage, code = "RPC_FAILED") {
		super(message);
		this.stage = stage;
		this.code = code;
		this.name = "RpcTransportError";
	}
};
const abortedError = () => new RpcTransportError("search cancelled or deadline expired", "request", "RPC_ABORTED");
/** The supplied launch string is single-line ASCII; user values only cross the stdin channel. */
function launchWsl(target, code) {
	return spawn(target.wslPath, [
		"-d",
		target.distro,
		...target.username === void 0 ? [] : ["-u", target.username],
		"--cd",
		"/",
		"-e",
		"python3",
		"-I",
		"-S",
		"-u",
		"-c",
		code
	], {
		stdio: [
			"pipe",
			"pipe",
			"pipe"
		],
		windowsHide: true
	});
}
function awaitReady(ready, timeout, signal) {
	if (signal?.aborted || timeout <= 0) return Promise.reject(abortedError());
	return new Promise((resolve, reject) => {
		const cancel = () => {
			cleanup();
			reject(abortedError());
		};
		const timer = setTimeout(cancel, timeout);
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
		};
		signal?.addEventListener("abort", cancel, { once: true });
		ready.then(() => {
			cleanup();
			resolve();
		}, (error) => {
			cleanup();
			reject(error);
		});
	});
}
var Worker = class {
	ready;
	closed = false;
	booted = false;
	child;
	bootTimer;
	idleTimer;
	acceptReady;
	rejectReady;
	pending = /* @__PURE__ */ new Map();
	waiting = 0;
	nextId = 1;
	chunks = [];
	chunkBytes = 0;
	stderr = Buffer.alloc(0);
	options;
	onIdle;
	constructor(target, options, onIdle) {
		this.options = options;
		this.onIdle = onIdle;
		this.ready = new Promise((resolve, reject) => {
			this.acceptReady = resolve;
			this.rejectReady = reject;
		});
		this.ready.catch(() => {});
		try {
			const child = this.options.launch(target, rpcWorkerCode());
			this.child = child;
			child.stdout.on("data", (chunk) => this.read(chunk));
			child.stderr.on("data", (chunk) => {
				this.stderr = Buffer.concat([this.stderr, chunk]).subarray(-8192);
			});
			child.stdin.on("error", (error) => this.break(error.message));
			child.on("error", (error) => this.break(error.message));
			child.on("close", () => this.break(`worker closed: ${decodeWslOutput(this.stderr).trim().slice(0, 1024)}`));
			this.bootTimer = setTimeout(() => this.break("search worker did not become ready"), options.bootMs);
		} catch (error) {
			this.break(String(error));
		}
	}
	get outstanding() {
		return this.pending.size + this.waiting;
	}
	get idle() {
		return this.booted && this.waiting === 0 && this.pending.size === 0;
	}
	ref(active) {
		if (!this.child) return;
		if (active) this.child.ref();
		else this.child.unref();
		for (const pipe of [
			this.child.stdin,
			this.child.stdout,
			this.child.stderr
		]) {
			const handle = pipe;
			if (active) handle.ref?.();
			else handle.unref?.();
		}
	}
	rest() {
		if (this.closed || !this.idle) return;
		clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			this.dispose();
			this.onIdle();
		}, this.options.idleMs);
		this.idleTimer.unref();
		this.ref(false);
	}
	async run(target, request) {
		const start = performance.now();
		if (this.closed) {
			await this.ready;
			throw new RpcTransportError("search worker is closed", "request");
		}
		if (this.pending.size + this.waiting >= MAX_PENDING) throw new RpcTransportError("search queue is full (16 requests)", "request");
		clearTimeout(this.idleTimer);
		this.ref(true);
		this.waiting++;
		try {
			await awaitReady(this.ready, request.timeoutMs, request.signal);
		} finally {
			this.waiting--;
			this.rest();
		}
		const remaining = Math.floor(request.timeoutMs - (performance.now() - start));
		if (request.signal?.aborted || remaining <= 0) return abortedRun();
		if (this.closed) throw new RpcTransportError("search worker closed before dispatch", "request");
		const id = this.nextId++;
		const message = JSON.stringify({
			id,
			op: request.op,
			args: request.args,
			cwd: target.linuxCwd,
			timeoutMs: remaining,
			maxBytes: request.maxBytes
		}) + "\n";
		if (Buffer.byteLength(message) > (request.op.startsWith("fs.") && request.op !== "fs.metadata" ? MAX_FILE_REQUEST : MAX_REQUEST)) throw new RpcTransportError("RPC request exceeds its byte limit", "request", "RPC_TOO_LARGE");
		clearTimeout(this.idleTimer);
		this.ref(true);
		return new Promise((resolve, reject) => {
			const cancel = () => {
				const pending = this.pending.get(id);
				if (!pending || pending.answered || pending.cancelling) return;
				pending.cancelling = true;
				pending.cleanup();
				if (!pending.mutating) {
					pending.answered = true;
					resolve(abortedRun());
				}
				this.send(JSON.stringify({
					id,
					op: "cancel"
				}) + "\n");
				pending.cancelTimer = setTimeout(() => this.break("worker did not acknowledge cancellation"), 1500);
				pending.cancelTimer.unref();
			};
			const timer = setTimeout(cancel, remaining);
			const cleanup = () => {
				clearTimeout(timer);
				request.signal?.removeEventListener("abort", cancel);
			};
			this.pending.set(id, {
				mutating: request.op === "fs.write" || request.op === "fs.edit",
				cancelling: false,
				done: resolve,
				fail: reject,
				cleanup,
				maxBytes: request.maxBytes,
				answered: false,
				readyMs: performance.now() - start,
				sentAt: performance.now()
			});
			request.signal?.addEventListener("abort", cancel, { once: true });
			this.send(message);
		});
	}
	send(message) {
		if (this.closed) return;
		this.child?.stdin.write(message, (error) => {
			if (error) this.break(error.message);
		});
	}
	read(chunk) {
		if (this.closed) return;
		const limit = this.booted ? Math.ceil((Math.max(0, ...Array.from(this.pending.values(), (p) => p.maxBytes)) + 1) * 4 / 3) + PROTOCOL_SLACK : 8192;
		let start = 0;
		while (start < chunk.length) {
			const end = chunk.indexOf(10, start);
			const piece = chunk.subarray(start, end < 0 ? void 0 : end);
			this.chunks.push(piece);
			this.chunkBytes += piece.length;
			if (this.chunkBytes > limit) {
				this.break("search response exceeds its byte budget");
				return;
			}
			if (end < 0) return;
			const line = Buffer.concat(this.chunks, this.chunkBytes);
			this.chunks = [];
			this.chunkBytes = 0;
			try {
				this.reply(JSON.parse(line.toString("utf8")));
			} catch (error) {
				this.break(`invalid search response: ${String(error)}`);
				return;
			}
			if (this.closed) return;
			start = end + 1;
		}
	}
	reply(value) {
		if (!value || typeof value !== "object") throw new Error("not an object");
		if (!this.booted) {
			if (value.ready !== 3 || !Number.isSafeInteger(value.pid) || !Array.isArray(value.methods) || !RPC_METHODS.every((method) => value.methods.includes(method))) throw new Error("protocol/version or capability mismatch");
			this.booted = true;
			clearTimeout(this.bootTimer);
			this.acceptReady();
			this.rest();
			return;
		}
		const id = value.id;
		if (typeof id !== "number") throw new Error("missing request id");
		const pending = this.pending.get(id);
		if (!pending) throw new Error("unknown request id");
		let result;
		if (typeof value.error !== "string") {
			if (typeof value.aborted !== "boolean" || value.code !== null && !Number.isSafeInteger(value.code)) throw new Error("invalid status");
			const decode = (raw, max) => {
				if (typeof raw !== "string") throw new Error("invalid byte payload");
				const bytes = Buffer.from(raw, "base64");
				if (bytes.length > max || bytes.toString("base64") !== raw) throw new Error("invalid or oversized base64");
				return bytes;
			};
			const timing = {
				readyMs: pending.readyMs,
				roundTripMs: performance.now() - pending.sentAt
			};
			if (value.timing !== void 0) {
				const native = value.timing;
				if (!native || ![native.queueMs, native.executionMs].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) throw new Error("invalid native timing");
				timing.queueMs = native.queueMs;
				timing.executionMs = native.executionMs;
			}
			const code = value.code;
			result = {
				timing,
				code,
				aborted: value.aborted || code !== null && code < 0,
				signal: null,
				stdout: decode(value.stdout, pending.maxBytes + 1),
				stderr: decode(value.stderr, MAX_REQUEST)
			};
		}
		this.pending.delete(id);
		pending.cleanup();
		clearTimeout(pending.cancelTimer);
		if (!pending.answered) {
			if (result) pending.done(result);
			else pending.fail(pending.mutating ? mutationUnknown(String(value.error)) : new RpcTransportError(String(value.error), "request"));
		}
		this.rest();
	}
	break(message) {
		if (this.closed) return;
		const error = new RpcTransportError(message, this.booted ? "request" : "startup");
		this.rejectReady(error);
		for (const pending of this.pending.values()) {
			pending.cleanup();
			clearTimeout(pending.cancelTimer);
			if (!pending.answered) pending.fail(pending.mutating ? mutationUnknown(message) : error);
		}
		this.pending.clear();
		this.dispose();
	}
	dispose() {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.idleTimer);
		clearTimeout(this.bootTimer);
		this.rejectReady(new RpcTransportError("search transport disposed", "request"));
		for (const pending of this.pending.values()) {
			pending.cleanup();
			clearTimeout(pending.cancelTimer);
			if (!pending.answered) {
				if (pending.mutating) pending.fail(mutationUnknown("provider disposed before acknowledgement"));
				else pending.done(abortedRun());
			}
		}
		this.pending.clear();
		this.chunks = [];
		this.chunkBytes = 0;
		const child = this.child;
		if (!child) return;
		child.stdin.end();
		const kill = setTimeout(() => child.kill("SIGKILL"), 1e3);
		kill.unref();
		child.once("close", () => clearTimeout(kill));
		this.ref(false);
	}
};
/** One owner-scoped pool for all RPC methods, bounded across distro/user/executable identities. */
var WslRpcPool = class {
	options;
	workers = /* @__PURE__ */ new Map();
	unavailable = /* @__PURE__ */ new Map();
	disposed = false;
	launches = 0;
	idleReleases = 0;
	lruReleases = 0;
	fallbacks = 0;
	metrics;
	constructor(options = {}) {
		this.options = {
			launch: launchWsl,
			idleMs: 12e4,
			bootMs: 15e3,
			maxWorkers: 4,
			cooldownMs: 6e4,
			metrics: true,
			...options
		};
		this.metrics = new RpcMetrics(this.options.metrics);
		for (const key of [
			"idleMs",
			"bootMs",
			"maxWorkers",
			"cooldownMs"
		]) if (!Number.isSafeInteger(this.options[key]) || this.options[key] <= 0) throw new RangeError(`invalid ${key}`);
	}
	snapshot() {
		return {
			workers: this.workers.size,
			launches: this.launches
		};
	}
	diagnostics() {
		return {
			...this.snapshot(),
			idleMs: this.options.idleMs,
			maxWorkers: this.options.maxWorkers,
			pending: [...this.workers.values()].reduce((n, worker) => n + worker.outstanding, 0),
			idleReleases: this.idleReleases,
			lruReleases: this.lruReleases,
			fallbacks: this.fallbacks,
			metrics: this.metrics.snapshot()
		};
	}
	async run(target, request) {
		const start = performance.now();
		let outcome = "error";
		try {
			const result = await this.runRequest(target, request);
			outcome = result.aborted ? "aborted" : result.stdout.length > request.maxBytes ? "overflow" : result.code === 0 || request.op === "grep" && result.code === 1 ? "ok" : "error";
			if (result.timing) {
				const times = result.timing;
				for (const [stage, ms] of [
					["ready", times.readyMs],
					["roundTrip", times.roundTripMs],
					["queue", times.queueMs],
					["execute", times.executionMs]
				]) if (ms !== void 0) this.metrics.record(`rpc.${request.op}.${stage}`, ms, outcome);
			}
			return result;
		} catch (error) {
			if (error instanceof RpcTransportError && error.code === "RPC_ABORTED") outcome = "aborted";
			throw error;
		} finally {
			this.metrics.record(`rpc.${request.op}.total`, performance.now() - start, outcome);
		}
	}
	async runRequest(target, request) {
		if (this.disposed) throw new RpcTransportError("search pool is disposed", "request");
		if (request.signal?.aborted) return abortedRun();
		if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > 864e5 || !Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0 || request.maxBytes > MAX_BYTES) throw new RpcTransportError("invalid search timeout or byte budget", "request");
		if (!RPC_METHODS.includes(request.op) || !Array.isArray(request.args) || request.args.length > 256 || request.args.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !target.linuxCwd.startsWith("/") || target.linuxCwd.includes("\0")) throw new RpcTransportError("invalid or excess RPC request", "request");
		const key = JSON.stringify([
			target.wslPath,
			target.distro,
			target.username ?? null
		]);
		const unavailable = this.unavailable.get(key);
		if (unavailable && unavailable.until > performance.now()) throw unavailable.error;
		this.unavailable.delete(key);
		let worker = this.workers.get(key);
		if (worker?.closed) {
			this.workers.delete(key);
			worker = void 0;
		}
		if (!worker) {
			if (this.workers.size >= this.options.maxWorkers) {
				const idle = [...this.workers].find(([, w]) => w.idle || w.closed);
				if (!idle) throw new RpcTransportError("all search workers are busy", "request");
				idle[1].dispose();
				this.workers.delete(idle[0]);
				this.lruReleases++;
			}
			worker = new Worker(target, this.options, () => {
				if (this.workers.get(key) === worker) {
					this.workers.delete(key);
					this.idleReleases++;
				}
			});
			this.workers.set(key, worker);
			this.launches++;
		} else {
			this.workers.delete(key);
			this.workers.set(key, worker);
		}
		try {
			return await worker.run(target, request);
		} catch (error) {
			if (error instanceof RpcTransportError && error.stage === "startup") {
				this.unavailable.set(key, {
					until: performance.now() + this.options.cooldownMs,
					error
				});
				while (this.unavailable.size > 16) this.unavailable.delete(this.unavailable.keys().next().value);
			}
			throw error;
		}
	}
	/** Fall back only before dispatch; a request that may have run is never replayed. */
	async runAuto(target, request, fallback) {
		const started = performance.now();
		try {
			return await this.run(target, request);
		} catch (error) {
			if (!(error instanceof RpcTransportError) || error.stage !== "startup") throw error;
			const remaining = Math.floor(request.timeoutMs - (performance.now() - started));
			if (this.disposed || request.signal?.aborted || remaining <= 0) return abortedRun();
			this.fallbacks++;
			return fallback(remaining, error.message);
		}
	}
	dispose() {
		this.disposed = true;
		for (const worker of this.workers.values()) worker.dispose();
		this.workers.clear();
		this.unavailable.clear();
	}
};
//#endregion
export { GREP_SCRIPT as i, WslRpcPool as n, GLOB_SCRIPT as r, RpcTransportError as t };

//# sourceMappingURL=rpc-transport-UiXQOdiW.js.map