/** Linux file transactions. Mirrors the pinned dsh-fs-local text/guard contract (MIT; see NOTICE). */
export const NATIVE_FILE_PROGRAM = String.raw`
import base64, codecs, errno, fcntl, json, os, signal, stat, sys, uuid, zlib
from collections import deque

MAX_CONTENT = 16 * 1024 * 1024
MAX_WIRE = 32 * 1024 * 1024
committed = False
cleaning = False
running = False
cancel_requested = False

class Failure(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)

def fail(code, message):
    raise Failure(code, message)

def cancel(signum, frame):
    global cancel_requested
    cancel_requested = True
    if running and not committed and not cleaning:
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

def probe(path, follow=True, dir_fd=None):
    try: return os.stat(path, dir_fd=dir_fd, follow_symlinks=follow)
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
        return data  # Consumers accept the buffer; avoid a second full-file allocation.
    finally: os.close(fd)

# Compress read-only bytes only when first, middle and final 8 KiB slices
# all show substantial redundancy. This bounds CPU for random files *and*
# avoids a cheap, compressible header tricking us into compressing random MBs.
# Confirm a meaningful full-body reduction after encoding; otherwise fall back.
# Node independently bounds decompression to the requested uncompressed size.
def encoded_read(data):
    if len(data) >= 65536:
        sample_size = 8192
        sample = memoryview(data)
        offsets = (0, (len(data) - sample_size) // 2, len(data) - sample_size)
        if all(len(zlib.compress(sample[start:start + sample_size], 1)) * 5
               < sample_size * 4 for start in offsets):
            compressed = zlib.compress(data, 1)
            if len(compressed) * 5 < len(data) * 4:
                return {'dataZ': base64.b64encode(compressed).decode('ascii'),
                        'rawBytes': len(data)}
    return {'data': base64.b64encode(data).decode('ascii')}


# A registered-read-only operation. Scan the original file once for an exact
# total-line count and strict UTF-8 validity, but retain at most the requested
# bounded window. The model-facing JS tool keeps the original schema/rendering.
# JS counts UTF-16 code units (not Python code points) when truncating lines.
def read_window(path, req):
    offset, limit = req.get('offset'), req.get('limit')
    max_line, max_bytes = req.get('maxLineLength'), req.get('maxBytes')
    if (any(type(v) is not int for v in (offset, limit, max_line, max_bytes))
            or not 1 <= offset <= 9007199254740991
            or not 1 <= limit <= 100000
            or not 1 <= max_line <= 65536
            or not 1 <= max_bytes <= 1048576):
        fail('FS_IO_ERROR', 'invalid native read window limits')
    fd, initial = regular(path)
    version = info(initial)
    lines, total, consumed, truncated = [], 0, 0, False
    buffer, buffer_units, has_text = '', 0, False
    cap = max_line + 1
    decoder = codecs.getincrementaldecoder('utf-8-sig')('strict')
    first_bytes = 0

    def capture(segment):
        nonlocal buffer, buffer_units
        spare = cap - buffer_units
        if spare <= 0 or not segment:
            return
        prefix = []
        for character in segment:
            unit = 2 if ord(character) > 0xffff else 1
            if unit > spare:
                # JS slice at a surrogate boundary returns the high half.
                cp = ord(character) - 0x10000
                prefix.append(chr(0xd800 + (cp >> 10)))
                buffer_units += 1
                break
            prefix.append(character)
            buffer_units += unit
            spare -= unit
            if spare == 0: break
        buffer += ''.join(prefix)

    def flush():
        nonlocal total, consumed, truncated, buffer, buffer_units, has_text
        total += 1
        if not truncated and offset <= total and len(lines) < limit:
            line = buffer[:-1] if buffer.endswith('\r') else buffer
            visible_units = buffer_units - (1 if buffer.endswith('\r') else 0)
            if visible_units > max_line:
                # JS substring(maxLine) cuts in UTF-16 units; capture already
                # contains only maxLine+1 units, including a possible surrogate.
                utf16 = line.encode('utf-16-le', 'surrogatepass')
                line = utf16[:max_line * 2].decode('utf-16-le', 'surrogatepass')
                line += '... (line truncated to %d chars)' % max_line
            # JS Buffer.byteLength replaces isolated UTF-16 surrogates with U+FFFD.
            size = len(line.encode('utf-16-le', 'surrogatepass').decode('utf-16-le', 'replace').encode('utf-8'))
            size += 1 if lines else 0
            if consumed + size > max_bytes:
                truncated = True
            else:
                consumed += size
                lines.append({'number': total, 'text': line})
        buffer, buffer_units, has_text = '', 0, False

    def accept(decoded):
        nonlocal has_text
        parts = decoded.split('\n')
        for index, part in enumerate(parts):
            if part:
                has_text = True
                if not truncated and offset <= total + 1 and len(lines) < limit:
                    capture(part)
            if index + 1 < len(parts):
                flush()

    try:
        while True:
            if cancel_requested: fail('FS_ABORTED', 'file window read cancelled')
            raw = os.read(fd, 65536)
            if not raw: break
            if first_bytes < 8192:
                checked = raw[:8192-first_bytes]
                if b'\0' in checked: fail('FS_NOT_TEXT', 'binary file')
                first_bytes += len(checked)
            try: accept(decoder.decode(raw))
            except UnicodeDecodeError: fail('FS_NOT_TEXT', 'invalid UTF-8 text')
        try: accept(decoder.decode(b'', final=True))
        except UnicodeDecodeError: fail('FS_NOT_TEXT', 'invalid UTF-8 text')
        if has_text: flush()
        if info(os.fstat(fd))['version'] != version['version']:
            fail('FS_STALE_VERSION', 'file changed during read')
    finally:
        os.close(fd)
    out_of_range = not truncated and offset > total and not (total == 0 and offset == 1)
    return {'info': version, 'lines': lines, 'totalLines': total,
            'truncatedByBytes': truncated, 'outOfRange': out_of_range}

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
            sample = original[:4096].encode('utf-16-le', 'surrogatepass')[:8192].decode('utf-16-le', 'surrogatepass')
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
    if op == 'fs.window':
        # The Windows drive backend must own drvfs paths, as for fs.snapshot.
        path = canonical(path)
        if (len(path) >= 6 and path.startswith('/mnt/') and path[5].isascii()
                and path[5].isalpha() and (len(path) == 6 or path[6] == '/')):
            return {'path': path, 'fallback': True}
        state = probe(path)
        if state is None or not stat.S_ISREG(state.st_mode):
            return {'path': path, 'info': None if state is None else info(state),
                    'lines': [], 'totalLines': 0, 'truncatedByBytes': False,
                    'outOfRange': False}
        return {'path': path, **read_window(path, req)}
    if op == 'fs.snapshot':
        # Read-tool-only transaction: resolve, observe, and (for small regular
        # files) read within one native round trip. The original per-call
        # physical path and fresh inode checks are reused, never cached.
        threshold = req.get('streamMinSize')
        if type(threshold) is not int or threshold < 1:
            fail('FS_IO_ERROR', 'invalid snapshot streaming threshold')
        path = canonical(path)
        # /mnt/<drive> is served by the Windows backend. Do not probe that
        # drvfs inode here: Linux may deny access where Win32 can still read.
        if (len(path) >= 6 and path.startswith('/mnt/') and path[5].isascii()
                and path[5].isalpha() and (len(path) == 6 or path[6] == '/')):
            return {'path': path, 'info': None, 'data': None}
        state = probe(path)
        metadata = None if state is None else info(state)
        data = {'data': None}
        if (state is not None and stat.S_ISREG(state.st_mode)
                and state.st_size < threshold):
            data = encoded_read(read_bytes(path, MAX_CONTENT))
        return {'path': path, 'info': metadata, **data}
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
        return encoded_read(data)
    if op == 'fs.list':
        s = probe(path)
        if s is None: fail('FS_NOT_FOUND', 'directory not found')
        if not stat.S_ISDIR(s.st_mode): fail('FS_NOT_DIRECTORY', 'not a directory')
        result = []
        directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(directory)
            with os.scandir(directory) as entries:
                for entry in entries:
                    resolved = os.path.join(path, entry.name)
                    # Fresh descriptor-relative metadata; common ancestors are not walked N times.
                    s = probe(entry.name, False, directory)
                    if s is not None and stat.S_ISLNK(s.st_mode):
                        resolved = canonical(resolved)
                        s = probe(resolved)
                    row = {'name': entry.name, 'path': resolved, 'type': 'other'}
                    if s is not None: row.update(info(s))
                    result.append(row)
                    if len(result) > 100000: fail('FS_TOO_LARGE', 'directory exceeds 100000 entries')
            current = probe(path, False)
            if (current is None or (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino)
                    or canonical(path) != path):
                fail('FS_STALE_VERSION', 'directory changed during enumeration')
            return result
        finally:
            os.close(directory)
    if op == 'fs.write': return atomic(path, req)
    if op == 'fs.edit': return atomic(path, req, True)
    fail('FS_IO_ERROR', 'unknown file operation')

def dispatch(op, payload):
    global committed, cleaning, running
    # A pooled executor retains code, never a prior operation's state or receipt.
    committed, cleaning, running = False, False, True
    try:
        if cancel_requested: fail('FS_ABORTED', 'file operation cancelled before execution')
        req = json.loads(payload)
        if op == 'fs.batch':
            items = req.get('requests')
            allowed = ('fs.resolve', 'fs.stat', 'fs.lstat', 'fs.read')
            if (type(items) is not list or not 2 <= len(items) <= 8 or
                    any(type(item) is not dict or item.get('op') not in allowed or
                        type(item.get('payload')) is not dict for item in items)):
                fail('FS_IO_ERROR', 'invalid read-only file batch')
            value = []
            for item in items:
                if cancel_requested: fail('FS_ABORTED', 'file batch cancelled')
                reply, _ = dispatch(item['op'], json.dumps(item['payload']))
                running = True
                value.append(reply)
        else:
            value = run(op, req)
        return {'ok': True, 'committed': committed, 'value': value}, 0
    except Failure as error:
        return {'ok': False, 'committed': committed, 'code': error.code, 'message': error.message}, 1
    except OSError as error:
        kind = ('FS_NOT_FOUND' if error.errno in (errno.ENOENT, errno.ENOTDIR) else
                'FS_PERMISSION_DENIED' if error.errno in (errno.EACCES, errno.EPERM) else 'FS_IO_ERROR')
        return {'ok': False, 'committed': committed, 'code': kind, 'message': errno.errorcode.get(error.errno, 'EIO')}, 1
    except Exception as error:
        return {'ok': False, 'committed': committed, 'code': 'FS_IO_ERROR', 'message': str(error)[:1024]}, 1
    finally:
        running = False

if sys.argv[1] == '--persistent':
    # One request at a time per executor. The parent owns a bounded four-executor
    # pool and retires an executor after cancellation or an incomplete response.
    while True:
        cancel_requested = False
        raw = sys.stdin.buffer.readline(MAX_WIRE + 1)
        if not raw: break
        if len(raw) > MAX_WIRE or not raw.endswith(b'\n'):
            raise ValueError('invalid native executor frame')
        message = json.loads(raw)
        os.chdir(message['cwd'])
        result, code = dispatch(message['op'], message['payload'])
        data = json.dumps(result, ensure_ascii=message['op'] == 'fs.window', separators=(',', ':')).encode('utf-8') + b'\n'
        sys.stdout.buffer.write(str(code).encode('ascii') + data)
        sys.stdout.buffer.flush()
        del message, raw, result, data  # Keep no previous request or file-body cache.
else:
    raw = sys.stdin.buffer.read(MAX_WIRE + 1)
    if len(raw) > MAX_WIRE: raise ValueError('native request exceeded its byte limit')
    result, code = dispatch(sys.argv[1], raw)
    sys.stdout.buffer.write((json.dumps(result, ensure_ascii=sys.argv[1] == 'fs.window', separators=(',', ':')) + '\n').encode('utf-8'))
    sys.stdout.buffer.flush()
    sys.exit(code)
`
