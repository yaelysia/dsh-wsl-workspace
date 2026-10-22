// Paired real provider reads on ONE Linux/WSL fixture. Historical CP15 is only the git baseline.
// No host/tool scheduler, UI or model latency is included.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { makeFixture, python, rpcOptions, windows, distro } from '../tests/support/native-fixture.mjs'

const flag=(name,defaultValue)=>{const i=process.argv.indexOf(name);return i<0?defaultValue:process.argv[i+1]}
const iterations=Number(flag('--iterations','20'))
assert.ok(Number.isInteger(iterations)&&iterations>=4&&iterations<=80)
const baseline=resolve(flag('--baseline','.cp16-baseline'))
const git=spawnSync('git',['-C',baseline,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true})
assert.equal(git.status,0,'baseline must be an existing checkout')
assert.equal(git.stdout.trim(),'2e7e279e0a62dcaa86452c090d1313c7b2aa8342')
const previous=await import(pathToFileURL(join(baseline,'src/fs.ts')).href)
const fixture=await makeFixture()
const before=new previous.WslFileSystem(new Context(),{
  cwd:fixture.cwd,backend:'native',diffBasisMaxBytes:1024*1024,
},rpcOptions)
const providers={before,after:fixture.fs}
const fileCount=24,fileSize=4096
const expected=Array.from({length:fileCount},(_,i)=>('CP16_'+String(i).padStart(2,'0')).padEnd(fileSize,'x'))
let active=null,ops=[]
for(const [name,fs] of Object.entries(providers)){
  const original=fs.wslRpcPool.run.bind(fs.wslRpcPool)
  fs.wslRpcPool.run=(target,request)=>{
    if(active===name)ops.push(request.op)
    return original(target,request)
  }
}
const stats=values=>{
  const sorted=[...values].sort((a,b)=>a-b)
  return {p50Ms:+sorted[Math.ceil(sorted.length*.5)-1].toFixed(3),
    p95Ms:+sorted[Math.ceil(sorted.length*.95)-1].toFixed(3),rawMs:values}
}
const readOne=async(fs,i)=>{
  const target=await fs.resolve('small/'+i+'.txt')
  const info=await fs.stat(target)
  assert.equal(info?.size,fileSize)
  assert.equal(info.type,'file')
  const content=await fs.readText(target)
  assert.equal(content,expected[i])
}
const scenarios=[
  {name:'24-files-serial',work:async fs=>{for(let i=0;i<fileCount;i++)await readOne(fs,i)}},
  {name:'24-files-8way',work:async fs=>{
    for(let start=0;start<fileCount;start+=8)
      await Promise.all(Array.from({length:8},(_,i)=>readOne(fs,start+i)))
  }},
]
try{
  await python(String.raw`import os,sys
r=sys.argv[1];os.makedirs(r+'/small',exist_ok=True)
for i in range(24):
    content=('CP16_%02d'%i).encode().ljust(4096,b'x')
    with open(r+'/small/'+str(i)+'.txt','wb') as f:f.write(content)
`,[fixture.root])
  const rows=[]
  for(const scenario of scenarios){
    const raw={before:[],after:[]},counts={before:[],after:[]}
    for(let i=-3;i<iterations;i++){
      for(const name of i%2===0?['before','after']:['after','before']){
        active=name;ops=[]
        const start=performance.now()
        await scenario.work(providers[name])
        const elapsed=performance.now()-start
        const observed=ops;active=null
        if(i>=0){raw[name].push(elapsed);counts[name].push({
          total:observed.length,byOp:Object.fromEntries([...new Set(observed)].sort().map(op=>[
            op,observed.filter(x=>x===op).length,
          ])),
        })}
      }
    }
    assert.deepEqual([...new Set(counts.before.map(x=>x.total))],[72],'baseline must run 72 RPCs')
    const afterCount=counts.after[0].total
    if(scenario.name.endsWith('serial'))
      assert.deepEqual([...new Set(counts.after.map(x=>x.total))],[72],'sequential control must be unchanged')
    else
      assert.ok(counts.after.every(x=>x.total<72),'every parallel sample must reduce RPCs')
    rows.push({scenario:scenario.name,before:{wall:stats(raw.before),calls:counts.before},
      after:{wall:stats(raw.after),calls:counts.after},medianCallReduction:
      +(1-afterCount/72).toFixed(4)})
  }
  for(const [name,fs] of Object.entries(providers)){
    const diag=fs.wslRpcPool.diagnostics()
    assert.equal(diag.workers,1,name)
    assert.equal(diag.pending,0,name)
    assert.equal(diag.fallbacks,0,name)
  }
  const output={scope:'paired real native fs.resolve -> stat -> readText; warm worker, same fixture, excludes DSH model/GUI',
    baselineSha:git.stdout.trim(),platform:process.platform,distro:windows?distro:null,
    node:process.version,iterations,fileCount,fileSize,rows}
  const json=JSON.stringify(output,null,2)+'\n'
  if(flag('--output'))await writeFile(flag('--output'),json)
  console.log(json)
}finally{
  active=null
  before.wslRpcPool.dispose()
  await fixture.cleanup()
}
