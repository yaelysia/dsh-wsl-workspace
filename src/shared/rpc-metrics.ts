/** Bounded, in-memory timing counters. No paths, user identities, arguments or file contents. */
export type Outcome = 'ok' | 'error' | 'aborted' | 'overflow'
export type RpcMethod = 'grep' | 'glob' | 'fs.metadata'
export type TimingKey = `tool.${'grep' | 'glob'}` | `oneshot.${'grep' | 'glob'}`
  | `rpc.${RpcMethod}.${'total' | 'ready' | 'roundTrip' | 'queue' | 'execute'}`
const WINDOW = 256
interface Bucket { count: number; cursor: number; samples: number[]; outcomes: Record<Outcome, number> }
export class RpcMetrics {
  private readonly buckets = new Map<TimingKey, Bucket>()
  readonly enabled: boolean
  constructor(enabled = true) { this.enabled = enabled }
  record(key: TimingKey, milliseconds: number, outcome: Outcome = 'ok'): void {
    if (!this.enabled || !Number.isFinite(milliseconds) || milliseconds < 0) return
    // A fixed grammar, not caller labels: diagnostics cannot retain high-cardinality request data.
    if (!/^(tool|oneshot)\.(grep|glob)$|^rpc\.(grep|glob|fs\.metadata)\.(total|ready|roundTrip|queue|execute)$/.test(key)) return
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { count: 0, cursor: 0, samples: [], outcomes: { ok: 0, error: 0, aborted: 0, overflow: 0 } }
      this.buckets.set(key, bucket)
    }
    bucket.count++; bucket.outcomes[outcome]++
    bucket.samples[bucket.cursor] = milliseconds
    bucket.cursor = (bucket.cursor + 1) % WINDOW
  }
  snapshot() {
    return { enabled: this.enabled, windowSize: WINDOW, stages: Object.fromEntries(
      [...this.buckets].map(([key, value]) => {
        const sorted = [...value.samples].sort((a, b) => a - b)
        const at = (p: number) => Math.round((sorted[Math.ceil(sorted.length * p) - 1] ?? 0) * 1000) / 1000
        return [key, { count: value.count, samples: sorted.length, outcomes: { ...value.outcomes },
          p50Ms: at(0.5), p95Ms: at(0.95) }]
      })) }
  }
}

/** Shared between the host API and built search entry via one bundled module, not per-entry globals. */
const providers = new Map<number, () => unknown>()
let sequence = 0
export function registerRpcDiagnostics(snapshot: () => unknown): () => void {
  const id = ++sequence
  providers.set(id, snapshot)
  return () => { providers.delete(id) }
}
export function rpcDiagnostics() {
  return { scope: 'search-tool-execution-and-rpc; not model latency or UNC file IO',
    providers: [...providers].map(([id, snapshot]) => ({ id, ...snapshot() as object })) }
}
