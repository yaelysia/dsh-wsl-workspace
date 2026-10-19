/**
 * WSL filesystem provider. Native Linux operations use the world's shared RPC;
 * Windows-drive targets and explicitly selected UNC targets retain fs-local.
 * Target keys pin the backend and user that resolved them. Native writes/edit
 * execute guard, match and atomic publication together inside Linux.
 * @module dsh-wsl-workspace/fs
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AsyncLocalStorage } from 'node:async_hooks'
import { link, lstat, rename } from 'node:fs/promises'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsInfo, FsEditOutcome, FsEditRequest, FsPathInfo, FsTarget, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
import { resolveLinuxSymlink } from './shared/links.ts'
import {
  isAbsoluteLinuxPath,
  isValidWslUsername,
  joinUnc,
  mntToWindowsPath,
  parseWslUnc,
  windowsToMntPath,
} from './shared/paths.ts'
import { defaultDistroSync } from './shared/wsl.ts'
import { getWorkspaceUsername } from './shared/wsl-credentials.ts'
import { WslRpcPool, RpcTransportError, type RpcOptions, type RpcTarget } from './shared/rpc-transport.ts'
import { registerRpcDiagnostics } from './shared/rpc-metrics.ts'
import { resolveFileConfig, nativeKey, nativeCoordinate, type FileOptions, type NativeCoordinate } from './shared/native-file-config.ts'
import { NativeFileClient, NativeFileError, decodeNativeText, type NativePolicy } from './shared/native-files.ts'

/** Plugin config. `cwd`/`distro` are optional because UNC workdirs carry both. */
export interface Config {
  /** auto selects native when supported, native requires it, unc opts out. */
  backend?: string
  idleMs?: number
  metrics?: boolean
  wslPath?: string
  /** Base directory for relative paths without a per-call cwd (UNC or Linux). */
  cwd?: string
  /** Default distribution for Linux-absolute paths without a UNC cwd. */
  distro?: string
  /** Exclusive UTF-8 byte limit on each overwrite-diff side (see fs-local). */
  diffBasisMaxBytes?: number
}

/** The host file-effect policy for one call, as `ctx.sandboxPolicy` resolves it. */
export interface SandboxPolicyLike {
  mode: string
  workspaceRoot?: string
}

/** The `ctx.sandboxPolicy` face this backend fences its writes with (optional service). */
export interface SandboxPolicyFace {
  /** Deployment default mode, mirrored as this backend's `sandboxMode`. */
  defaultMode?: string
  /** Per-call (or session-resolved) policy. */
  resolve(): SandboxPolicyLike
}


/** One translated coordinate: the input the local backend opens plus its cwd. */
interface Translated {
  /** Absolute path to hand to the local backend (UNC or Windows drive). */
  input: string
  /** Absolute Windows-side base for relative inputs (UNC or Windows drive). */
  cwd: string
}

interface ToolExecution {
  agent?: { session: { header: { cwd?: string } } }
}

/**
 * The WSL filesystem backend. Identity keys are canonical UNC paths; the
 * Linux form is derived on demand, so both worlds stay in sync across
 * aliases and symlinks.
 */
export class WslFileSystem extends LocalFileSystem {
  static override Config: z<Config> = z.object({
    backend: z.string(), idleMs: z.number(), metrics: z.boolean(), wslPath: z.string(),
    cwd: z.string(),
    distro: z.string(),
    diffBasisMaxBytes: z.number().default(10 * 1024 * 1024),
  })

  /** Owner-scoped RPC shared by this filesystem and the search provider in the same realm. */
  readonly wslRpcPool: WslRpcPool | undefined
  private readonly nativeClient: NativeFileClient | undefined
  private readonly fileOptions: FileOptions
  private readonly nativeOnThisHost: boolean
  private warnedFallback = false
  private readonly distro: string | undefined
  private readonly executionCwd = new AsyncLocalStorage<string | undefined>()

  constructor(ctx: Context, config: Config, rpcOptions: RpcOptions = {}) {
    // schemastery fills the defaults before construction; the parent validates
    // `diffBasisMaxBytes` and stores the resolved shape.
    super(ctx, config)
    this.distro = config.distro
    this.fileOptions = resolveFileConfig(config)
    this.nativeOnThisHost = process.platform === 'win32' || rpcOptions.launch !== undefined
    if (typeof ctx.effect === 'function') {
      this.wslRpcPool = new WslRpcPool({ idleMs: this.fileOptions.idleMs, metrics: this.fileOptions.metrics, ...rpcOptions })
      this.nativeClient = new NativeFileClient(this.wslRpcPool)
      ctx.effect(() => {
        const unregister = registerRpcDiagnostics(() => ({ owner: 'wsl-filesystem', mode: this.fileOptions.backend,
          ...this.wslRpcPool!.diagnostics() }))
        return () => { unregister(); this.wslRpcPool?.dispose() }
      })
    } else if (this.fileOptions.backend === 'native') {
      throw new FsError('native filesystem requires a host disposal scope', 'FS_IO_ERROR')
    }
    ctx.on('tools/execute', (exec: ToolExecution, next: () => unknown) => (
      this.executionCwd.run(exec.agent?.session.header.cwd, next)
    ))
    // The 9P/drvfs substrate has no hard links and no Win32 security semantics:
    // replace the atomic-publication boundaries the parent's fsio defaults to.
    this.internals = {
      linkFile: WslFileSystem.publishNoReplace,
      replaceFile: WslFileSystem.replaceOverWrite,
      copyFileDacl: WslFileSystem.skipDaclCopy,
    }
  }

  /**
   * No-replace publication for filesystems without hard links. A real
   * collision (a concurrent external creator won) must still surface as the
   * original EEXIST so the guarded-create failure path classifies it; an
   * absent target falls back to rename, which on Windows publishes without
   * replacing anything. Safe against this backend's own writers because the
   * per-target lock serializes them.
   * @param tempPath - the staged file.
   * @param destPath - the destination to create.
   */
  private static async publishNoReplace(tempPath: string, destPath: string): Promise<void> {
    try {
      await link(tempPath, destPath)
      return
    } catch (error) {
      let exists = false
      try {
        await lstat(destPath)
        exists = true
      } catch {
        // Absent destination: rename publishes the staged file.
      }
      if (exists) throw error
      await rename(tempPath, destPath)
    }
  }

  /**
   * Security-preserving replacement boundary: Windows rename replaces an
   * existing destination atomically; no DACL preservation is needed over 9P.
   * @param destPath - the file being replaced.
   * @param tempPath - the staged replacement.
   */
  private static async replaceOverWrite(destPath: string, tempPath: string): Promise<void> {
    await rename(tempPath, destPath)
  }

  /** 9P files inherit their directory's DACL; nothing to preserve. */
  private static async skipDaclCopy(): Promise<void> {}

  /** Translate a model/plugin path into Windows-side coordinates. */
  private translate(path: string, cwd?: string): Translated {
    const unc = parseWslUnc(path)
    if (unc !== null) {
      return { input: joinUnc(unc.distro, unc.linuxPath), cwd: this.cwdOr(cwd) }
    }
    if (isAbsoluteLinuxPath(path)) {
      // /mnt/<drive>/… names the Windows filesystem inside the Linux world
      // (the dual-access path for migration): open the drive path directly so
      // both worlds stay coherent — the display stays the /mnt form.
      const win = mntToWindowsPath(path)
      if (win !== null) return { input: win, cwd: this.cwdOr(cwd) }
      return { input: joinUnc(this.distroFor(cwd), path), cwd: this.cwdOr(cwd) }
    }
    if (windowsToMntPath(path) !== null) {
      // Windows drive paths open directly; the Linux world reaches them via /mnt.
      return { input: path, cwd: this.cwdOr(cwd) }
    }
    // Relative: resolve against the caller cwd (or the configured base).
    const base = this.uncCwd(cwd)
    return { input: path, cwd: base }
  }

  /** A base for absolute inputs (unused by resolution, but the parent needs one). */
  private cwdOr(cwd?: string): string {
    return cwd ?? this.executionCwd.getStore() ?? this.config.cwd ?? process.cwd()
  }

  private uncCwd(cwd?: string): string {
    const base = cwd ?? this.executionCwd.getStore() ?? this.config.cwd
    if (base === undefined || base === '') {
      throw new FsError('wsl-fs: no cwd and no configured base for relative resolution', 'FS_IO_ERROR')
    }
    const unc = parseWslUnc(base)
    if (unc !== null) return joinUnc(unc.distro, unc.linuxPath)
    if (isAbsoluteLinuxPath(base)) return joinUnc(this.distroFor(base), base)
    if (windowsToMntPath(base) !== null) return base
    throw new FsError(`wsl-fs: cwd "${base}" is not in the WSL execution world`, 'FS_IO_ERROR')
  }

  /**
   * Resolve the distribution an absolute Linux path opens inside. The chain:
   * the caller cwd when it is a WSL UNC path, then the current tool
   * execution's session cwd, then the configured `distro`,
   * then the host's default distribution from the Lxss registry. The registry
   * fallback is reserved for calls that genuinely have no session.
   */
  private distroFor(cwd?: string): string {
    const fromCwd = parseWslUnc(cwd ?? '')
    if (fromCwd !== null) return fromCwd.distro
    const fromExecution = parseWslUnc(this.executionCwd.getStore() ?? '')
    if (fromExecution !== null) return fromExecution.distro
    const distro = this.distro
    if (distro !== undefined && distro !== '') return distro
    const fallback = defaultDistroSync()
    if (fallback !== undefined) return fallback
    throw new FsError('wsl-fs: Linux path carries no distribution and none is configured', 'FS_IO_ERROR')
  }

  /** The Linux display path for a resolved Windows-side path. */
  private linuxDisplay(raw: string): string {
    const unc = parseWslUnc(raw)
    if (unc !== null) return unc.linuxPath
    const mnt = windowsToMntPath(raw)
    if (mnt !== null) return mnt
    throw new FsError(`wsl-fs: resolved path "${raw}" is outside the WSL execution world`, 'FS_IO_ERROR')
  }

  private coordinateForPath(path: string, cwd?: string): NativeCoordinate | undefined {
    if (!this.nativeOnThisHost || this.fileOptions.backend === 'unc' || !this.nativeClient) return undefined
    const base = this.cwdOr(cwd)
    const unc = parseWslUnc(path)
    const baseUnc = parseWslUnc(base)
    if (windowsToMntPath(path) !== null || (unc === null && mntToWindowsPath(path) !== null)) return undefined
    const distro = unc?.distro ?? baseUnc?.distro ?? (isAbsoluteLinuxPath(base) || isAbsoluteLinuxPath(path) ? this.distroFor(cwd) : undefined)
    if (distro === undefined) return undefined
    const linuxPath = unc?.linuxPath ?? (isAbsoluteLinuxPath(path) ? path
      : baseUnc !== null ? `${baseUnc.linuxPath}/${path}` : `${base}/${path}`)
    if (mntToWindowsPath(linuxPath) !== null) return undefined
    const username = getWorkspaceUsername(base)
    if (username !== undefined && !isValidWslUsername(username)) throw new FsError('invalid configured WSL username', 'FS_IO_ERROR')
    return { distro, path: linuxPath, ...username === undefined ? {} : { username } }
  }

  /** Share only when lifecycle/metrics policy agrees; an explicit consumer override stays effective. */
  rpcPoolFor(options: { idleMs: number; metrics: boolean }): WslRpcPool | undefined {
    return options.idleMs === this.fileOptions.idleMs && options.metrics === this.fileOptions.metrics ? this.wslRpcPool : undefined
  }

  private rpcTarget(where: NativeCoordinate): RpcTarget {
    return { distro: where.distro, linuxCwd: '/', wslPath: this.fileOptions.wslPath,
      ...where.username === undefined ? {} : { username: where.username } }
  }

  private targetFor(where: NativeCoordinate): FsTarget {
    return { targetKey: FsTargetKey(nativeKey(where)), displayPath: where.path }
  }

  private async nativeCall<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation() }
    catch (error) {
      if (error instanceof FsError) throw error
      if (error instanceof NativeFileError) throw new FsError(error.message, error.code, { cause: error })
      throw new FsError(error instanceof Error ? error.message : String(error), 'FS_IO_ERROR', { cause: error })
    }
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const where = this.coordinateForPath(path, opts?.cwd)
    if (where === undefined) return this.resolveUnc(path, opts)
    return this.nativeCall(async () => {
      let actual: string
      try { actual = await this.nativeClient!.resolve(this.rpcTarget(where), where.path, opts) }
      catch (error) {
        // Fallback happens only before a target/observation is created, and cannot change an explicit user.
        if (this.fileOptions.backend !== 'auto' || where.username !== undefined
          || !(error instanceof RpcTransportError) || error.stage !== 'startup' || opts?.signal?.aborted) throw error
        if (!this.warnedFallback) { this.warnedFallback = true; console.warn('wsl-fs: native startup unavailable; resolving via UNC') }
        return this.resolveUnc(path, opts)
      }
      const drive = mntToWindowsPath(actual)
      if (drive !== null) return this.resolveUnc(drive, opts)
      return this.targetFor({ ...where, path: actual })
    })
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const where = nativeCoordinate(String(target.targetKey))
    if (!where) return super.stat(target, signal)
    return this.nativeCall(async () => {
      const value = await this.nativeClient!.stat(this.rpcTarget(where), where.path, false, { signal })
      return value === undefined ? undefined : { ...value, type: value.type as FsInfo['type'], version: FsVersion(value.version) }
    })
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const where = nativeCoordinate(String(target.targetKey))
    if (!where) return super.readText(target, signal)
    return this.nativeCall(async () => decodeNativeText(await this.nativeClient!.read(this.rpcTarget(where), where.path, undefined, { signal })))
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const where = nativeCoordinate(String(target.targetKey))
    if (!where) return super.readBytes(target, signal, maxBytes)
    return this.nativeCall(() => this.nativeClient!.read(this.rpcTarget(where), where.path, maxBytes, { signal }))
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const where = nativeCoordinate(String(target.targetKey))
    if (!where) return super.readByteRange(target, range, signal)
    return this.nativeCall(() => this.nativeClient!.range(this.rpcTarget(where), where.path, range.offset, range.length, undefined, { signal }))
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const where = nativeCoordinate(String(target.targetKey))
    if (!where) return super.streamText(target, signal)
    const provider = this
    return (async function* () {
      const meta = await provider.stat(target, signal)
      if (!meta) throw new FsError('file not found', 'FS_NOT_FOUND')
      if (meta.type !== 'file') throw new FsError('not a regular file', 'FS_NOT_REGULAR_FILE')
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let offset = 0
      while (true) {
        const chunk = await provider.nativeCall(() => provider.nativeClient!.range(provider.rpcTarget(where), where.path,
          offset, 256 * 1024, String(meta.version), { signal }))
        if (offset < 8192 && chunk.subarray(0, 8192 - offset).includes(0)) throw new FsError('binary file', 'FS_NOT_TEXT')
        try {
          const decoded = decoder.decode(chunk, { stream: true })
          if (decoded) yield decoded
        } catch { throw new FsError('invalid UTF-8 text', 'FS_NOT_TEXT') }
        offset += chunk.length
        if (chunk.length < 256 * 1024) break
      }
      try { const tail = decoder.decode(); if (tail) yield tail }
      catch { throw new FsError('invalid UTF-8 text', 'FS_NOT_TEXT') }
    })()
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const where = nativeCoordinate(String(target.targetKey))
    if (!where) return super.listDir(target, signal)
    return this.nativeCall(async () => {
      const rows = await this.nativeClient!.list(this.rpcTarget(where), where.path, { signal })
      const entries: FsDirEntry[] = []
      for (const row of rows) {
        if (signal?.aborted) throw new FsError('listDir aborted', 'FS_ABORTED')
        const drive = mntToWindowsPath(row.path)
        if (drive === null) {
          entries.push({
            name: row.name, type: row.type as FsDirEntry['type'], target: this.targetFor({ ...where, path: row.path }),
            ...row.version === undefined ? {} : { version: FsVersion(row.version) },
            ...row.type === 'file' && row.size !== undefined ? { size: row.size } : {},
          })
          continue
        }
        // A listed Linux symlink may physically point onto a Windows drive.
        // Match resolve() routing and observe the version through that backend;
        // carrying a Linux version into a guarded Windows write would be stale.
        const mapped = await this.resolveUnc(drive, signal === undefined ? undefined : { signal })
        const info = await super.stat(mapped, signal)
        entries.push({
          name: row.name, type: info?.type ?? 'other', target: mapped,
          ...info === undefined ? {} : { version: info.version },
          ...info?.type === 'file' ? { size: info.size } : {},
        })
      }
      return entries
    })
  }

  override async watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>> {
    if (nativeCoordinate(String(target.targetKey))) {
      if (signal.aborted) throw new FsError('watch aborted', 'FS_ABORTED')
      throw new FsError('native filesystem watching is not implemented', 'FS_IO_ERROR')
    }
    return super.watch(target, changed, signal)
  }

  private nativePolicy(where: NativeCoordinate, perCall?: SandboxPolicyLike): NativePolicy | undefined {
    const policy = this.sandboxPolicy(perCall)
    if (policy === undefined) return undefined
    const roots = this.writableRoots(policy).flatMap(root => {
      const unc = parseWslUnc(root)
      if (unc !== null) return unc.distro.toLowerCase() === where.distro.toLowerCase() ? [unc.linuxPath] : []
      const drive = windowsToMntPath(root)
      return drive !== null ? [drive] : isAbsoluteLinuxPath(root) ? [root] : []
    })
    if (policy.mode === 'workspace-write') roots.push('/tmp')
    return { mode: policy.mode, roots }
  }

  private async resolveUnc(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    const { input, cwd } = this.translate(path, opts?.cwd)
    const resolved = { cwd, ...opts?.signal !== undefined ? { signal: opts.signal } : {} }
    let local: FsTarget
    try {
      local = await super.resolve(input, resolved)
    } catch (error) {
      const real = await this.linkAwarePath(input, input)
      if (real === undefined) throw error
      return this.wslTarget(await super.resolve(real, resolved))
    }
    // The share resolves a link path to a *lexical* identity: `lstat` on a
    // Linux symlink fails, so the local resolver hands back the deepest
    // existing ancestor plus the remaining segments. Ask the distribution
    // before accepting that identity, or a link would be treated as a plain
    // missing file (and a write through it would escape the policy).
    const real = await this.linkAwarePath(input, String(local.targetKey))
    if (real === undefined) return this.wslTarget(local)
    return this.wslTarget(await super.resolve(real, resolved))
  }

  /** Wrap a locally resolved target in this world's Linux-facing identity. */
  private wslTarget(local: FsTarget): FsTarget {
    return { targetKey: local.targetKey, displayPath: this.linuxDisplay(String(local.displayPath)) }
  }

  /**
   * The real path a link-aware lookup must use, or `undefined` when the input
   * needs no help. Only a path this share cannot already describe pays for a
   * `wsl.exe` lookup: an existing file or directory resolves directly, while a
   * symlink (in the final segment or anywhere above it), a dangling target and
   * a not-yet-created file all ask the distribution, which answers with the
   * same path when nothing was linked.
   * @param input - the translated input or resolved identity to inspect.
   * @param targetKey - the identity the local resolver produced.
   * @returns the distribution's real path when it differs, else `undefined`.
   */
  private async linkAwarePath(input: string, targetKey: string): Promise<string | undefined> {
    const unc = parseWslUnc(targetKey) ?? parseWslUnc(input)
    if (unc === null) return undefined
    const asSpelled = joinUnc(unc.distro, unc.linuxPath)
    if (await this.describable(targetKey)) return undefined
    const real = await resolveLinuxSymlink(asSpelled)
    if (real === undefined) return undefined
    return real.toLowerCase() === asSpelled.toLowerCase() ? undefined : real
  }

  /** Whether this share can describe a Windows-side identity at all. */
  private async describable(winPath: string): Promise<boolean> {
    return await super.lstat(winPath, {}).catch(() => undefined) !== undefined
  }

  /**
   * The host file-effect policy for this call: the tool layer's per-call value
   * when it passes one, else the service's own resolution. `undefined` means
   * the deployment mounts no policy at all — the same state as a host
   * filesystem without `fs-sandbox`, so nothing is fenced.
   */
  protected sandboxPolicy(perCall?: SandboxPolicyLike): SandboxPolicyLike | undefined {
    if (isSandboxPolicy(perCall)) return perCall
    const service = this.sandboxPolicyService()
    if (service === undefined) return undefined
    try {
      const policy = service.resolve()
      return isSandboxPolicy(policy) ? policy : undefined
    } catch {
      // A policy that cannot resolve (no session in scope) fences nothing.
      return undefined
    }
  }

  /** The policy service this backend reads, when the deployment mounts one. */
  private sandboxPolicyService(): SandboxPolicyFace | undefined {
    const service = this.ctx.get('sandboxPolicy') as SandboxPolicyFace | undefined
    return service !== undefined && typeof service.resolve === 'function' ? service : undefined
  }

  /**
   * The deployment's default sandbox mode — the capability fact the file tool
   * reads to advertise escalation, mirrored from `SandboxedFileSystem`.
   */
  get sandboxMode(): string | undefined {
    const mode = this.sandboxPolicyService()?.defaultMode
    return typeof mode === 'string' ? mode : undefined
  }

  /**
   * Fence a mutation by the policy, then hand back the EXACT target to mutate
   * (no check-here-write-there): `read-only` denies, `workspace-write`
   * re-resolves and requires containment under a writable root, and
   * `danger-full-access` passes through. Mirrors
   * `@deepseek-ai/dsh-fs-sandbox`'s `checkedTarget`, including the
   * `FS_SANDBOX_DENIED` code the tool layer renders as a denial.
   * @param target - the resolved target about to be written.
   * @param perCall - the tool layer's per-call policy, when it passes one.
   * @returns the target the mutation must use.
   */
  private async checkedTarget(target: FsTarget, perCall?: SandboxPolicyLike): Promise<FsTarget> {
    const policy = this.sandboxPolicy(perCall)
    if (policy === undefined || policy.mode === 'danger-full-access') return target
    if (policy.mode === 'read-only') {
      throw new FsError(
        `cannot write "${target.displayPath}": file access denied under read-only mode`,
        'FS_SANDBOX_DENIED',
      )
    }
    if (policy.mode !== 'workspace-write') return target
    const fresh = await this.resolveUnc(target.displayPath)
    for (const root of this.writableRoots(policy)) {
      if (this.underRoot(String(fresh.targetKey), root)) return fresh
    }
    throw new FsError(
      `cannot write "${target.displayPath}": file access denied under workspace-write mode`,
      'FS_SANDBOX_DENIED',
    )
  }

  /**
   * The roots a write may land under: the host's rule verbatim
   * (`writableRoots`: the workspace root plus the platform temp areas) plus,
   * in a WSL session, the distribution's own `/tmp` — the temp area of the
   * world this session actually runs in, which the host-side rule cannot name.
   * @param policy - the resolved policy.
   */
  private writableRoots(policy: SandboxPolicyLike): string[] {
    const roots = writableRoots(policy as Parameters<typeof writableRoots>[0]) as string[]
    const workspace = policy.workspaceRoot
    const unc = workspace === undefined ? null : parseWslUnc(workspace)
    if (unc !== null) roots.push(joinUnc(unc.distro, '/tmp'))
    return roots
  }

  /** Whether a canonical target key is a writable root or sits below one. */
  private underRoot(targetKey: string, root: string): boolean {
    const key = trimTrailing(canonicalPath(targetKey)).toLowerCase()
    const base = trimTrailing(canonicalPath(root)).toLowerCase()
    if (base === '' || base === '/' || key === base) return key === base
    return key.startsWith(base.endsWith('/') || base.endsWith('\\') ? base : `${base}\\`)
      || key.startsWith(`${base}/`)
  }

  /** Fence a full-content write by the policy, then delegate to the parent. */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxPolicyLike,
  ): Promise<FsWriteOutcome> {
    const where = nativeCoordinate(String(target.targetKey))
    if (!where) return super.writeText(await this.checkedTarget(target, sandboxPolicy), content, expected, signal)
    return this.nativeCall(async () => {
      const value = await this.nativeClient!.write(this.rpcTarget(where), where.path, content, expected,
        this.nativePolicy(where, sandboxPolicy), this.config.diffBasisMaxBytes, { signal })
      return { operation: value.operation!, version: FsVersion(value.version), before: value.before, after: value.after }
    })
  }

  /** Fence an edit by the policy, then delegate to the parent. */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxPolicyLike,
  ): Promise<FsEditOutcome> {
    const where = nativeCoordinate(String(target.targetKey))
    if (!where) return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal)
    return this.nativeCall(async () => {
      const value = await this.nativeClient!.edit(this.rpcTarget(where), where.path, edit, expected?.version,
        this.nativePolicy(where, sandboxPolicy), { signal })
      return { version: FsVersion(value.version), before: value.before!, after: value.after }
    })
  }

  override processPath(target: FsTarget): string {
    return this.worldPath(target).linuxPath
  }

  override fileUrl(target: FsTarget): string {
    const linux = this.processPath(target)
    const encoded = linux.split('/').map(encodeURIComponent).join('/')
    return `file://${encoded}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const parentWorld = this.worldPath(parent)
    const childWorld = this.worldPath(child)
    if (parentWorld.distro?.toLowerCase() !== childWorld.distro?.toLowerCase() || parentWorld.username !== childWorld.username) return false
    const parentPath = parentWorld.linuxPath
    const childPath = childWorld.linuxPath
    if (childPath === parentPath) return true
    return parentPath === '/' ? true : childPath.startsWith(`${parentPath}/`)
  }

  /** One target's (distro, linuxPath) pair for containment; `undefined` distro = Windows world. */
  private worldPath(target: FsTarget): { distro: string | undefined; username?: string; linuxPath: string } {
    const key = String(target.targetKey)
    const native = nativeCoordinate(key)
    if (native) return { distro: native.distro, linuxPath: native.path, ...native.username === undefined ? {} : { username: native.username } }
    const unc = parseWslUnc(key)
    if (unc !== null) return { distro: unc.distro, linuxPath: unc.linuxPath }
    const mnt = windowsToMntPath(key)
    if (mnt !== null) return { distro: undefined, linuxPath: mnt }
    throw new FsError(`wsl-fs: target "${target.displayPath}" is outside the WSL execution world`, 'FS_IO_ERROR')
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const where = this.coordinateForPath(path, opts?.cwd)
    if (where) return this.nativeCall(async () => {
      try {
        const value = await this.nativeClient!.stat(this.rpcTarget(where), where.path, true, { signal })
        return value === undefined ? undefined : { ...value, version: FsVersion(value.version) }
      } catch (error) {
        if (this.fileOptions.backend !== 'auto' || where.username !== undefined || signal?.aborted
          || !(error instanceof RpcTransportError) || error.stage !== 'startup') throw error
        return this.lstatUnc(path, opts, signal)
      }
    })
    return this.lstatUnc(path, opts, signal)
  }

  private async lstatUnc(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const { input, cwd } = this.translate(path, opts?.cwd)
    const info = await super.lstat(input, { cwd }, signal).catch(() => undefined)
    if (info !== undefined) return info
    // Same substrate limit as `resolve`: a link path must describe its target,
    // because the share cannot describe the link itself.
    const real = await this.linkAwarePath(input, input)
    if (real === undefined) return info
    return super.lstat(real, { cwd }, signal)
  }
}

/** Whether a value is a usable file-effect policy. */
function isSandboxPolicy(value: SandboxPolicyLike | undefined): value is SandboxPolicyLike {
  return value !== undefined && typeof value.mode === 'string' && value.mode !== ''
}

/** Strip a trailing separator (keeping the root separator itself). */
function trimTrailing(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, '') : path
}

export default WslFileSystem
