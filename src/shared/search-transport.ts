/** Bounded, lazily started search-only workers. No interactive shell state is shared. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { decodeWslOutput } from './wsl.ts'
import { searchWorkerCode } from './search-worker.ts'

export interface SearchTarget { distro: string; username?: string; linuxCwd: string; wslPath: string }
export interface SearchRun { code: number | null; stdout: Buffer; stderr: Buffer; aborted: boolean; signal: NodeJS.Signals | null }
export interface SearchRequest { op: 'grep' | 'glob'; args: readonly string[]; timeoutMs: number; maxBytes: number; signal?: AbortSignal }
export type SearchLauncher = (target: SearchTarget, code: string) => ChildProcessWithoutNullStreams
interface Options { launch?: SearchLauncher; idleMs?: number; bootMs?: number; maxWorkers?: number; cooldownMs?: number }
interface Pending {
  done(value: SearchRun): void
  fail(error: Error): void
  cleanup(): void
  maxBytes: number
  answered: boolean
  cancelTimer?: ReturnType<typeof setTimeout>
}

const abortedRun = (): SearchRun => ({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), aborted: true, signal: null })
const MAX_REQUEST = 1_048_576
const MAX_PENDING = 16
const MAX_BYTES = 64 * 1_048_576
const PROTOCOL_SLACK = 2 * 1_048_576

export class SearchTransportError extends Error {
  readonly stage: 'startup' | 'request'
  readonly code: string
  constructor(message: string, stage: 'startup' | 'request', code = 'SEARCH_FAILED') {
    super(message)
    this.stage = stage
    this.code = code
    this.name = 'SearchTransportError'
  }
}

const abortedError = () => new SearchTransportError('search cancelled or deadline expired', 'request', 'SEARCH_ABORTED')

/** The supplied launch string is single-line ASCII; user values only cross the stdin channel. */
function launchWsl(target: SearchTarget, code: string): ChildProcessWithoutNullStreams {
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

  private readonly options: Required<Options>
  private readonly onIdle: () => void

  constructor(target: SearchTarget, options: Required<Options>, onIdle: () => void) {
    this.options = options
    this.onIdle = onIdle
    this.ready = new Promise((resolve, reject) => { this.acceptReady = resolve; this.rejectReady = reject })
    // A start can fail before the first call reaches awaitReady; keep the rejection observed.
    void this.ready.catch(() => {})
    try {
      const child = this.options.launch(target, searchWorkerCode())
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

  async run(target: SearchTarget, request: SearchRequest): Promise<SearchRun> {
    const start = performance.now()
    if (this.closed) {
      await this.ready
      throw new SearchTransportError('search worker is closed', 'request')
    }
    if (this.pending.size + this.waiting >= MAX_PENDING) throw new SearchTransportError('search queue is full (16 requests)', 'request')
    clearTimeout(this.idleTimer)
    this.ref(true)
    this.waiting++
    try { await awaitReady(this.ready, request.timeoutMs, request.signal) }
    finally { this.waiting--; this.rest() }
    const remaining = Math.floor(request.timeoutMs - (performance.now() - start))
    if (request.signal?.aborted || remaining <= 0) return abortedRun()
    if (this.closed) throw new SearchTransportError('search worker closed before dispatch', 'request')
    const id = this.nextId++
    const message = JSON.stringify({ id, op: request.op, args: request.args, cwd: target.linuxCwd,
      timeoutMs: remaining, maxBytes: request.maxBytes }) + '\n'
    if (Buffer.byteLength(message) > MAX_REQUEST) throw new SearchTransportError('search request exceeds 1 MiB', 'request')
    clearTimeout(this.idleTimer)
    this.ref(true)
    return new Promise<SearchRun>((resolve, reject) => {
      const cancel = () => {
        const pending = this.pending.get(id)
        if (!pending || pending.answered) return
        pending.answered = true
        pending.cleanup()
        resolve(abortedRun())
        // Keep the slot until acknowledgement: cancelled callers cannot flood the Linux queue.
        this.send(JSON.stringify({ id, op: 'cancel' }) + '\n')
        pending.cancelTimer = setTimeout(() => this.break('worker did not acknowledge cancellation'), 1500)
        pending.cancelTimer.unref()
      }
      const timer = setTimeout(cancel, remaining)
      const cleanup = () => { clearTimeout(timer); request.signal?.removeEventListener('abort', cancel) }
      this.pending.set(id, { done: resolve, fail: reject, cleanup, maxBytes: request.maxBytes, answered: false })
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
      if (value.ready !== 1 || !Number.isSafeInteger(value.pid)) throw new Error('protocol/version mismatch')
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
    let result: SearchRun | undefined
    if (typeof value.error !== 'string') {
      if (typeof value.aborted !== 'boolean' || (value.code !== null && !Number.isSafeInteger(value.code))) throw new Error('invalid status')
      const decode = (raw: unknown, max: number): Buffer => {
        if (typeof raw !== 'string') throw new Error('invalid byte payload')
        const bytes = Buffer.from(raw, 'base64')
        if (bytes.length > max || bytes.toString('base64') !== raw) throw new Error('invalid or oversized base64')
        return bytes
      }
      const code = value.code as number | null
      result = { code, aborted: value.aborted || (code !== null && code < 0), signal: null,
        stdout: decode(value.stdout, pending.maxBytes + 1), stderr: decode(value.stderr, MAX_REQUEST) }
    }
    this.pending.delete(id)
    pending.cleanup()
    clearTimeout(pending.cancelTimer)
    if (!pending.answered) {
      if (result) pending.done(result)
      else pending.fail(new SearchTransportError(String(value.error), 'request'))
    }
    this.rest()
  }

  private break(message: string): void {
    if (this.closed) return
    const error = new SearchTransportError(message, this.booted ? 'request' : 'startup')
    this.rejectReady(error)
    for (const pending of this.pending.values()) {
      pending.cleanup(); clearTimeout(pending.cancelTimer)
      if (!pending.answered) pending.fail(error)
    }
    this.pending.clear()
    this.dispose()
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.idleTimer); clearTimeout(this.bootTimer)
    this.rejectReady(new SearchTransportError('search transport disposed', 'request'))
    for (const pending of this.pending.values()) {
      pending.cleanup(); clearTimeout(pending.cancelTimer)
      if (!pending.answered) pending.done(abortedRun())
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

/** One pool per mounted search provider, bounded across distro/user/executable identities. */
export class SearchWorkerPool {
  private readonly options: Required<Options>
  private workers = new Map<string, Worker>()
  private unavailable = new Map<string, { until: number; error: SearchTransportError }>()
  private disposed = false
  private launches = 0

  constructor(options: Options = {}) {
    this.options = { launch: launchWsl, idleMs: 30_000, bootMs: 15_000, maxWorkers: 4, cooldownMs: 60_000, ...options }
    for (const key of ['idleMs', 'bootMs', 'maxWorkers', 'cooldownMs'] as const) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] <= 0) throw new RangeError(`invalid ${key}`)
    }
  }

  snapshot(): { workers: number; launches: number } {
    return { workers: this.workers.size, launches: this.launches }
  }

  async run(target: SearchTarget, request: SearchRequest): Promise<SearchRun> {
    if (this.disposed) throw new SearchTransportError('search pool is disposed', 'request')
    if (request.signal?.aborted) return abortedRun()
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > 86_400_000
      || !Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0 || request.maxBytes > MAX_BYTES) {
      throw new SearchTransportError('invalid search timeout or byte budget', 'request')
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
        if (!idle) throw new SearchTransportError('all search workers are busy', 'request')
        idle[1].dispose(); this.workers.delete(idle[0])
      }
      worker = new Worker(target, this.options, () => { if (this.workers.get(key) === worker) this.workers.delete(key) })
      this.workers.set(key, worker)
      this.launches++
    } else { this.workers.delete(key); this.workers.set(key, worker) }
    try { return await worker.run(target, request) }
    catch (error) {
      if (error instanceof SearchTransportError && error.stage === 'startup') {
        this.unavailable.set(key, { until: performance.now() + this.options.cooldownMs, error })
        while (this.unavailable.size > 16) this.unavailable.delete(this.unavailable.keys().next().value!)
      }
      throw error
    }
  }

  /** Fall back only before dispatch; a request that may have run is never replayed. */
  async runAuto(target: SearchTarget, request: SearchRequest,
    fallback: (remainingMs: number, reason: string) => Promise<SearchRun>): Promise<SearchRun> {
    const started = performance.now()
    try { return await this.run(target, request) }
    catch (error) {
      if (!(error instanceof SearchTransportError) || error.stage !== 'startup') throw error
      const remaining = Math.floor(request.timeoutMs - (performance.now() - started))
      if (this.disposed || request.signal?.aborted || remaining <= 0) return abortedRun()
      return fallback(remaining, error.message)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const worker of this.workers.values()) worker.dispose()
    this.workers.clear(); this.unavailable.clear()
  }
}
