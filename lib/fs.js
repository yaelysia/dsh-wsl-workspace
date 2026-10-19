import { r as registerRpcDiagnostics } from "./rpc-metrics-A9FocmpU.js";
import { a as joinUnc, c as parseWslUnc, n as isAbsoluteLinuxPath, o as mntToWindowsPath, r as isValidWslUsername, u as windowsToMntPath } from "./paths-CkIGMcuV.js";
import { a as resolveFileConfig, i as nativeKey, r as nativeCoordinate, t as resolveLinuxSymlink } from "./links-B0zBokRp.js";
import { r as defaultDistroSync, u as getWorkspaceUsername } from "./wsl-CWw3IAkU.js";
import { n as WslRpcPool, r as decodeRpcBytes, t as RpcTransportError } from "./rpc-transport-CgugYHF1.js";
import z from "@deepseek-ai/schemastery";
import { link, lstat, rename } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { FsError, FsTargetKey, FsVersion } from "@deepseek-ai/dsh-fs";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { canonicalPath, writableRoots } from "@deepseek-ai/dsh-sandbox";
import { performance } from "node:perf_hooks";
//#region src/shared/native-files.ts
/** Typed consumer of the shared RPC. No host package at runtime; the provider maps its errors. */
const NATIVE_MAX_BYTES = 16777216;
const REPLY_MAX_BYTES = 67108864;
const FILE_CODES = /* @__PURE__ */ new Set([
	"FS_NOT_FOUND",
	"FS_NOT_DIRECTORY",
	"FS_NOT_TEXT",
	"FS_NOT_REGULAR_FILE",
	"FS_TOO_LARGE",
	"FS_PERMISSION_DENIED",
	"FS_SANDBOX_DENIED",
	"FS_IO_ERROR",
	"FS_STALE_VERSION",
	"FS_NOT_OBSERVED",
	"FS_AMBIGUOUS_EDIT",
	"FS_EDIT_NOT_FOUND",
	"FS_ABORTED"
]);
var NativeFileError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "NativeFileError";
	}
};
function invalid(message = "invalid native file response") {
	throw new NativeFileError("FS_IO_ERROR", message);
}
function validPath(value) {
	return typeof value === "string" && value.startsWith("/") && !value.includes("\0");
}
function isInfo(value) {
	const row = value;
	return !!row && typeof row.version === "string" && row.version.length > 0 && [
		"file",
		"directory",
		"symlink",
		"other"
	].includes(row.type) && Number.isSafeInteger(row.size) && row.size >= 0;
}
function decodeNativeText(bytes) {
	if (bytes.subarray(0, 8192).includes(0)) throw new NativeFileError("FS_NOT_TEXT", "binary file");
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new NativeFileError("FS_NOT_TEXT", "invalid UTF-8 text");
	}
}
/** All mutations are one Linux transaction, not read in Windows and a blind write later. */
var NativeFileClient = class {
	pool;
	constructor(pool) {
		this.pool = pool;
	}
	async call(target, op, payload, options = {}) {
		const started = performance.now();
		let outcome = "error";
		const mutating = op === "fs.write" || op === "fs.edit";
		try {
			const run = await this.pool.run(target, {
				op,
				args: [JSON.stringify({
					...payload,
					replyLimit: REPLY_MAX_BYTES
				})],
				timeoutMs: options.timeoutMs ?? 3e4,
				maxBytes: REPLY_MAX_BYTES,
				...options.signal === void 0 ? {} : { signal: options.signal }
			});
			if (run.aborted) throw new NativeFileError("FS_ABORTED", "file operation cancelled before execution");
			if (run.stdout.length > REPLY_MAX_BYTES) throw new NativeFileError(mutating ? "FS_IO_ERROR" : "FS_TOO_LARGE", mutating ? "file mutation result unknown; re-read before retrying" : "file response exceeds its byte limit");
			let response;
			try {
				response = JSON.parse(run.stdout.toString("utf8"));
			} catch {
				invalid(mutating ? "file mutation result unknown; re-read before retrying" : void 0);
			}
			if (!response || typeof response.ok !== "boolean" || typeof response.committed !== "boolean") invalid(mutating ? "file mutation result unknown; re-read before retrying" : void 0);
			if (!response.ok) {
				if (response.committed) invalid("file was published but its receipt failed; re-read before retrying");
				if (!FILE_CODES.has(response.code ?? "") || typeof response.message !== "string") invalid(mutating ? "file mutation result unknown; re-read before retrying" : void 0);
				throw new NativeFileError(response.code, response.message);
			}
			if (run.code !== 0 || mutating !== response.committed) invalid(mutating ? "file mutation result unknown; re-read before retrying" : void 0);
			outcome = "ok";
			return response.value;
		} catch (error) {
			if (error instanceof NativeFileError) {
				if (error.code === "FS_ABORTED") outcome = "aborted";
				if (error.code === "FS_TOO_LARGE") outcome = "overflow";
			}
			if (error instanceof RpcTransportError && error.code === "RPC_ABORTED") {
				outcome = "aborted";
				throw new NativeFileError("FS_ABORTED", error.message);
			}
			if (error instanceof RpcTransportError && error.code === "RPC_TOO_LARGE") {
				outcome = "overflow";
				throw new NativeFileError("FS_TOO_LARGE", error.message);
			}
			throw error;
		} finally {
			this.pool.metrics.record(`file.${op.slice(3)}`, performance.now() - started, outcome);
		}
	}
	async resolve(target, path, options) {
		const result = await this.call(target, "fs.resolve", { path }, options);
		if (!result || !validPath(result.path)) invalid();
		return result.path;
	}
	async stat(target, path, nofollow = false, options) {
		const result = await this.call(target, nofollow ? "fs.lstat" : "fs.stat", { path }, options);
		if (result === null) return void 0;
		if (!isInfo(result)) invalid();
		return result;
	}
	async read(target, path, maxBytes = NATIVE_MAX_BYTES, options) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new NativeFileError("FS_TOO_LARGE", "invalid byte limit");
		const result = await this.call(target, "fs.read", {
			path,
			maxBytes: Math.min(maxBytes, NATIVE_MAX_BYTES)
		}, options);
		return this.bytes(result, Math.min(maxBytes, NATIVE_MAX_BYTES));
	}
	async range(target, path, offset, length, version, options) {
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 16777216) throw new NativeFileError("FS_TOO_LARGE", "invalid or excessive byte range");
		const result = await this.call(target, "fs.range", {
			path,
			offset,
			maxBytes: length,
			version
		}, options);
		return this.bytes(result, length);
	}
	bytes(value, max) {
		const data = value?.data;
		try {
			return decodeRpcBytes(data, max);
		} catch {
			invalid();
		}
	}
	async list(target, path, options) {
		const rows = await this.call(target, "fs.list", { path }, options);
		if (!Array.isArray(rows) || rows.some((row) => !row || typeof row.name !== "string" || row.name.includes("/") || !validPath(row.path) || (row.version === void 0 ? row.type !== "other" : !isInfo(row)))) invalid();
		return rows.sort((a, b) => a.name.localeCompare(b.name));
	}
	async write(target, path, content, expected, policy, diffBasisMaxBytes, options) {
		const bytes = Buffer.from(content, "utf8");
		if (bytes.length > 16777216) throw new NativeFileError("FS_TOO_LARGE", "native write exceeds 16 MiB");
		return this.receipt(await this.call(target, "fs.write", {
			path,
			content: bytes.toString("base64"),
			expected,
			policy,
			diffBasisMaxBytes
		}, options), false);
	}
	async edit(target, path, edit, version, policy, options) {
		return this.receipt(await this.call(target, "fs.edit", {
			path,
			...edit,
			expected: version === void 0 ? void 0 : {
				kind: "replaceIfVersion",
				version
			},
			policy
		}, options), true);
	}
	receipt(value, editing) {
		const result = value;
		if (!result || typeof result.version !== "string" || !result.version || typeof result.after !== "string" || !(typeof result.before === "string" || !editing && result.before === null) || !editing && result.operation !== "create" && result.operation !== "update") invalid("invalid mutation receipt; re-read before retrying");
		return result;
	}
};
//#endregion
//#region src/fs.ts
/**
* The WSL filesystem backend. Identity keys are canonical UNC paths; the
* Linux form is derived on demand, so both worlds stay in sync across
* aliases and symlinks.
*/
var WslFileSystem = class WslFileSystem extends LocalFileSystem {
	static Config = z.object({
		backend: z.string(),
		idleMs: z.number(),
		metrics: z.boolean(),
		wslPath: z.string(),
		cwd: z.string(),
		distro: z.string(),
		diffBasisMaxBytes: z.number().default(10485760)
	});
	/** Owner-scoped RPC shared by this filesystem and the search provider in the same realm. */
	wslRpcPool;
	nativeClient;
	fileOptions;
	nativeOnThisHost;
	warnedFallback = false;
	distro;
	executionCwd = new AsyncLocalStorage();
	constructor(ctx, config, rpcOptions = {}) {
		super(ctx, config);
		this.distro = config.distro;
		this.fileOptions = resolveFileConfig(config);
		this.nativeOnThisHost = process.platform === "win32" || rpcOptions.launch !== void 0;
		if (typeof ctx.effect === "function") {
			this.wslRpcPool = new WslRpcPool({
				idleMs: this.fileOptions.idleMs,
				metrics: this.fileOptions.metrics,
				...rpcOptions
			});
			this.nativeClient = new NativeFileClient(this.wslRpcPool);
			ctx.effect(() => {
				const unregister = registerRpcDiagnostics(() => ({
					owner: "wsl-filesystem",
					mode: this.fileOptions.backend,
					...this.wslRpcPool.diagnostics()
				}));
				return () => {
					unregister();
					this.wslRpcPool?.dispose();
				};
			});
		} else if (this.fileOptions.backend === "native") throw new FsError("native filesystem requires a host disposal scope", "FS_IO_ERROR");
		ctx.on("tools/execute", (exec, next) => this.executionCwd.run(exec.agent?.session.header.cwd, next));
		this.internals = {
			linkFile: WslFileSystem.publishNoReplace,
			replaceFile: WslFileSystem.replaceOverWrite,
			copyFileDacl: WslFileSystem.skipDaclCopy
		};
	}
	/**
	* No-replace publication for filesystems without hard links. A real
	* collision (a concurrent external creator won) must still surface as the
	* original EEXIST so the guarded-create failure path classifies it; an
	* absent target falls back to rename, which on Windows publishes without
	* replacing anything. Safe against this backend's own writers because the
	* per-target lock serializes them.
	* @param tempPath - the staged file.
	* @param destPath - the destination to create.
	*/
	static async publishNoReplace(tempPath, destPath) {
		try {
			await link(tempPath, destPath);
			return;
		} catch (error) {
			let exists = false;
			try {
				await lstat(destPath);
				exists = true;
			} catch {}
			if (exists) throw error;
			await rename(tempPath, destPath);
		}
	}
	/**
	* Security-preserving replacement boundary: Windows rename replaces an
	* existing destination atomically; no DACL preservation is needed over 9P.
	* @param destPath - the file being replaced.
	* @param tempPath - the staged replacement.
	*/
	static async replaceOverWrite(destPath, tempPath) {
		await rename(tempPath, destPath);
	}
	/** 9P files inherit their directory's DACL; nothing to preserve. */
	static async skipDaclCopy() {}
	/** Translate a model/plugin path into Windows-side coordinates. */
	translate(path, cwd) {
		const unc = parseWslUnc(path);
		if (unc !== null) return {
			input: joinUnc(unc.distro, unc.linuxPath),
			cwd: this.cwdOr(cwd)
		};
		if (isAbsoluteLinuxPath(path)) {
			const win = mntToWindowsPath(path);
			if (win !== null) return {
				input: win,
				cwd: this.cwdOr(cwd)
			};
			return {
				input: joinUnc(this.distroFor(cwd), path),
				cwd: this.cwdOr(cwd)
			};
		}
		if (windowsToMntPath(path) !== null) return {
			input: path,
			cwd: this.cwdOr(cwd)
		};
		return {
			input: path,
			cwd: this.uncCwd(cwd)
		};
	}
	/** A base for absolute inputs (unused by resolution, but the parent needs one). */
	cwdOr(cwd) {
		return cwd ?? this.executionCwd.getStore() ?? this.config.cwd ?? process.cwd();
	}
	uncCwd(cwd) {
		const base = cwd ?? this.executionCwd.getStore() ?? this.config.cwd;
		if (base === void 0 || base === "") throw new FsError("wsl-fs: no cwd and no configured base for relative resolution", "FS_IO_ERROR");
		const unc = parseWslUnc(base);
		if (unc !== null) return joinUnc(unc.distro, unc.linuxPath);
		if (isAbsoluteLinuxPath(base)) return joinUnc(this.distroFor(base), base);
		if (windowsToMntPath(base) !== null) return base;
		throw new FsError(`wsl-fs: cwd "${base}" is not in the WSL execution world`, "FS_IO_ERROR");
	}
	/**
	* Resolve the distribution an absolute Linux path opens inside. The chain:
	* the caller cwd when it is a WSL UNC path, then the current tool
	* execution's session cwd, then the configured `distro`,
	* then the host's default distribution from the Lxss registry. The registry
	* fallback is reserved for calls that genuinely have no session.
	*/
	distroFor(cwd) {
		const fromCwd = parseWslUnc(cwd ?? "");
		if (fromCwd !== null) return fromCwd.distro;
		const fromExecution = parseWslUnc(this.executionCwd.getStore() ?? "");
		if (fromExecution !== null) return fromExecution.distro;
		const distro = this.distro;
		if (distro !== void 0 && distro !== "") return distro;
		const fallback = defaultDistroSync();
		if (fallback !== void 0) return fallback;
		throw new FsError("wsl-fs: Linux path carries no distribution and none is configured", "FS_IO_ERROR");
	}
	/** The Linux display path for a resolved Windows-side path. */
	linuxDisplay(raw) {
		const unc = parseWslUnc(raw);
		if (unc !== null) return unc.linuxPath;
		const mnt = windowsToMntPath(raw);
		if (mnt !== null) return mnt;
		throw new FsError(`wsl-fs: resolved path "${raw}" is outside the WSL execution world`, "FS_IO_ERROR");
	}
	coordinateForPath(path, cwd) {
		if (!this.nativeOnThisHost || this.fileOptions.backend === "unc" || !this.nativeClient) return void 0;
		const base = this.cwdOr(cwd);
		const unc = parseWslUnc(path);
		const baseUnc = parseWslUnc(base);
		if (windowsToMntPath(path) !== null || unc === null && mntToWindowsPath(path) !== null) return void 0;
		const distro = unc?.distro ?? baseUnc?.distro ?? (isAbsoluteLinuxPath(base) || isAbsoluteLinuxPath(path) ? this.distroFor(cwd) : void 0);
		if (distro === void 0) return void 0;
		const linuxPath = unc?.linuxPath ?? (isAbsoluteLinuxPath(path) ? path : baseUnc !== null ? `${baseUnc.linuxPath}/${path}` : `${base}/${path}`);
		if (mntToWindowsPath(linuxPath) !== null) return void 0;
		const username = getWorkspaceUsername(base);
		if (username !== void 0 && !isValidWslUsername(username)) throw new FsError("invalid configured WSL username", "FS_IO_ERROR");
		return {
			distro,
			path: linuxPath,
			...username === void 0 ? {} : { username }
		};
	}
	/** Share only when lifecycle/metrics policy agrees; an explicit consumer override stays effective. */
	rpcPoolFor(options) {
		return options.idleMs === this.fileOptions.idleMs && options.metrics === this.fileOptions.metrics ? this.wslRpcPool : void 0;
	}
	rpcTarget(where) {
		return {
			distro: where.distro,
			linuxCwd: "/",
			wslPath: this.fileOptions.wslPath,
			...where.username === void 0 ? {} : { username: where.username }
		};
	}
	targetFor(where) {
		return {
			targetKey: FsTargetKey(nativeKey(where)),
			displayPath: where.path
		};
	}
	async nativeCall(operation) {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof FsError) throw error;
			if (error instanceof NativeFileError) throw new FsError(error.message, error.code, { cause: error });
			throw new FsError(error instanceof Error ? error.message : String(error), "FS_IO_ERROR", { cause: error });
		}
	}
	async resolve(path, opts) {
		if (opts?.signal?.aborted) throw new FsError("resolve aborted", "FS_ABORTED");
		if (path.trim().length === 0) throw new FsError("file_path must be a non-empty string", "FS_NOT_FOUND");
		const where = this.coordinateForPath(path, opts?.cwd);
		if (where === void 0) return this.resolveUnc(path, opts);
		return this.nativeCall(async () => {
			let actual;
			try {
				actual = await this.nativeClient.resolve(this.rpcTarget(where), where.path, opts);
			} catch (error) {
				if (this.fileOptions.backend !== "auto" || where.username !== void 0 || !(error instanceof RpcTransportError) || error.stage !== "startup" || opts?.signal?.aborted) throw error;
				if (!this.warnedFallback) {
					this.warnedFallback = true;
					console.warn("wsl-fs: native startup unavailable; resolving via UNC");
				}
				return this.resolveUnc(path, opts);
			}
			const drive = mntToWindowsPath(actual);
			if (drive !== null) return this.resolveUnc(drive, opts);
			return this.targetFor({
				...where,
				path: actual
			});
		});
	}
	async stat(target, signal) {
		const where = nativeCoordinate(String(target.targetKey));
		if (!where) return super.stat(target, signal);
		return this.nativeCall(async () => {
			const value = await this.nativeClient.stat(this.rpcTarget(where), where.path, false, { signal });
			return value === void 0 ? void 0 : {
				...value,
				type: value.type,
				version: FsVersion(value.version)
			};
		});
	}
	async readText(target, signal) {
		const where = nativeCoordinate(String(target.targetKey));
		if (!where) return super.readText(target, signal);
		return this.nativeCall(async () => decodeNativeText(await this.nativeClient.read(this.rpcTarget(where), where.path, void 0, { signal })));
	}
	async readBytes(target, signal, maxBytes) {
		const where = nativeCoordinate(String(target.targetKey));
		if (!where) return super.readBytes(target, signal, maxBytes);
		return this.nativeCall(() => this.nativeClient.read(this.rpcTarget(where), where.path, maxBytes, { signal }));
	}
	async readByteRange(target, range, signal) {
		const where = nativeCoordinate(String(target.targetKey));
		if (!where) return super.readByteRange(target, range, signal);
		return this.nativeCall(() => this.nativeClient.range(this.rpcTarget(where), where.path, range.offset, range.length, void 0, { signal }));
	}
	async streamText(target, signal) {
		const where = nativeCoordinate(String(target.targetKey));
		if (!where) return super.streamText(target, signal);
		const provider = this;
		return (async function* () {
			const meta = await provider.stat(target, signal);
			if (!meta) throw new FsError("file not found", "FS_NOT_FOUND");
			if (meta.type !== "file") throw new FsError("not a regular file", "FS_NOT_REGULAR_FILE");
			const decoder = new TextDecoder("utf-8", { fatal: true });
			let offset = 0;
			while (true) {
				const chunk = await provider.nativeCall(() => provider.nativeClient.range(provider.rpcTarget(where), where.path, offset, 262144, String(meta.version), { signal }));
				if (offset < 8192 && chunk.subarray(0, 8192 - offset).includes(0)) throw new FsError("binary file", "FS_NOT_TEXT");
				try {
					const decoded = decoder.decode(chunk, { stream: true });
					if (decoded) yield decoded;
				} catch {
					throw new FsError("invalid UTF-8 text", "FS_NOT_TEXT");
				}
				offset += chunk.length;
				if (chunk.length < 262144) break;
			}
			try {
				const tail = decoder.decode();
				if (tail) yield tail;
			} catch {
				throw new FsError("invalid UTF-8 text", "FS_NOT_TEXT");
			}
		})();
	}
	async listDir(target, signal) {
		const where = nativeCoordinate(String(target.targetKey));
		if (!where) return super.listDir(target, signal);
		return this.nativeCall(async () => {
			const rows = await this.nativeClient.list(this.rpcTarget(where), where.path, { signal });
			const entries = [];
			for (const row of rows) {
				if (signal?.aborted) throw new FsError("listDir aborted", "FS_ABORTED");
				const drive = mntToWindowsPath(row.path);
				if (drive === null) {
					entries.push({
						name: row.name,
						type: row.type,
						target: this.targetFor({
							...where,
							path: row.path
						}),
						...row.version === void 0 ? {} : { version: FsVersion(row.version) },
						...row.type === "file" && row.size !== void 0 ? { size: row.size } : {}
					});
					continue;
				}
				const mapped = await this.resolveUnc(drive, signal === void 0 ? void 0 : { signal });
				const info = await super.stat(mapped, signal);
				entries.push({
					name: row.name,
					type: info?.type ?? "other",
					target: mapped,
					...info === void 0 ? {} : { version: info.version },
					...info?.type === "file" ? { size: info.size } : {}
				});
			}
			return entries;
		});
	}
	async watch(target, changed, signal) {
		if (nativeCoordinate(String(target.targetKey))) {
			if (signal.aborted) throw new FsError("watch aborted", "FS_ABORTED");
			throw new FsError("native filesystem watching is not implemented", "FS_IO_ERROR");
		}
		return super.watch(target, changed, signal);
	}
	nativePolicy(where, perCall) {
		const policy = this.sandboxPolicy(perCall);
		if (policy === void 0) return void 0;
		const roots = this.writableRoots(policy).flatMap((root) => {
			const unc = parseWslUnc(root);
			if (unc !== null) return unc.distro.toLowerCase() === where.distro.toLowerCase() ? [unc.linuxPath] : [];
			const drive = windowsToMntPath(root);
			return drive !== null ? [drive] : isAbsoluteLinuxPath(root) ? [root] : [];
		});
		if (policy.mode === "workspace-write") roots.push("/tmp");
		return {
			mode: policy.mode,
			roots
		};
	}
	async resolveUnc(path, opts) {
		if (opts?.signal?.aborted) throw new FsError("resolve aborted", "FS_ABORTED");
		const { input, cwd } = this.translate(path, opts?.cwd);
		const resolved = {
			cwd,
			...opts?.signal !== void 0 ? { signal: opts.signal } : {}
		};
		let local;
		try {
			local = await super.resolve(input, resolved);
		} catch (error) {
			const real = await this.linkAwarePath(input, input);
			if (real === void 0) throw error;
			return this.wslTarget(await super.resolve(real, resolved));
		}
		const real = await this.linkAwarePath(input, String(local.targetKey));
		if (real === void 0) return this.wslTarget(local);
		return this.wslTarget(await super.resolve(real, resolved));
	}
	/** Wrap a locally resolved target in this world's Linux-facing identity. */
	wslTarget(local) {
		return {
			targetKey: local.targetKey,
			displayPath: this.linuxDisplay(String(local.displayPath))
		};
	}
	/**
	* The real path a link-aware lookup must use, or `undefined` when the input
	* needs no help. Only a path this share cannot already describe pays for a
	* `wsl.exe` lookup: an existing file or directory resolves directly, while a
	* symlink (in the final segment or anywhere above it), a dangling target and
	* a not-yet-created file all ask the distribution, which answers with the
	* same path when nothing was linked.
	* @param input - the translated input or resolved identity to inspect.
	* @param targetKey - the identity the local resolver produced.
	* @returns the distribution's real path when it differs, else `undefined`.
	*/
	async linkAwarePath(input, targetKey) {
		const unc = parseWslUnc(targetKey) ?? parseWslUnc(input);
		if (unc === null) return void 0;
		const asSpelled = joinUnc(unc.distro, unc.linuxPath);
		if (await this.describable(targetKey)) return void 0;
		const real = await resolveLinuxSymlink(asSpelled);
		if (real === void 0) return void 0;
		return real.toLowerCase() === asSpelled.toLowerCase() ? void 0 : real;
	}
	/** Whether this share can describe a Windows-side identity at all. */
	async describable(winPath) {
		return await super.lstat(winPath, {}).catch(() => void 0) !== void 0;
	}
	/**
	* The host file-effect policy for this call: the tool layer's per-call value
	* when it passes one, else the service's own resolution. `undefined` means
	* the deployment mounts no policy at all — the same state as a host
	* filesystem without `fs-sandbox`, so nothing is fenced.
	*/
	sandboxPolicy(perCall) {
		if (isSandboxPolicy(perCall)) return perCall;
		const service = this.sandboxPolicyService();
		if (service === void 0) return void 0;
		try {
			const policy = service.resolve();
			return isSandboxPolicy(policy) ? policy : void 0;
		} catch {
			return;
		}
	}
	/** The policy service this backend reads, when the deployment mounts one. */
	sandboxPolicyService() {
		const service = this.ctx.get("sandboxPolicy");
		return service !== void 0 && typeof service.resolve === "function" ? service : void 0;
	}
	/**
	* The deployment's default sandbox mode — the capability fact the file tool
	* reads to advertise escalation, mirrored from `SandboxedFileSystem`.
	*/
	get sandboxMode() {
		const mode = this.sandboxPolicyService()?.defaultMode;
		return typeof mode === "string" ? mode : void 0;
	}
	/**
	* Fence a mutation by the policy, then hand back the EXACT target to mutate
	* (no check-here-write-there): `read-only` denies, `workspace-write`
	* re-resolves and requires containment under a writable root, and
	* `danger-full-access` passes through. Mirrors
	* `@deepseek-ai/dsh-fs-sandbox`'s `checkedTarget`, including the
	* `FS_SANDBOX_DENIED` code the tool layer renders as a denial.
	* @param target - the resolved target about to be written.
	* @param perCall - the tool layer's per-call policy, when it passes one.
	* @returns the target the mutation must use.
	*/
	async checkedTarget(target, perCall) {
		const policy = this.sandboxPolicy(perCall);
		if (policy === void 0 || policy.mode === "danger-full-access") return target;
		if (policy.mode === "read-only") throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, "FS_SANDBOX_DENIED");
		if (policy.mode !== "workspace-write") return target;
		const fresh = await this.resolveUnc(target.displayPath);
		for (const root of this.writableRoots(policy)) if (this.underRoot(String(fresh.targetKey), root)) return fresh;
		throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, "FS_SANDBOX_DENIED");
	}
	/**
	* The roots a write may land under: the host's rule verbatim
	* (`writableRoots`: the workspace root plus the platform temp areas) plus,
	* in a WSL session, the distribution's own `/tmp` — the temp area of the
	* world this session actually runs in, which the host-side rule cannot name.
	* @param policy - the resolved policy.
	*/
	writableRoots(policy) {
		const roots = writableRoots(policy);
		const workspace = policy.workspaceRoot;
		const unc = workspace === void 0 ? null : parseWslUnc(workspace);
		if (unc !== null) roots.push(joinUnc(unc.distro, "/tmp"));
		return roots;
	}
	/** Whether a canonical target key is a writable root or sits below one. */
	underRoot(targetKey, root) {
		const key = trimTrailing(canonicalPath(targetKey)).toLowerCase();
		const base = trimTrailing(canonicalPath(root)).toLowerCase();
		if (base === "" || base === "/" || key === base) return key === base;
		return key.startsWith(base.endsWith("/") || base.endsWith("\\") ? base : `${base}\\`) || key.startsWith(`${base}/`);
	}
	/** Fence a full-content write by the policy, then delegate to the parent. */
	async writeText(target, content, expected, signal, sandboxPolicy) {
		const where = nativeCoordinate(String(target.targetKey));
		if (!where) return super.writeText(await this.checkedTarget(target, sandboxPolicy), content, expected, signal);
		return this.nativeCall(async () => {
			const value = await this.nativeClient.write(this.rpcTarget(where), where.path, content, expected, this.nativePolicy(where, sandboxPolicy), this.config.diffBasisMaxBytes, { signal });
			return {
				operation: value.operation,
				version: FsVersion(value.version),
				before: value.before,
				after: value.after
			};
		});
	}
	/** Fence an edit by the policy, then delegate to the parent. */
	async editText(target, edit, expected, signal, sandboxPolicy) {
		const where = nativeCoordinate(String(target.targetKey));
		if (!where) return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal);
		return this.nativeCall(async () => {
			const value = await this.nativeClient.edit(this.rpcTarget(where), where.path, edit, expected?.version, this.nativePolicy(where, sandboxPolicy), { signal });
			return {
				version: FsVersion(value.version),
				before: value.before,
				after: value.after
			};
		});
	}
	processPath(target) {
		return this.worldPath(target).linuxPath;
	}
	fileUrl(target) {
		return `file://${this.processPath(target).split("/").map(encodeURIComponent).join("/")}`;
	}
	contains(parent, child) {
		const parentWorld = this.worldPath(parent);
		const childWorld = this.worldPath(child);
		if (parentWorld.distro?.toLowerCase() !== childWorld.distro?.toLowerCase() || parentWorld.username !== childWorld.username) return false;
		const parentPath = parentWorld.linuxPath;
		const childPath = childWorld.linuxPath;
		if (childPath === parentPath) return true;
		return parentPath === "/" ? true : childPath.startsWith(`${parentPath}/`);
	}
	/** One target's (distro, linuxPath) pair for containment; `undefined` distro = Windows world. */
	worldPath(target) {
		const key = String(target.targetKey);
		const native = nativeCoordinate(key);
		if (native) return {
			distro: native.distro,
			linuxPath: native.path,
			...native.username === void 0 ? {} : { username: native.username }
		};
		const unc = parseWslUnc(key);
		if (unc !== null) return {
			distro: unc.distro,
			linuxPath: unc.linuxPath
		};
		const mnt = windowsToMntPath(key);
		if (mnt !== null) return {
			distro: void 0,
			linuxPath: mnt
		};
		throw new FsError(`wsl-fs: target "${target.displayPath}" is outside the WSL execution world`, "FS_IO_ERROR");
	}
	async lstat(path, opts, signal) {
		if (signal?.aborted) throw new FsError("lstat aborted", "FS_ABORTED");
		if (path.trim().length === 0) throw new FsError("file_path must be a non-empty string", "FS_NOT_FOUND");
		const where = this.coordinateForPath(path, opts?.cwd);
		if (where) return this.nativeCall(async () => {
			try {
				const value = await this.nativeClient.stat(this.rpcTarget(where), where.path, true, { signal });
				return value === void 0 ? void 0 : {
					...value,
					version: FsVersion(value.version)
				};
			} catch (error) {
				if (this.fileOptions.backend !== "auto" || where.username !== void 0 || signal?.aborted || !(error instanceof RpcTransportError) || error.stage !== "startup") throw error;
				return this.lstatUnc(path, opts, signal);
			}
		});
		return this.lstatUnc(path, opts, signal);
	}
	async lstatUnc(path, opts, signal) {
		const { input, cwd } = this.translate(path, opts?.cwd);
		const info = await super.lstat(input, { cwd }, signal).catch(() => void 0);
		if (info !== void 0) return info;
		const real = await this.linkAwarePath(input, input);
		if (real === void 0) return info;
		return super.lstat(real, { cwd }, signal);
	}
};
/** Whether a value is a usable file-effect policy. */
function isSandboxPolicy(value) {
	return value !== void 0 && typeof value.mode === "string" && value.mode !== "";
}
/** Strip a trailing separator (keeping the root separator itself). */
function trimTrailing(path) {
	return path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
}
//#endregion
export { WslFileSystem, WslFileSystem as default };

//# sourceMappingURL=fs.js.map