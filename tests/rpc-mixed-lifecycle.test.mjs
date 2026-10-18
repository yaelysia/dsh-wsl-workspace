import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { load } from '../scripts/compatibility/plane.mjs'
import { makeFixture, lockedDirectory, readRaw, codeIs } from './support/native-fixture.mjs'

async function until(check) {
  const end = Date.now() + 5000
  while (!check()) {
    if (Date.now() > end) throw new Error('pending RPC did not reach the expected state')
    await delay(10)
  }
}

// A real kernel directory lock keeps the write pending, without slowing unrelated
// reads/searches artificially or making a timing guess about when it started.
test('a blocked native write overlaps reads and search, cancels cleanly and permits a later edit', { timeout: 30000 }, async t => {
  const f = await makeFixture()
  const ctx = f.fs.ctx
  t.after(async () => { await ctx.fiber.dispose(); await f.cleanup() })
  const target = await f.fs.resolve('mixed.txt')
  const initial = await f.fs.writeText(target, 'original needle\n', { kind: 'createIfAbsent' })
  const tools = []
  ctx.provide('tools', { register(tool) {
    tools.push(tool)
    return () => { const i = tools.indexOf(tool); if (i >= 0) tools.splice(i, 1) }
  } })
  const search = await load('search')
  await ctx.plugin(search, { transport: 'persistent' })
  const unlock = await lockedDirectory(f.root)
  const stop = new AbortController()
  const blocked = f.fs.writeText(target, 'must never publish',
    { kind: 'replaceIfVersion', version: initial.version }, stop.signal)
  const rejected = assert.rejects(blocked, codeIs('FS_ABORTED'))
  // Observe failures immediately while preserving the later assertion.
  void rejected.catch(() => {})
  const stats = () => f.fs.wslRpcPool.diagnostics()
  try {
    assert.equal(typeof stats().pending, 'number', 'pending belongs to diagnostics, not the minimal snapshot')
    await until(() => stats().pending > 0)
    const exec = { agent: { session: { header: { cwd: f.cwd } } }, signal: new AbortController().signal }
    const grep = tools.find(tool => tool.name === 'grep')
    assert.ok(grep, 'the dependent search plugin must be active')
    const result = await Promise.all([
      grep.execute({ pattern: 'needle', path: f.root }, exec),
      ...Array.from({ length: 6 }, () => f.fs.readText(target)),
    ])
    assert.equal(result[0].matches.length, 1)
    for (const value of result.slice(1)) assert.equal(value, 'original needle\n')
    assert.equal(stats().launches, 1)
    assert.ok(stats().pending >= 1, 'the locked write must still be pending during the other work')
    stop.abort()
    await rejected
  } finally {
    stop.abort()
    await unlock()
    await rejected
  }
  assert.equal((await readRaw(`${f.root}/mixed.txt`)).toString(), 'original needle\n')
  const info = await f.fs.stat(target)
  const edited = await f.fs.editText(target, { oldText: 'original', newText: 'recovered' }, { version: info.version })
  assert.equal(edited.after, 'recovered needle\n')
  assert.equal(await f.fs.readText(target), 'recovered needle\n')
  assert.equal(stats().pending, 0)
  assert.equal(stats().launches, 1)
})
