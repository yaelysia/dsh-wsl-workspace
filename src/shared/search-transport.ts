/** Compatibility facade: existing search consumers and regressions share the WSL RPC implementation. */
export { WslRpcPool as SearchWorkerPool, RpcTransportError as SearchTransportError } from './rpc-transport.ts'
export type { RpcTarget as SearchTarget, RpcRun as SearchRun, RpcLauncher as SearchLauncher } from './rpc-transport.ts'
import type { RpcRequest } from './rpc-transport.ts'
export type SearchRequest = Omit<RpcRequest, 'op'> & { op: 'grep' | 'glob' }
