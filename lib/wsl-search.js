import { a as resolveRpcConfig, i as RPC_DEFAULTS, n as registerRpcDiagnostics, r as rpcDiagnostics, t as RpcMetrics } from "./rpc-metrics-DkZBc0ZP.js";
import { c as parseWslUnc, n as isAbsoluteLinuxPath, u as windowsToMntPath } from "./paths-CkIGMcuV.js";
import { r as getWorkspaceUsername } from "./wsl-credentials-DzKgEzy7.js";
import { r as defaultDistroSync, t as decodeWslOutput } from "./wsl-DN2-D6tr.js";
import z from "@deepseek-ai/schemastery";
import { posix } from "node:path";
import { execFile, spawn } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { performance } from "node:perf_hooks";
import { GLOB_MAX_RESULTS, GREP_MAX_LINE_BYTES, GREP_MAX_MATCHES, RAW_OUTPUT_MAX_BYTES, SEARCH_META_MAX_BYTES, SEARCH_TIMEOUT_MS, SearchError, formatGlobOutput, formatGrepMatches, formatGrepOutput, parseGlobArgs, parseGrepArgs, presentGlobCall, presentGlobResult, presentGrepCall, presentGrepResult, previewLine, sampleAcrossTopLevel, trySaveFormattedResult } from "@deepseek-ai/dsh-tool-fs-search";
//#region src/shared/search-patterns.ts
/** Shared search matching; no host dependencies or filesystem effects. */
/**
* Expand one glob's `{a,b,c}` alternations into the equivalent list of plain
* globs. ripgrep's globset understands braces; GNU grep's `--include` does not,
* so the tool passes one `--include` per expansion (repeated includes are OR-ed).
* @param glob - the glob to expand.
* @returns every brace-free alternative, in source order.
*/
function expandBraces(glob) {
	const open = glob.indexOf("{");
	if (open < 0) return [glob];
	const close = glob.indexOf("}", open + 1);
	if (close < 0) return [glob];
	const head = glob.slice(0, open);
	const tail = glob.slice(close + 1);
	return glob.slice(open + 1, close).split(",").flatMap((part) => expandBraces(`${head}${part}${tail}`));
}
/**
* Translate one gitignore-style glob into a regular-expression source (no
* anchors). `*` and `?` never cross a separator, `**` does (a `**` followed by a
* separator also matches zero segments), `[...]` is a character class (negated
* by a leading `!` or `^`), and `{a,b}` is an alternation.
* @param pattern - the glob source.
* @returns the unanchored regex source.
*/
function globSource(pattern) {
	let source = "";
	let index = 0;
	while (index < pattern.length) {
		const char = pattern[index] ?? "";
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				if (pattern[index + 2] === "/") {
					source += "(?:[^/]*/)*";
					index += 3;
					continue;
				}
				source += ".*";
				index += 2;
				continue;
			}
			source += "[^/]*";
			index += 1;
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			index += 1;
			continue;
		}
		if (char === "[") {
			const close = pattern.indexOf("]", index + 2);
			if (close > index + 1) {
				const body = pattern.slice(index + 1, close);
				const negated = body.startsWith("!") || body.startsWith("^");
				const chars = (negated ? body.slice(1) : body).replace(/[\\^\]]/g, "\\$&");
				source += `[${negated ? "^" : ""}${chars}]`;
				index = close + 1;
				continue;
			}
			source += "\\[";
			index += 1;
			continue;
		}
		if (char === "{") {
			const close = pattern.indexOf("}", index + 1);
			if (close > index + 1) {
				const alternatives = pattern.slice(index + 1, close).split(",").map((part) => globSource(part));
				source += `(?:${alternatives.join("|")})`;
				index = close + 1;
				continue;
			}
			source += "\\{";
			index += 1;
			continue;
		}
		source += /[.+^$()|\\]/.test(char) ? `\\${char}` : char;
		index += 1;
	}
	return source;
}
/**
* Compile one glob into a whole-string matcher.
* @param pattern - the glob source.
* @returns the anchored regular expression.
*/
function globToRegExp(pattern) {
	return new RegExp(`^${globSource(pattern)}$`);
}
/**
* Whether one file passes a glob filter. A pattern containing `/` matches the
* path relative to the search root; one without matches the basename at any
* depth. A leading `!` negates the match, so `!*.log` keeps everything that is
* not a log file.
* @param pattern - the glob filter.
* @returns a reusable predicate; one compilation per search, not per file.
*/
function compileGlob(pattern) {
	let body = pattern;
	let negated = false;
	if (body.startsWith("!")) {
		negated = true;
		body = body.slice(1);
	}
	const regex = globToRegExp(body);
	const pathShaped = body.includes("/");
	return (relativePath) => {
		const candidate = pathShaped ? relativePath : posix.basename(relativePath);
		const matched = regex.test(candidate);
		return negated ? !matched : matched;
	};
}
/** Compatibility entry point for callers matching just one path. */
function matchGlob(pattern, relativePath) {
	return compileGlob(pattern)(relativePath);
}
/**
* Conservative filename filters for GNU find/grep. The full path matcher remains
* authoritative. Unsupported syntax falls back for the WHOLE union, never just
* one alternative; dropping an alternative could silently lose real matches.
*
* GNU's byte/locale glob and JavaScript's UTF-16 glob need not agree on `?`,
* character classes or escapes, so those shapes are deliberately not pushed down.
* A basename `**` is broadened to `*`; this is safe because this layer may keep
* extra candidates, but must never discard a match the original matcher keeps.
*/
function basenameFilters(patterns, skipHidden = false) {
	const names = /* @__PURE__ */ new Set();
	for (const pattern of patterns) {
		if (pattern === "" || pattern.startsWith("!") || /[?\[\]{}\\\r\n]/.test(pattern)) return [];
		let name = posix.basename(pattern);
		if (name === "" || pattern.endsWith("/")) return [];
		if (name.includes("**") && name !== "**") return [];
		name = name.replace(/\*+/g, "*");
		if (skipHidden) {
			if (name.startsWith(".")) return [];
			if (name.startsWith("*") && name.length > 1 && name[1] !== ".") return [];
			if (name.startsWith("*")) name = `[!.]*${name.slice(1)}`;
		}
		names.add(name);
	}
	return [...names];
}
//#endregion
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
//#region src/shared/rpc-worker.ts
/** Read-only worker: fixed search scripts, JSON-lines over pipes, Python standard library only. */
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
`;
/** Single-line ASCII launch code; search arguments are never embedded in it. */
function rpcWorkerCode() {
	const scripts = Buffer.from(JSON.stringify({
		grep: GREP_SCRIPT,
		glob: GLOB_SCRIPT
	})).toString("base64");
	const program = `import base64, json\nMETADATA=${JSON.stringify(METADATA)}\nSCRIPTS=json.loads(base64.b64decode("${scripts}"))\n${PROGRAM}`;
	return `exec(__import__('base64').b64decode('${Buffer.from(program).toString("base64")}'))`;
}
//#endregion
//#region src/shared/rpc-transport.ts
/** Shared, bounded WSL RPC lifecycle. Only versioned, bundled read-only methods are accepted. */
const abortedRun = () => ({
	code: null,
	stdout: Buffer.alloc(0),
	stderr: Buffer.alloc(0),
	aborted: true,
	signal: null
});
const MAX_REQUEST = 1048576;
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
		if (Buffer.byteLength(message) > MAX_REQUEST) throw new RpcTransportError("search request exceeds 1 MiB", "request");
		clearTimeout(this.idleTimer);
		this.ref(true);
		return new Promise((resolve, reject) => {
			const cancel = () => {
				const pending = this.pending.get(id);
				if (!pending || pending.answered) return;
				pending.answered = true;
				pending.cleanup();
				resolve(abortedRun());
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
			if (value.ready !== 2 || !Number.isSafeInteger(value.pid) || !Array.isArray(value.methods) || ![
				"grep",
				"glob",
				"fs.metadata"
			].every((method) => value.methods.includes(method))) throw new Error("protocol/version or capability mismatch");
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
			else pending.fail(new RpcTransportError(String(value.error), "request"));
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
			if (!pending.answered) pending.fail(error);
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
			if (!pending.answered) pending.done(abortedRun());
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
		if (![
			"grep",
			"glob",
			"fs.metadata"
		].includes(request.op) || !Array.isArray(request.args) || request.args.length > 256 || request.args.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !target.linuxCwd.startsWith("/") || target.linuxCwd.includes("\0")) throw new RpcTransportError("invalid or excess RPC request", "request");
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
//#region src/shared/rpc-files.ts
/** First non-search RPC consumer. Read-only metadata; does not replace the DSH filesystem provider. */
async function readMetadata(pool, target, paths, options = {}) {
	if (paths.length === 0 || paths.length > 64 || paths.some((path) => !path.startsWith("/") || path.includes("\0"))) throw new RpcTransportError("metadata requires 1-64 absolute Linux paths", "request");
	const run = await pool.run(target, {
		op: "fs.metadata",
		args: paths,
		timeoutMs: options.timeoutMs ?? 1e4,
		maxBytes: 1048576,
		...options.signal === void 0 ? {} : { signal: options.signal }
	});
	if (run.aborted) throw new RpcTransportError("metadata cancelled", "request", "RPC_ABORTED");
	if (run.code !== 0 || run.stdout.length > 1048576) throw new RpcTransportError("metadata query failed or exceeded its output budget", "request");
	let rows;
	try {
		rows = JSON.parse(run.stdout.toString("utf8"));
	} catch {
		throw new RpcTransportError("invalid metadata response", "request");
	}
	if (!Array.isArray(rows) || rows.length !== paths.length || rows.some((row, i) => !row || row.path !== paths[i] || (typeof row.error === "string" ? !/^E[A-Z0-9]+$/.test(row.error) : typeof row.realpath !== "string" || !row.realpath.startsWith("/") || ![
		"file",
		"directory",
		"other"
	].includes(row.kind) || typeof row.symlink !== "boolean" || !Number.isSafeInteger(row.size) || row.size < 0 || ![
		row.mtimeNs,
		row.device,
		row.inode
	].every((x) => typeof x === "string" && /^-?\d+$/.test(x))))) throw new RpcTransportError("invalid metadata response", "request");
	return rows;
}
//#endregion
//#region src/host/wsl-search.ts
/**
* The WSL world's `grep` / `glob` tools.
*
* DSH's own discovery suite (`@deepseek-ai/dsh-tool-fs-search`) spawns the
* *packaged* ripgrep binary through `ctx.subprocess`. That binary is a Windows
* executable and every path the model hands it is a Linux path, so inside a WSL
* session the search either cannot start or looks at the wrong tree — which is
* why the generated WSL world dropped the `tool-fs-search` row outright and left
* the model to grep through the shell.
*
* This module replaces that row with a WSL-native twin. The search executes
* *inside the distribution* (`wsl.exe … bash -c <fixed script>`, every
* model-controlled value passed as a separate argv element and never
* interpolated into the script), so it runs on the Linux kernel over the real
* tree — symlinks, permissions and ownership included — instead of crawling the
* `\\wsl.localhost` 9P share.
*
* The model-facing contract stays DSH's own, not a lookalike: the tool names,
* parameter schemas, caps, output schema, `Line N:` grouping, found-count header,
* capped-result footer and search card all mirror the host suite, and its
* exported formatters (`formatGrepOutput`, `formatGlobOutput`,
* `sampleAcrossTopLevel`, `previewLine`, `present*`) do the rendering. Only the
* projections that package keeps private — the search-card metadata builder and
* the glob page selection — are reproduced here, and `tests/wsl-search.test.ts`
* compares them against the package's own output so drift is caught.
*
* Engine notes, both honest and documented in the UI:
*  - `grep` asks the distribution's GNU grep (`grep -rnIE -Z`), present on every
*    mainstream distribution and requiring no installation. Its dialect is POSIX
*    ERE — `\d`, `\w`, `\b` and `(?i)` work, lookaround and backreferences do
*    not — and it has no `.gitignore` support, so hidden entries and
*    `node_modules` are excluded explicitly while git-ignored files are still
*    searched.
*  - `glob` asks `find` (`-printf` reports each file's mtime without a stat per
*    file) and matches the pattern in this process, because neither GNU find nor
*    a shell reproduces ripgrep's globset semantics faithfully.
*  - Both bound the in-distro output with `head -c`, so a search over a huge tree
*    fails as an overflow instead of buffering the world.
*
* @module dsh-wsl-workspace/host/wsl-search
*/
/** The marker `$0` of both scripts; a fixed string, never a path from the model. */
const SCRIPT_ARGV0 = "dsh";
/** GNU grep stderr shapes that mean "the pattern is not a valid regex". */
const INVALID_PATTERN = /Unmatched|Invalid (?:regular expression|range end|character class|back reference|preceding regular expression)|unrecognized|trailing backslash|parentheses not balanced|Invalid collating element/i;
/**
* The defaults, kept as data as well as schema fields. A world row that mounts
* this plugin without a `config:` block hands `apply` an *undefined* config —
* schemastery's defaults are not applied on that path — and a live session
* caught exactly that as `Cannot read properties of undefined (reading
* 'grepMaxMatches')`, which failed the whole world. Reading the defaults from one
* place keeps the schema and the fallback from drifting apart.
*/
const DEFAULTS = {
	grepMaxMatches: GREP_MAX_MATCHES,
	grepMaxLineBytes: GREP_MAX_LINE_BYTES,
	globMaxResults: GLOB_MAX_RESULTS,
	sampleOverCapGlobResults: false,
	searchMetaMaxBytes: SEARCH_META_MAX_BYTES,
	rawOutputMaxBytes: RAW_OUTPUT_MAX_BYTES,
	timeoutMs: SEARCH_TIMEOUT_MS,
	wslPath: "wsl.exe",
	...RPC_DEFAULTS
};
/** Validated plugin config. */
const Config = z.object({
	grepMaxMatches: z.number().default(DEFAULTS.grepMaxMatches),
	grepMaxLineBytes: z.number().default(DEFAULTS.grepMaxLineBytes),
	globMaxResults: z.number().default(DEFAULTS.globMaxResults),
	sampleOverCapGlobResults: z.boolean().default(DEFAULTS.sampleOverCapGlobResults),
	searchMetaMaxBytes: z.number().default(DEFAULTS.searchMetaMaxBytes),
	rawOutputMaxBytes: z.number().default(DEFAULTS.rawOutputMaxBytes),
	timeoutMs: z.number().default(DEFAULTS.timeoutMs),
	wslPath: z.string().default(DEFAULTS.wslPath),
	distro: z.string(),
	transport: z.string(),
	idleMs: z.number(),
	metrics: z.boolean()
});
/** Services these tools register into. */
const inject = ["tools"];
/**
* Frame a raw `grep -rnIE -Z` stdout buffer into matches.
*
* GNU grep prints `<path>\0<line>:<text>\n` per match, so splitting on NUL and
* then on the first newline of each following segment recovers all three fields
* even when a path contains spaces, colons or newlines (the text cannot, because
* grep reports one line at a time and `-I` keeps NUL bytes out of the stream).
* @param stdout - the complete raw stdout bytes.
* @returns the matches in output order.
*/
function parseGrepRecords(stdout) {
	const records = [];
	const segments = stdout.toString("utf8").split("\0");
	let path = segments[0] ?? "";
	for (let index = 1; index < segments.length; index += 1) {
		const segment = segments[index] ?? "";
		if (segment === "") continue;
		const newline = segment.indexOf("\n");
		const head = newline < 0 ? segment : segment.slice(0, newline);
		const colon = head.indexOf(":");
		const lineNumber = Number.parseInt(colon < 0 ? head : head.slice(0, colon), 10);
		if (Number.isFinite(lineNumber)) records.push({
			path,
			lineNumber,
			line: colon < 0 ? "" : head.slice(colon + 1)
		});
		path = newline < 0 ? "" : segment.slice(newline + 1);
	}
	return records;
}
/**
* Frame a raw `glob` stdout buffer into a listing mode, a resolved root and
* entries.
*
* The script prefixes its output with a NUL-terminated `<mode><root>` header
* (`G` = GNU `-printf`: `mtime\tpath` records; `P` = plain `-print0`: paths only,
* no modification times). NUL framing keeps a root whose own path contains a
* newline in one piece.
* @param stdout - the complete raw stdout bytes.
* @returns the listing; `plain` entries carry `mtimeMs: 0`.
*/
function parseGlobRecords(stdout) {
	const headerEnd = stdout.indexOf(0);
	const header = (headerEnd < 0 ? stdout : stdout.subarray(0, headerEnd)).toString("utf8");
	const mode = header.startsWith("G") ? "gnu" : "plain";
	const root = header.length > 0 ? header.slice(1) : "";
	const files = [];
	const body = headerEnd < 0 ? Buffer.alloc(0) : stdout.subarray(headerEnd + 1);
	for (const entry of body.toString("utf8").split("\0")) {
		if (entry === "") continue;
		if (mode === "plain") {
			files.push({
				path: entry,
				mtimeMs: 0
			});
			continue;
		}
		const tab = entry.indexOf("	");
		if (tab < 0) continue;
		const seconds = Number.parseFloat(entry.slice(0, tab));
		files.push({
			path: entry.slice(tab + 1),
			mtimeMs: Number.isFinite(seconds) ? Math.round(seconds * 1e3) : 0
		});
	}
	return {
		mode,
		root,
		files
	};
}
/**
* Map one absolute Linux path to what the model should see: relative to the
* session workdir when it is inside it, absolute otherwise. The POSIX twin of
* the host suite's `toWorkdirRelative`, which is Windows-flavored
* (`path.relative` prints `src\a.ts`).
* @param absolutePath - the search's absolute Linux path.
* @param workdir - the session workdir in Linux coordinates.
* @returns the display path.
*/
function displayPath(absolutePath, workdir) {
	const relative = posix.relative(workdir, absolutePath);
	if (relative === "") return ".";
	return relative.startsWith("..") || posix.isAbsolute(relative) ? absolutePath : relative;
}
/**
* Apply DSH's inline caps to a match list: preview each line and keep the first
* `maxMatches`. Byte-for-byte the outcome of the host suite's private
* `retainGrepMatches` (`ItemRetainer` head + `previewLine`), which that package
* does not export.
* @param matches - every match the search parsed.
* @param maxMatches - the inline match cap.
* @param maxLineBytes - the per-line preview budget.
* @returns the retention outcome, with exact omission metadata.
*/
function retainMatches(matches, maxMatches, maxLineBytes) {
	const items = matches.slice(0, Math.max(0, maxMatches)).map((match) => ({
		...match,
		line: previewLine(match.line, maxLineBytes)
	}));
	const omitted = Math.max(0, matches.length - items.length);
	return {
		items,
		truncated: omitted > 0,
		seen: matches.length,
		kept: items.length,
		omitted: omitted > 0 ? {
			kind: "exact",
			count: omitted
		} : { kind: "none" }
	};
}
/**
* Apply DSH's inline cap to a path list (the host suite's private
* `retainGlobPaths`).
* @param paths - every discovered path.
* @param maxResults - the inline path cap.
* @returns the retention outcome, with exact omission metadata.
*/
function retainPaths(paths, maxResults) {
	const items = paths.slice(0, Math.max(0, maxResults));
	const omitted = Math.max(0, paths.length - items.length);
	return {
		items,
		truncated: omitted > 0,
		seen: paths.length,
		kept: items.length,
		omitted: omitted > 0 ? {
			kind: "exact",
			count: omitted
		} : { kind: "none" }
	};
}
/** The serialized UTF-8 byte size of one card payload (the size persisted and re-sent). */
function metaBytes(meta) {
	return Buffer.byteLength(JSON.stringify(meta), "utf8");
}
/**
* Drop trailing file groups (or paths) until the serialized card metadata fits
* `maxMetaBytes`, marking it truncated. Mirrors the host suite's private
* `capMetaBytes`: `total` keeps counting what the search found, and a single
* oversized item survives rather than producing an empty card.
* @param meta - the projected metadata, already capped to the inline item count.
* @param maxMetaBytes - the serialized byte budget.
* @returns the same metadata when it fits, else a byte-bounded copy.
*/
function capMetaBytes(meta, maxMetaBytes) {
	if (metaBytes(meta) <= maxMetaBytes) return meta;
	if (meta.shape === "matches") {
		const files = [...meta.files];
		while (files.length > 1 && metaBytes({
			...meta,
			files,
			truncated: true
		}) > maxMetaBytes) files.pop();
		return {
			...meta,
			files,
			truncated: true
		};
	}
	const paths = [...meta.paths];
	while (paths.length > 1 && metaBytes({
		...meta,
		paths,
		truncated: true
	}) > maxMetaBytes) paths.pop();
	return {
		...meta,
		paths,
		truncated: true
	};
}
/**
* Project a retained match page into the `matches`-shaped search card: the host
* suite's private `grepSearchMeta` + `groupMatchesByFile`, reproduced verbatim
* (first-seen file order, then the byte cap).
* @param page - the retained page (previewed, capped) or any equivalent subset.
* @param maxMetaBytes - the serialized metadata budget.
* @returns the card metadata.
*/
function grepSearchMeta(page, maxMetaBytes) {
	const byFile = /* @__PURE__ */ new Map();
	for (const match of page.items) {
		const entry = {
			lineNumber: match.lineNumber,
			line: match.line
		};
		const group = byFile.get(match.path);
		if (group === void 0) byFile.set(match.path, [entry]);
		else group.push(entry);
	}
	return capMetaBytes({
		shape: "matches",
		files: Array.from(byFile, ([path, matches]) => ({
			path,
			matches
		})),
		truncated: page.truncated,
		total: page.seen
	}, maxMetaBytes);
}
/**
* Project a retained path page into the `paths`-shaped search card (the host
* suite's private `globSearchMeta`).
* @param page - the retained page (capped) or any equivalent subset.
* @param maxMetaBytes - the serialized metadata budget.
* @returns the card metadata.
*/
function globSearchMeta(page, maxMetaBytes) {
	return capMetaBytes({
		shape: "paths",
		paths: [...page.items],
		truncated: page.truncated,
		total: page.seen
	}, maxMetaBytes);
}
/**
* Format one capped `glob` page in the flat (head) style, mirroring the host
* suite's private `formatGlobPage`.
* @param items - the page shown inline.
* @param seen - how many paths the complete result holds.
* @param spillRef - the saved complete-result reference, or undefined when unsaved.
* @returns the model-facing text.
*/
function formatGlobPage(items, seen, spillRef) {
	const recovery = spillRef !== void 0 ? `Full sorted result stored at: ${spillRef.locator}. ${spillRef.retrievalHint}` : "The complete result could not be saved; narrow pattern or path to see more.";
	return `${items.join("\n")}\n\n(Showing ${items.length} of ${seen} paths. ${recovery})`;
}
/**
* Normalize a spill reference for rendering.
*
* The canonical value is validated against the tool's output schema, and a
* backend's `SpillRef` carries fields of its own (`@deepseek-ai/dsh-spill`'s
* `SpillRef` is `{locator, bytes, retrievalHint}`), so the schema cannot close
* the object. This keeps the renderer's contract to the two fields it reads and
* survives a backend that omits the hint.
* @param spill - the backend's reference, as returned into the canonical value.
* @returns a render-ready reference, or undefined when there is nothing to name.
*/
function normalizeSpill(spill) {
	if (spill === void 0 || spill === null) return void 0;
	const locator = spill.locator;
	if (typeof locator !== "string" || locator === "") return void 0;
	const retrievalHint = spill.retrievalHint;
	return {
		...spill,
		locator,
		retrievalHint: typeof retrievalHint === "string" ? retrievalHint : ""
	};
}
/**
* The spill reference's schema: an object whose extra fields are the backend's
* business. Requiring only what the footer prints keeps a version's `SpillRef`
* (which carries `bytes` too, and is branded) from failing the tool's own output
* validation — which is why `additionalProperties` is `true` here.
*/
const SPILL_SCHEMA = {
	type: "object",
	additionalProperties: true,
	properties: {
		locator: { type: "string" },
		retrievalHint: { type: "string" }
	}
};
/**
* Format one `glob` result exactly as the host suite's private `renderGlobPaths`
* does: whole when within the cap, else the modification-time head or the
* top-level sample, with the same footer.
* @param paths - the complete display-path list, in modification-time order.
* @param caps - the inline cap and the sampling switch.
* @param root - the search root in the same display-path space as `paths`.
* @param spillRef - the saved complete-result reference, or undefined when unsaved.
* @returns the model-facing text.
*/
function renderGlobText(paths, caps, root, spillRef) {
	if (paths.length === 0) return "No files found";
	if (paths.length <= caps.maxResults) return paths.join("\n");
	if (!caps.sampleOverCapGlobResults) return formatGlobPage(paths.slice(0, caps.maxResults), paths.length, spillRef);
	return formatGlobOutput(sampleAcrossTopLevel([...paths], caps.maxResults, root), paths.length, spillRef);
}
/**
* The inline page a `glob` card shows, computed the same way {@link renderGlobText}
* computes its model page so text and card never disagree (the host suite's
* private `globCardPage`).
* @param paths - the complete display-path list.
* @param caps - the inline cap and the sampling switch.
* @param root - the search root in the same display-path space as `paths`.
* @returns the page and whether the complete result was capped.
*/
function globCardPage(paths, caps, root) {
	if (paths.length <= caps.maxResults) return {
		items: [...paths],
		truncated: false
	};
	if (!caps.sampleOverCapGlobResults) return {
		items: paths.slice(0, caps.maxResults),
		truncated: true
	};
	return {
		items: sampleAcrossTopLevel([...paths], caps.maxResults, root).items,
		truncated: true
	};
}
/**
* Format one `grep` result exactly as the host suite's private
* `formatRetainedGrep` does, including its zero-match wording.
* @param matches - every match the search returned, with display paths.
* @param caps - the inline caps.
* @param spillRef - the saved complete-result reference, or undefined when unsaved.
* @returns the model-facing text.
*/
function renderGrepText(matches, caps, spillRef) {
	const retained = retainMatches(matches, caps.maxMatches, caps.maxLineBytes);
	if (retained.seen === 0) return "No matches found";
	return formatGrepOutput(retained, spillRef);
}
/**
* Resolve the distribution and Linux workdir one search runs in, mirroring the
* shell and filesystem providers' chain: a WSL UNC cwd carries both, an absolute
* Linux cwd uses the configured distribution (then the host default).
* @param cwd - the calling session's cwd.
* @param configured - the world's configured distribution, when any.
* @returns the target, or undefined when the cwd is not in a WSL world.
*/
function resolveTarget(cwd, configured) {
	if (cwd === void 0 || cwd === "") return void 0;
	const unc = parseWslUnc(cwd);
	if (unc !== null) {
		const linuxCwd = unc.linuxPath === "" ? "/" : unc.linuxPath;
		const username = getWorkspaceUsername(cwd);
		return {
			distro: unc.distro,
			linuxCwd,
			...username === void 0 ? {} : { username }
		};
	}
	if (!isAbsoluteLinuxPath(cwd)) return void 0;
	const distro = configured !== void 0 && configured.trim() !== "" ? configured.trim() : defaultDistroSync();
	if (distro === void 0 || distro === "") return void 0;
	return {
		distro,
		linuxCwd: cwd
	};
}
/**
* Express a model-supplied search target in Linux coordinates: a WSL UNC path
* becomes its Linux form, a Windows drive path becomes its `/mnt/<drive>` form
* (the same translation the file tools apply, so `grep path='D:\proj'` searches
* what `read D:\proj\a.ts` reads), and everything else — absolute, relative,
* empty — is used as typed and resolved by the distribution against the session
* workdir.
* @param path - the tool call's `path`, when given.
* @returns the script's `target` parameter.
*/
function linuxTarget(path) {
	if (path === void 0) return "";
	const unc = parseWslUnc(path);
	if (unc !== null) return unc.linuxPath === "" ? "/" : unc.linuxPath;
	return windowsToMntPath(path) ?? path;
}
/**
* Build the `wsl.exe` argv for one search. Values ride as positional parameters
* after the fixed script, so nothing the model typed is ever parsed by a shell.
* @param target - where to run.
* @param script - the fixed script.
* @param values - the script's positional parameters.
* @returns the complete argv vector.
*/
function buildWslArgv(target, script, values) {
	return [
		"-d",
		target.distro,
		...target.username === void 0 ? [] : ["-u", target.username],
		"--cd",
		target.linuxCwd,
		"-e",
		"bash",
		"-c",
		script,
		SCRIPT_ARGV0,
		...values
	];
}
/**
* Run one fixed script inside the distribution.
*
* Errors stay in the host suite's two domains: a spawn failure (a missing
* `wsl.exe`) rejects, while every completed or killed run comes back for the
* caller to classify.
* @param argv - the complete `wsl.exe` argv.
* @param wslPath - the executable to run.
* @param timeoutMs - the hard kill deadline.
* @param rawOutputMaxBytes - the stdout budget the script already bounded.
* @param signal - caller cancellation.
* @returns the run outcome.
*/
function runInDistro(argv, wslPath, timeoutMs, rawOutputMaxBytes, signal) {
	return new Promise((settle, fail) => {
		execFile(wslPath, [...argv], {
			maxBuffer: rawOutputMaxBytes + 1048576,
			encoding: "buffer",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
			windowsHide: true,
			...signal === void 0 ? {} : { signal }
		}, (error, stdout, stderr) => {
			const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
			const err = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "");
			if (error === null || error === void 0) {
				settle({
					code: 0,
					stdout: out,
					stderr: err,
					aborted: false,
					signal: null
				});
				return;
			}
			const aborted = error.name === "AbortError";
			const code = typeof error.code === "number" ? error.code : null;
			const killSignal = error.signal ?? null;
			if (code === null && !aborted && killSignal === null) {
				fail(error);
				return;
			}
			settle({
				code,
				stdout: out,
				stderr: err,
				aborted,
				signal: killSignal
			});
		});
	});
}
/**
* Classify one completed run into raw stdout or a `SEARCH_*` failure, using the
* host suite's error vocabulary so retry/permission layers branch identically.
*
* The two engines disagree on exit 1: it is grep's "searched, found nothing",
* while `find` returns non-zero when it could not read the target at all — which
* must not be reported as an empty directory.
* @param run - the completed run.
* @param toolName - `grep` or `glob`, for the message.
* @param rawOutputMaxBytes - the budget the script bounded stdout to.
* @returns the raw stdout bytes.
*/
function acceptRun(run, toolName, rawOutputMaxBytes) {
	if (run.aborted || run.signal !== null) throw new SearchError(`${toolName} was cancelled or timed out before it finished`, "SEARCH_ABORTED");
	if (run.stdout.length > rawOutputMaxBytes) throw new SearchError(`${toolName} produced more than ${rawOutputMaxBytes} bytes of raw output; narrow pattern or path`, "SEARCH_RAW_OUTPUT_OVERFLOW");
	const code = run.code ?? -1;
	if (code === 0 || code === 1 && toolName === "grep") return run.stdout;
	const stderrText = decodeWslOutput(run.stderr);
	const firstLine = (text) => text.trim().split("\n")[0] ?? "";
	const detail = (firstLine(stderrText) === "" ? firstLine(decodeWslOutput(run.stdout)) : firstLine(stderrText)).slice(0, 300);
	if (code === 2 && toolName === "grep" && INVALID_PATTERN.test(stderrText)) throw new SearchError(`${toolName} pattern rejected by the distribution's grep${detail === "" ? "" : `: ${detail}`}`, "SEARCH_INVALID_PATTERN");
	if (code === 3) throw new SearchError(`${toolName} needs a GNU grep inside the distribution${detail === "" ? "" : ` (${detail})`}`, "SEARCH_FAILED");
	if (code === 127) throw new SearchError(`${toolName} could not start its search command inside the distribution${detail === "" ? "" : `: ${detail}`}`, "SEARCH_FAILED");
	throw new SearchError(`${toolName} search failed inside the distribution (exit ${code})${detail === "" ? "" : `: ${detail}`}`, "SEARCH_FAILED");
}
/**
* Register the `grep` and `glob` tools plus their system-prompt guidance.
*
* Both keep the host suite's split of responsibilities: `execute` returns the
* complete canonical value (display paths included) and may spill it, `render`
* applies the inline caps and formats, and `presentationMeta` projects the search
* card from the same retained page so text and card agree.
* @param ctx - plugin context; registrations are effects scoped to it.
* @param config - plugin configuration; a row without a `config:` block mounts
*   this plugin with none, and {@link DEFAULTS} then supplies every knob.
*/
function apply(ctx, config) {
	const resolved = {
		...DEFAULTS,
		...config,
		...resolveRpcConfig(config)
	};
	const tools = ctx.get("tools");
	if (tools === void 0) return;
	const runtime = createSearchRunner(ctx, resolved);
	const measured = timedTools(tools, runtime.metrics);
	registerGrep(ctx, measured, resolved, runtime.run);
	registerGlob(ctx, measured, resolved, runtime.run);
	registerGuidance(ctx);
}
/** The exact existing tool protocol stays above this replaceable execution seam. */
function createSearchRunner(ctx, config) {
	const owned = typeof ctx.effect === "function";
	if (!owned && config.transport === "persistent") throw new Error("wsl-search: persistent transport needs a host effect scope");
	const pool = owned && config.transport !== "oneshot" ? new WslRpcPool({
		idleMs: config.idleMs,
		metrics: config.metrics
	}) : void 0;
	const metrics = pool?.metrics ?? new RpcMetrics(config.metrics);
	if (owned) ctx.effect(() => {
		const unregister = registerRpcDiagnostics(() => ({
			mode: config.transport,
			effectiveMode: pool ? config.transport : "oneshot",
			...pool ? pool.diagnostics() : {
				workers: 0,
				launches: 0,
				pending: 0,
				metrics: metrics.snapshot()
			}
		}));
		return () => {
			unregister();
			pool?.dispose();
		};
	});
	const once = async (target, op, values, signal, timeout = config.timeoutMs) => {
		const start = performance.now();
		let outcome = "error";
		try {
			const result = await runInDistro(buildWslArgv(target, op === "grep" ? GREP_SCRIPT : GLOB_SCRIPT, values), config.wslPath, timeout, config.rawOutputMaxBytes, signal);
			outcome = result.aborted ? "aborted" : result.stdout.length > config.rawOutputMaxBytes ? "overflow" : result.code === 0 || op === "grep" && result.code === 1 ? "ok" : "error";
			return result;
		} finally {
			metrics.record(`oneshot.${op}`, performance.now() - start, outcome);
		}
	};
	let warned = false;
	const run = async (target, op, values, signal) => {
		if (!pool) return once(target, op, values, signal);
		const where = {
			...target,
			wslPath: config.wslPath
		};
		const request = {
			op,
			args: values,
			timeoutMs: config.timeoutMs,
			maxBytes: config.rawOutputMaxBytes,
			...signal === void 0 ? {} : { signal }
		};
		try {
			if (config.transport === "persistent") return await pool.run(where, request);
			return await pool.runAuto(where, request, (remaining, reason) => {
				if (!warned) {
					warned = true;
					console.warn(`wsl-search: persistent startup unavailable; using oneshot: ${reason}`);
				}
				return once(target, op, values, signal, remaining);
			});
		} catch (error) {
			if (error instanceof RpcTransportError) throw new SearchError(error.message, error.code === "RPC_ABORTED" ? "SEARCH_ABORTED" : "SEARCH_FAILED");
			throw error;
		}
	};
	return {
		run,
		metrics
	};
}
/** Measure actual tool execution (including parsing/filtering/spill), without changing its returned schema. */
function timedTools(tools, metrics) {
	return { register(value) {
		const tool = value;
		tools.register({
			...tool,
			async execute(...args) {
				const start = performance.now();
				let outcome = "ok";
				try {
					return await tool.execute(...args);
				} catch (error) {
					const code = error?.code ?? "";
					outcome = code.includes("ABORT") ? "aborted" : code.includes("OVERFLOW") ? "overflow" : "error";
					throw error;
				} finally {
					metrics.record(`tool.${tool.name}`, performance.now() - start, outcome);
				}
			}
		});
	} };
}
/**
* Register the model-facing `grep` tool.
* @param ctx - plugin context.
* @param tools - the tool registry.
* @param config - resolved configuration.
*/
function registerGrep(ctx, tools, config, executeSearch) {
	const caps = {
		maxMatches: config.grepMaxMatches,
		maxLineBytes: config.grepMaxLineBytes,
		maxMetaBytes: config.searchMetaMaxBytes
	};
	const tool = defineTool({
		name: "grep",
		description: `Search file contents inside this WSL distribution with a GNU grep extended regular expression. Returns matching lines with line numbers, grouped by file. Returns the first ${caps.maxMatches} matches inline; a capped result reports where the complete match list was saved. Use read on a matched file for surrounding context.`,
		parameters: {
			pattern: {
				type: "string",
				required: true,
				description: "Regular expression to search for (GNU grep -E syntax: \\d, \\w, \\b and (?i) work; lookaround and backreferences do not)."
			},
			path: {
				type: "string",
				description: "File or Linux path to search. Defaults to the session workspace; a relative path resolves against it."
			},
			include: {
				type: "string",
				description: "One glob filter on file names for which files to search (e.g. \"*.ts\", \"*.{js,jsx}\"). A filter containing \"/\" is matched against the path relative to the search root. Not a list; negation is not supported."
			}
		},
		timeoutMs: config.timeoutMs,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					matches: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								path: {
									type: "string",
									required: true
								},
								lineNumber: {
									type: "integer",
									required: true
								},
								line: {
									type: "string",
									required: true
								}
							}
						}
					},
					spill: SPILL_SCHEMA
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: renderGrepText(value.matches, caps, normalizeSpill(value.spill))
			}],
			presentationMeta: (_args, value) => grepSearchMeta(retainMatches(value.matches, caps.maxMatches, caps.maxLineBytes), caps.maxMetaBytes)
		},
		async execute(args, exec) {
			const input = parseGrepArgs(args);
			const target = resolveTarget(exec.agent?.session.header.cwd, config.distro);
			if (target === void 0) throw new SearchError("grep is only available in a WSL workspace session", "SEARCH_FAILED");
			const globs = expandBraces(input.include ?? "");
			const pathShaped = globs.filter((glob) => glob.includes("/"));
			const matchers = pathShaped.map(compileGlob);
			const matches = parseGrepRecords(acceptRun(await executeSearch(target, "grep", [
				input.pattern,
				pathShaped.length > 0 ? "" : globs.join("\n"),
				linuxTarget(input.path),
				String(config.rawOutputMaxBytes + 1),
				...pathShaped.length > 0 ? basenameFilters(pathShaped, true) : []
			], exec.signal), "grep", config.rawOutputMaxBytes)).filter((record) => {
				if (pathShaped.length === 0) return true;
				const relative = posix.relative(target.linuxCwd, record.path);
				const candidate = relative.startsWith("..") ? record.path : relative;
				return matchers.some((matches) => matches(candidate));
			}).map((record) => ({
				path: displayPath(record.path, target.linuxCwd),
				lineNumber: record.lineNumber,
				line: record.line
			}));
			if (matches.length <= caps.maxMatches) return { matches };
			const previewed = matches.map((match) => ({
				...match,
				line: previewLine(match.line, caps.maxLineBytes)
			}));
			const spill = await trySaveFormattedResult(ctx, exec, "grep-results.txt", `Found ${matches.length} matches\n\n${formatGrepMatches(previewed)}`);
			return spill === void 0 ? { matches } : {
				matches,
				spill
			};
		},
		presentCall: presentGrepCall,
		presentResult: presentGrepResult
	});
	tools.register(tool);
}
/**
* Register the model-facing `glob` tool.
* @param ctx - plugin context.
* @param tools - the tool registry.
* @param config - resolved configuration.
*/
function registerGlob(ctx, tools, config, executeSearch) {
	const caps = {
		maxResults: config.globMaxResults,
		sampleOverCapGlobResults: config.sampleOverCapGlobResults
	};
	const overCap = caps.sampleOverCapGlobResults ? `a larger result instead returns ${caps.maxResults} paths sampled across top-level entries` : `a larger result returns the first ${caps.maxResults} paths in modification-time order`;
	const tool = defineTool({
		name: "glob",
		description: `Find files inside this WSL distribution whose paths match a glob pattern. Returns matching file paths — never directories — including hidden and ignored files (VCS metadata directories are excluded). Up to ${caps.maxResults} paths come back in modification-time order (oldest first); ${overCap}, says so, and reports where the complete sorted list was saved. This tool does not enumerate directory entries.`,
		parameters: {
			pattern: {
				type: "string",
				required: true,
				description: "Glob pattern to match file paths against (e.g. \"**/*.ts\", \"src/**/*.test.js\"). A pattern with no \"/\" matches the basename at any depth, so \"*\" and \"*.ts\" both search the whole tree; include a separator to anchor the depth. A leading \"!\" negates the pattern."
			},
			path: {
				type: "string",
				description: "Directory to search in. Defaults to the session workspace; a relative path resolves against it."
			}
		},
		timeoutMs: config.timeoutMs,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					root: {
						type: "string",
						required: true
					},
					paths: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					spill: SPILL_SCHEMA
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: renderGlobText(value.paths, caps, value.root, normalizeSpill(value.spill))
			}],
			presentationMeta: (_args, value) => {
				const page = globCardPage(value.paths, caps, value.root);
				return globSearchMeta({
					items: page.items,
					truncated: page.truncated,
					seen: value.paths.length
				}, config.searchMetaMaxBytes);
			}
		},
		async execute(args, exec) {
			const input = parseGlobArgs(args);
			const target = resolveTarget(exec.agent?.session.header.cwd, config.distro);
			if (target === void 0) throw new SearchError("glob is only available in a WSL workspace session", "SEARCH_FAILED");
			const listing = parseGlobRecords(acceptRun(await executeSearch(target, "glob", [
				linuxTarget(input.path),
				String(config.rawOutputMaxBytes + 1),
				...basenameFilters([input.pattern])
			], exec.signal), "glob", config.rawOutputMaxBytes));
			const rootAbsolute = listing.root === "" ? target.linuxCwd : listing.root;
			const matches = compileGlob(input.pattern);
			const selected = listing.files.filter((file) => {
				const relative = posix.relative(rootAbsolute, file.path);
				return matches(relative === "" ? posix.basename(file.path) : relative);
			});
			selected.sort(listing.mode === "gnu" ? (left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path) : (left, right) => left.path.localeCompare(right.path));
			const root = input.path === void 0 ? "." : displayPath(rootAbsolute, target.linuxCwd);
			const paths = [];
			for (const file of selected) paths.push(displayPath(file.path, target.linuxCwd));
			if (paths.length <= caps.maxResults) return {
				root,
				paths
			};
			const spill = await trySaveFormattedResult(ctx, exec, "glob-results.txt", paths.join("\n"));
			return spill === void 0 ? {
				root,
				paths
			} : {
				root,
				paths,
				spill
			};
		},
		presentCall: presentGlobCall,
		presentResult: presentGlobResult
	});
	tools.register(tool);
}
/**
* Register the tools' scope-aware system-prompt guidance, mirroring the host
* suite's sections. Best-effort: a release whose `systemPrompt` surface differs
* loses the hint, never the tools.
* @param ctx - plugin context.
*/
function registerGuidance(ctx) {
	const systemPrompt = ctx.get("systemPrompt");
	if (systemPrompt === void 0 || typeof systemPrompt.section !== "function") return;
	const order = (name) => {
		try {
			return systemPrompt.getSectionOrder?.(name);
		} catch {
			return;
		}
	};
	try {
		systemPrompt.section({
			name: "tool:grep",
			order: order("TOOL_GREP"),
			text: () => "Use the grep tool — not shell grep or rg — to search file contents inside this WSL workspace. Use read on a matched file when you need surrounding context."
		});
		systemPrompt.section({
			name: "tool:glob",
			order: order("TOOL_GLOB"),
			text: () => "Use the glob tool — not shell find — to discover files by path pattern inside this WSL workspace. A pattern with no \"/\" matches basenames at any depth, so \"*\" matches every file in the tree rather than its top level. Results are files only, never directories."
		});
	} catch {}
}
//#endregion
export { Config, WslRpcPool, apply, apply as default, buildWslArgv, capMetaBytes, displayPath, expandBraces, globCardPage, globSearchMeta, globToRegExp, grepSearchMeta, inject, linuxTarget, matchGlob, normalizeSpill, parseGlobRecords, parseGrepRecords, rpcDiagnostics as performanceSnapshot, readMetadata, registerGuidance, renderGlobText, renderGrepText, resolveTarget, retainMatches, retainPaths };

//# sourceMappingURL=wsl-search.js.map