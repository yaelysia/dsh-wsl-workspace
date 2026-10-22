// Actual registered grep tool: baseline vs CP15 on one real WSL/Linux fixture.
// Alternate execution order, verify every returned match, retain raw timings.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { makeFixture, python, rpcOptions, windows, distro } from '../tests/support/native-fixture.mjs'
import { load } from './compatibility/plane.mjs'

const flag = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i+1] }
const iterations = Number(flag('--iterations', '20'))
assert.ok(Number.isInteger(iterations) && iterations >= 4 && iterations <= 80)
const baseline = resolve(flag('--baseline', '.cp15-baseline'))
const git = spawnSync('git', ['-C', baseline, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true })
assert.equal(git.status, 0, 'baseline must be a git checkout')
assert.equal(git.stdout.trim(), '59f70928687480bd46fc5c77c46727f2c9daa2f3')
const old = await import(pathToFileURL(join(baseline,'src/fs.ts')).href)
const oldSearch = await import(pathToFileURL(join(baseline,'src/host/wsl-search.ts')).href)
const search = await load('search')
const f = await makeFixture()
const beforeCtx = new Context(), before = new old.WslFileSystem(beforeCtx,
  { cwd:f.cwd,backend:'native',diffBasisMaxBytes:1024*1024 },rpcOptions)
const providers={before,after:f.fs}, cleanups=[]
const tools={}
const lastWire={}
for(const [name,fs] of Object.entries(providers)) {
  const registry=new Map()
  const module=name==='before'?oldSearch:search
  module.apply({get(key){return key==='tools'?{register:t=>registry.set(t.name,t)}:key==='fs'?fs:undefined},
    effect(fn){cleanups.push(fn())}}, {grepMaxMatches:20000,rawOutputMaxBytes:24*1024*1024})
  tools[name]=registry.get('grep')
  assert.ok(tools[name])
  const run=fs.wslRpcPool.run.bind(fs.wslRpcPool)
  fs.wslRpcPool.run=async(target,request)=>{
    const result=await run(target,request)
    if(request.op==='grep')lastWire[name]=result.stdout.length
    return result
  }
}
const summarise=x=>{const s=[...x].sort((a,b)=>a-b)
  return {samples:x.length,p50Ms:+s[Math.ceil(s.length*.5)-1].toFixed(3),
    p95Ms:+s[Math.ceil(s.length*.95)-1].toFixed(3),rawMs:x}}
try {
  await python(String.raw`import os,sys
r=sys.argv[1]
for d in ('src/services/deep','src/other'):
    os.makedirs(r+'/'+d,exist_ok=True)
for i in range(120):
    with open(r+'/src/services/deep/'+str(i)+'.tsx','w') as file: file.write('CP15_BENCH_NEEDLE\n')
for d in range(100):
    path=r+'/src/other/vendor-'+str(d)
    os.makedirs(path)
    for j in range(160):
        with open(path+'/'+str(j)+'.tsx','w') as file: file.write('CP15_BENCH_NEEDLE\n')
`,[f.root])
  const exec={agent:{session:{header:{cwd:f.cwd}}},signal:new AbortController().signal}
  const cases=[
    {name:'fixed-prefix',include:'src/services/**/*.tsx'},
    {name:'leading-wildcard-control',include:'**/services/**/*.tsx'},
  ]
  const rows=[]
  for(const c of cases) {
    const samples={before:[],after:[]}
    const answers={}
    const wire={}
    for(let i=-3;i<iterations;i++) {
      for(const name of i%2===0?['before','after']:['after','before']) {
        const start=performance.now()
        const answer=await tools[name].execute({pattern:'CP15_BENCH_NEEDLE',include:c.include},exec)
        const elapsed=performance.now()-start
        answers[name]=answer
        wire[name]=lastWire[name]
        if(i>=0)samples[name].push(elapsed)
      }
    }
    assert.deepEqual(answers.before,answers.after,'grep full-result mismatch: '+c.name)
    assert.equal(answers.after.matches.length,120,c.name)
    rows.push({scenario:c.name,...Object.fromEntries(Object.entries(samples).map(([k,v])=>[k,summarise(v)])),
      decodedRpcStdoutBytes:wire,matchCount:answers.after.matches.length})
  }
  const pools=Object.fromEntries(Object.entries(providers).map(([name,fs])=>{
    const p=fs.wslRpcPool.diagnostics()
    assert.equal(p.launches,1);assert.equal(p.pending,0);assert.equal(p.fallbacks,0)
    return [name,{workers:p.workers,launches:p.launches,pending:p.pending,fallbacks:p.fallbacks}]
  }))
  const result={scope:'warm registered grep tool (includes Linux search, RPC, host filtering); excludes LLM/GUI',
    baselineSha:git.stdout.trim(),platform:process.platform,node:process.version,
    distro:windows?distro:null,iterations,fixture:{matchingFiles:120,unrelatedSameExtensionFiles:16000},
    rows,pools}
  const json=JSON.stringify(result,null,2)+'\n'
  if(flag('--output'))await writeFile(flag('--output'),json)
  console.log(json)
}finally{
  for(const fn of cleanups)fn?.()
  before.wslRpcPool.dispose()
  await f.cleanup()
}
