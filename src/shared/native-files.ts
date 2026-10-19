/** Typed consumer of the shared RPC. No host package at runtime; the provider maps its errors. */
import { decodeRpcBytes, RpcTransportError, WslRpcPool, type RpcTarget } from './rpc-transport.ts'
import { performance } from 'node:perf_hooks'
import type { FsErrorCode, FsEditRequest, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type { Outcome, RpcMethod } from './rpc-metrics.ts'

export const NATIVE_MAX_BYTES = 16 * 1024 * 1024
const REPLY_MAX_BYTES = 64 * 1024 * 1024
const FILE_CODES = new Set<string>(['FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_NOT_TEXT', 'FS_NOT_REGULAR_FILE',
  'FS_TOO_LARGE', 'FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED', 'FS_IO_ERROR', 'FS_STALE_VERSION',
  'FS_NOT_OBSERVED', 'FS_AMBIGUOUS_EDIT', 'FS_EDIT_NOT_FOUND', 'FS_ABORTED'])
export type NativeMethod = Exclude<RpcMethod, 'grep' | 'glob' | 'fs.metadata'>
export interface NativePolicy { mode: string; roots: string[] }
export interface NativeInfo { version: string; type: 'file' | 'directory' | 'symlink' | 'other'; size: number }
export interface NativeEntry extends Partial<NativeInfo> { name: string; path: string; type: NativeInfo['type'] }
export interface NativeWrite { version: string; before: string | null; after: string; operation?: 'create' | 'update' }
export interface NativeOptions { signal?: AbortSignal | undefined; timeoutMs?: number | undefined }
export class NativeFileError extends Error {
  readonly code: FsErrorCode
  constructor(code: FsErrorCode, message: string) { super(message); this.code = code; this.name = 'NativeFileError' }
}
function invalid(message = 'invalid native file response'): never { throw new NativeFileError('FS_IO_ERROR', message) }
function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0')
}
function isInfo(value: unknown): value is NativeInfo {
  const row = value as NativeInfo | undefined
  return !!row && typeof row.version === 'string' && row.version.length > 0
    && ['file', 'directory', 'symlink', 'other'].includes(row.type) && Number.isSafeInteger(row.size) && row.size >= 0
}
export function decodeNativeText(bytes: Uint8Array): string {
  if (bytes.subarray(0, 8192).includes(0)) throw new NativeFileError('FS_NOT_TEXT', 'binary file')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new NativeFileError('FS_NOT_TEXT', 'invalid UTF-8 text') }
}

/** All mutations are one Linux transaction, not read in Windows and a blind write later. */
export class NativeFileClient {
  readonly pool: WslRpcPool
  constructor(pool: WslRpcPool) { this.pool = pool }

  private async call(target: RpcTarget, op: NativeMethod, payload: object, options: NativeOptions = {}): Promise<unknown> {
    const started = performance.now()
    let outcome: Outcome = 'error'
    const mutating = op === 'fs.write' || op === 'fs.edit'
    try {
      const run = await this.pool.run(target, { op, args: [JSON.stringify({ ...payload, replyLimit: REPLY_MAX_BYTES })],
        timeoutMs: options.timeoutMs ?? 30_000, maxBytes: REPLY_MAX_BYTES,
        ...options.signal === undefined ? {} : { signal: options.signal } })
      if (run.aborted) throw new NativeFileError('FS_ABORTED', 'file operation cancelled before execution')
      if (run.stdout.length > REPLY_MAX_BYTES) throw new NativeFileError(mutating ? 'FS_IO_ERROR' : 'FS_TOO_LARGE',
        mutating ? 'file mutation result unknown; re-read before retrying' : 'file response exceeds its byte limit')
      let response: { ok?: boolean; committed?: boolean; value?: unknown; code?: string; message?: string }
      try { response = JSON.parse(run.stdout.toString('utf8')) }
      catch { invalid(mutating ? 'file mutation result unknown; re-read before retrying' : undefined) }
      if (!response || typeof response.ok !== 'boolean' || typeof response.committed !== 'boolean') {
        invalid(mutating ? 'file mutation result unknown; re-read before retrying' : undefined)
      }
      if (!response.ok) {
        if (response.committed) invalid('file was published but its receipt failed; re-read before retrying')
        if (!FILE_CODES.has(response.code ?? '') || typeof response.message !== 'string') {
          invalid(mutating ? 'file mutation result unknown; re-read before retrying' : undefined)
        }
        throw new NativeFileError(response.code as FsErrorCode, response.message)
      }
      if (run.code !== 0 || mutating !== response.committed) invalid(mutating ? 'file mutation result unknown; re-read before retrying' : undefined)
      outcome = 'ok'
      return response.value
    } catch (error) {
      if (error instanceof NativeFileError) {
        if (error.code === 'FS_ABORTED') outcome = 'aborted'
        if (error.code === 'FS_TOO_LARGE') outcome = 'overflow'
      }
      if (error instanceof RpcTransportError && error.code === 'RPC_ABORTED') {
        outcome = 'aborted'; throw new NativeFileError('FS_ABORTED', error.message)
      }
      if (error instanceof RpcTransportError && error.code === 'RPC_TOO_LARGE') {
        outcome = 'overflow'; throw new NativeFileError('FS_TOO_LARGE', error.message)
      }
      // Preserve startup stage so ONLY resolve can select the UNC fallback before creating a target.
      throw error
    } finally { this.pool.metrics.record(`file.${op.slice(3)}` as `file.${'resolve'}`, performance.now() - started, outcome) }
  }

  async resolve(target: RpcTarget, path: string, options?: NativeOptions): Promise<string> {
    const result = await this.call(target, 'fs.resolve', { path }, options) as { path?: unknown }
    if (!result || !validPath(result.path)) invalid()
    return result.path
  }
  async stat(target: RpcTarget, path: string, nofollow = false, options?: NativeOptions): Promise<NativeInfo | undefined> {
    const result = await this.call(target, nofollow ? 'fs.lstat' : 'fs.stat', { path }, options)
    if (result === null) return undefined
    if (!isInfo(result)) invalid()
    return result
  }
  async read(target: RpcTarget, path: string, maxBytes = NATIVE_MAX_BYTES, options?: NativeOptions): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new NativeFileError('FS_TOO_LARGE', 'invalid byte limit')
    const result = await this.call(target, 'fs.read', { path, maxBytes: Math.min(maxBytes, NATIVE_MAX_BYTES) }, options)
    return this.bytes(result, Math.min(maxBytes, NATIVE_MAX_BYTES))
  }
  async range(target: RpcTarget, path: string, offset: number, length: number, version?: string, options?: NativeOptions): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > NATIVE_MAX_BYTES) {
      throw new NativeFileError('FS_TOO_LARGE', 'invalid or excessive byte range')
    }
    const result = await this.call(target, 'fs.range', { path, offset, maxBytes: length, version }, options)
    return this.bytes(result, length)
  }
  private bytes(value: unknown, max: number): Buffer {
    const data = (value as { data?: unknown })?.data
    try { return decodeRpcBytes(data, max) }
    catch { invalid() }
  }
  async list(target: RpcTarget, path: string, options?: NativeOptions): Promise<NativeEntry[]> {
    const rows = await this.call(target, 'fs.list', { path }, options)
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row.name !== 'string' || row.name.includes('/')
      || !validPath(row.path) || (row.version === undefined ? row.type !== 'other' : !isInfo(row)))) invalid()
    return (rows as NativeEntry[]).sort((a, b) => a.name.localeCompare(b.name))
  }
  async write(target: RpcTarget, path: string, content: string, expected: FsWriteIntent | undefined,
    policy: NativePolicy | undefined, diffBasisMaxBytes: number, options?: NativeOptions): Promise<NativeWrite> {
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.length > NATIVE_MAX_BYTES) throw new NativeFileError('FS_TOO_LARGE', 'native write exceeds 16 MiB')
    return this.receipt(await this.call(target, 'fs.write', { path, content: bytes.toString('base64'), expected,
      policy, diffBasisMaxBytes }, options), false)
  }
  async edit(target: RpcTarget, path: string, edit: FsEditRequest, version: string | undefined,
    policy: NativePolicy | undefined, options?: NativeOptions): Promise<NativeWrite> {
    return this.receipt(await this.call(target, 'fs.edit', { path, ...edit,
      expected: version === undefined ? undefined : { kind: 'replaceIfVersion', version }, policy }, options), true)
  }
  private receipt(value: unknown, editing: boolean): NativeWrite {
    const result = value as NativeWrite
    if (!result || typeof result.version !== 'string' || !result.version || typeof result.after !== 'string'
      || !(typeof result.before === 'string' || (!editing && result.before === null))
      || (!editing && result.operation !== 'create' && result.operation !== 'update')) invalid('invalid mutation receipt; re-read before retrying')
    return result
  }
}
