#!/usr/bin/env node
/** Native-script A/B: same scripts/arguments, different process transport. Not DSH end-to-end. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { SearchWorkerPool } from '../src/shared/search-transport.ts'
import { GREP_SCRIPT, GLOB_SCRIPT } from '../src/shared/search-scripts.ts'
import { basenameFilters } from '../src/shared/search-patterns.ts'
import { fixture, runBash } from './benchmark-search.mjs'

const options = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  if (!['--iterations', '--files', '--distro'].includes(key) || process.argv[i + 1] === undefined) throw new Error(`unknown/incomplete option: ${key}`)
  options.set(key, process.argv[i + 1])
}
function count(key, fallback, max) {
  const value = Number(options.get(key) ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`invalid ${key}`)
  return value
}
function summary(samples) {
  const sorted = [...samples].sort((a,b) => a-b)
  const p = q => Number(sorted[Math.ceil(q * sorted.length) - 1].toFixed(3))
  return { samples: sorted.length, p50Ms: p(0.5), p95Ms: p(0.95) }
}
const distro = options.get('--distro') || process.env.WSL_COMPAT_DISTRO || 'Ubuntu'
const files = count('--files', 1000, 20_000)
const iterations = count('--iterations', 30, 100)
const windows = process.platform === 'win32'
const pool = new SearchWorkerPool(windows ? {} : {
  launch: (_, code) => spawn('python3', ['-I', '-S', '-u', '-c', code], {stdio:'pipe'}),
})
const root = await fixture(files, distro)
const target = {wslPath:'wsl.exe', distro, linuxCwd:root}
const maxBytes = 20_000_000
const rows = []
try {
  const boot = performance.now()
  await pool.run(target, {op:'glob', args:[root, String(maxBytes + 1)], timeoutMs:30_000, maxBytes})
  const workerBootMs = Number((performance.now() - boot).toFixed(3))
  for (const op of ['glob', 'grep']) {
    const script = op === 'glob' ? GLOB_SCRIPT : GREP_SCRIPT
    const args = [...op === 'glob' ? [root, String(maxBytes + 1)] : ['needle', '', root, String(maxBytes + 1)],
      ...basenameFilters(['src/**/*.ts'], op === 'grep')]
    const samples = [[],[]]
    let stdoutBytes = 0
    for (let i=-2;i<iterations;i++) {
      const results = []
      for (const mode of i % 2 === 0 ? [0,1] : [1,0]) {
        const started = performance.now()
        results[mode] = mode === 0 ? await runBash(script,args,distro) :
          await pool.run(target, {op,args,timeoutMs:30_000,maxBytes})
        if (i >= 0) samples[mode].push(performance.now() - started)
        assert.equal(results[mode].code, 0)
        assert.ok(!results[mode].aborted)
      }
      assert.deepEqual(results[0].stdout,results[1].stdout,'transport changed the search bytes')
      assert.deepEqual(results[0].stderr,results[1].stderr,'transport changed the diagnostic bytes')
      stdoutBytes = results[1].stdout.length
    }
    rows.push({op,stdoutBytes,oneshot:summary(samples[0]),persistent:summary(samples[1])})
  }
  console.log(JSON.stringify({scope:'native scripts + transport; warm filesystem; excludes DSH, model and host filtering',
    platform:process.platform,node:process.version,distro:windows?distro:null,unrelatedFiles:files,
    workerBootMs,bootScope:'new worker; distribution already warm from fixture setup',
    persistentPool:pool.snapshot(),rows},null,2))
} finally {
  pool.dispose()
  await runBash('rm -rf -- "$1"',[root],distro)
}
