/** Shared, bounded WSL RPC lifecycle. Only versioned, bundled methods are accepted; dispatched mutations are never replayed. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { decodeWslOutput } from './wsl.ts'
import { rpcWorkerCode } from './rpc-worker.ts'
import { RPC_METHODS, RpcMetrics, rpcRunOutcome, type Outcome, type RpcMethod } from './rpc-metrics.ts'

export interface RpcTarget { distro: string; username?: string; linuxCwd: string; wslPath: string }
export interface RpcTiming { readyMs: number; roundTripMs: number; queueMs?: number; executionMs?: number }
export interface RpcRun { timing?: RpcTiming; code: number | null; stdout: Buffer; stderr: Buffer; aborted: boolean; signal: NodeJS.Signals | null }
export interface RpcRequest { op: RpcMethod; args: readonly string[]; timeoutMs: number; maxBytes: number; signal?: AbortSignal }
export type RpcLauncher = (target: RpcTarget, code: string) => ChildProcessWithoutNullStreams
export interface RpcOptions { launch?: RpcLauncher; idleMs?: number; bootMs?: number; maxWorkers?: number; cooldownMs?: number; metrics?: boolean }
interface Pending {
  mutating: boolean
  cancelling: boolean
  done(value: RpcRun): void
  fail(error: Error): void
  cleanup(): void
  maxBytes: number
  answered: boolean
  readyMs: number
  sentAt: number
  cancelTimer?: ReturnType<typeof setTimeout>
}

const abortedRun = (): RpcRun => ({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), aborted: true, signal: null })
const MAX_REQUEST = 1_048_576
const MAX_FILE_REQUEST = 32 * MAX_REQUEST
const mutationUnknown = (message: string) => new RpcTransportError(`file mutation result unknown: ${message}; re-read before retrying`, 'request', 'RPC_MUTATION_UNKNOWN')
const MAX_PENDING = 16
const MAX_BYTES = 64 * 1_048_576
const PROTOCOL_SLACK = 2 * 1_048_576

export class RpcTransportError extends Error {
  readonly stage: 'startup' | 'request'
  readonly code: string
  constructor(message: string, stage: 'startup' | 'request', code = 'RPC_FAILED') {
    super(message)
    this.stage = stage
    this.code = code
    this.name = 'RpcTransportError'
  }
}

const abortedError = () => new RpcTransportError('search cancelled or deadline expired', 'request', 'RPC_ABORTED')

/** The supplied launch string is single-line ASCII; user values only cross the stdin channel. */
function launchWsl(target: RpcTarget, code: string): ChildProcessWithoutNullStreams {
  return spawn(target.wslPath, ['-d', target.distro,
    ...target.username === undefined ? [] : ['-u', target.username],
    '--cd', '/', '-e', 'python3', '-I', '-S', '-u', '-c', code],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
}

function awaitReady(ready: Promise<void>, timeout: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || timeout <= 0) return Promise.reject(abortedError())
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(abortedError()) }
    const timer = setTimeout(cancel, timeout)
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
    signal?.addEventListener('abort', cancel, { once: true })
    ready.then(() => { cleanup(); resolve() }, error => { cleanup(); reject(error) })
  })
}

/** Decode only canonical, bounded base64. Both RPC envelopes and native file bodies use this rule. */
export function decodeRpcBytes(raw: unknown, max: number): Buffer {
  if (typeof raw !== 'string') throw new Error('invalid byte payload')
  const bytes = Buffer.from(raw, 'base64')
  if (bytes.length > max || bytes.toString('base64') !== raw) throw new Error('invalid or oversized base64')
  return bytes
}

class Worker {
  readonly ready: Promise<void>
  closed = false
  private booted = false
  private child: ChildProcessWithoutNullStreams | undefined
  private bootTimer: ReturnType<typeof setTimeout> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private acceptReady!: () => void
  private rejectReady!: (error: Error) => void
  private pending = new Map<number, Pending>()
  private waiting = 0
  private nextId = 1
  private chunks: Buffer[] = []
  private chunkBytes = 0
  private stderr = Buffer.alloc(0)

  private readonly options: Required<RpcOptions>
  private readonly onIdle: () => void

  constructor(target: RpcTarget, options: Required<RpcOptions>, onIdle: () => void) {
    this.options = options
    this.onIdle = onIdle
    this.ready = new Promise((resolve, reject) => { this.acceptReady = resolve; this.rejectReady = reject })
    // A start can fail before the first call reaches awaitReady; keep the rejection observed.
    void this.ready.catch(() => {})
    try {
      const child = this.options.launch(target, rpcWorkerCode())
      this.child = child
      child.stdout.on('data', (chunk: Buffer) => this.read(chunk))
      child.stderr.on('data', (chunk: Buffer) => {
        this.stderr = Buffer.concat([this.stderr, chunk]).subarray(-8192)
      })
      child.stdin.on('error', error => this.break(error.message))
      child.on('error', error => this.break(error.message))
      child.on('close', () => this.break(`worker closed: ${decodeWslOutput(this.stderr).trim().slice(0,1024)}`))
      this.bootTimer = setTimeout(() => this.break('search worker did not become ready'), options.bootMs)
    } catch (error) { this.break(String(error)) }
  }

  get outstanding(): number { return this.pending.size + this.waiting }

  get idle(): boolean { return this.booted && this.waiting === 0 && this.pending.size === 0 }

  private ref(active: boolean): void {
    if (!this.child) return
    if (active) this.child.ref(); else this.child.unref()
    for (const pipe of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      const handle = pipe as unknown as { ref?(): void; unref?(): void }
      if (active) handle.ref?.(); else handle.unref?.()
    }
  }

  private rest(): void {
    if (this.closed || !this.idle) return
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { this.dispose(); this.onIdle() }, this.options.idleMs)
    this.idleTimer.unref()
    this.ref(false)
  }

  async run(target: RpcTarget, request: RpcRequest): Promise<RpcRun> {
    const start = performance.now()
    if (this.closed) {
      await this.ready
      throw new RpcTransportError('search worker is closed', 'request')
    }
    if (this.pending.size + this.waiting >= MAX_PENDING) throw new RpcTransportError('search queue is full (16 requests)', 'request')
    clearTimeout(this.idleTimer)
    this.ref(true)
    this.waiting++
    try { await awaitReady(this.ready, request.timeoutMs, request.signal) }
    finally { this.waiting--; this.rest() }
    const remaining = Math.floor(request.timeoutMs - (performance.now() - start))
    if (request.signal?.aborted || remaining <= 0) return abortedRun()
    if (this.closed) throw new RpcTransportError('search worker closed before dispatch', 'request')
    const id = this.nextId++
    const message = JSON.stringify({ id, op: request.op, args: request.args, cwd: target.linuxCwd,
      timeoutMs: remaining, maxBytes: request.maxBytes }) + '\n'
    if (Buffer.byteLength(message) > (request.op.startsWith('fs.') && request.op !== 'fs.metadata' ? MAX_FILE_REQUEST : MAX_REQUEST)) throw new RpcTransportError('RPC request exceeds its byte limit', 'request', 'RPC_TOO_LARGE')
    clearTimeout(this.idleTimer)
    this.ref(true)
    return new Promise<RpcRun>((resolve, reject) => {
      const cancel = () => {
        const pending = this.pending.get(id)
        if (!pending || pending.answered || pending.cancelling) return
        pending.cancelling = true
        pending.cleanup()
        if (!pending.mutating) { pending.answered = true; resolve(abortedRun()) }
        // Keep the slot until acknowledgement: cancelled callers cannot flood the Linux queue.
        this.send(JSON.stringify({ id, op: 'cancel' }) + '\n')
        pending.cancelTimer = setTimeout(() => this.break('worker did not acknowledge cancellation'), 1500)
        pending.cancelTimer.unref()
      }
      const timer = setTimeout(cancel, remaining)
      const cleanup = () => { clearTimeout(timer); request.signal?.removeEventListener('abort', cancel) }
      this.pending.set(id, { mutating: request.op === 'fs.write' || request.op === 'fs.edit', cancelling: false, done: resolve, fail: reject, cleanup, maxBytes: request.maxBytes, answered: false, readyMs: performance.now() - start, sentAt: performance.now() })
      request.signal?.addEventListener('abort', cancel, { once: true })
      this.send(message)
    })
  }

  private send(message: string): void {
    if (this.closed) return
    this.child?.stdin.write(message, error => { if (error) this.break(error.message) })
  }

  private read(chunk: Buffer): void {
    if (this.closed) return
    const limit = this.booted
      ? Math.ceil((Math.max(0, ...Array.from(this.pending.values(), p => p.maxBytes)) + 1) * 4 / 3) + PROTOCOL_SLACK
      : 8192
    let start = 0
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start)
      const piece = chunk.subarray(start, end < 0 ? undefined : end)
      this.chunks.push(piece)
      this.chunkBytes += piece.length
      if (this.chunkBytes > limit) { this.break('search response exceeds its byte budget'); return }
      if (end < 0) return
      const line = Buffer.concat(this.chunks, this.chunkBytes)
      this.chunks = []; this.chunkBytes = 0
      try { this.reply(JSON.parse(line.toString('utf8')) as Record<string, unknown>) }
      catch (error) { this.break(`invalid search response: ${String(error)}`); return }
      if (this.closed) return
      start = end + 1
    }
  }

  private reply(value: Record<string, unknown>): void {
    if (!value || typeof value !== 'object') throw new Error('not an object')
    if (!this.booted) {
      if (value.ready !== 3 || !Number.isSafeInteger(value.pid) || !Array.isArray(value.methods)
        || !RPC_METHODS.every(method => (value.methods as unknown[]).includes(method))) {
        throw new Error('protocol/version or capability mismatch')
      }
      this.booted = true
      clearTimeout(this.bootTimer)
      this.acceptReady()
      this.rest()
      return
    }
    const id = value.id
    if (typeof id !== 'number') throw new Error('missing request id')
    const pending = this.pending.get(id)
    if (!pending) throw new Error('unknown request id')
    let result: RpcRun | undefined
    if (typeof value.error !== 'string') {
      if (typeof value.aborted !== 'boolean' || (value.code !== null && !Number.isSafeInteger(value.code))) throw new Error('invalid status')
      const timing: RpcTiming = { readyMs: pending.readyMs, roundTripMs: performance.now() - pending.sentAt }
      if (value.timing !== undefined) {
        const native = value.timing as { queueMs?: number; executionMs?: number }
        if (!native || ![native.queueMs, native.executionMs].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
          throw new Error('invalid native timing')
        }
        timing.queueMs = native.queueMs as number; timing.executionMs = native.executionMs as number
      }
      const code = value.code as number | null
      result = { timing, code, aborted: value.aborted || (code !== null && code < 0), signal: null,
        stdout: decodeRpcBytes(value.stdout, pending.maxBytes + 1), stderr: decodeRpcBytes(value.stderr, MAX_REQUEST) }
    }
    this.pending.delete(id)
    pending.cleanup()
    clearTimeout(pending.cancelTimer)
    if (!pending.answered) {
      if (result) pending.done(result)
      else pending.fail(pending.mutating ? mutationUnknown(String(value.error)) : new RpcTransportError(String(value.error), 'request'))
    }
    this.rest()
  }

  private break(message: string): void {
    this.close(new RpcTransportError(message, this.booted ? 'request' : 'startup'))
  }

  dispose(): void { this.close() }

  /** One terminal path; faults reject reads, explicit disposal cancels them, and writes remain unknown. */
  private close(error?: RpcTransportError): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.idleTimer); clearTimeout(this.bootTimer)
    this.rejectReady(error ?? new RpcTransportError('search transport disposed', 'request'))
    for (const pending of this.pending.values()) {
      pending.cleanup(); clearTimeout(pending.cancelTimer)
      if (pending.answered) continue
      if (pending.mutating) pending.fail(mutationUnknown(error?.message ?? 'provider disposed before acknowledgement'))
      else if (error) pending.fail(error)
      else pending.done(abortedRun())
    }
    this.pending.clear()
    this.chunks = []; this.chunkBytes = 0
    const child = this.child
    if (!child) return
    // EOF lets the worker cancel/reap its own Linux process groups, even if Windows exits.
    child.stdin.end()
    const kill = setTimeout(() => child.kill('SIGKILL'), 1000)
    kill.unref()
    child.once('close', () => clearTimeout(kill))
    this.ref(false)
  }
}

/** One owner-scoped pool for all RPC methods, bounded across distro/user/executable identities. */
export class WslRpcPool {
  private readonly options: Required<RpcOptions>
  private workers = new Map<string, Worker>()
  private unavailable = new Map<string, { until: number; error: RpcTransportError }>()
  private disposed = false
  private launches = 0
  private idleReleases = 0
  private lruReleases = 0
  private fallbacks = 0
  readonly metrics: RpcMetrics

  constructor(options: RpcOptions = {}) {
    this.options = { launch: launchWsl, idleMs: 120_000, bootMs: 15_000, maxWorkers: 4, cooldownMs: 60_000, metrics: true, ...options }
    this.metrics = new RpcMetrics(this.options.metrics)
    for (const key of ['idleMs', 'bootMs', 'maxWorkers', 'cooldownMs'] as const) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] <= 0) throw new RangeError(`invalid ${key}`)
    }
  }

  snapshot(): { workers: number; launches: number } {
    return { workers: this.workers.size, launches: this.launches }
  }

  diagnostics() {
    return { ...this.snapshot(), idleMs: this.options.idleMs, maxWorkers: this.options.maxWorkers,
      pending: [...this.workers.values()].reduce((n, worker) => n + worker.outstanding, 0),
      idleReleases: this.idleReleases, lruReleases: this.lruReleases, fallbacks: this.fallbacks,
      metrics: this.metrics.snapshot() }
  }

  async run(target: RpcTarget, request: RpcRequest): Promise<RpcRun> {
    const start = performance.now()
    let outcome: Outcome = 'error'
    try {
      const result = await this.runRequest(target, request)
      outcome = rpcRunOutcome(result, request.op, request.maxBytes)
      if (result.timing) {
        const times = result.timing
        for (const [stage, ms] of [['ready', times.readyMs], ['roundTrip', times.roundTripMs],
          ['queue', times.queueMs], ['execute', times.executionMs]] as const) {
          if (ms !== undefined) this.metrics.record(`rpc.${request.op}.${stage}`, ms, outcome)
        }
      }
      return result
    } catch (error) {
      if (error instanceof RpcTransportError && error.code === 'RPC_ABORTED') outcome = 'aborted'
      throw error
    } finally { this.metrics.record(`rpc.${request.op}.total`, performance.now() - start, outcome) }
  }

  private async runRequest(target: RpcTarget, request: RpcRequest): Promise<RpcRun> {
    if (this.disposed) throw new RpcTransportError('search pool is disposed', 'request')
    if (request.signal?.aborted) return abortedRun()
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > 86_400_000
      || !Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0 || request.maxBytes > MAX_BYTES) {
      throw new RpcTransportError('invalid search timeout or byte budget', 'request')
    }
    if (!(RPC_METHODS as readonly string[]).includes(request.op) || !Array.isArray(request.args)
      || request.args.length > 256 || request.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
      || !target.linuxCwd.startsWith('/') || target.linuxCwd.includes('\0')) {
      throw new RpcTransportError('invalid or excess RPC request', 'request')
    }
    const key = JSON.stringify([target.wslPath, target.distro, target.username ?? null])
    const unavailable = this.unavailable.get(key)
    if (unavailable && unavailable.until > performance.now()) throw unavailable.error
    this.unavailable.delete(key)
    let worker = this.workers.get(key)
    if (worker?.closed) { this.workers.delete(key); worker = undefined }
    if (!worker) {
      if (this.workers.size >= this.options.maxWorkers) {
        const idle = [...this.workers].find(([, w]) => w.idle || w.closed)
        if (!idle) throw new RpcTransportError('all search workers are busy', 'request')
        idle[1].dispose(); this.workers.delete(idle[0]); this.lruReleases++
      }
      worker = new Worker(target, this.options, () => { if (this.workers.get(key) === worker) { this.workers.delete(key); this.idleReleases++ } })
      this.workers.set(key, worker)
      this.launches++
    } else { this.workers.delete(key); this.workers.set(key, worker) }
    try { return await worker.run(target, request) }
    catch (error) {
      if (error instanceof RpcTransportError && error.stage === 'startup') {
        this.unavailable.set(key, { until: performance.now() + this.options.cooldownMs, error })
        while (this.unavailable.size > 16) this.unavailable.delete(this.unavailable.keys().next().value!)
      }
      throw error
    }
  }

  /** Fall back only before dispatch; a request that may have run is never replayed. */
  async runAuto(target: RpcTarget, request: RpcRequest,
    fallback: (remainingMs: number, reason: string) => Promise<RpcRun>): Promise<RpcRun> {
    const started = performance.now()
    try { return await this.run(target, request) }
    catch (error) {
      if (!(error instanceof RpcTransportError) || error.stage !== 'startup') throw error
      const remaining = Math.floor(request.timeoutMs - (performance.now() - started))
      if (this.disposed || request.signal?.aborted || remaining <= 0) return abortedRun()
      this.fallbacks++
      return fallback(remaining, error.message)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const worker of this.workers.values()) worker.dispose()
    this.workers.clear(); this.unavailable.clear()
  }
}
