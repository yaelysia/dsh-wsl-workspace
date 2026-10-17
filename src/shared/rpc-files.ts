/** First non-search RPC consumer. Read-only metadata; does not replace the DSH filesystem provider. */
import { WslRpcPool, RpcTransportError, type RpcTarget } from './rpc-transport.ts'
export type FileMetadata = { path: string; error: string } | {
  path: string; realpath: string; kind: 'file' | 'directory' | 'other'; symlink: boolean;
  size: number; mtimeNs: string; device: string; inode: string
}
export async function readMetadata(pool: WslRpcPool, target: RpcTarget, paths: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<FileMetadata[]> {
  if (paths.length === 0 || paths.length > 64 || paths.some(path => !path.startsWith('/') || path.includes('\0'))) {
    throw new RpcTransportError('metadata requires 1-64 absolute Linux paths', 'request')
  }
  const run = await pool.run(target, { op: 'fs.metadata', args: paths, timeoutMs: options.timeoutMs ?? 10_000,
    maxBytes: 1_048_576, ...options.signal === undefined ? {} : { signal: options.signal } })
  if (run.aborted) throw new RpcTransportError('metadata cancelled', 'request', 'RPC_ABORTED')
  if (run.code !== 0 || run.stdout.length > 1_048_576) throw new RpcTransportError('metadata query failed or exceeded its output budget', 'request')
  let rows: unknown
  try { rows = JSON.parse(run.stdout.toString('utf8')) }
  catch { throw new RpcTransportError('invalid metadata response', 'request') }
  if (!Array.isArray(rows) || rows.length !== paths.length || rows.some((row, i) => !row || row.path !== paths[i]
    || (typeof row.error === 'string' ? !/^E[A-Z0-9]+$/.test(row.error)
      : typeof row.realpath !== 'string' || !row.realpath.startsWith('/') || !['file', 'directory', 'other'].includes(row.kind)
      || typeof row.symlink !== 'boolean' || !Number.isSafeInteger(row.size) || row.size < 0
      || ![row.mtimeNs, row.device, row.inode].every(x => typeof x === 'string' && /^-?\d+$/.test(x))))) {
    throw new RpcTransportError('invalid metadata response', 'request')
  }
  return rows as FileMetadata[]
}
