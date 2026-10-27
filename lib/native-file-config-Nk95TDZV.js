import { s as resolveRpcConfig } from "./rpc-metrics-BpoobETe.js";
import { r as isValidWslUsername } from "./paths-BDE1NVOv.js";
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
//#endregion
export { nativeKey as n, resolveFileConfig as r, nativeCoordinate as t };

//# sourceMappingURL=native-file-config-Nk95TDZV.js.map