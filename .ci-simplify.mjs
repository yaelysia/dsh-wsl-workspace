// Temporary delivery transform. Every source input is pinned to its reviewed Git blob.
// No user installation or host package is modified. Removed after tested source/lib publication.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const expected = {
  'src/fs.ts': 'cd78ea01b0f14ce7a2b7846dd28c7a64cb664b20',
  'src/shared/rpc-transport.ts': '2c3fc46627bba29a06fca6a06bebe4e608c5b84e',
  'src/shared/rpc-metrics.ts': '48753b455bc07c0cb21ef8524dfaaaf761138265',
  'src/shared/native-files.ts': '5b121388e8471f11289655b97497375117ceaba3',
  'src/host/wsl-search.ts': '5c7e86a180a02e899adc2edce27908ec4c76f7df',
  'tests/rpc-config-metrics.test.mjs': '284778a855d690e46d148dca6e278b975db5f93a',
  'tests/search-transport.test.mjs': 'fc759025612a62436fb0169c3f8d2124a8fd3cf9',
  'CHECKPOINT.md': 'ea9f239b3a10bd8d13fa84f2fe7960a83e32a50f',
}
const changes = new Map()
function load(path) {
  const bytes = readFileSync(path)
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  assert.equal(sha, expected[path], `unreviewed input: ${path}`)
  return bytes.toString('utf8')
}
function once(source, from, to) {
  assert.equal(source.split(from).length, 2, `expected one exact occurrence: ${from.slice(0,100)}`)
  return source.replace(from, () => to)
}
function between(source, from, until, replacement) {
  assert.equal(source.split(from).length, 2, 'start anchor must be unique')
  const start = source.indexOf(from), end = source.indexOf(until, start + from.length)
  assert.ok(end > start, 'end anchor must follow start')
  return source.slice(0,start) + replacement + source.slice(end)
}

// One result classification shared by one-shot search and persistent RPC.
let metrics = load('src/shared/rpc-metrics.ts')
metrics = once(metrics, 'const WINDOW = 256', `/** Shared execution accounting; grep exit 1 means no matches, not a failure. */
export function rpcRunOutcome(result: { aborted: boolean; code: number | null; stdout: Uint8Array },
  op: RpcMethod, maxBytes: number): Outcome {
  if (result.aborted) return 'aborted'
  if (result.stdout.length > maxBytes) return 'overflow'
  return result.code === 0 || (op === 'grep' && result.code === 1) ? 'ok' : 'error'
}

const WINDOW = 256`)
changes.set('src/shared/rpc-metrics.ts', metrics)

// Canonical byte validation and one idempotent worker shutdown path.
let transport = load('src/shared/rpc-transport.ts')
transport = once(transport, 'RPC_METHODS, RpcMetrics, type Outcome', 'RPC_METHODS, RpcMetrics, rpcRunOutcome, type Outcome')
transport = once(transport, 'class Worker {', `/** Decode only canonical, bounded base64. Both RPC envelopes and native file bodies use this rule. */
export function decodeRpcBytes(raw: unknown, max: number): Buffer {
  if (typeof raw !== 'string') throw new Error('invalid byte payload')
  const bytes = Buffer.from(raw, 'base64')
  if (bytes.length > max || bytes.toString('base64') !== raw) throw new Error('invalid or oversized base64')
  return bytes
}

class Worker {`)
transport = once(transport, `      const decode = (raw: unknown, max: number): Buffer => {
        if (typeof raw !== 'string') throw new Error('invalid byte payload')
        const bytes = Buffer.from(raw, 'base64')
        if (bytes.length > max || bytes.toString('base64') !== raw) throw new Error('invalid or oversized base64')
        return bytes
      }
`, '')
transport = once(transport, 'stdout: decode(value.stdout, pending.maxBytes + 1), stderr: decode(value.stderr, MAX_REQUEST)',
  'stdout: decodeRpcBytes(value.stdout, pending.maxBytes + 1), stderr: decodeRpcBytes(value.stderr, MAX_REQUEST)')
transport = once(transport, `      outcome = result.aborted ? 'aborted' : result.stdout.length > request.maxBytes ? 'overflow'
        : result.code === 0 || (request.op === 'grep' && result.code === 1) ? 'ok' : 'error'`,
  '      outcome = rpcRunOutcome(result, request.op, request.maxBytes)')
transport = between(transport, '  private break(message: string): void {', '    this.chunks = []; this.chunkBytes = 0', `  private break(message: string): void {
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
`)
changes.set('src/shared/rpc-transport.ts', transport)

// Keep the filesystem error boundary, while deleting its second base64 decoder.
let files = load('src/shared/native-files.ts')
files = once(files, 'import { RpcTransportError, WslRpcPool, type RpcTarget }',
  'import { decodeRpcBytes, RpcTransportError, WslRpcPool, type RpcTarget }')
files = once(files, `    if (typeof data !== 'string') invalid()
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length > max || bytes.toString('base64') !== data) invalid()
    return bytes`, `    try { return decodeRpcBytes(data, max) }
    catch { invalid() }`)
changes.set('src/shared/native-files.ts', files)

// Delete the duplicate process-result model and the separate outcome expression.
let search = load('src/host/wsl-search.ts')
search = once(search, "import { WslRpcPool, RpcTransportError } from '../shared/rpc-transport.ts'",
  "import { WslRpcPool, RpcTransportError, type RpcRun as WslRun } from '../shared/rpc-transport.ts'")
search = once(search, 'import { RpcMetrics, registerRpcDiagnostics, type Outcome }',
  'import { RpcMetrics, rpcRunOutcome, registerRpcDiagnostics, type Outcome }')
search = between(search, '/** One completed in-distro run: its exit code, raw stdout, raw stderr and kill signal. */',
  '/**\n * Run one fixed script inside the distribution.', '')
search = once(search, `      outcome = result.aborted ? 'aborted' : result.stdout.length > config.rawOutputMaxBytes ? 'overflow'
        : result.code === 0 || (op === 'grep' && result.code === 1) ? 'ok' : 'error'`,
  '      outcome = rpcRunOutcome(result, op, config.rawOutputMaxBytes)')
search = once(search, `      const paths: string[] = []
      for (const file of selected) {
        paths.push(displayPath(file.path, target.linuxCwd))
      }`, '      const paths = selected.map(file => displayPath(file.path, target.linuxCwd))')
assert.ok(search.includes('export default { apply, inject, Config }'), 'do not lose the accepted Loader metadata')
changes.set('src/host/wsl-search.ts', search)

// The existing identity-aware resolver is already the authority for containment.
let fs = load('src/fs.ts')
fs = between(fs, '  override processPath(target: FsTarget): string {', '  override fileUrl(target: FsTarget): string {', `  override processPath(target: FsTarget): string {
    return this.worldPath(target).linuxPath
  }

`)
changes.set('src/fs.ts', fs)

let metricTests = load('tests/rpc-config-metrics.test.mjs')
metricTests += `
// Explicit cases pin precedence, the exact byte boundary and grep's special exit code.
test('shared outcome classification preserves cancellation, byte limits and command status', async () => {
  const { rpcRunOutcome, RPC_METHODS } = await import('../src/shared/rpc-metrics.ts')
  const cases = [
    { aborted: true, code: 0, length: 17, normal: 'aborted', grep: 'aborted' },
    { aborted: true, code: 2, length: 0, normal: 'aborted', grep: 'aborted' },
    { aborted: false, code: 0, length: 17, normal: 'overflow', grep: 'overflow' },
    { aborted: false, code: 2, length: 17, normal: 'overflow', grep: 'overflow' },
    { aborted: false, code: 0, length: 16, normal: 'ok', grep: 'ok' },
    { aborted: false, code: 1, length: 0, normal: 'error', grep: 'ok' },
    { aborted: false, code: 2, length: 0, normal: 'error', grep: 'error' },
    { aborted: false, code: null, length: 0, normal: 'error', grep: 'error' },
    { aborted: false, code: -9, length: 0, normal: 'error', grep: 'error' },
  ]
  for (const op of RPC_METHODS) for (const item of cases) {
    assert.equal(rpcRunOutcome({ ...item, stdout: new Uint8Array(item.length) }, op, 16),
      op === 'grep' ? item.grep : item.normal, op + ':' + JSON.stringify(item))
  }
})
`
changes.set('tests/rpc-config-metrics.test.mjs', metricTests)

let transportTests = load('tests/search-transport.test.mjs')
transportTests += `
test('shared byte decoder keeps canonical base64 and inclusive byte limits', async () => {
  const { decodeRpcBytes } = await import('../src/shared/rpc-transport.ts')
  for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 1]), Buffer.from('中文\\r\\n'), Buffer.alloc(256, 123)]) {
    const encoded = bytes.toString('base64')
    assert.deepEqual(decodeRpcBytes(encoded, bytes.length), bytes)
    if (bytes.length) assert.throws(() => decodeRpcBytes(encoded, bytes.length - 1), /invalid or oversized base64/)
  }
  for (const raw of [null, undefined, 12, {}, []]) assert.throws(() => decodeRpcBytes(raw, 64), /invalid byte payload/)
  for (const raw of ['Zg', 'Zg=', 'Zh==', 'Zg===', 'Zg== ', 'Zg==\\n', '***', '_w==']) {
    assert.throws(() => decodeRpcBytes(raw, 64), /invalid or oversized base64/, JSON.stringify(raw))
  }
})

test('native body validation retains filesystem errors when reusing the RPC decoder', async () => {
  const { NativeFileClient } = await import('../src/shared/native-files.ts')
  const { RpcMetrics } = await import('../src/shared/rpc-metrics.ts')
  let data = ''
  const client = new NativeFileClient({
    metrics: new RpcMetrics(),
    async run() { return { code: 0, aborted: false, signal: null, stderr: Buffer.alloc(0),
      stdout: Buffer.from(JSON.stringify({ ok: true, committed: false, value: { data } })) } },
  })
  for (data of [null, 12, 'Zg', 'Zh==', 'Zg== ', 'Zm9v']) {
    await assert.rejects(client.read(target('/'), '/file', 1),
      error => error.code === 'FS_IO_ERROR' && error.message === 'invalid native file response')
  }
  data = 'Zg=='
  assert.deepEqual(await client.read(target('/'), '/file', 1), Buffer.from('f'))
  data = ''
  assert.deepEqual(await client.read(target('/'), '/file', 0), Buffer.alloc(0))
})
`
changes.set('tests/search-transport.test.mjs', transportTests)

let checkpoint = load('CHECKPOINT.md')
checkpoint = once(checkpoint, '# Windows DSH → WSL continuation checkpoint\n', `# Windows DSH → WSL continuation checkpoint

## CP12: behaviour-preserving code simplification (2026-10-19)

Base: main \`22c3349874e4968f0ca751f3aaa873d43adacd42\` after the README rewrite and accepted shared-pool UAT. Branch: \`refactor/simplify-rpc-files\`.

The simplification has four concrete targets: share process-result types and outcome accounting; reuse one strict base64 decoder while preserving the native filesystem error boundary; converge broken/disposed worker cleanup on one idempotent close path; use the existing identity-aware worldPath resolver instead of a second processPath decoder. Glob display projection uses map rather than a push loop. No new runtime dependency, worker, cache, API mode or generic framework is added.

Do not change Loader default metadata, pool owner/identity/configuration keys, write authorization, versions, atomic publication, cancellation acknowledgement or unknown-mutation handling. No Skill, watch, PTC or host hot-reload changes belong to this round. The user accepts a full host restart for updates and leaves host hot-reload work to DSH upstream.

Delivery must include source, matching lib, byte-for-byte repeat-build verification and existing source/lib native-file, RPC-owner, Loader, mixed and busy-lifetime checks. Added tests pin outcome precedence and canonical byte decoding, including filesystem-specific error messages. A CI job being started is not a pass; read its final result and the published branch SHA. Temporary delivery machinery must be removed before merge.

User tests at CP11 remain the accepted earlier build's evidence, not new Desktop validation of this refactor. Start with this checkpoint and the exact branch head, not an old phase branch. Historical CP10/CP11 material below remains unchanged.
`)
changes.set('CHECKPOINT.md', checkpoint)

// Do not write a partial transform if any preceding hash/anchor assertion failed.
for (const [path, content] of changes) {
  const before = readFileSync(path, 'utf8')
  assert.notEqual(content, before, path)
  writeFileSync(path, content)
  console.log(JSON.stringify({ path, oldLines: before.split('\n').length, newLines: content.split('\n').length,
    oldBytes: Buffer.byteLength(before), newBytes: Buffer.byteLength(content) }))
}
console.log('Reviewed simplification applied; build and behaviour tests must pass before publication.')
