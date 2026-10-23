import { a as rpcRunOutcome, n as RpcMetrics, t as RPC_METHODS } from "./rpc-metrics-BpoobETe.js";
import { t as decodeWslOutput } from "./wsl-CWw3IAkU.js";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { deflateSync } from "node:zlib";
//#region src/shared/search-scripts.ts
/** Fixed Bash scripts: all model-controlled values are argv, never interpolated code. */
/**
* GNU grep emits path\0line:text records. After the first four argv fields,
* optional ["", literal-directory-prefix] or ["", "", "", anchor-name] restricts the Linux walk only when
* safe, followed by conservative basename hints. The host remains the exact matcher.
* Hints retain the original hidden-file rule; explicit file targets stay visible.
* The cap is enforced in Linux and PIPESTATUS preserves grep's exit status.
*/
const GREP_SCRIPT = [
	"set -u",
	"pattern=$1; include=$2; target=$3; cap=$4; shift 4",
	"prefix=; anchor=",
	"if [ \"$#\" -ge 2 ] && [ \"$1\" = \"\" ]; then prefix=$2; shift 2; fi",
	"if [ \"$#\" -ge 2 ] && [ \"$1\" = \"\" ]; then anchor=$2; shift 2; fi",
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
	"if [ \"$dir\" = 1 ] && [ -z \"$include\" ] && [ \"$#\" -gt 0 ]; then",
	"  printf -v include \"%s\\n\" \"$@\"",
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
	"if [ \"$dir\" = 1 ] && [ -n \"$prefix\" ]; then",
	"  candidate=${target%/}; safe=1",
	"  IFS=/ read -r -a segments <<<\"$prefix\"",
	"  for segment in \"${segments[@]}\"; do",
	"    case $segment in \"\"|\".\"|\"..\"|node_modules|.*) safe=0; break ;; esac",
	"    candidate=$candidate/$segment",
	"    if [ -L \"$candidate\" ] || [ ! -d \"$candidate\" ]; then safe=0; break; fi",
	"  done",
	"  if [ \"$safe\" = 1 ] && [ \"$(cd -- \"$candidate\" && pwd -P)\" = \"$candidate\" ]; then target=$candidate; fi",
	"fi",
	"if [ \"$dir\" = 1 ] && [ -z \"$prefix\" ] && [ -n \"$anchor\" ] && [ \"${target##*/}\" != node_modules ]; then",
	"  excludes=(-type d -name node_modules)",
	"  case ${target##*/} in .*) ;; *) excludes+=(-o -type d -name \".*\") ;; esac",
	"  dirs=()",
	"  mapfile -d \"\" -t dirs < <(find \"$target\" -mindepth 1 \\( \"${excludes[@]}\" \\) -prune -o -type d -name \"$anchor\" -print0 -prune 2>/dev/null)",
	"  walkPid=$!",
	"  if wait \"$walkPid\" && [ \"${#dirs[@]}\" -eq 1 ]; then",
	"    selected=${dirs[0]}",
	"    if [ ! -L \"$selected\" ] && [ -d \"$selected\" ] && [ \"$(cd -- \"$selected\" && pwd -P)\" = \"$selected\" ]; then target=$selected; fi",
	"  fi",
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
	"prefix=; anchor=",
	"if [ \"$#\" -ge 2 ] && [ \"$1\" = \"\" ]; then prefix=$2; shift 2; fi",
	"if [ \"$#\" -ge 2 ] && [ \"$1\" = \"\" ]; then anchor=$2; shift 2; fi",
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
	"scope=()",
	"if [ -n \"$prefix\" ]; then",
	"  literal_path() {",
	"    escaped=$1",
	"    escaped=${escaped//\\\\/\\\\\\\\}",
	"    escaped=${escaped//\\*/\\\\*}",
	"    escaped=${escaped//\\?/\\\\?}",
	"    escaped=${escaped//\\[/\\\\[}",
	"  }",
	"  literal_path \"$target\"",
	"  allowed=(-path \"$escaped\")",
	"  cursor=${target%/}",
	"  IFS=/ read -r -a parts <<<\"$prefix\"",
	"  for part in \"${parts[@]}\"; do",
	"    cursor=$cursor/$part",
	"    literal_path \"$cursor\"",
	"    allowed+=(-o -path \"$escaped\")",
	"  done",
	"  # Keep the original root: a directory symlink must never become a traversal root.",
	"  allowed+=(-o -path \"$escaped/*\")",
	"  scope=(-type d ! '(' \"${allowed[@]}\" ')' -prune -o -path \"$escaped/*\")",
	"fi",
	"scanTarget=$target",
	"case ${target##*/} in .git|.hg|.svn|.bzr|.jj|.sl) anchor=;; esac",
	"if [ -n \"$anchor\" ] && [ -d \"$target\" ]; then",
	"  dirs=()",
	"  mapfile -d \"\" -t dirs < <(find \"$target\" -mindepth 1 \\( \"${prune[@]}\" \\) -prune -o -type d -name \"$anchor\" -print0 -prune 2>/dev/null)",
	"  walkPid=$!",
	"  if wait \"$walkPid\" && [ \"${#dirs[@]}\" -eq 1 ]; then",
	"    selected=${dirs[0]}",
	"    if [ ! -L \"$selected\" ] && [ -d \"$selected\" ] && [ \"$(cd -- \"$selected\" && pwd -P)\" = \"$selected\" ]; then scanTarget=$selected; fi",
	"  fi",
	"fi",
	"if find --version 2>/dev/null | head -n 1 | grep -q GNU; then",
	"  { printf 'G%s\\0' \"$target\"; find \"$scanTarget\" \\( \"${prune[@]}\" \\) -prune -o \"${scope[@]}\" -type f \"${names[@]}\" -printf '%T@\\t%p\\0'; } | head -c \"$cap\"",
	"else",
	"  { printf 'P%s\\0' \"$target\"; find \"$scanTarget\" \\( \"${prune[@]}\" \\) -prune -o \"${scope[@]}\" -type f \"${names[@]}\" -print0; } | head -c \"$cap\"",
	"fi",
	"exit \"${PIPESTATUS[0]}\""
].join("\n");
//#endregion
//#region src/shared/native-file-worker.ts
/** Linux file transactions. Mirrors the pinned dsh-fs-local text/guard contract (MIT; see NOTICE). */
const NATIVE_FILE_PROGRAM = String.raw`
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
        nonlocal has_text, total
        if not decoded: return
        newline_count = decoded.count('\n')
        # Still validate every UTF-8 byte, but count irrelevant lines inside
        # CPython instead of allocating hundreds of thousands of strings.
        # A whole decoded chunk may be skipped only when it cannot reach the
        # requested first line, or the output window is already complete.
        if (truncated or len(lines) >= limit or
                total + newline_count + 1 < offset):
            total += newline_count
            if newline_count:
                has_text = decoded[-1] != '\n'
            else:
                has_text = True
            return
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
FILE_METHODS = ["fs.batch", "fs.snapshot", "fs.window", "fs.resolve", "fs.stat", "fs.lstat", "fs.read", "fs.range", "fs.list", "fs.write", "fs.edit"]
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
`;
/** Single-line ASCII launch code; search arguments are never embedded in it. */
let cachedBootstrap;
function rpcWorkerCode() {
	if (cachedBootstrap !== void 0) return cachedBootstrap;
	const scripts = Buffer.from(JSON.stringify({
		grep: GREP_SCRIPT,
		glob: GLOB_SCRIPT
	})).toString("base64");
	const program = `import base64, json\nMETADATA=${JSON.stringify(METADATA)}\nFILE_PROGRAM=${JSON.stringify(NATIVE_FILE_PROGRAM)}\nSCRIPTS=json.loads(base64.b64decode("${scripts}"))\n${PROGRAM}`;
	const encoded = deflateSync(Buffer.from(program)).toString("base64");
	if (encoded.length > 24e3) throw new Error("WSL RPC bootstrap exceeds its Windows command-line budget");
	return cachedBootstrap = `exec(__import__('zlib').decompress(__import__('base64').b64decode('${encoded}')))`;
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
/** Decode only canonical, bounded base64. Both RPC envelopes and native file bodies use this rule. */
function decodeRpcBytes(raw, max) {
	if (typeof raw !== "string") throw new Error("invalid byte payload");
	const padding = raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0;
	if (raw.length / 4 * 3 - padding > max) throw new Error("invalid or oversized base64");
	const bytes = Buffer.from(raw, "base64");
	if (bytes.length > max || bytes.toString("base64") !== raw) throw new Error("invalid or oversized base64");
	return bytes;
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
			const line = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.chunkBytes);
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
				stdout: decodeRpcBytes(value.stdout, pending.maxBytes + 1),
				stderr: decodeRpcBytes(value.stderr, MAX_REQUEST)
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
		this.close(new RpcTransportError(message, this.booted ? "request" : "startup"));
	}
	dispose() {
		this.close();
	}
	/** One terminal path; faults reject reads, explicit disposal cancels them, and writes remain unknown. */
	close(error) {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.idleTimer);
		clearTimeout(this.bootTimer);
		this.rejectReady(error ?? new RpcTransportError("search transport disposed", "request"));
		for (const pending of this.pending.values()) {
			pending.cleanup();
			clearTimeout(pending.cancelTimer);
			if (pending.answered) continue;
			if (pending.mutating) pending.fail(mutationUnknown(error?.message ?? "provider disposed before acknowledgement"));
			else if (error) pending.fail(error);
			else pending.done(abortedRun());
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
			outcome = rpcRunOutcome(result, request.op, request.maxBytes);
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
export { GREP_SCRIPT as a, GLOB_SCRIPT as i, WslRpcPool as n, decodeRpcBytes as r, RpcTransportError as t };

//# sourceMappingURL=rpc-transport-BLEcbEWq.js.map