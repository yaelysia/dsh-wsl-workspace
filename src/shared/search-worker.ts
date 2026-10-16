import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { GREP_SCRIPT, GLOB_SCRIPT } from './search-scripts.ts'
import { SEARCH_WORKER_BOOTSTRAP, SEARCH_WORKER_LAUNCH, SEARCH_WORKER_SCRIPT } from './search-worker-script.ts'

export interface SearchRequest {
  op: 'grep' | 'glob'
  cwd: string
  args: readonly string[]
  timeoutMs: number
  maxBytes: number
}
export interface SearchRun {
  code: number | null
  stdout: Buffer
  stderr: Buffer
  aborted: boolean
  signal: NodeJS.Signals | null
  overflow?: boolean
}
export interface WorkerOptions {
  command: string
  argv: readonly string[]
  idleMs?: number
  bootTimeoutMs?: number
  /** Trusted test seam. Runtime callers always use the shipped read-only scripts. */
  scripts?: { grep: string; glob: string }
}
interface Pending {
  request: SearchRequest
  finish: (error: Error | undefined, result?: SearchRun) => void
  timer: ReturnType<typeof setTimeout>
  sent: boolean
  cancelled: boolean
}
interface Header {
  id?: number
  ready?: number
  pid?: number
  code?: number | null
  aborted?: boolean
  overflow?: boolean
  error?: string | null
  outBytes: number
  errBytes: number
}

export class SearchWorkerUnavailable extends Error {}
export class SearchWorkerCancelled extends Error {}
export class SearchWorkerBusy extends Error {}

/** A bounded, multiplexed byte channel; it never shares the agent's stateful Bash. */
export class SearchWorker {
  private readonly options: WorkerOptions
  private child: ChildProcessWithoutNullStreams | undefined
  private opening: Promise<void> | undefined
  private opened: (() => void) | undefined
  private openingFailed: ((error: Error) => void) | undefined
  private ready = false
  private closed = false
  private serial = 0
  private pending = new Map<number, Pending>()
  private idle: ReturnType<typeof setTimeout> | undefined
  private boot: ReturnType<typeof setTimeout> | undefined
  private diagnostic = Buffer.alloc(0)
  private headerBytes = Buffer.alloc(0)
  private header: Header | undefined
  private chunks: Buffer[] = []
  private received = 0
  pid: number | undefined

  constructor(options: WorkerOptions) { this.options = options }
  get active(): number { return this.pending.size }
  get dead(): boolean { return this.closed }

  run(request: SearchRequest, signal?: AbortSignal): Promise<SearchRun> {
    if (signal?.aborted) return Promise.reject(new SearchWorkerCancelled('search cancelled'))
    if (this.closed) return Promise.reject(new SearchWorkerUnavailable('search worker is closed'))
    if (this.pending.size >= 4) return Promise.reject(new SearchWorkerBusy('search worker is busy'))
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 600_000
      || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > 64 * 1024 * 1024
      || !request.cwd.startsWith('/') || request.cwd.includes('\0')
      || request.args.length > 4096 || request.args.some(arg => arg.includes('\0'))) {
      return Promise.reject(new Error('invalid search request'))
    }
    const id = ++this.serial
    const deadline = performance.now() + request.timeoutMs
    if (this.idle !== undefined) clearTimeout(this.idle)
    return new Promise<SearchRun>((resolve, reject) => {
      const cancel = () => {
        const call = this.pending.get(id)
        if (call === undefined || call.cancelled) return
        call.cancelled = true
        clearTimeout(call.timer)
        if (!call.sent) {
          call.finish(new SearchWorkerCancelled('search cancelled or timed out during startup'))
          return
        }
        this.send({ cancel: id })
        // Only a broken control channel retires siblings; ordinary cancellation is per request.
        call.timer = setTimeout(() => this.fail(new Error('search worker did not acknowledge cancellation')), 2_000)
      }
      const call: Pending = {
        request, sent: false, cancelled: false,
        timer: setTimeout(cancel, request.timeoutMs),
        finish: (error, result) => {
          if (!this.pending.delete(id)) return
          clearTimeout(call.timer)
          signal?.removeEventListener('abort', cancel)
          if (error !== undefined) reject(error)
          else if (result !== undefined) resolve({ ...result, aborted: result.aborted || call.cancelled })
          this.armIdle()
        },
      }
      this.pending.set(id, call)
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      if (!this.pending.has(id)) return
      this.open().then(() => {
        if (!this.pending.has(id)) return
        const remaining = Math.ceil(deadline - performance.now())
        if (remaining < 1) { cancel(); return }
        const value = { ...request, id, timeoutMs: remaining }
        if (Buffer.byteLength(JSON.stringify(value)) + 1 > 1024 * 1024) {
          call.finish(new Error('search request exceeds protocol limit'))
          return
        }
        call.sent = true
        this.send(value)
      }, error => call.finish(error instanceof Error ? error : new Error(String(error))))
    })
  }

  private open(): Promise<void> {
    if (this.opening !== undefined) return this.opening
    this.opening = new Promise<void>((resolve, reject) => {
      this.opened = resolve
      this.openingFailed = reject
      this.boot = setTimeout(() => this.fail(new Error('Python search worker startup timed out')), this.options.bootTimeoutMs ?? 5_000)
      try {
        this.child = spawn(this.options.command, [...this.options.argv, '--noprofile', '--norc', '-c', SEARCH_WORKER_LAUNCH, 'dsh', SEARCH_WORKER_BOOTSTRAP], {
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        })
        const scripts = this.options.scripts ?? { grep: GREP_SCRIPT, glob: GLOB_SCRIPT }
        const encoded = Buffer.from(JSON.stringify(scripts)).toString('base64')
        const program = `import base64,json\nSCRIPTS=json.loads(base64.b64decode('${encoded}'))\n${SEARCH_WORKER_SCRIPT}`
        this.child.stdout.on('data', (chunk: Buffer) => {
          try { this.consume(chunk) } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
        })
        this.child.stderr.on('data', (chunk: Buffer) => {
          this.diagnostic = Buffer.concat([this.diagnostic, chunk]).subarray(-4096)
        })
        this.child.on('error', error => this.fail(error))
        this.child.stdin.on('error', error => this.fail(error))
        this.child.on('close', code => this.fail(new Error(`search worker exited (${code}): ${this.diagnostic.toString('utf8').replaceAll('\0', '')}`)))
        this.child.stdin.write(Buffer.from(program).toString('hex') + '\n')
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    return this.opening
  }

  private send(value: unknown): void {
    if (this.closed) return
    this.child?.stdin.write(JSON.stringify(value) + '\n', error => {
      if (error) this.fail(error)
    })
  }

  private consume(chunk: Buffer): void {
    while (chunk.length > 0 && !this.closed) {
      if (this.header === undefined) {
        const end = chunk.indexOf(10)
        const prefix = end < 0 ? chunk : chunk.subarray(0, end)
        if (this.headerBytes.length + prefix.length > 4096) throw new Error('invalid search response header')
        this.headerBytes = Buffer.concat([this.headerBytes, prefix])
        if (end < 0) return
        const header = JSON.parse(this.headerBytes.toString('utf8')) as Header
        this.headerBytes = Buffer.alloc(0)
        chunk = chunk.subarray(end + 1)
        if (!this.ready) {
          if (header.ready !== 1 || !Number.isSafeInteger(header.pid) || header.outBytes !== 0 || header.errBytes !== 0) {
            throw new Error('incompatible search worker handshake')
          }
          this.ready = true
          this.pid = header.pid
          if (this.boot !== undefined) clearTimeout(this.boot)
          this.opened?.()
          this.armIdle()
          continue
        }
        const call = this.pending.get(header.id ?? 0)
        if (call === undefined || !call.sent
          || !Number.isSafeInteger(header.outBytes) || header.outBytes < 0 || header.outBytes > call.request.maxBytes
          || !Number.isSafeInteger(header.errBytes) || header.errBytes < 0 || header.errBytes > 1024 * 1024
          || (header.code !== null && !Number.isSafeInteger(header.code))
          || typeof header.aborted !== 'boolean' || typeof header.overflow !== 'boolean'
          || (header.error !== null && typeof header.error !== 'string')) {
          throw new Error('invalid search response')
        }
        this.header = header
        this.chunks = []
        this.received = 0
      }
      const total = this.header.outBytes + this.header.errBytes
      const take = Math.min(total - this.received, chunk.length)
      if (take > 0) this.chunks.push(chunk.subarray(0, take))
      chunk = chunk.subarray(take)
      this.received += take
      if (this.received < total) return
      const header = this.header
      const payload = Buffer.concat(this.chunks, total)
      this.header = undefined
      this.chunks = []
      const call = this.pending.get(header.id ?? 0)
      if (header.error) call?.finish(new Error(`native search failed: ${header.error}`))
      else call?.finish(undefined, {
        code: header.code ?? null, stdout: payload.subarray(0, header.outBytes), stderr: payload.subarray(header.outBytes),
        aborted: header.aborted ?? false, overflow: header.overflow ?? false,
        signal: (header.code ?? 0) < 0 ? 'SIGKILL' : null,
      })
    }
  }

  private armIdle(): void {
    if (this.closed || !this.ready || this.pending.size !== 0) return
    if (this.idle !== undefined) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.dispose(), this.options.idleMs ?? 120_000)
    this.idle.unref()
  }

  private fail(error: Error): void {
    if (this.closed) return
    const reason = this.ready ? error : new SearchWorkerUnavailable(error.message)
    this.openingFailed?.(reason)
    this.dispose(reason)
  }

  /** EOF lets Python stop and reap its Linux process groups before WSL exits. */
  dispose(reason: Error = new Error('search worker disposed')): void {
    if (this.closed) return
    this.closed = true
    if (this.idle !== undefined) clearTimeout(this.idle)
    if (this.boot !== undefined) clearTimeout(this.boot)
    this.openingFailed?.(reason)
    for (const call of this.pending.values()) call.finish(call.cancelled ? new SearchWorkerCancelled('search cancelled') : reason)
    this.chunks = []
    this.headerBytes = Buffer.alloc(0)
    const child = this.child
    if (child === undefined) return
    child.stdin.end()
    const killer = setTimeout(() => child.kill(), 3_000)
    killer.unref()
    child.once('close', () => clearTimeout(killer))
  }
}
