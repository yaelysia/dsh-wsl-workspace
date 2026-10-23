// Paired current/baseline measurements. Real provider calls include resolve + stat + operation.
// No latency gate: preserve all samples, alternate order and verify returned/disk bytes.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { makeFixture, readRaw, python } from '../tests/support/native-fixture.mjs'
import { decodeRpcBytes } from '../src/shared/rpc-transport.ts'
import { rpcWorkerCode } from '../src/shared/rpc-worker.ts'
import { NATIVE_FILE_PROGRAM } from '../src/shared/native-file-worker.ts'
const flag = (name, value) => { const i = process.argv.indexOf(name); return i < 0 ? value : process.argv[i + 1] }
const iterations = Number(flag('--iterations', '12'))
if (!Number.isInteger(iterations) || iterations < 4 || iterations > 100) throw new Error('iterations must be 4..100')
const baseline = resolve(flag('--baseline', '.cp13-baseline'))
const imported = file => import(pathToFileURL(join(baseline, file)).href)
const oldFixture = await imported('tests/support/native-fixture.mjs')
const oldTransport = await imported('src/shared/rpc-transport.ts')
const oldWorker = await imported('src/shared/rpc-worker.ts')
const oldFileWorker = await imported('src/shared/native-file-worker.ts')
const git = spawnSync('git', ['-C', baseline, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true })
if (git.status !== 0) throw new Error('baseline must be a readable git checkout: ' + git.stderr)
const summarize = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return { samples: values.length, p50Ms: +sorted[Math.ceil(sorted.length * 0.5) - 1].toFixed(6),
    p95Ms: +sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(6), rawMs: values }
}
const paired = async (count, execute, verify) => {
  const samples = { before: [], after: [] }
  for (let i = -4; i < count; i++) {
    for (const name of i % 2 === 0 ? ['before', 'after'] : ['after', 'before']) {
      const started = performance.now()
      const answer = await execute(name)
      const elapsed = performance.now() - started
      verify(answer)
      if (i >= 0) samples[name].push(elapsed)
    }
  }
  return Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, summarize(values)]))
}
const decoders = { before: oldTransport.decodeRpcBytes, after: decodeRpcBytes }
const decoding = []
for (const bytes of [4096, 256 * 1024, 4 * 1024 * 1024]) {
  const content = Buffer.alloc(bytes, 171), encoded = content.toString('base64')
  decoding.push({ bytes, ...await paired(40, name => decoders[name](encoded, bytes), answer => assert.deepEqual(answer, content)) })
}
const boot = { before: oldWorker.rpcWorkerCode, after: rpcWorkerCode }
// Each benchmark iteration asks for the same immutable bootstrap 20 times.
const bootstrap = await paired(30, name => { let answer; for (let i = 0; i < 20; i++) answer = boot[name](); return answer },
  answer => assert.ok(answer.startsWith('exec(') && answer.length < 32767))
const fixtures = {}
try {
  fixtures.before = await oldFixture.makeFixture()
  fixtures.after = await makeFixture()
  const rows = []
  for (const bytes of [4096, 256 * 1024, 4 * 1024 * 1024]) {
    const body = 'TOKEN_A0\n' + 'payload line\n'.repeat(Math.ceil(bytes / 13)).slice(0, bytes - 9)
    assert.equal(Buffer.byteLength(body), bytes)
    for (const fixture of Object.values(fixtures)) for (const op of ['read', 'write', 'edit']) {
      await fixture.fs.writeText(await fixture.fs.resolve(op + '-' + bytes + '.txt'), body, { kind: 'createIfAbsent' })
    }
    for (const op of ['read', 'write', 'edit']) {
      const expected = { before: body, after: body }
      const versions = {}
      const samples = { before: [], after: [] }
      for (let i = -2; i < iterations; i++) {
        for (const name of i % 2 === 0 ? ['before', 'after'] : ['after', 'before']) {
          const fs = fixtures[name].fs, filename = op + '-' + bytes + '.txt'
          const started = performance.now()
          const target = await fs.resolve(filename), stat = await fs.stat(target)
          assert.equal(stat.type, 'file')
          let answer
          if (op === 'read') answer = await fs.readText(target)
          else if (op === 'write') {
            const result = await fs.writeText(target, body, { kind: 'replaceIfVersion', version: stat.version })
            versions[name] = result.version; answer = result.after
          } else {
            const oldString = expected[name].startsWith('TOKEN_A0') ? 'TOKEN_A0' : 'TOKEN_B0'
            const newString = oldString === 'TOKEN_A0' ? 'TOKEN_B0' : 'TOKEN_A0'
            const result = await fs.editText(target, { oldString, newString, replaceAll: false }, { version: stat.version })
            versions[name] = result.version; answer = result.after
            expected[name] = expected[name].replace(oldString, newString)
          }
          const elapsed = performance.now() - started
          assert.equal(answer, expected[name])
          if (i >= 0) samples[name].push(elapsed)
        }
      }
      for (const name of ['before', 'after']) {
        const fixture = fixtures[name], file = op + '-' + bytes + '.txt'
        assert.deepEqual(await readRaw(fixture.root + '/' + file), Buffer.from(expected[name]))
        if (versions[name]) assert.equal((await fixture.fs.stat(await fixture.fs.resolve(file))).version, versions[name])
      }
      rows.push({ operation: op, bytes, ...Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, summarize(values)])) })
    }
  }
  // Profile just the actual bundled newline sampling expressions, not an imitation.
  const expressions = Object.fromEntries(Object.entries({ before: oldFileWorker.NATIVE_FILE_PROGRAM, after: NATIVE_FILE_PROGRAM })
    .map(([name, source]) => { const match = /^\s+sample = (original[^\n]+)$/m.exec(source); assert.ok(match, 'newline-sampling expression must use original; compression samples do not qualify'); return [name, match[1]] }))
  const sampleMemory = JSON.parse((await python(String.raw`
import json, sys, tracemalloc
expressions = json.loads(sys.stdin.buffer.read())
original = 'x' * (4 * 1024 * 1024) + '\r\n'
answers, result = {}, {}
for name, expression in expressions.items():
    fn = eval('lambda original: ' + expression)
    fn(original)
    tracemalloc.start()
    answers[name] = fn(original)
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    result[name] = {'peakBytes': peak, 'sampleCodePoints': len(answers[name])}
assert answers['before'] == answers['after']
print(json.dumps(result))
`, [], JSON.stringify(expressions))).toString())
  const pools = Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => [name, fixture.fs.wslRpcPool.diagnostics()]))
  for (const state of Object.values(pools)) { assert.equal(state.pending, 0); assert.equal(state.fallbacks, 0); assert.equal(state.launches, 1) }
  const result = { scope: 'warm resolve+stat+native read/guarded-write/edit; baseline vs optimized; not UNC, model or Desktop GUI latency',
    platform: process.platform, node: process.version, baselineSha: git.stdout.trim(), iterations, decoding, bootstrap20Calls: bootstrap,
    newlineSamplingOnly: sampleMemory, rows, pools }
  const json = JSON.stringify(result, null, 2) + '\n'
  const output = flag('--output', undefined)
  if (output) await writeFile(output, json)
  console.log(json)
} finally {
  for (const fixture of Object.values(fixtures)) await fixture.cleanup()
}
