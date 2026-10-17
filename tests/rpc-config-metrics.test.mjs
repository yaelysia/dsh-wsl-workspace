import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveRpcConfig, RPC_DEFAULTS } from '../src/shared/rpc-config.ts'
import { RpcMetrics, registerRpcDiagnostics, rpcDiagnostics } from '../src/shared/rpc-metrics.ts'
import { transformPresetForWsl } from '../src/host/variants.ts'

test('default is automatic with a two-minute idle lifetime and bounded local metrics', () => {
  assert.deepEqual(resolveRpcConfig({}, {}), { transport: 'auto', idleMs: 120000, metrics: true })
  assert.deepEqual(resolveRpcConfig({}, {}), RPC_DEFAULTS)
})
test('explicit options override environment including false; environment overrides defaults', () => {
  const env = { DSH_WSL_SEARCH_TRANSPORT: 'persistent', DSH_WSL_RPC_IDLE_MS: '300000', DSH_WSL_RPC_METRICS: '0' }
  assert.deepEqual(resolveRpcConfig({}, env), { transport: 'persistent', idleMs: 300000, metrics: false })
  assert.deepEqual(resolveRpcConfig({transport:'oneshot',idleMs:1000,metrics:true}, env),
    {transport:'oneshot',idleMs:1000,metrics:true})
  assert.equal(resolveRpcConfig({metrics:false}, {DSH_WSL_RPC_METRICS:'true'}).metrics, false)
})
test('invalid options and environment values fail before resources start', () => {
  for (const transport of ['', 'autos', 'AUTO']) assert.throws(() => resolveRpcConfig({transport}, {}), /transport/)
  for (const idleMs of [0, -1, 999, 3600001, 1500.5, NaN, Infinity]) assert.throws(() => resolveRpcConfig({idleMs}, {}), /idleMs/)
  for (const idle of ['', '1e4', ' 1000', 'no']) assert.throws(() => resolveRpcConfig({}, {DSH_WSL_RPC_IDLE_MS:idle}), /idleMs/)
  assert.throws(() => resolveRpcConfig({}, {DSH_WSL_RPC_METRICS:'yes'}), /metrics/)
})
test('runtime options reach generated search rows but never add search to modes without it', () => {
  const options = resolveRpcConfig({transport:'oneshot', idleMs:300000, metrics:false}, {})
  const source = "- id: tool-fs-search\n  name: '@deepseek-ai/dsh-tool-fs-search'\n"
  const output = transformPresetForWsl(source, '/shell.js', '/fs.js', undefined, '/search.js', undefined, undefined, options)
  assert.match(output, /id: search-wsl\n +name: '\/search.js'\n +config:\n +transport: 'oneshot'\n +idleMs: 300000\n +metrics: false/)
  assert.ok(!transformPresetForWsl('', '/shell.js', '/fs.js', undefined, '/search.js', undefined, undefined, options).includes('search-wsl'))
})
test('percentiles cover the last 256 samples; counts and outcomes cover the full lifetime', () => {
  const metrics = new RpcMetrics()
  for(let i=1;i<=300;i++) metrics.record('tool.grep', i, i%2 ? 'ok' : 'error')
  const row = metrics.snapshot().stages['tool.grep']
  assert.deepEqual(row, {count:300,samples:256,outcomes:{ok:150,error:150,aborted:0,overflow:0},p50Ms:172,p95Ms:288})
  row.outcomes.ok = 0
  assert.equal(metrics.snapshot().stages['tool.grep'].outcomes.ok,150,'snapshots must not mutate counters')
})
test('disabled metrics and arbitrary request labels retain no data', () => {
  const disabled = new RpcMetrics(false); disabled.record('tool.grep',1)
  assert.deepEqual(disabled.snapshot().stages,{})
  const metrics = new RpcMetrics()
  for(const key of ['/private/token','rpc.secret.total','tool.file-content']) metrics.record(key,1)
  for(const duration of [NaN, Infinity, -1]) metrics.record('tool.grep',duration)
  assert.deepEqual(metrics.snapshot().stages,{})
})
test('diagnostic registration is explicitly owned, anonymous and disposable', () => {
  const count = rpcDiagnostics().providers.length
  const dispose = registerRpcDiagnostics(() => ({workers:1,metrics:new RpcMetrics().snapshot()}))
  assert.equal(rpcDiagnostics().providers.length,count+1)
  dispose(); dispose()
  assert.equal(rpcDiagnostics().providers.length,count)
})
