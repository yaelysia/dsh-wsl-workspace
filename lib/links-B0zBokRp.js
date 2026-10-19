import { s as resolveRpcConfig } from "./rpc-metrics-A9FocmpU.js";
import { a as joinUnc, c as parseWslUnc, n as isAbsoluteLinuxPath, r as isValidWslUsername } from "./paths-CkIGMcuV.js";
import { i as execFileResult, o as textOf, s as wslExecutableCandidates } from "./wsl-CWw3IAkU.js";
//#region src/shared/native-file-config.ts
/** Native file routing is separate from search's oneshot switch. */
function resolveFileConfig(config = {}, env = process.env) {
	const backend = config.backend ?? env.DSH_WSL_FILE_BACKEND ?? "auto";
	if (![
		"auto",
		"native",
		"unc"
	].includes(backend)) throw new RangeError("wsl-fs: backend must be auto, native, or unc");
	const rpc = resolveRpcConfig({
		transport: "auto",
		idleMs: config.idleMs,
		metrics: config.metrics
	}, env);
	return {
		backend,
		idleMs: rpc.idleMs,
		metrics: rpc.metrics,
		wslPath: config.wslPath ?? "wsl.exe"
	};
}
const PREFIX = "wsl-native:";
/** Opaque keys preserve literal backslashes/case and bind a resolved target to its Linux identity. */
function nativeKey(value) {
	return PREFIX + JSON.stringify([
		value.distro,
		value.username ?? null,
		value.path
	]);
}
function nativeCoordinate(key) {
	if (!key.startsWith(PREFIX)) return void 0;
	let data;
	try {
		data = JSON.parse(key.slice(11));
	} catch {
		throw new Error("invalid native target key");
	}
	if (!Array.isArray(data) || data.length !== 3 || typeof data[0] !== "string" || !data[0] || /[\\/]/.test(data[0]) || data[0] === "." || data[0] === ".." || data[1] !== null && (typeof data[1] !== "string" || !isValidWslUsername(data[1])) || typeof data[2] !== "string" || !data[2].startsWith("/") || data.some((value) => typeof value === "string" && value.includes("\0"))) throw new Error("invalid native target key");
	return {
		distro: data[0],
		path: data[2],
		...data[1] === null ? {} : { username: data[1] }
	};
}
/** How long the distribution may take to answer one `readlink` call. */
const LINK_RESOLVE_TIMEOUT_MS = 1e4;
/**
* Resolve Linux symlinks through the distribution that owns them.
*
* Never throws: a link the distribution cannot resolve (a missing component, a
* stopped distribution, a `readlink` that fails) stays unresolved, and callers
* keep whatever behaviour they had before this fallback existed.
*
* @param uncPaths - the links to resolve, in UNC spelling.
* @param wslPath - the `wsl.exe` executable (absolute or PATH name).
* @returns one entry per input, in order: the resolved real path as a UNC
*   path, or `undefined` when the link or the distribution could not answer.
*/
async function resolveLinuxSymlinks(uncPaths, wslPath = "wsl.exe") {
	const resolved = uncPaths.map(() => void 0);
	let next = 0;
	const workers = Array.from({ length: Math.min(4, uncPaths.length) }, async () => {
		for (let index = next; index < uncPaths.length; index = next) {
			next += 1;
			resolved[index] = await resolveLinuxSymlink(uncPaths[index] ?? "", wslPath);
		}
	});
	await Promise.all(workers);
	return resolved;
}
/**
* Resolve one Linux symlink the share cannot follow.
* @param uncPath - the link, in UNC spelling.
* @param wslPath - the `wsl.exe` executable (absolute or PATH name).
* @returns the real path as a UNC path, or `undefined` when it does not resolve.
*/
async function resolveLinuxSymlink(uncPath, wslPath = "wsl.exe") {
	const unc = parseWslUnc(uncPath);
	if (unc === null || /[\r\n]/.test(unc.linuxPath)) return void 0;
	try {
		for (const candidate of wslExecutableCandidates(wslPath)) try {
			const output = await execFileResult(candidate, [
				"-d",
				unc.distro,
				"--",
				"readlink",
				"-f",
				unc.linuxPath
			], {
				encoding: "utf8",
				timeout: LINK_RESOLVE_TIMEOUT_MS,
				windowsHide: true
			});
			const target = textOf(output.stdout).trim();
			return isAbsoluteLinuxPath(target) ? joinUnc(unc.distro, target) : void 0;
		} catch {}
		return;
	} catch {
		return;
	}
}
//#endregion
export { resolveFileConfig as a, nativeKey as i, resolveLinuxSymlinks as n, nativeCoordinate as r, resolveLinuxSymlink as t };

//# sourceMappingURL=links-B0zBokRp.js.map