import { a as joinUnc, c as parseWslUnc, r as isValidWslUsername, t as canonicalWindowsPath } from "./paths-BDE1NVOv.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
//#region src/shared/wsl-credentials.ts
/**
* Per-workspace WSL credentials (host side only). The dialog stores the
* optional Linux username of a WSL workspace under the harness home; the
* per-session env contributor and the WSL shell executor read it back so
* `wsl.exe -u <username>` can run commands as that user. Keys are canonical
* UNC workspace paths. This module touches node builtins, so the browser
* half never imports it.
* @module dsh-wsl-workspace/shared/wsl-credentials
*/
/** The store file lives under the harness home so both host halves share it. */
function storePath() {
	const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(dshHome, "wsl-workspaces.json");
}
/** Read the store; a missing or corrupt file reads as empty (never throws). */
function readStore() {
	try {
		const parsed = JSON.parse(readFileSync(storePath(), "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed;
	} catch {
		return {};
	}
}
/**
* Canonicalize any accepted WSL UNC spelling into the store's key form.
* @param path - candidate workspace path (either UNC host form).
* @returns the canonical UNC path, or null when the path is not a WSL UNC.
*/
function canonicalWslUnc(path) {
	const parsed = parseWslUnc(path);
	return parsed === null ? null : joinUnc(parsed.distro, parsed.linuxPath);
}
/**
* Read the stored username for a WSL workspace.
* @param uncPath - the workspace path (any accepted WSL UNC spelling).
* @returns the username, or undefined when none is stored.
*/
function getWorkspaceUsername(uncPath) {
	const key = canonicalWslUnc(uncPath);
	if (key === null) return void 0;
	const username = readStore()[key]?.username;
	return username === void 0 || username === "" ? void 0 : username;
}
/**
* Store (or clear) the username of a WSL workspace.
* @param uncPath - the workspace path (any accepted WSL UNC spelling).
* @param username - the username; empty or undefined clears the stored value.
*/
function setWorkspaceUsername(uncPath, username) {
	const key = canonicalWslUnc(uncPath);
	if (key === null) throw new Error("wsl-workspace: workspace path is not a WSL UNC path");
	const store = readStore();
	if (username === void 0 || username.trim() === "") delete store[key];
	else {
		const trimmed = username.trim();
		if (!isValidWslUsername(trimmed)) throw new Error("wsl-workspace: username must match the Linux username pattern [A-Za-z_][A-Za-z0-9_.-]*");
		store[key] = { username: trimmed };
	}
	const path = storePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
}
/**
* Register the WSL distribution (and optional Linux username) of a
* Windows-drive workspace (`/mnt/<drive>` path). Keys are canonical Windows
* drive paths; the per-session env contributor reads the entry back so
* `wsl.exe -d <distro>` can run when the session cwd is a drive path.
* @param winPath - the Windows drive path (any spelling).
* @param distro - the WSL distribution the workspace belongs to.
* @param username - optional Linux username (distro default when absent).
*/
function registerWindowsWorkspace(winPath, distro, username) {
	const key = canonicalWindowsPath(winPath);
	if (key === null) throw new Error("wsl-workspace: workspace path is not a Windows drive path");
	const entry = { distro };
	if (username !== void 0 && username.trim() !== "") {
		const trimmed = username.trim();
		if (!isValidWslUsername(trimmed)) throw new Error("wsl-workspace: username must match the Linux username pattern [A-Za-z_][A-Za-z0-9_.-]*");
		entry.username = trimmed;
	}
	const store = readStore();
	store[key] = entry;
	const path = storePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
}
/**
* Read the stored credentials of a Windows-drive workspace.
* @param winPath - the Windows drive path (any spelling).
* @returns the stored entry, or undefined when none is registered.
*/
function getWindowsWorkspace(winPath) {
	const key = canonicalWindowsPath(winPath);
	if (key === null) return void 0;
	return readStore()[key];
}
/** Every stored workspace key (canonical UNC and Windows drive paths). */
function listWorkspaceKeys() {
	return Object.keys(readStore());
}
/**
* Every stored workspace with its credentials.
*
* The client half needs more than the keys: to translate a file reference it has
* to know which distribution a `/mnt/<drive>` workspace belongs to, because a
* path outside the drive mounts can only be opened through that distribution's
* UNC share. The keys alone cannot say.
* @returns one record per stored workspace.
*/
function listWorkspaceRecords() {
	return Object.entries(readStore()).map(([path, entry]) => {
		const record = { path };
		if (entry.distro !== void 0 && entry.distro !== "") record.distro = entry.distro;
		if (entry.username !== void 0 && entry.username !== "") record.username = entry.username;
		return record;
	});
}
//#endregion
//#region src/shared/wsl.ts
/**
* WSL discovery helpers (host side): enumerate installed distributions
* through `wsl.exe -l -q` and read the default distribution from the Lxss
* registry key. `wsl.exe` output is UTF-16LE on most builds, so decoding
* sniffs for NUL bytes before choosing an encoding.
* @module dsh-wsl-workspace/shared/wsl
*/
/** Executable timeout for the short discovery calls. */
const DISCOVERY_TIMEOUT_MS = 1e4;
const LXSS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";
/** Human text for an unknown rejection. */
function messageOf(value) {
	return value instanceof Error ? value.message : String(value);
}
/**
* Run `execFile` through its callback API and resolve `{ stdout, stderr }`.
*
* `util.promisify(execFile)` only resolves that object because `execFile`
* carries `util.promisify.custom`. A host that replaces
* `child_process.execFile` with a plain wrapper loses that metadata, and
* `promisify` then falls back to "resolve the first callback value" — which is
* stdout itself, so `result.stdout` is `undefined` (issue #35: DSH Desktop
* injects `windowsHide: true` that way, and `listDistros()` died with
* `Cannot read properties of undefined (reading 'includes')`).
*
* The callback form is what every such wrapper preserves, so this does not
* depend on how the host patched the module.
* @param file - the executable.
* @param args - its arguments.
* @param options - `execFile` options, including the requested encoding.
* @returns both streams; the caller narrows them by the encoding it asked for.
*/
function execFileResult(file, args, options) {
	return new Promise((settle, fail) => {
		execFile(file, [...args], options, (error, stdout, stderr) => {
			if (error !== null && error !== void 0) {
				fail(error);
				return;
			}
			settle({
				stdout,
				stderr
			});
		});
	});
}
/**
* Read a captured stream as text, whichever way the encoding arrived.
*
* One decode policy for every captured stream in the plugin: a `reg.exe` answer written in UTF-16LE
* used to reach this function's hard `toString('utf8')` and came back as mojibake, which the caller
* could not tell from "the registry said nothing" — an empty picker, no throw, no log.
* @param stream - the captured output, or text that arrived as text.
* @returns the decoded text.
*/
function textOf(stream) {
	return decodeWslOutput(stream);
}
/**
* The `wsl.exe` spellings to try, in order.
*
* The bare name relies on `PATH`. A host whose `PATH` omits `System32` can run
* every other part of this plugin — `listDir`/`check` go through the
* `\\wsl.localhost\…` share and never spawn anything — while `listDistros`
* reports that WSL is missing, which is what issue #36 describes. The
* absolute fallback removes that failure mode.
* @param wslPath - the configured executable.
* @returns the candidates, without duplicates.
*/
function wslExecutableCandidates(wslPath) {
	if (wslPath !== "wsl.exe") return [wslPath];
	const root = process.env.SystemRoot ?? process.env.windir;
	if (root === void 0 || root === "") return [wslPath];
	return [wslPath, `${root.replace(/[\\/]+$/, "")}\\System32\\wsl.exe`];
}
/**
* Decide whether a captured buffer is UTF-16LE, structurally.
*
* The old rule asked only whether a NUL was **present**. That is not a UTF-16 marker, it is the byte
* 0x00, and UTF-8 streams carry those legitimately — `find -print0`, `grep -Z` and `git ls-files -z`
* all speak NUL-delimited, which is why this plugin's own search path splits stdout on a NUL delimiter. A
* UTF-16LE console answer has its NULs at a **regular parity** (for ASCII text, every odd byte) and at
* a **high density**; a NUL-delimited or error-bearing UTF-8 stream has them at no parity in
* particular and rarely.
* @param buffer - the captured bytes.
* @returns whether the shape says UTF-16LE.
*/
function looksUtf16Le(buffer) {
	const sample = Math.min(buffer.length, 4096);
	let even = 0;
	let odd = 0;
	for (let index = 0; index < sample; index += 1) {
		if (buffer[index] !== 0) continue;
		if (index % 2 === 0) even += 1;
		else odd += 1;
	}
	const nuls = even + odd;
	if (nuls === 0) return false;
	const parity = Math.max(even, odd) / nuls;
	const density = nuls / sample;
	return parity >= .9 && density >= .1;
}
/**
* Decode a captured stream the way the writer meant it.
*
* `wsl.exe -l -q` and `reg.exe query` answer in UTF-16LE on most Windows builds and in UTF-8 on
* newer ones, so the encoding has to be decided per stream — but decided **structurally**, not by the
* existence of a NUL (see {@link looksUtf16Le}).
*
* A caller that knows its stream never goes through the heuristic: `find -print0` output is NUL-
* delimited UTF-8 by definition and reads its buffer directly, and a caller with a documented
* encoding passes it.
*
* Known limit, stated rather than hidden: UTF-16LE text with no Latin characters at all (pure CJK,
* say) carries so few NUL bytes that the density guard declines it. The `ff fe` BOM covers that case
* for any writer that emits one, which includes the Windows console; a BOM-less, NUL-free UTF-16LE
* answer would read as mojibake rather than as an error.
* @param buffer - the captured output, or text that arrived as text.
* @param encoding - the encoding when the caller knows it, which skips the sniff entirely.
* @returns the decoded text.
*/
function decodeWslOutput(buffer, encoding) {
	if (typeof buffer === "string") return buffer;
	if (!(buffer instanceof Uint8Array)) throw new Error(`wsl-workspace: expected captured output, got ${typeof buffer}`);
	if (encoding === "utf8") return buffer.toString("utf8");
	if (encoding === "utf16le") return buffer.toString("utf16le");
	if (buffer.length >= 2 && buffer[0] === 255 && buffer[1] === 254) return buffer.toString("utf16le");
	return looksUtf16Le(buffer) ? buffer.toString("utf16le") : buffer.toString("utf8");
}
/**
* List installed WSL distributions in `wsl.exe` order.
* @param wslPath - the `wsl.exe` executable (absolute or PATH name).
* @returns distribution names, blank lines dropped.
*/
async function listDistros(wslPath = "wsl.exe") {
	const candidates = wslExecutableCandidates(wslPath);
	let stdout;
	let lastError;
	for (const candidate of candidates) try {
		stdout = (await execFileResult(candidate, ["-l", "-q"], {
			encoding: "buffer",
			timeout: DISCOVERY_TIMEOUT_MS
		})).stdout;
		break;
	} catch (error) {
		lastError = error;
	}
	if (stdout === void 0) throw new Error(`wsl-workspace: cannot list WSL distributions (tried ${candidates.join(" and ")}: ${messageOf(lastError)}); is WSL installed?`);
	return decodeWslOutput(stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}
/**
* Read the user's default distribution from the Lxss registry. Non-fatal:
* returns `undefined` when the value is absent or unreadable (the caller
* falls back to list order).
* @returns the default distribution name, or `undefined`.
*/
async function defaultDistro() {
	try {
		const value = await execFileResult("reg.exe", [
			"query",
			LXSS_KEY,
			"/v",
			"DefaultDistribution"
		], {
			encoding: "buffer",
			timeout: DISCOVERY_TIMEOUT_MS
		});
		const guid = /DefaultDistribution\s+REG_SZ\s+(\{[0-9a-fA-F-]+\})/i.exec(textOf(value.stdout))?.[1];
		if (guid === void 0) return void 0;
		const name = await execFileResult("reg.exe", [
			"query",
			`${LXSS_KEY}\\${guid}`,
			"/v",
			"DistributionName"
		], {
			encoding: "buffer",
			timeout: DISCOVERY_TIMEOUT_MS
		});
		const distro = /DistributionName\s+REG_SZ\s+(.+)/i.exec(textOf(name.stdout))?.[1]?.trim();
		return distro === void 0 || distro === "" ? void 0 : distro;
	} catch {
		return;
	}
}
/** Module-level cache for {@link defaultDistroSync} (one registry read per process). */
let syncDefaultResolved = false;
let syncDefault;
/**
* Synchronous variant of {@link defaultDistro} for executors that must
* resolve a distribution inside a synchronous plan step. Cached after the
* first read; non-fatal (returns `undefined` when the registry is
* unreadable, letting the caller fail loud with its own message).
* @returns the default distribution name, or `undefined`.
*/
function defaultDistroSync() {
	if (syncDefaultResolved) return syncDefault;
	syncDefaultResolved = true;
	try {
		const value = execFileSync("reg.exe", [
			"query",
			LXSS_KEY,
			"/v",
			"DefaultDistribution"
		], {
			encoding: "buffer",
			timeout: DISCOVERY_TIMEOUT_MS
		});
		const guid = /DefaultDistribution\s+REG_SZ\s+(\{[0-9a-fA-F-]+\})/i.exec(textOf(value))?.[1];
		if (guid === void 0) return void 0;
		const name = execFileSync("reg.exe", [
			"query",
			`${LXSS_KEY}\\${guid}`,
			"/v",
			"DistributionName"
		], {
			encoding: "buffer",
			timeout: DISCOVERY_TIMEOUT_MS
		});
		const distro = /DistributionName\s+REG_SZ\s+(.+)/i.exec(textOf(name))?.[1]?.trim();
		syncDefault = distro === void 0 || distro === "" ? void 0 : distro;
	} catch {
		syncDefault = void 0;
	}
	return syncDefault;
}
//#endregion
export { listDistros as a, canonicalWslUnc as c, listWorkspaceKeys as d, listWorkspaceRecords as f, execFileResult as i, getWindowsWorkspace as l, setWorkspaceUsername as m, defaultDistro as n, textOf as o, registerWindowsWorkspace as p, defaultDistroSync as r, wslExecutableCandidates as s, decodeWslOutput as t, getWorkspaceUsername as u };

//# sourceMappingURL=wsl-D8IMrwip.js.map