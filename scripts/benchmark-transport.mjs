#!/usr/bin/env node
/** Actual fixed search scripts: identical data and results, different process transport. */
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { SearchWorker } from '../src/shared/search-worker.ts'
import { GREP_SCRIPT, GLOB_SCRIPT } from '../src/shared/search-scripts.ts'
import { basenameFilters } from '../src/shared/search-patterns.ts'
import { fixture, runBash } from './benchmark-search.mjs'

const distro = process.env.WSL_COMPAT_DISTRO || 'Ubuntu'
const isWindows = process.platform === 'win32'
const worker = new SearchWorker({ command: isWindows ? 'wsl.exe' : 'bash',
  argv: isWindows ? ['-d', distro, '--cd', '/', '--exec', 'bash'] : [], bootTimeoutMs: 15_000 })
const files = Number(process.env.DSH_SEARCH_BENCH_FILES || 1000)
const iterations = Number(process.env.DSH_SEARCH_BENCH_ITERATIONS || 20)
if (!Number.isInteger(files) || files < 1 || files > 20_000 || !Number.isInteger(iterations) || iterations < 2 || iterations > 100) {
  throw new Error('invalid benchmark size')
}
function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const percentile = p => Number(sorted[Math.ceil(p * sorted.length) - 1].toFixed(3))
  return { calls: samples.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) }
}
const root = await fixture(files, distro)
try {
  const rows = []
  let firstCallMs
  for (const op of ['glob', 'grep']) {
    const args = op === 'glob'
      ? [root, '20000000', ...basenameFilters(['src/**/*.ts'])]
      : ['needle', '', root, '20000000', ...basenameFilters(['src/**/*.ts'], true)]
    const samples = [[], []]
    let bytes = 0
    for (let i = -2; i < iterations; i++) {
      const pair = []
      for (const which of i % 2 === 0 ? [0, 1] : [1, 0]) {
        const start = performance.now()
        const value = which === 0 ? await runBash(op === 'glob' ? GLOB_SCRIPT : GREP_SCRIPT, args, distro)
          : await worker.run({ op, cwd: '/', args, timeoutMs: 30_000, maxBytes: 21_048_576 })
        const elapsed = performance.now() - start
        assert.equal(value.code, 0)
        assert.equal(value.aborted ?? false, false)
        if (which === 1 && firstCallMs === undefined) firstCallMs = Number(elapsed.toFixed(3))
        if (i >= 0) samples[which].push(elapsed)
        pair[which] = value
      }
      assert.deepEqual(pair[0].stdout, pair[1].stdout)
      assert.deepEqual(pair[0].stderr, pair[1].stderr)
      bytes = pair[1].stdout.length
    }
    rows.push({ op, stdoutBytes: bytes, oneshot: summary(samples[0]), persistent: summary(samples[1]) })
  }
  console.log(JSON.stringify({ scope: 'warmed fixed search scripts; excludes DSH/model/host matching; no latency gate',
    platform: process.platform, node: process.version, distro: isWindows ? distro : null,
    files, iterations, firstPersistentCallMs: firstCallMs, persistentWorkerPid: worker.pid, rows }, null, 2))
} finally {
  worker.dispose()
  await runBash('rm -rf -- "$1"', [root], distro)
}
