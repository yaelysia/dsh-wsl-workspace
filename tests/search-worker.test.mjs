import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { SearchWorker, SearchWorkerBusy, SearchWorkerCancelled, SearchWorkerUnavailable } from '../src/shared/search-worker.ts'
import { SearchTransport } from '../src/shared/search-transport.ts'
import { GREP_SCRIPT, GLOB_SCRIPT } from '../src/shared/search-scripts.ts'
import { fixture, runBash } from '../scripts/benchmark-search.mjs'

const distro = process.env.WSL_COMPAT_DISTRO || 'Ubuntu'
const options = extra => ({
  command: process.platform === 'win32' ? 'wsl.exe' : 'bash',
  argv: process.platform === 'win32' ? ['-d', distro, '--cd', '/', '--exec', 'bash'] : [],
  bootTimeoutMs: 15_000,
  ...extra,
})
const request = (args = [], overrides = {}) => ({ op: 'grep', args, cwd: '/', timeoutMs: 20_000, maxBytes: 2_000_000, ...overrides })
const echo = 'printf "%s\\0" "$@"; printf "err\\0尾\\n" >&2'

async function withWorker(run, extra = {}) {
  const worker = new SearchWorker(options(extra))
  try { return await run(worker) } finally { worker.dispose() }
}

test('one worker preserves byte framing, separate stderr, argv and cwd across concurrent calls', async () => {
  await withWorker(async worker => {
    await worker.run(request(['warm']))
    const pid = worker.pid
    for (let batch = 0; batch < 4; batch++) {
      const args = ['plain', '', '中文 path', 'line\nbreak', '$(touch SHOULD_NOT_EXIST)', 'quote"end', '\\wsl']
      const results = await Promise.all(Array.from({ length: 4 }, (_, i) => worker.run(request([...args, String(i)]))))
      for (let i = 0; i < results.length; i++) {
        assert.deepEqual(results[i].stdout, Buffer.from([...args, String(i)].join('\0') + '\0'))
        assert.deepEqual(results[i].stderr, Buffer.from('err\0尾\n'))
        assert.equal(results[i].code, 0)
      }
    }
    assert.equal(worker.pid, pid)
  }, { scripts: { grep: echo, glob: 'pwd -P' } })
})

test('persistent and one-shot fixed scripts produce the same raw search results', async () => {
  const root = await fixture(30, distro)
  try {
    await withWorker(async worker => {
      const cases = [
        request(['needle', '', root, '1000000']),
        request(['needle', '*.ts\n*.js', root, '1000000']),
        request(['not_present', '', root, '1000000']),
        request(['[', '', root, '1000000']),
        request([root, '1000000', '*.ts'], { op: 'glob' }),
        request(['src', '1000000'], { op: 'glob', cwd: root }),
        request(['/path-that-does-not-exist-xyz', '1000000'], { op: 'glob' }),
      ]
      for (const req of cases) {
        const native = await worker.run(req)
        // WSL argv cannot preserve a newline-containing argument on all builds;
        // use stdin framing for that case and assert the expected union instead.
        if (process.platform === 'win32' && req.args.some(value => value.includes('\n'))) {
          assert.match(native.stdout.toString(), /main\.ts/)
          assert.match(native.stdout.toString(), /main\.js/)
          continue
        }
        let direct
        try {
          direct = await runBash('cd -- "$1" || exit; shift; ' + (req.op === 'grep' ? GREP_SCRIPT : GLOB_SCRIPT), [req.cwd, ...req.args], distro)
        } catch (error) {
          direct = { code: error.code, stdout: error.stdout, stderr: error.stderr }
        }
        assert.equal(native.code, direct.code)
        assert.deepEqual(native.stdout, direct.stdout)
        assert.deepEqual(native.stderr, direct.stderr)
      }
    })
  } finally { await runBash('rm -rf -- "$1"', [root], distro) }
})

test('cancelling one request does not kill its sibling or poison the next request', async () => {
  await withWorker(async worker => {
    await worker.run(request(['warm']))
    const pid = worker.pid
    const controller = new AbortController()
    const cancelled = worker.run(request(['slow']), controller.signal)
    await sleep(100)
    const fast = worker.run(request(['fast']))
    controller.abort()
    assert.equal((await cancelled).aborted, true)
    assert.equal((await fast).stdout.toString(), 'fast')
    assert.equal((await worker.run(request(['next']))).stdout.toString(), 'next')
    assert.equal(worker.pid, pid)
  }, { scripts: { grep: 'if [ "$1" = slow ]; then sleep 30; fi; printf "%s" "$1"', glob: GLOB_SCRIPT } })
})

test('deadlines, per-stream caps and capacity are bounded without discarding the worker', async () => {
  await withWorker(async worker => {
    await worker.run(request(['warm']))
    const timed = await worker.run(request(['slow'], { timeoutMs: 100 }))
    assert.equal(timed.aborted, true)
    const big = await worker.run(request(['big'], { maxBytes: 1024 }))
    assert.equal(big.overflow, true)
    assert.equal(big.stdout.length, 1024)
    const err = await worker.run(request(['stderr']))
    assert.equal(err.overflow, true)
    assert.equal(err.stderr.length, 1024 * 1024)
    const signal = new AbortController()
    const work = Array.from({ length: 4 }, () => worker.run(request(['slow']), signal.signal))
    await assert.rejects(worker.run(request(['fifth'])), SearchWorkerBusy)
    signal.abort()
    assert.equal((await Promise.all(work)).every(value => value.aborted), true)
    assert.equal((await worker.run(request(['next']))).stdout.toString(), 'next')
  }, { scripts: { grep: 'case "$1" in slow) sleep 30;; big) head -c 100000 /dev/zero;; stderr) head -c 2000000 /dev/zero >&2;; *) printf "%s" "$1";; esac', glob: GLOB_SCRIPT } })
})

test('auto fallback probes a missing interpreter only once, including concurrent startup failures', async () => {
  let starts = 0, fallbacks = 0, warnings = 0
  const transport = new SearchTransport('auto', async () => {
    fallbacks++
    return { code: 0, stdout: Buffer.from('fallback'), stderr: Buffer.alloc(0), aborted: false, signal: null }
  }, () => { starts++; return { command: 'definitely-not-a-python-interpreter-93847', argv: [] } }, () => { warnings++ })
  const target = { distro: 'test', linuxCwd: '/' }
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => transport.run(target, request())))
    assert.equal(results.every(value => value.stdout.toString() === 'fallback'), true)
    await transport.run(target, request())
    assert.equal(starts, 1)
    assert.equal(fallbacks, 5)
    assert.equal(warnings, 1)
  } finally { transport.dispose() }
})

test('strict mode never hides a missing runtime; already-cancelled requests never start', async () => {
  const worker = new SearchWorker({ command: 'missing-python-for-test-94874', argv: [] })
  try {
    const signal = new AbortController(); signal.abort()
    await assert.rejects(worker.run(request(), signal.signal), SearchWorkerCancelled)
    await assert.rejects(worker.run(request()), SearchWorkerUnavailable)
  } finally { worker.dispose() }
})

test('idle workers retire, identities do not mix, and a disposed transport cannot restart', async () => {
  let starts = 0
  const transport = new SearchTransport('persistent', () => { throw Error('unexpected fallback') }, () => {
    starts++
    return options({ idleMs: 100, scripts: { grep: 'pwd -P', glob: 'pwd -P' } })
  })
  try {
    const target = { distro: 'test', linuxCwd: '/' }
    assert.equal((await transport.run(target, request())).stdout.toString(), '/\n')
    assert.equal((await transport.run(target, request([], { cwd: '/tmp' }))).stdout.toString(), '/tmp\n')
    assert.equal(starts, 1)
    await transport.run({ ...target, username: 'other' }, request())
    assert.equal(starts, 2)
    await sleep(150)
    await transport.run(target, request())
    assert.equal(starts, 3)
    transport.dispose()
    await assert.rejects(transport.run(target, request()), /disposed/)
  } finally { transport.dispose() }
})

test('closing the channel cancels live searches instead of replaying them', async () => {
  const worker = new SearchWorker(options({ scripts: { grep: 'sleep 30', glob: 'printf ready' } }))
  await worker.run(request([], { op: 'glob' }))
  const pending = worker.run(request())
  const rejected = assert.rejects(pending, /disposed/)
  await sleep(100)
  worker.dispose()
  await rejected
  await assert.rejects(worker.run(request()), SearchWorkerUnavailable)
})

test('cancellation stops the Linux child process group, not just its Windows transport', async () => {
  await withWorker(async worker => {
    await worker.run(request(['0'], { op: 'glob' }))
    const controller = new AbortController()
    const pending = worker.run(request(), controller.signal)
    await sleep(150)
    controller.abort()
    const cancelled = await pending
    assert.equal(cancelled.aborted, true)
    const pid = cancelled.stdout.toString().trim()
    assert.match(pid, /^\d+$/)
    const status = await worker.run(request([pid], { op: 'glob' }))
    // An orphan may briefly be a reparented zombie; it must not still execute.
    assert.equal(status.stdout.toString().trim(), '')
  }, { scripts: {
    grep: 'sleep 30 & printf "%s\\n" "$!"; wait',
    glob: 'ps -o stat= -p "$1" 2>/dev/null | grep -v "^[[:space:]]*Z" || true',
  } })
})

test('a worker dying after dispatch is not replayed through the fallback', async () => {
  let fallbacks = 0
  const transport = new SearchTransport('auto', async () => { fallbacks++; throw Error('unexpected fallback') }, () => options({
    scripts: { grep: 'if [ "$1" = die ]; then kill -KILL "$PPID"; else printf "%s" "$1"; fi', glob: GLOB_SCRIPT },
  }))
  const target = { distro: 'test', linuxCwd: '/' }
  try {
    await transport.run(target, request(['warm']))
    await assert.rejects(transport.run(target, request(['die'])), /exited/)
    assert.equal(fallbacks, 0)
    assert.equal((await transport.run(target, request(['recovered']))).stdout.toString(), 'recovered')
  } finally { transport.dispose() }
})
