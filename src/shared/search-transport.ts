import { performance } from 'node:perf_hooks'
import { SearchWorker, SearchWorkerBusy, SearchWorkerUnavailable, type SearchRequest, type SearchRun, type WorkerOptions } from './search-worker.ts'

export type SearchTransportMode = 'auto' | 'oneshot' | 'persistent'
export interface SearchTarget { distro: string; username?: string; linuxCwd: string }
type OneShot = (target: SearchTarget, request: SearchRequest, signal?: AbortSignal) => Promise<SearchRun>
interface Entry { worker: SearchWorker | undefined; retryAt: number }

/** Small per-provider LRU, keyed by Linux identity, with request-local cwd and cancellation. */
export class SearchTransport {
  private readonly entries = new Map<string, Entry>()
  private disposed = false
  private readonly mode: SearchTransportMode
  private readonly oneShot: OneShot
  private readonly commandFor: (target: SearchTarget) => WorkerOptions
  private readonly warn: (message: string) => void

  constructor(mode: SearchTransportMode, oneShot: OneShot, commandFor: (target: SearchTarget) => WorkerOptions,
    warn: (message: string) => void = () => {}) {
    this.mode = mode
    this.oneShot = oneShot
    this.commandFor = commandFor
    this.warn = warn
  }

  async run(target: SearchTarget, request: SearchRequest, signal?: AbortSignal): Promise<SearchRun> {
    if (this.disposed) throw new Error('search transport disposed')
    if (this.mode === 'oneshot' || (this.mode === 'auto' && request.maxBytes > 64 * 1024 * 1024)) return this.oneShot(target, request, signal)
    const started = performance.now()
    const key = JSON.stringify([target.distro, target.username ?? null])
    let entry = this.entries.get(key)
    if (entry === undefined) {
      if (this.entries.size >= 4) {
        const oldest = [...this.entries].find(([, value]) => (value.worker?.active ?? 0) === 0)
        if (oldest === undefined) {
          if (this.mode === 'auto') return this.oneShot(target, request, signal)
          throw new SearchWorkerBusy('all search workers are busy')
        }
        oldest[1].worker?.dispose()
        this.entries.delete(oldest[0])
      }
      entry = { worker: undefined, retryAt: 0 }
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    if (entry.retryAt > started) return this.oneShot(target, request, signal)
    if (entry.worker === undefined || entry.worker.dead) entry.worker = new SearchWorker(this.commandFor(target))
    const worker = entry.worker
    try {
      return await worker.run(request, signal)
    } catch (error) {
      // Only failures before dispatch or capacity pressure may use the old path.
      // An aborted, failed or disconnected in-flight search is never silently replayed.
      if (this.mode !== 'auto' || !(error instanceof SearchWorkerUnavailable || error instanceof SearchWorkerBusy)) throw error
      if (error instanceof SearchWorkerUnavailable) {
        worker.dispose()
        if (entry.worker === worker) {
          entry.worker = undefined
          entry.retryAt = performance.now() + 30_000
          this.warn(`WSL search: using one-shot transport for ${target.distro}; ${error.message}`)
        }
      }
      const remaining = Math.floor(request.timeoutMs - (performance.now() - started))
      if (remaining < 1 || signal?.aborted || this.disposed) throw error
      return this.oneShot(target, { ...request, timeoutMs: remaining }, signal)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.entries.values()) entry.worker?.dispose()
    this.entries.clear()
  }
}
