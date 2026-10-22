// Same fixture, alternating registered grep+glob runs against exact merged CP16.
// A selector only narrows a physical scan, never changes host glob matching.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { makeFixture, python, rpcOptions, windows, distro } from '../tests/support/native-fixture.mjs'
import { load } from './compatibility/plane.mjs'

const flag=(key,fallback)=>{const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1]}
const iterations=Number(flag('--iterations','20'))
assert.ok(Number.isInteger(iterations)&&iterations>=4&&iterations<=60)
const baseline=resolve(flag('--baseline','.cp17-baseline'))
const git=spawnSync('git',['-C',baseline,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true})
assert.equal(git.status,0,'baseline is an existing git checkout')
assert.equal(git.stdout.trim(),'053a71a5941c9bcec51a8e371c31aa279087ad36',
  'baseline must be merged CP16 main')
const old=await import(pathToFileURL(join(baseline,'src/fs.ts')).href)
const oldSearch=await import(pathToFileURL(join(baseline,'src/host/wsl-search.ts')).href)
const newer=await load('search')
const f=await makeFixture()
const before=new old.WslFileSystem(new Context(),
  {cwd:f.cwd,backend:'native',diffBasisMaxBytes:1024*1024},rpcOptions)
const providers={before,after:f.fs},cleanups=[],registry={},wire={}
const options={grepMaxMatches:20000,globMaxResults:20000,rawOutputMaxBytes:24*1024*1024}
for(const [name,fs] of Object.entries(providers)){
  const tools=new Map(),search=name==='before'?oldSearch:newer
  search.apply({get(key){return key==='tools'?{register:tool=>tools.set(tool.name,tool)}:
    key==='fs'?fs:undefined},effect(fn){cleanups.push(fn())}},options)
  registry[name]=tools
  const original=fs.wslRpcPool.run.bind(fs.wslRpcPool)
  fs.wslRpcPool.run=async(target,request)=>{
    const answer=await original(target,request)
    if(request.op==='grep'||request.op==='glob'){
      wire[name+':'+request.op]=answer.stdout.length
    }
    return answer
  }
}
const summary=x=>{
  const ordered=[...x].sort((a,b)=>a-b)
  return {p50Ms:+ordered[Math.ceil(ordered.length*.5)-1].toFixed(3),
    p95Ms:+ordered[Math.ceil(ordered.length*.95)-1].toFixed(3),rawMs:x}
}
try{
  await python([
    'import os,sys',
    'r=sys.argv[1]',
    "for d in ('src/services/deep','src/other'): os.makedirs(r+'/'+d,exist_ok=True)",
    'for i in range(120):',
    "    with open(r+'/src/services/deep/'+str(i)+'.tsx','w') as f: f.write('ANCHOR_BENCH_NEEDLE\\n')",
    'for d in range(100):',
    "    path=r+'/src/other/vendor-'+str(d)",
    '    os.makedirs(path)',
    '    for j in range(160):',
    "        with open(path+'/'+str(j)+'.tsx','w') as f: f.write('ANCHOR_BENCH_NEEDLE\\n')",
  ].join('\n'),[f.root])
  const exec={agent:{session:{header:{cwd:f.cwd}}},signal:new AbortController().signal}
  const cases=[
    {op:'grep',name:'wildcard-selector',args:{pattern:'ANCHOR_BENCH_NEEDLE',include:'**/services/**/*.tsx'},expected:120},
    {op:'glob',name:'wildcard-selector',args:{pattern:'**/services/**/*.tsx'},expected:120},
    {op:'grep',name:'all-files-control',args:{pattern:'ANCHOR_BENCH_NEEDLE',include:'**/*.tsx'},expected:16120},
    {op:'glob',name:'all-files-control',args:{pattern:'**/*.tsx'},expected:16120},
  ]
  const rows=[]
  for(const c of cases){
    const samples={before:[],after:[]},received={},bytes={}
    for(let i=-3;i<iterations;i++){
      for(const name of i%2===0?['before','after']:['after','before']){
        const start=performance.now()
        const result=await registry[name].get(c.op).execute(c.args,exec)
        const duration=performance.now()-start
        received[name]=result
        bytes[name]=wire[name+':'+c.op]
        if(i>=0)samples[name].push(duration)
      }
    }
    assert.deepEqual(received.before,received.after,c.op+' '+c.name+' changed complete results')
    assert.equal((c.op==='grep'?received.after.matches:received.after.paths).length,c.expected)
    rows.push({operation:c.op,scenario:c.name,...Object.fromEntries(Object.entries(samples)
      .map(([name,values])=>[name,summary(values)])),decodedRpcStdoutBytes:bytes,matchCount:c.expected})
  }
  const pools=Object.fromEntries(Object.entries(providers).map(([name,fs])=>{
    const p=fs.wslRpcPool.diagnostics()
    assert.equal(p.workers,1);assert.equal(p.pending,0);assert.equal(p.fallbacks,0)
    return [name,{workers:p.workers,launches:p.launches,pending:p.pending,fallbacks:p.fallbacks}]
  }))
  const result={scope:'registered grep/glob + real WSL RPC + host filtering; warm worker, excludes DSH model/UI',
    baselineSha:git.stdout.trim(),platform:process.platform,node:process.version,
    distro:windows?distro:null,iterations,fixture:{matchingFiles:120,unrelatedSameExtensionFiles:16000},rows,pools}
  const json=JSON.stringify(result,null,2)+'\n'
  if(flag('--output'))await writeFile(flag('--output'),json)
  console.log(json)
}finally{
  for(const fn of cleanups)fn?.()
  before.wslRpcPool.dispose()
  await f.cleanup()
}
