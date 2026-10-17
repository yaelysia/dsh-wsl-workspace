/** Runtime defaults shared by the top-level plugin and independently mounted search rows. */
export type TransportMode = 'auto' | 'persistent' | 'oneshot'
export interface RpcConfig { transport?: string | undefined; idleMs?: number | undefined; metrics?: boolean | undefined }
export interface ResolvedRpcConfig { transport: TransportMode; idleMs: number; metrics: boolean }
export const RPC_DEFAULTS: ResolvedRpcConfig = { transport: 'auto', idleMs: 120_000, metrics: true }

/** Explicit row/plugin values win over the host environment; invalid values never silently fall through. */
export function resolveRpcConfig(config: RpcConfig = {}, env: NodeJS.ProcessEnv = process.env): ResolvedRpcConfig {
  const transport = config.transport ?? env.DSH_WSL_SEARCH_TRANSPORT ?? RPC_DEFAULTS.transport
  if (transport !== 'auto' && transport !== 'persistent' && transport !== 'oneshot') {
    throw new RangeError('wsl-search: transport must be auto, persistent, or oneshot')
  }
  const rawIdle = config.idleMs ?? env.DSH_WSL_RPC_IDLE_MS ?? RPC_DEFAULTS.idleMs
  const idleMs = typeof rawIdle === 'string' && /^\d+$/.test(rawIdle) ? Number(rawIdle) : rawIdle
  if (typeof idleMs !== 'number' || !Number.isSafeInteger(idleMs) || idleMs < 1000 || idleMs > 3_600_000) {
    throw new RangeError('wsl-search: idleMs must be an integer from 1000 to 3600000')
  }
  const rawMetrics = config.metrics ?? env.DSH_WSL_RPC_METRICS ?? RPC_DEFAULTS.metrics
  const metrics = rawMetrics === 'true' || rawMetrics === '1' ? true
    : rawMetrics === 'false' || rawMetrics === '0' ? false : rawMetrics
  if (typeof metrics !== 'boolean') throw new RangeError('wsl-search: metrics must be true or false')
  return { transport, idleMs, metrics }
}
