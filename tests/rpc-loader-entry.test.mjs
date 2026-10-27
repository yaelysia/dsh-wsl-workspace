/** Exercise the export/entry boundary used by Desktop, not ctx.plugin(moduleNamespace). */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import { load as parseYaml } from 'js-yaml'
import { transformPresetForWsl } from '../src/host/variants.ts'
import { load, resolvePath } from '../scripts/compatibility/plane.mjs'
import { makeFixture, rpcOptions, WslFileSystem } from './support/native-fixture.mjs'

const search = await load('search')
const require = createRequire(import.meta.url)
const versions = Object.fromEntries(['cordis', 'cordis-plugin-loader', 'dsh-fs-local'].map(name => [name,
  JSON.parse(readFileSync(require.resolve(`@deepseek-ai/${name}/package.json`), 'utf8')).version]))
console.log('loader-entry host:', JSON.stringify(versions))

async function until(check) {
  const end = Date.now() + 5000
  while (!check()) {
    if (Date.now() >= end) throw new Error('actual Loader lifecycle did not settle')
    await delay(10)
  }
}

// Only the tool observation sink is a fixture. Real Cordis tracing/effects own
// registrations, so filesystem removal must actually withdraw search tools.
class ToolSink extends Service {
  active = new Map()
  constructor(ctx) { super(ctx, 'tools') }
  register(tool) {
    return this.ctx.effect(() => {
      assert.equal(this.active.has(tool.name), false, `duplicate ${tool.name}`)
      this.active.set(tool.name, tool)
      return () => { if (this.active.get(tool.name) === tool) this.active.delete(tool.name) }
    })
  }
}

async function harness(t) {
  const f = await makeFixture()
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await f.cleanup() })
  await ctx.plugin(Loader)
  await ctx.plugin(ToolSink)
  ctx.provide('workingDirectory', { async ensure() { return f.cwd } })
  ctx.provide('systemPrompt', { getSectionOrder() { return 1 }, section() {} })
  // A real isolated world must neither borrow nor dispose the root's filesystem.
  ctx.provide('fs', { rpcPoolFor() { throw new Error('search escaped its isolated filesystem realm') } })
  const loader = ctx.get('loader')
  loader.builtins.group = Group
  class NativeFiles extends WslFileSystem {
    constructor(scope, config) { super(scope, config, rpcOptions) }
  }
  loader.builtins['fixture-files'] = NativeFiles
  const generated = parseYaml(transformPresetForWsl(
    '- id: tool-fs-search\n  name: "@deepseek-ai/dsh-tool-fs-search"\n',
    'cordis:unused-shell', 'cordis:fixture-files', undefined, pathToFileURL(resolvePath('search')).href,
    undefined, undefined, undefined, undefined, pathToFileURL(resolvePath('wsl-read-tool')).href,
  ))
  const world = generated.find(row => row.id === 'wsl-world')
  assert.equal(world.isolate.fs, true)
  const fileRow = world.config.find(row => row.id === 'fs-wsl')
  fileRow.config = { cwd: f.cwd, backend: 'native', diffBasisMaxBytes: 1024 }
  const searchRow = world.config.find(row => row.id === 'search-wsl')
  const readRow = world.config.find(row => row.id === 'read-wsl')
  assert.ok(readRow, 'the transformed world must mount the native WSL read tool')
  // These are the generated group and real search file URL. No replacement
  // import(), fake unwrapExports(), or namespace-based ctx.plugin(search).
  await loader.create({ ...world, config: [] })
  const scope = loader.resolveGroup(world.id).ctx
  assert.equal(scope.get('fs'), undefined)
  return { f, ctx, loader, scope, world, fileRow, searchRow, readRow, tools: ctx.get('tools').active }
}

function execution(f) {
  return { agent: { session: { header: { cwd: f.cwd } } }, signal: new AbortController().signal }
}

async function operate(h, expected = 'AFTER') {
  const fs = h.scope.get('fs')
  const target = await fs.resolve('loader-marker.txt')
  const written = await fs.writeText(target, 'CP10_NEEDLE\nBEFORE\n')
  await fs.editText(target, { oldString: 'BEFORE', newString: expected, replaceAll: false }, { version: written.version })
  assert.equal(await fs.readText(target), `CP10_NEEDLE\n${expected}\n`)
  const grep = await h.tools.get('grep').execute({ pattern: 'CP10_NEEDLE', path: h.f.root }, execution(h.f))
  const glob = await h.tools.get('glob').execute({ pattern: '*.txt', path: h.f.root }, execution(h.f))
  assert.equal(grep.matches.length, 1)
  assert.ok(glob.paths.some(path => path.endsWith('loader-marker.txt')))
  const diag = fs.wslRpcPool.diagnostics()
  for (const name of ['file.read', 'file.write', 'file.edit', 'tool.grep', 'tool.glob']) {
    assert.ok(diag.metrics.stages[name]?.count > 0, `${name} belongs to the same pool`)
  }
  assert.equal(diag.workers, 1)
  assert.equal(diag.launches, 1)
  assert.equal(diag.pending, 0)
  assert.equal(diag.fallbacks, 0)
  return { fs, target, pool: fs.wslRpcPool }
}


test('actual Loader mounts the native window read tool and returns exact content with one RPC', { timeout: 30000 }, async t => {
  const h = await harness(t)
  await h.loader.create(h.fileRow, h.world.id)
  await h.loader.create(h.readRow, h.world.id)
  await until(() => h.tools.has('read') && h.scope.get('fs'))
  const fs = h.scope.get('fs')
  const target = await fs.resolve('loader-read.txt')
  await fs.writeText(target, 'snapshot\nfrom loader\n')
  const captured = []
  const pool = fs.wslRpcPool, base = pool.run.bind(pool)
  pool.run = (where, request) => { captured.push(request.op); return base(where, request) }
  const value = await h.tools.get('read').execute({ file_path: 'loader-read.txt' }, execution(h.f))
  assert.equal(value.path, h.f.root + '/loader-read.txt')
  assert.deepEqual(value.lines, [
    { number: 1, text: 'snapshot' },
    { number: 2, text: 'from loader' },
  ])
  assert.deepEqual(captured, ['fs.window'])
  assert.equal(pool.diagnostics().pending, 0)
  assert.equal(pool.diagnostics().fallbacks, 0)
})

test('the actual Loader-selected default preserves dependency and schema metadata', () => {
  const selected = Loader.prototype.unwrapExports(search)
  assert.deepEqual(selected.inject, ['tools', 'fs'])
  assert.equal(selected.Config, search.Config)
  assert.equal(selected.apply, search.apply)
})

test('negative control: the old bare default registers search before the isolated owner exists', async t => {
  const h = await harness(t)
  h.loader.builtins['old-search'] = { ...search, default: search.apply }
  await h.loader.create({ ...h.searchRow, name: 'cordis:old-search' }, h.world.id)
  await until(() => h.tools.size === 2)
  assert.equal(h.scope.get('fs'), undefined)
  assert.equal(h.loader.resolve(h.searchRow.id).fiber.runtime.Config, undefined)
  assert.deepEqual(Object.keys(h.loader.resolve(h.searchRow.id).fiber.inject), [])
})

for (const order of ['search-first', 'filesystem-first']) {
  test(`actual file entry in the generated isolated realm shares one worker: ${order}`, { timeout: 30000 }, async t => {
    const h = await harness(t)
    if (order === 'filesystem-first') await h.loader.create(h.fileRow, h.world.id)
    await h.loader.create(h.searchRow, h.world.id)
    if (order === 'search-first') {
      await delay(30)
      assert.equal(h.tools.size, 0, 'actual default must wait, not allocate its own pool')
      await h.loader.create(h.fileRow, h.world.id)
    }
    await until(() => h.tools.size === 2 && h.scope.get('fs'))
    const entry = h.loader.resolve(h.searchRow.id)
    assert.deepEqual(Object.keys(entry.fiber.inject).sort(), ['fs', 'tools'])
    assert.equal(entry.fiber.runtime.Config, search.Config)
    const first = await operate(h)

    // Removing the owner must withdraw dependents, not leave tools holding its
    // disposed pool. Re-enabling creates a new owner and rebinds the actual entry.
    await h.loader.update(h.fileRow.id, { disabled: true })
    await until(() => h.tools.size === 0 && !h.scope.get('fs'))
    assert.equal(first.pool.diagnostics().workers, 0)
    await h.loader.update(h.fileRow.id, { disabled: false })
    await until(() => h.tools.size === 2 && h.scope.get('fs'))
    const second = await operate(h, 'REBOUND')
    assert.notEqual(second.pool, first.pool)

    await h.loader.update(h.searchRow.id, { disabled: true })
    await until(() => h.tools.size === 0)
    assert.equal(await second.fs.readText(second.target), 'CP10_NEEDLE\nREBOUND\n')
    assert.equal(second.pool.diagnostics().launches, 1, 'search disposal cannot kill the owner')
    console.log('loader-entry verified:', JSON.stringify({ order, launches: 1, reboundLaunches: 1, pending: 0 }))
  })
}
