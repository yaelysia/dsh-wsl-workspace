/** Typed consumer of the shared RPC. No host package at runtime; the provider maps its errors. */
import { decodeRpcBytes, RpcTransportError, WslRpcPool, type RpcRun, type RpcTarget } from './rpc-transport.ts'
import { performance } from 'node:perf_hooks'
import { inflateSync } from 'node:zlib'
import type { FsErrorCode, FsEditRequest, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type { Outcome, RpcMethod } from './rpc-metrics.ts'

export const NATIVE_MAX_BYTES = 16 * 1024 * 1024
const REPLY_MAX_BYTES = 64 * 1024 * 1024
const FILE_CODES = new Set<string>(['FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_NOT_TEXT', 'FS_NOT_REGULAR_FILE',
  'FS_TOO_LARGE', 'FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED', 'FS_IO_ERROR', 'FS_STALE_VERSION',
  'FS_NOT_OBSERVED', 'FS_AMBIGUOUS_EDIT', 'FS_EDIT_NOT_FOUND', 'FS_ABORTED'])
export type NativeMethod = Exclude<RpcMethod, 'grep' | 'glob' | 'fs.metadata' | 'fs.batch'>
export interface NativePolicy { mode: string; roots: string[] }
export interface NativeInfo { version: string; type: 'file' | 'directory' | 'symlink' | 'other'; size: number }
export interface NativeEntry extends Partial<NativeInfo> { name: string; path: string; type: NativeInfo['type'] }
export interface NativeWrite { version: string; before: string | null; after: string; operation?: 'create' | 'update' }
export interface NativeSnapshot { path: string; info: NativeInfo | null; data: Buffer | null }
export interface NativeWindowLine { number: number; text: string }
export interface NativeWindow { path: string; fallback: boolean; info: NativeInfo | null;
  lines: NativeWindowLine[]; totalLines: number; truncatedByBytes: boolean; outOfRange: boolean }
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


/**
 * Read-only receipt: either canonical raw Base64, or a bounded zlib payload.
 * Never infer a codec from user bytes and never decompress past a validated cap.
 * Snapshot's null data means a non-file/missing or streaming-size file.
 */
function decodedReadData(receipt: unknown, maxBytes: number, allowNull: boolean): Buffer | null {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) invalid()
  const { data, dataZ, rawBytes } = receipt as { data?: unknown; dataZ?: unknown; rawBytes?: unknown }
  if (dataZ === undefined) {
    if (rawBytes !== undefined) invalid()
    if (data === null && allowNull) return null
    try { return decodeRpcBytes(data, maxBytes) }
    catch { invalid() }
  }
  if (data !== undefined || typeof dataZ !== 'string' || !Number.isSafeInteger(rawBytes)
    || (rawBytes as number) < 65536 || (rawBytes as number) > maxBytes) invalid()
  try {
    const compressed = decodeRpcBytes(dataZ, maxBytes)
    const restored = inflateSync(compressed, { maxOutputLength: (rawBytes as number) + 1 })
    if (restored.length !== rawBytes) invalid()
    return restored
  } catch { invalid() }
}

/** Batch only independent read-only calls in the same microtask and identical Linux identity. */
type BatchOp = 'fs.resolve' | 'fs.stat' | 'fs.lstat' | 'fs.read'
interface QueuedCall {
  target: RpcTarget
  op: BatchOp
  payload: object
  options: NativeOptions
  resolve(run: RpcRun): void
  reject(error: unknown): void
}
const abortedRun = (): RpcRun => ({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), aborted: true, signal: null })

/** All mutations are one Linux transaction, not read in Windows and a blind write later. */
export class NativeFileClient {
  readonly pool: WslRpcPool
  private readonly queued = new Map<string, QueuedCall[]>()
  constructor(pool: WslRpcPool) { this.pool = pool }

  /** No freshness cache: each entry still physically resolves, stats or reads in Linux. */
  private submit(target: RpcTarget, op: NativeMethod, payload: object, options: NativeOptions): Promise<RpcRun> {
    const timeoutMs = options.timeoutMs ?? 30_000
    if (op !== 'fs.resolve' && op !== 'fs.stat' && op !== 'fs.lstat' && op !== 'fs.read') {
      return this.pool.run(target, { op, args: [JSON.stringify({ ...payload, replyLimit: REPLY_MAX_BYTES })],
        timeoutMs, maxBytes: REPLY_MAX_BYTES,
        ...options.signal === undefined ? {} : { signal: options.signal } })
    }
    const key = JSON.stringify([target.wslPath, target.distro, target.username ?? null, target.linuxCwd, op, timeoutMs])
    return new Promise<RpcRun>((resolve, reject) => {
      const item: QueuedCall = { target, op, payload, options, resolve, reject }
      const pending = this.queued.get(key)
      if (pending) { pending.push(item); return }
      this.queued.set(key, [item])
      queueMicrotask(() => {
        const entries = this.queued.get(key)!
        this.queued.delete(key)
        const live = entries.filter(entry => {
          if (!entry.options.signal?.aborted) return true
          entry.resolve(abortedRun())
          return false
        })
        const limit = op === 'fs.read' ? 2 : 8 // Worst-case two 16 MiB base64 reads fit in a 64 MiB receipt.
        for (let i = 0; i < live.length; i += limit) void this.sendGroup(live.slice(i, i + limit))
      })
    })
  }

  private async sendGroup(entries: QueuedCall[]): Promise<void> {
    const first = entries[0]!
    if (entries.length === 1) {
      try {
        first.resolve(await this.pool.run(first.target, {
          op: first.op, args: [JSON.stringify({ ...first.payload, replyLimit: REPLY_MAX_BYTES })],
          timeoutMs: first.options.timeoutMs ?? 30_000, maxBytes: REPLY_MAX_BYTES,
          ...first.options.signal === undefined ? {} : { signal: first.options.signal },
        }))
      } catch (error) { first.reject(error) }
      return
    }
    // One cancelled read must not cancel another session's independent request.
    const controller = new AbortController()
    const pending = new Set(entries)
    const cleanup = entries.map(entry => {
      const onAbort = () => {
        if (!pending.delete(entry)) return
        entry.resolve(abortedRun())
        if (pending.size === 0) controller.abort()
      }
      entry.options.signal?.addEventListener('abort', onAbort, { once: true })
      if (entry.options.signal?.aborted) onAbort()
      return () => entry.options.signal?.removeEventListener('abort', onAbort)
    })
    try {
      if (pending.size === 0) return
      const run = await this.pool.run(first.target, {
        op: 'fs.batch',
        args: [JSON.stringify({ requests: entries.map(entry => ({
          op: entry.op, payload: { ...entry.payload, replyLimit: REPLY_MAX_BYTES },
        })) })],
        timeoutMs: first.options.timeoutMs ?? 30_000, maxBytes: REPLY_MAX_BYTES,
        signal: controller.signal,
      })
      if (run.aborted) {
        for (const entry of pending) entry.resolve(run)
        return
      }
      if (run.code !== 0 || run.stdout.length > REPLY_MAX_BYTES) invalid('invalid batched file response')
      let outer: { ok?: boolean; committed?: boolean; value?: unknown }
      try { outer = JSON.parse(run.stdout.toString('utf8')) }
      catch { invalid('invalid batched file response') }
      if (!outer || outer.ok !== true || outer.committed !== false ||
        !Array.isArray(outer.value) || outer.value.length !== entries.length ||
        outer.value.some(row => !row || typeof row.ok !== 'boolean' || row.committed !== false)) {
        invalid('invalid batched file receipt')
      }
      entries.forEach((entry, i) => {
        if (pending.has(entry)) {
          const reply = (outer.value as { ok: boolean }[])[i]!
          entry.resolve({ ...run, code: reply.ok ? 0 : 1, stdout: Buffer.from(JSON.stringify(reply)) })
        }
      })
    } catch (error) {
      for (const entry of pending) entry.reject(error)
    } finally {
      for (const stop of cleanup) stop()
    }
  }

  private async call(target: RpcTarget, op: NativeMethod, payload: object, options: NativeOptions = {}): Promise<unknown> {
    const started = performance.now()
    let outcome: Outcome = 'error'
    const mutating = op === 'fs.write' || op === 'fs.edit'
    try {
      const run = await this.submit(target, op, payload, options)
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

  async snapshot(target: RpcTarget, path: string, streamMinSize: number,
    options?: NativeOptions): Promise<NativeSnapshot> {
    if (!Number.isSafeInteger(streamMinSize) || streamMinSize < 1) {
      throw new NativeFileError('FS_IO_ERROR', 'invalid snapshot streaming threshold')
    }
    const value = await this.call(target, 'fs.snapshot', { path, streamMinSize }, options) as {
      path?: unknown; info?: unknown; data?: unknown; dataZ?: unknown; rawBytes?: unknown
    }
    if (!value || !validPath(value.path) || (value.info !== null && !isInfo(value.info))) invalid()
    const data = decodedReadData(value, NATIVE_MAX_BYTES, true)
    if (data !== null && (value.info as NativeInfo | null)?.type !== 'file') invalid()
    return { path: value.path, info: value.info as NativeInfo | null, data }
  }


  /** One physical Linux open/scan, returning only bounded model-visible lines and fresh observation. */
  async window(target: RpcTarget, path: string, request: {
    offset: number; limit: number; maxLineLength: number; maxBytes: number;
  }, options?: NativeOptions): Promise<NativeWindow | undefined> {
    // Preserve the existing full-read path for unusually large host-configured
    // read caps; native windowing intentionally never allocates huge line arrays.
    if (request.maxLineLength > 65536 || request.maxBytes > 1048576 || request.limit > 100000) return undefined
    if (!Object.values(request).every(v => Number.isSafeInteger(v) && v > 0)) {
      throw new NativeFileError('FS_IO_ERROR', 'invalid native read window limits')
    }
    const value = await this.call(target, 'fs.window', { path, ...request }, options) as
      Partial<NativeWindow> | undefined
    if (!value || !validPath(value.path)) invalid('invalid native window response')
    if (value.fallback === true) {
      if (value.info !== undefined || value.lines !== undefined) invalid('invalid native window fallback')
      return { path: value.path, fallback: true, info: null, lines: [],
        totalLines: 0, truncatedByBytes: false, outOfRange: false }
    }
    if (value.fallback !== undefined || (value.info !== null && !isInfo(value.info))
      || !Array.isArray(value.lines)
      || !Number.isSafeInteger(value.totalLines) || (value.totalLines as number) < 0
      || typeof value.truncatedByBytes !== 'boolean' || typeof value.outOfRange !== 'boolean'
      || value.lines.length > request.limit) invalid('invalid native window response')
    if (value.info?.type !== 'file' && (value.lines.length || value.totalLines || value.outOfRange || value.truncatedByBytes)) {
      invalid('invalid non-file window')
    }
    let previous = request.offset - 1
    for (const line of value.lines) {
      if (!line || !Number.isSafeInteger(line.number) || line.number !== previous + 1
        || line.number > value.totalLines! || typeof line.text !== 'string') invalid('invalid native window line')
      previous = line.number
    }
    return value as NativeWindow
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
    return decodedReadData(value, max, false) as Buffer
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
