import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { load } from '../scripts/compatibility/plane.mjs'
import { makeFixture, rpcOptions, WslFileSystem } from './support/native-fixture.mjs'

const search = await load('search')

async function until(check) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('service lifecycle did not settle')
    await delay(10)
  }
}

function collectTools(ctx) {
  const tools = []
  ctx.provide('tools', { register(tool) { tools.push(tool); return () => {} } })
  return tools
}

for (const order of ['search-first', 'filesystem-first']) {
  test(`real Context plugin lifecycle shares the owner pool: ${order}`, async t => {
    const f = await makeFixture()
    const ctx = new Context()
    t.after(async () => { await ctx.fiber.dispose(); await f.cleanup() })
    const tools = collectTools(ctx)
    const config = { backend: 'native', cwd: f.cwd, diffBasisMaxBytes: 1024 }
    class Files extends WslFileSystem {
      constructor(scope, options) { super(scope, options, rpcOptions) }
    }
    let searchFiber
    if (order === 'search-first') {
      searchFiber = ctx.plugin(search, { transport: 'persistent' })
      await delay(30)
      assert.equal(tools.length, 0, 'search must wait for its declared filesystem dependency')
      await ctx.plugin(Files, config)
    } else {
      await ctx.plugin(Files, config)
      searchFiber = ctx.plugin(search, { transport: 'persistent' })
    }
    await until(() => tools.some(tool => tool.name === 'grep') && ctx.get('fs'))
    const fs = ctx.get('fs')
    const target = await fs.resolve('owner.txt')
    await fs.writeText(target, 'owner needle', { kind: 'createIfAbsent' })
    const exec = { agent: { session: { header: { cwd: f.cwd } } }, signal: new AbortController().signal }
    const result = await tools.find(tool => tool.name === 'grep').execute({ pattern: 'needle', path: f.root }, exec)
    assert.equal(result.matches.length, 1)
    const stats = fs.wslRpcPool.diagnostics()
    assert.equal(stats.launches, 1, 'read/write and search must use the same worker')
    assert.equal(stats.metrics.stages['tool.grep'].count, 1)
    await (await searchFiber).dispose()
    assert.equal(await fs.readText(target), 'owner needle', 'search disposal must not kill its owner pool')
    assert.equal(fs.wslRpcPool.diagnostics().launches, 1)
  })
}

test('independent filesystem owners retain separate pools and explicit metrics policy', async t => {
  const f = await makeFixture()
  t.after(() => f.cleanup())
  const another = f.provider({ metrics: false })
  assert.notEqual(f.fs.wslRpcPool, another.wslRpcPool)
  assert.equal(f.fs.rpcPoolFor({ idleMs: 120000, metrics: false }), undefined)
  assert.equal(another.rpcPoolFor({ idleMs: 120000, metrics: true }), undefined)
  const file = await f.fs.resolve('isolation.txt')
  await f.fs.writeText(file, 'independent', { kind: 'createIfAbsent' })
  assert.equal(await another.readText(file), 'independent')
  f.fs.wslRpcPool.dispose()
  assert.equal(await another.readText(file), 'independent')
  assert.equal(another.wslRpcPool.metrics.enabled, false)
})
