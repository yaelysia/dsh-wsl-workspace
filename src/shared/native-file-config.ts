/** Native file routing is separate from search's oneshot switch. */
import { resolveRpcConfig } from './rpc-config.ts'
import { isValidWslUsername } from './paths.ts'
export type FileBackend = 'auto' | 'native' | 'unc'
export interface FileOptions { backend: FileBackend; idleMs: number; metrics: boolean; wslPath: string }
export function resolveFileConfig(config: { backend?: string | undefined; idleMs?: number | undefined; metrics?: boolean | undefined; wslPath?: string | undefined } = {},
  env: NodeJS.ProcessEnv = process.env): FileOptions {
  const backend = config.backend ?? env.DSH_WSL_FILE_BACKEND ?? 'auto'
  if (!['auto', 'native', 'unc'].includes(backend)) throw new RangeError('wsl-fs: backend must be auto, native, or unc')
  const rpc = resolveRpcConfig({ transport: 'auto', idleMs: config.idleMs, metrics: config.metrics }, env)
  return { backend: backend as FileBackend, idleMs: rpc.idleMs, metrics: rpc.metrics, wslPath: config.wslPath ?? 'wsl.exe' }
}
export interface NativeCoordinate { distro: string; username?: string; path: string }
const PREFIX = 'wsl-native:'
/** Opaque keys preserve literal backslashes/case and bind a resolved target to its Linux identity. */
export function nativeKey(value: NativeCoordinate): string {
  return PREFIX + JSON.stringify([value.distro, value.username ?? null, value.path])
}
export function nativeCoordinate(key: string): NativeCoordinate | undefined {
  if (!key.startsWith(PREFIX)) return undefined
  let data: unknown
  try { data = JSON.parse(key.slice(PREFIX.length)) } catch { throw new Error('invalid native target key') }
  if (!Array.isArray(data) || data.length !== 3 || typeof data[0] !== 'string' || !data[0]
    || /[\\/]/.test(data[0]) || data[0] === '.' || data[0] === '..'
    || (data[1] !== null && (typeof data[1] !== 'string' || !isValidWslUsername(data[1]))) || typeof data[2] !== 'string'
    || !data[2].startsWith('/') || data.some(value => typeof value === 'string' && value.includes('\0'))) {
    throw new Error('invalid native target key')
  }
  return { distro: data[0], path: data[2], ...data[1] === null ? {} : { username: data[1] } }
}
