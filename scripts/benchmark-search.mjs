#!/usr/bin/env node
/** Controlled native-script A/B, not an end-to-end DSH or cold-WSL benchmark. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { resolve, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { GLOB_SCRIPT, GREP_SCRIPT } from '../src/shared/search-scripts.ts'
import { basenameFilters, compileGlob } from '../src/shared/search-patterns.ts'

const exec = promisify(execFile)
const isWindows = process.platform === 'win32'

/** Executes the same fixed scripts on Linux or through Windows' real wsl.exe. */
export async function runBash(script, args = [], distro = process.env.WSL_COMPAT_DISTRO || 'Ubuntu') {
  const start = performance.now()
  const command = isWindows ? 'wsl.exe' : 'bash'
  const argv = [...isWindows ? ['-d', distro, '-e', 'bash'] : [], '-c', script, 'dsh', ...args]
  try {
    const { stdout, stderr } = await exec(command, argv, { encoding: 'buffer', timeout: 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
    return { code: 0, stdout, stderr, elapsedMs: performance.now() - start }
  } catch (error) {
    // grep's no-match and head's bounded pipe close are results, not launch errors.
    if (error.killed || ![1, 141].includes(error.code)) throw error
    return { code: error.code, stdout: error.stdout, stderr: error.stderr, elapsedMs: performance.now() - start }
  }
}

/** The fixture belongs to this invocation only; no user workspace is modified. */
export async function fixture(files = 1000, distro) {
  const created = await runBash('mktemp -d /tmp/dsh-search-perf-XXXXXX', [], distro)
  assert.equal(created.code, 0)
  const root = created.stdout.toString('utf8').trim()
  assert.match(root, /^\/tmp\/dsh-search-perf-[A-Za-z0-9]+$/)
  try {
    const prepared = await runBash(`set -eu
root=$1; count=$2
mkdir -p "$root/src" "$root/logs" "$root/test" "$root/.git" "$root/src/sub" "$root/src/prefix"
for ((i=0; i<count; i++)); do printf 'needle unrelated log %s\\n' "$i" > "$root/logs/generated-$i.log"; done
for name in main.ts .hidden.ts 'space name.ts' '中文.ts' 'odd\nname.ts'; do printf 'needle source\\n' > "$root/src/$name"; done
printf 'needle nested\\n' > "$root/src/sub/deep.ts"
printf 'needle readme\\n' > "$root/src/README"
printf 'needle single\\n' > "$root/src/a"
printf 'needle nested wildcard\\n' > "$root/src/prefix/bar.ts"
printf 'needle javascript\\n' > "$root/test/main.js"
printf 'needle metadata\\n' > "$root/.git/metadata.ts"
ln -s src "$root/linked-src"
`, [root, String(files)], distro)
    assert.equal(prepared.code, 0)
    return root
  } catch (error) {
    await runBash('rm -rf -- "$1"', [root], distro)
    throw error
  }
}

export function globPaths(stdout) {
  return stdout.toString('utf8').split('\0').slice(1).filter(Boolean).map(row => row.slice(row.indexOf('\t') + 1))
}
export function grepPaths(stdout) {
  return [...stdout.toString('utf8').matchAll(/([^\0]*)\0\d+:[^\n]*\n/g)].map(match => match[1])
}
export function selectedPaths(paths, pattern, root) {
  const matches = compileGlob(pattern)
  return paths.filter(path => matches(posix.relative(root, path) || posix.basename(path))).sort()
}

function numberArg(args, key, fallback, maximum) {
  const raw = args.get(key)
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${key} must be an integer from 1 to ${maximum}`)
  return value
}
function summary(samples) {
  const times = samples.map(sample => sample.elapsedMs).sort((a, b) => a - b)
  const percentile = p => Number(times[Math.max(0, Math.ceil(p * times.length) - 1)].toFixed(3))
  return { calls: samples.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), stdoutBytes: samples.at(-1).stdout.length }
}

async function main() {
  const args = new Map()
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]
    if (!['--iterations', '--files', '--distro'].includes(key) || process.argv[i + 1] === undefined) throw new Error(`unknown or incomplete option: ${key}`)
    args.set(key, process.argv[i + 1])
  }
  const iterations = numberArg(args, '--iterations', 10, 100)
  const files = numberArg(args, '--files', 1000, 20_000)
  const distro = args.get('--distro') || process.env.WSL_COMPAT_DISTRO || 'Ubuntu'
  const root = await fixture(files, distro)
  const cap = String(20_000_000)
  const pattern = 'src/**/*.ts'
  const rows = []
  try {
    for (const tool of ['glob', 'grep']) {
      const script = tool === 'glob' ? GLOB_SCRIPT : GREP_SCRIPT
      const plain = tool === 'glob' ? [root, cap] : ['needle', '', root, cap]
      const filtered = [...plain, ...basenameFilters([pattern], tool === 'grep')]
      const samples = [[], []]
      for (let i = -2; i < iterations; i += 1) {
        // Alternate order, with two warm-up pairs excluded from the report.
        for (const index of i % 2 === 0 ? [0, 1] : [1, 0]) {
          const result = await runBash(script, index === 0 ? plain : filtered, distro)
          assert.equal(result.code, 0)
          if (i >= 0) samples[index].push(result)
        }
      }
      const decode = tool === 'glob' ? globPaths : grepPaths
      assert.deepEqual(selectedPaths(decode(samples[0].at(-1).stdout), pattern, root), selectedPaths(decode(samples[1].at(-1).stdout), pattern, root), 'prefilter changed final matches')
      rows.push({ tool, unfiltered: summary(samples[0]), prefiltered: summary(samples[1]) })
    }
    console.log(JSON.stringify({ scope: 'native-script A/B; warmed filesystem; excludes DSH/model and host sorting', platform: process.platform, node: process.version, distro: isWindows ? distro : null, unrelatedFiles: files, iterations, rows }, null, 2))
  } finally {
    await runBash('rm -rf -- "$1"', [root], distro)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1 })
}
