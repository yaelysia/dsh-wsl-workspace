//#region src/shared/rpc-config.ts
const RPC_DEFAULTS = {
	transport: "auto",
	idleMs: 12e4,
	metrics: true
};
/** Explicit row/plugin values win over the host environment; invalid values never silently fall through. */
function resolveRpcConfig(config = {}, env = process.env) {
	const transport = config.transport ?? env.DSH_WSL_SEARCH_TRANSPORT ?? RPC_DEFAULTS.transport;
	if (transport !== "auto" && transport !== "persistent" && transport !== "oneshot") throw new RangeError("wsl-search: transport must be auto, persistent, or oneshot");
	const rawIdle = config.idleMs ?? env.DSH_WSL_RPC_IDLE_MS ?? RPC_DEFAULTS.idleMs;
	const idleMs = typeof rawIdle === "string" && /^\d+$/.test(rawIdle) ? Number(rawIdle) : rawIdle;
	if (typeof idleMs !== "number" || !Number.isSafeInteger(idleMs) || idleMs < 1e3 || idleMs > 36e5) throw new RangeError("wsl-search: idleMs must be an integer from 1000 to 3600000");
	const rawMetrics = config.metrics ?? env.DSH_WSL_RPC_METRICS ?? RPC_DEFAULTS.metrics;
	const metrics = rawMetrics === "true" || rawMetrics === "1" ? true : rawMetrics === "false" || rawMetrics === "0" ? false : rawMetrics;
	if (typeof metrics !== "boolean") throw new RangeError("wsl-search: metrics must be true or false");
	return {
		transport,
		idleMs,
		metrics
	};
}
//#endregion
//#region src/shared/rpc-metrics.ts
const RPC_METHODS = [
	"grep",
	"glob",
	"fs.metadata",
	"fs.resolve",
	"fs.stat",
	"fs.lstat",
	"fs.read",
	"fs.range",
	"fs.list",
	"fs.write",
	"fs.edit"
];
/** Shared execution accounting; grep exit 1 means no matches, not a failure. */
function rpcRunOutcome(result, op, maxBytes) {
	if (result.aborted) return "aborted";
	if (result.stdout.length > maxBytes) return "overflow";
	return result.code === 0 || op === "grep" && result.code === 1 ? "ok" : "error";
}
const WINDOW = 256;
var RpcMetrics = class {
	buckets = /* @__PURE__ */ new Map();
	enabled;
	constructor(enabled = true) {
		this.enabled = enabled;
	}
	record(key, milliseconds, outcome = "ok") {
		if (!this.enabled || !Number.isFinite(milliseconds) || milliseconds < 0) return;
		if (!/^(tool|oneshot)\.(grep|glob)$|^file\.(resolve|stat|lstat|read|range|list|write|edit)$|^rpc\.(grep|glob|fs\.(metadata|resolve|stat|lstat|read|range|list|write|edit))\.(total|ready|roundTrip|queue|execute)$/.test(key)) return;
		let bucket = this.buckets.get(key);
		if (!bucket) {
			bucket = {
				count: 0,
				cursor: 0,
				samples: [],
				outcomes: {
					ok: 0,
					error: 0,
					aborted: 0,
					overflow: 0
				}
			};
			this.buckets.set(key, bucket);
		}
		bucket.count++;
		bucket.outcomes[outcome]++;
		bucket.samples[bucket.cursor] = milliseconds;
		bucket.cursor = (bucket.cursor + 1) % WINDOW;
	}
	snapshot() {
		return {
			enabled: this.enabled,
			windowSize: WINDOW,
			stages: Object.fromEntries([...this.buckets].map(([key, value]) => {
				const sorted = [...value.samples].sort((a, b) => a - b);
				const at = (p) => Math.round((sorted[Math.ceil(sorted.length * p) - 1] ?? 0) * 1e3) / 1e3;
				return [key, {
					count: value.count,
					samples: sorted.length,
					outcomes: { ...value.outcomes },
					p50Ms: at(.5),
					p95Ms: at(.95)
				}];
			}))
		};
	}
};
/** Shared between the host API and built search entry via one bundled module, not per-entry globals. */
const providers = /* @__PURE__ */ new Map();
let sequence = 0;
function registerRpcDiagnostics(snapshot) {
	const id = ++sequence;
	providers.set(id, snapshot);
	return () => {
		providers.delete(id);
	};
}
function rpcDiagnostics() {
	return {
		scope: "search-and-native-file-execution-and-rpc; not model latency or UNC file IO",
		providers: [...providers].map(([id, snapshot]) => ({
			id,
			...snapshot()
		}))
	};
}
//#endregion
export { rpcRunOutcome as a, rpcDiagnostics as i, RpcMetrics as n, RPC_DEFAULTS as o, registerRpcDiagnostics as r, resolveRpcConfig as s, RPC_METHODS as t };

//# sourceMappingURL=rpc-metrics-A9FocmpU.js.map