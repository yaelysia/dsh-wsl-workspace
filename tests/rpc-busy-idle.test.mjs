import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { NativeFileClient } from '../src/shared/native-files.ts'
import { makeFixture, lockedDirectory, readRaw, distro } from './support/native-fixture.mjs'

// Deliberately separate from fast unit tests: this crosses the real default
// lifetime rather than only scaling a timer down or advancing a fake clock.
test('a native mutation stays alive through 125 seconds of busy time at the 120-second default', { timeout: 180000 }, async t => {
  const f = await makeFixture({ idleMs: 120000 })
  t.after(() => f.cleanup())
  const path = `${f.root}/busy.txt`
  const target = await f.fs.resolve('busy.txt')
  const before = await f.fs.writeText(target, 'before', { kind: 'createIfAbsent' })
  const unlock = await lockedDirectory(f.root)
  const stop = new AbortController()
  const pool = f.fs.wslRpcPool
  const client = new NativeFileClient(pool)
  let settled = false
  const outcome = client.write({ distro, linuxCwd: '/', wslPath: 'wsl.exe' }, path, 'after',
    { kind: 'replaceIfVersion', version: before.version }, undefined, 1024,
    { timeoutMs: 150000, signal: stop.signal }).then(
      value => { settled = true; return { value } }, error => { settled = true; return { error } })
  const started = Date.now()
  try {
    const deadline = Date.now() + 5000
    while (pool.snapshot().pending === 0 && !settled) {
      if (Date.now() > deadline) throw new Error('busy mutation did not enter the RPC')
      await delay(10)
    }
    assert.equal(settled, false)
    // No file/search request is made during this interval: it cannot accidentally
    // reset the deadline and conceal an erroneous idle eviction of busy work.
    await delay(125000)
    assert.equal(settled, false, 'the held mutation must not time out or be retired as idle')
    assert.equal(pool.snapshot().workers, 1)
    assert.equal(pool.snapshot().launches, 1)
    assert.equal(pool.snapshot().idleReleases, 0)
    assert.equal(pool.snapshot().pending, 1)
    await unlock()
    const result = await outcome
    if (result.error) throw result.error
    assert.equal(result.value.after, 'after')
    assert.equal((await readRaw(path)).toString(), 'after')
    assert.equal(pool.snapshot().pending, 0)
    console.log(JSON.stringify({ busyMs: Date.now() - started, idleMs: 120000,
      launches: pool.snapshot().launches, idleReleases: pool.snapshot().idleReleases, pending: 0 }))
  } finally {
    stop.abort()
    await unlock()
    await outcome
  }
})
