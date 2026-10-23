// CP19 paired real provider throughput: baseline CP18 vs adaptive read payloads.
// Same Linux files, warm native workers, alternating samples, exact full byte parity.
// Captures observed Windows<->WSL stdout bytes (including outer RPC Base64),
// and decoded native stdout, not just synthetic compression microbenchmarks.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { spawn, spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { makeFixture, windows, distro, python, collect, WslFileSystem, linuxLaunch } from '../tests/support/native-fixture.mjs'

const flag=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]}
const iterations=Number(flag('--iterations','20'))
assert.ok(Number.isInteger(iterations)&&iterations>=4&&iterations<=36)
const baseline=resolve(flag('--baseline','.cp19-baseline'))
const git=spawnSync('git',['-C',baseline,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true})
assert.equal(git.status,0,'require a real baseline checkout')
assert.equal(git.stdout.trim(),'a11073dbad8bd1a54cce7cf62f9e8dc04735b450','baseline must equal merged CP18 main')
const old=await import(pathToFileURL(join(baseline,'src/fs.ts')).href)
const fixture=await makeFixture()
const bytes=4*1024*1024
const compressedBody=Buffer.from('const value = nextItem + 42;\n'.repeat(160000)).subarray(0,bytes)
assert.equal(compressedBody.length,bytes)
const expected={}, cases=[]
const summaries={before:{bytes:0},after:{bytes:0}}
const launch=(name)=>(where,script)=>{
  const child=windows
    ? spawn(where.wslPath,['-d',where.distro,...where.username===undefined?[]:['-u',where.username],
      '--cd','/','-e','python3','-I','-S','-u','-c',script],
      {stdio:'pipe',windowsHide:true})
    : linuxLaunch(where,script)
  child.stdout.on('data',chunk=>{summaries[name].bytes+=chunk.length})
  return child
}
const params={cwd:fixture.cwd,backend:'native',diffBasisMaxBytes:1024*1024}
const providers={
  before:new old.WslFileSystem(new Context(),params,{launch:launch('before')}),
  after:new WslFileSystem(new Context(),params,{launch:launch('after')}),
}
const metrics={}
for(const [name,fs]of Object.entries(providers)){
  metrics[name]={count:0,decodedBytes:0}
  const pool=fs.wslRpcPool,run=pool.run.bind(pool)
  pool.run=(target,req)=> {
    metrics[name].count++
    return run(target,req).then(result=>{metrics[name].decodedBytes+=result.stdout.length;return result})
  }
}
const summarize=values=>{const sorted=[...values].sort((a,b)=>a-b)
  return {p50Ms:+sorted[Math.ceil(sorted.length/2)-1].toFixed(3),
    p95Ms:+sorted[Math.ceil(sorted.length*.95)-1].toFixed(3),rawMs:values}}
const clip=values=>values.map(x=>Math.round(x))
try {
  const filenames=['small.txt','source-256k.ts','source-4m.ts','random-4m.bin','mixed-4m.bin']
  const random=await python('import os,sys;sys.stdout.buffer.write(os.urandom(int(sys.argv[1])))',[String(bytes)])
  expected[filenames[0]]=Buffer.from('a'.repeat(4096))
  expected[filenames[1]]=compressedBody.subarray(0,256*1024)
  expected[filenames[2]]=compressedBody
  expected[filenames[3]]=random
  expected[filenames[4]]=Buffer.concat([random.subarray(0,32*1024),compressedBody.subarray(0,bytes-32*1024)])
  await python(String.raw`import os,sys
root=sys.argv[1]
for path in sys.argv[2:]:
    size=int.from_bytes(sys.stdin.buffer.read(4),'big')
    with open(root+'/'+path,'wb') as file:
        file.write(sys.stdin.buffer.read(size))
`,[]).catch(()=>{}) // unused: data arrives via exact per-file writes below
  // One Python generator receives content via stdin to keep Windows UNC off the hot path.
  const { writeRaw }=await import('../tests/support/native-fixture.mjs')
  for(const path of filenames) await writeRaw(fixture.root+'/'+path,expected[path])

  for(const file of filenames) {
    const targets={}
    for(const [name,fs] of Object.entries(providers))targets[name]=await fs.resolve(file)
    cases.push({name:file,type:file==='small.txt'||file.endsWith('.ts')?'readText':'readBytes',targets,
      expected:expected[file]})
  }
  const fileTarget=cases.find(x=>x.name==='source-4m.ts').targets
  cases.push({name:'source-4m-streamText',type:'streamText',targets:fileTarget,expected:compressedBody})
  cases.push({name:'source-4m-snapshot',type:'snapshot',targets:fileTarget,expected:compressedBody})

  const rows=[]
  const perform=async(c,name)=>{
    const fs=providers[name]
    if(c.type==='readText'){
      const data=await fs.readText(c.targets[name])
      assert.equal(data,c.expected.toString('utf8'),c.name+' text changed')
    }else if(c.type==='readBytes'){
      const data=await fs.readBytes(c.targets[name],undefined,c.expected.length)
      assert.deepEqual(Buffer.from(data),c.expected,c.name+' bytes changed')
    }else if(c.type==='streamText'){
      const stream=await fs.streamText(c.targets[name])
      const data=await collect(stream)
      assert.equal(data,c.expected.toString('utf8'),'stream text changed')
    }else{
      const snapshot=await fs.readSnapshot(c.name.replace('-snapshot','').replace('-4m','-4m.ts'),{
        cwd:fixture.cwd,streamMinSize:10*1024*1024,
      })
      assert.equal(snapshot.info?.type,'file')
      assert.equal(snapshot.text,c.expected.toString('utf8'))
    }
  }
  // The snapshot must address the physical source file, not the benchmark scenario label.
  for(const c of cases)if(c.type==='snapshot')c.snapshotPath='source-4m.ts'
  for(const c of cases){
    const timings={before:[],after:[]},wire={before:[],after:[]},
      decoded={before:[],after:[]},calls={before:[],after:[]}
    for(let i=-3;i<iterations;i++){
      for(const name of i%2===0?['before','after']:['after','before']){
        const startWire=summaries[name].bytes,startCall=metrics[name].count,
          startDecoded=metrics[name].decodedBytes
        const at=performance.now()
        if(c.type==='snapshot'){
          const snap=await providers[name].readSnapshot(c.snapshotPath,{
            cwd:fixture.cwd,streamMinSize:10*1024*1024,
          })
          assert.equal(snap.info?.type,'file')
          assert.equal(snap.text,c.expected.toString('utf8'))
        }else await perform(c,name)
        const elapsed=performance.now()-at
        if(i>=0){
          timings[name].push(elapsed)
          wire[name].push(summaries[name].bytes-startWire)
          decoded[name].push(metrics[name].decodedBytes-startDecoded)
          calls[name].push(metrics[name].count-startCall)
        }
      }
    }
    rows.push({scenario:c.name,kind:c.type,fileBytes:c.expected.length,
      before:{wall:summarize(timings.before),stdoutBytes:clip(wire.before),
        decodedReceiptBytes:clip(decoded.before),rpcCounts:calls.before},
      after:{wall:summarize(timings.after),stdoutBytes:clip(wire.after),
        decodedReceiptBytes:clip(decoded.after),rpcCounts:calls.after}})
  }
  const pools=Object.fromEntries(Object.entries(providers).map(([name,fs])=>{
    const d=fs.wslRpcPool.diagnostics()
    assert.equal(d.workers,1,name+' worker count')
    assert.equal(d.launches,1,name+' launch count')
    assert.equal(d.pending,0,name+' pending')
    assert.equal(d.fallbacks,0,name+' fallback')
    return[name,{workers:d.workers,launches:d.launches,pending:d.pending,fallbacks:d.fallbacks}]
  }))
  const report={scope:'actual owner-scoped WSL native read, same Linux files, paired warm baselined providers; full byte/text checks; no LLM or UI',
    baselineSha:git.stdout.trim(),platform:process.platform,distro:windows?distro:null,
    node:process.version,iterations,rows,pools,
    note:'stdoutBytes capture emitted RPC worker stdout bytes at Node pipes; decodedReceiptBytes are post-outer-Base64 decoded native JSON replies, both measured (not estimates); includes no initial provisioning time'}
  if(flag('--output'))await writeFile(flag('--output'),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
}finally{
  for(const fs of Object.values(providers))fs.wslRpcPool.dispose()
  await fixture.cleanup()
}
