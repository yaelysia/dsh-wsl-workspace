// Temporary delivery transform; exact baseline hashes prevent accidental edits to newer work.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
const read = path => readFileSync(path, 'utf8')
const expected = {
  'src/shared/rpc-transport.ts': 'e0c15dffbea4e9d8919b8578c3d091c10f9f7a35',
  'src/shared/rpc-worker.ts': '6f16f3e7b4d92c5b7ca0fcb18c2cd099321d39ff',
  'src/shared/native-file-worker.ts': '2f306f48c892d08eeaa05f225b53ee991442afec',
  'tests/search-transport.test.mjs': '437ff9efe8349608d19aa5d4565cf8e26e2b5d6a',
  'tests/native-files.test.mjs': '2def1bc0878a835a326f3b91bf265519e5d0fcbd',
}
for (const [path, sha] of Object.entries(expected)) {
  const bytes = readFileSync(path)
  assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), sha, path)
}
function replace(path, from, to) {
  const text = read(path)
  assert.equal(text.split(from).length, 2, `one reviewed occurrence: ${path}: ${from.slice(0,60)}`)
  writeFileSync(path, text.replace(from, to))
}
replace('src/shared/native-file-worker.ts', '        return bytes(data)',
  '        return data  # Consumers accept the buffer; avoid a second full-file allocation.')
replace('src/shared/native-file-worker.ts', "sample = original.encode('utf-16-le', 'surrogatepass')[:8192]",
  "sample = original[:4096].encode('utf-16-le', 'surrogatepass')[:8192]")
replace('src/shared/rpc-worker.ts', 'input_bytes[input_offset:input_offset + 65536]',
  'memoryview(input_bytes)[input_offset:input_offset + 65536]')
replace('src/shared/rpc-worker.ts', 'base64.b64encode(out[1:] if file_call else out)',
  'base64.b64encode(memoryview(out)[1:] if file_call else out)')
replace('src/shared/rpc-worker.ts', 'base64.b64encode(out[1:]).decode()',
  'base64.b64encode(memoryview(out)[1:]).decode()')
replace('src/shared/rpc-worker.ts', 'export function rpcWorkerCode(): string {',
  '// Cache immutable bundled code only, never user input, file data or a worker.\nlet cachedBootstrap: string | undefined\nexport function rpcWorkerCode(): string {\n  if (cachedBootstrap !== undefined) return cachedBootstrap')
replace('src/shared/rpc-worker.ts', "return `exec(__import__('zlib').decompress(__import__('base64').b64decode('${encoded}')))`",
  "return cachedBootstrap = `exec(__import__('zlib').decompress(__import__('base64').b64decode('${encoded}')))`")
const oldDecoder = `export function decodeRpcBytes(raw: unknown, max: number): Buffer {
  if (typeof raw !== 'string') throw new Error('invalid byte payload')
  const bytes = Buffer.from(raw, 'base64')
  if (bytes.length > max || bytes.toString('base64') !== raw) throw new Error('invalid or oversized base64')
  return bytes
}`
const newDecoder = `const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
export function decodeRpcBytes(raw: unknown, max: number): Buffer {
  if (typeof raw !== 'string') throw new Error('invalid byte payload')
  const padding = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0
  const end = raw.length - padding
  // Validate canonical alphabet, placement and unused pad bits without re-encoding
  // the entire decoded buffer. Reject oversized input before allocating that buffer.
  if (raw.length % 4 !== 0 || raw.length / 4 * 3 - padding > max
    || raw.search(/[^A-Za-z0-9+/]/) !== (padding ? end : -1)
    || (padding && (BASE64_ALPHABET.indexOf(raw[end - 1]!) & (padding === 2 ? 15 : 3)) !== 0)) {
    throw new Error('invalid or oversized base64')
  }
  return Buffer.from(raw, 'base64')
}`
replace('src/shared/rpc-transport.ts', oldDecoder, newDecoder)
replace('src/shared/rpc-transport.ts', 'const line = Buffer.concat(this.chunks, this.chunkBytes)',
  'const line = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.chunkBytes)')
writeFileSync('tests/search-transport.test.mjs', read('tests/search-transport.test.mjs') + String.raw`

test('optimized byte decoder agrees with the old canonical round-trip rule', async () => {
  const { decodeRpcBytes } = await import('../src/shared/rpc-transport.ts')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const same = (raw, max = 64) => {
    const decoded = Buffer.from(raw, 'base64')
    const valid = decoded.length <= max && decoded.toString('base64') === raw
    if (valid) assert.deepEqual(decodeRpcBytes(raw, max), decoded)
    else assert.throws(() => decodeRpcBytes(raw, max), /invalid or oversized base64/, JSON.stringify(raw))
  }
  for (const a of alphabet) for (const b of alphabet) {
    same(a + b + '==')
    same('A' + a + b + '=')
  }
  for (const raw of ['', '====', '=AAA', 'AA=A', 'AAAA====', 'AA==AAAA', 'A A=', 'AA\n=', 'AA\r=', 'ＡAAA', '\0AAA', 'AA-_', 'AAAA=']) same(raw)
  for (const size of [1, 2, 3, 4095, 4096, 65536, 1024 * 1024]) {
    const bytes = Buffer.alloc(size, 171), raw = bytes.toString('base64')
    same(raw, size); same(raw, size - 1)
    same(raw + ' ', size)
  }
})

test('oversized canonical data is rejected before allocating its decoded buffer', async () => {
  const { decodeRpcBytes } = await import('../src/shared/rpc-transport.ts')
  const raw = Buffer.alloc(1024 * 1024, 7).toString('base64')
  const original = Buffer.from
  let allocations = 0
  Buffer.from = function (...args) { allocations++; return original.apply(this, args) }
  try { assert.throws(() => decodeRpcBytes(raw, 1), /invalid or oversized base64/) }
  finally { Buffer.from = original }
  assert.equal(allocations, 0)
})

test('cached RPC bootstrap is identical and still a complete bounded Linux program', async () => {
  const { rpcWorkerCode } = await import('../src/shared/rpc-worker.ts')
  const { inflateSync } = await import('node:zlib')
  const first = rpcWorkerCode()
  for (let i = 0; i < 100; i++) assert.equal(rpcWorkerCode(), first)
  assert.ok(first.length < 32767 && /^[\x20-\x7e]+$/.test(first))
  const encoded = /b64decode\('([A-Za-z0-9+/=]+)'\)/.exec(first)?.[1]
  assert.ok(encoded)
  const program = inflateSync(Buffer.from(encoded, 'base64')).toString()
  for (const word of ['FILE_PROGRAM=', 'fs.read', 'fs.write', 'fs.edit', 'start_new_session=True']) assert.ok(program.includes(word))
})
`)
writeFileSync('tests/native-files.test.mjs', read('tests/native-files.test.mjs') + String.raw`

test('bounded newline sampling preserves the host UTF-16 boundary with non-BMP text', async t => {
  const { fs, root } = await fixture(t)
  const hostData = await hostReference(t), host = hostData.fs
  // A truncated surrogate, CRLF crossing the 4096-code-unit boundary, and
  // opposite newline styles after the sample must all match the actual host.
  const bodies = [
    'a'.repeat(4095) + '🙂\r\n' + 'b\r\n'.repeat(10000),
    '🙂'.repeat(2047) + '\r\n' + 'b\n'.repeat(10000),
    '🙂'.repeat(2047) + 'a\r\n' + 'b\r\n'.repeat(10000),
    'x\r\n'.repeat(1400) + '中\n'.repeat(10000),
  ].map(body => body + 'TOKEN_A0')
  for (const [i, body] of bodies.entries()) {
    const name = 'sample-' + i + '.txt'
    await writeRaw(root + '/' + name, body); await hostData.write(name, body)
    const native = await fs.resolve(name), local = await host.resolve(name)
    const edit = { oldString: 'TOKEN_A0', newString: 'TOKEN_B0', replaceAll: false }
    const [a, b] = await Promise.all([fs.editText(native, edit), host.editText(local, edit)])
    assert.equal(a.before, b.before); assert.equal(a.after, b.after)
    assert.deepEqual(await readRaw(root + '/' + name), await hostData.read(name))
  }
})
`)
const manifest = JSON.parse(read('package.json'))
assert.equal(manifest.scripts['bench:native-rpc'], undefined)
manifest.scripts['bench:native-rpc'] = 'node --experimental-strip-types scripts/benchmark-native-rpc.mjs'
writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\n')
const cp = read('CHECKPOINT.md')
writeFileSync('CHECKPOINT.md', cp.replace('\n\n', `\n\n## CP13: native I/O performance pass in progress\n\nBased on CP12 \\`30b9abf7496d818c1f43a69ee50745e924e8a37a\\`, branch \\`perf/cp13-native-io\\`. See [CP13 scope and measurement](docs/performance-cp13.md). Candidate changes remove full-buffer copies/re-encoding and repeated bootstrap compression; no protocol, permission, version, mutation replay or owner change. Only measured results from completed jobs may be claimed. CP12's main merge and its pending environment job remain separate. Keep source/lib in sync and retain CP11 Desktop acceptance as historical, not a new UAT.\n\n`.replaceAll('\\`', '`')))
console.log('Applied CP13: canonical decoding, zero-copy framing/buffers, bounded newline sampling and immutable bootstrap cache.')
