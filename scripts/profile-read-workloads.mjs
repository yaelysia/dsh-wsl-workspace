// Stage-level profiling of REAL native file provider paths, no runtime changes.
// Counts actual RPC invocations and decoded responses; not network wire bytes.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { writeFile } from 'node:fs/promises'
import { makeFixture, python, collect, windows, distro } from '../tests/support/native-fixture.mjs'

const flag=(key,fallback)=>{const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1]}
const iterations=Number(flag('--iterations','5'))
assert.ok(Number.isInteger(iterations)&&iterations>=2&&iterations<=30)
const fixture=await makeFixture()
const fs=fixture.fs, pool=fs.wslRpcPool, original=pool.run.bind(pool)
const fileCount=24, fileBytes=4096, largeBytes=4*1024*1024
let active=null
pool.run=async(target,request)=>{
  const began=performance.now()
  let result
  try {result=await original(target,request);return result}
  finally {
    if(active){
      const record=active
      const op=request.op
      const bucket=record.ops[op]??(record.ops[op]={calls:0,elapsedMs:0,decodedResponseBytes:0,approxRequestBytes:0})
      bucket.calls++
      bucket.elapsedMs+=performance.now()-began
      bucket.decodedResponseBytes+=result?.stdout?.length??0
      // JSON request bytes at the host, not the physical Base64/stdio frame.
      bucket.approxRequestBytes+=Buffer.byteLength(JSON.stringify({
        op:request.op,args:request.args,cwd:target.linuxCwd,
        timeoutMs:request.timeoutMs,maxBytes:request.maxBytes
      }))
    }
  }
}
const summarize=samples=>{
  const sorted=[...samples].sort((a,b)=>a-b)
  return {p50Ms:+sorted[Math.ceil(sorted.length*.5)-1].toFixed(3),
    p95Ms:+sorted[Math.ceil(sorted.length*.95)-1].toFixed(3),rawMs:samples}
}
const round=x=>+x.toFixed(3)
const runScenario=async(name,work)=>{
  const times=[],counts=[],stages=[],memory=[]
  for(let i=-1;i<iterations;i++){
    active={ops:{},phases:{}}
    const now=performance.now(),cpu=process.cpuUsage(),before=process.memoryUsage()
    await work()
    const duration=performance.now()-now
    const usage=process.cpuUsage(cpu),after=process.memoryUsage()
    const capture=active;active=null
    if(i>=0){
      times.push(duration)
      counts.push(capture.ops)
      stages.push(capture.phases)
      memory.push({rssDeltaBytes:after.rss-before.rss,heapDeltaBytes:after.heapUsed-before.heapUsed,
        hostCpuUserMs:usage.user/1000,hostCpuSystemMs:usage.system/1000})
    }
  }
  const opNames=[...new Set(counts.flatMap(row=>Object.keys(row)))].sort()
  const ops=Object.fromEntries(opNames.map(op=>[op,{
    callCounts:counts.map(row=>row[op]?.calls??0),
    summedRpcMs:summarize(counts.map(row=>row[op]?.elapsedMs??0)),
    decodedResponseBytes:counts.map(row=>row[op]?.decodedResponseBytes??0),
    approximateRequestBytes:counts.map(row=>row[op]?.approxRequestBytes??0)
  }]))
  const phaseNames=[...new Set(stages.flatMap(row=>Object.keys(row)))].sort()
  const phases=Object.fromEntries(phaseNames.map(stage=>[stage,summarize(stages.map(row=>row[stage]??0))]))
  return {scenario:name,samples:iterations,wall:summarize(times),ops,phases,
    hostOnlyMemoryCpu:memory.map(row=>({...row,hostCpuUserMs:round(row.hostCpuUserMs),
      hostCpuSystemMs:round(row.hostCpuSystemMs)}))}
}
const phase=async(name,fn)=>{
  const now=performance.now()
  try{return await fn()}finally{active.phases[name]=(active.phases[name]??0)+(performance.now()-now)}
}
try{
  await python(String.raw`import os,sys
r=sys.argv[1];count=int(sys.argv[2]);size=int(sys.argv[3]);large=int(sys.argv[4])
os.makedirs(r+'/small',exist_ok=True)
for i in range(count):
  content=('CP15_READ_%02d'%i).encode().ljust(size,b'x')
  with open(r+'/small/'+str(i)+'.txt','wb') as file:file.write(content)
with open(r+'/large.txt','wb') as file:file.write(b'q'*large)
`,[fixture.root,String(fileCount),String(fileBytes),String(largeBytes)])
  const names=Array.from({length:fileCount},(_,i)=>'small/'+i+'.txt')
  const expected=names.map((_,i)=>('CP15_READ_'+String(i).padStart(2,'0')).padEnd(fileBytes,'x'))
  const large=await fs.resolve('large.txt')
  const largeContent='q'.repeat(largeBytes)
  const readOne=async(i)=>{
    const target=await phase('resolve',()=>fs.resolve(names[i]))
    const stat=await phase('stat',()=>fs.stat(target))
    assert.equal(stat.size,fileBytes)
    const body=await phase('readText',()=>fs.readText(target))
    assert.equal(body,expected[i])
  }
  const scenarios=[]
  scenarios.push(await runScenario('24-files-serial-resolve-stat-read',async()=>{
    for(let i=0;i<fileCount;i++)await readOne(i)
  }))
  scenarios.push(await runScenario('24-files-8way-resolve-stat-read',async()=>{
    for(let index=0;index<fileCount;index+=8){
      await Promise.all(Array.from({length:Math.min(8,fileCount-index)},(_,i)=>readOne(index+i)))
    }
  }))
  scenarios.push(await runScenario('4MiB-readText-target-pre-resolved',async()=>{
    const s=await phase('readText',()=>fs.readText(large));assert.equal(s,largeContent)
  }))
  scenarios.push(await runScenario('4MiB-streamText-target-pre-resolved',async()=>{
    const stream=await phase('createStream',()=>fs.streamText(large))
    const content=await phase('consumeStream',()=>collect(stream))
    assert.equal(content,largeContent)
  }))
  const diag=pool.diagnostics()
  assert.equal(diag.pending,0);assert.equal(diag.fallbacks,0)
  const result={scope:'native Linux file provider profiling; warm worker; fixed synthetic data; no LLM/GUI/UNC',
    platform:process.platform,node:process.version,distro:windows?distro:null,
    iterations,fileCount,fileBytes,largeBytes,scenarios,
    metrics:diag.metrics.stages,pool:{workers:diag.workers,launches:diag.launches,pending:diag.pending,fallbacks:diag.fallbacks},
    note:'decodedResponseBytes are post-Base64 RPC payload bytes, not physical transport bytes; host-only CPU excludes Linux workers; RSS deltas are not peak RSS; summed stage durations may exceed wall time during concurrency'}
  const json=JSON.stringify(result,null,2)+'\n'
  if(flag('--output'))await writeFile(flag('--output'),json)
  console.log(json)
}finally{
  active=null
  await fixture.cleanup()
}
