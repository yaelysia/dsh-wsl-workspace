// Paired REAL registered read tool, old host chain vs one-RPC WSL snapshot.
// Same owner, same files, alternating trials and exact returned-object parity.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { apply as hostRead } from '@deepseek-ai/dsh-tool-fs'
import { makeFixture, python, windows, distro } from '../tests/support/native-fixture.mjs'
import { load } from './compatibility/plane.mjs'

const flag=(name,value)=>{const i=process.argv.indexOf(name);return i<0?value:process.argv[i+1]}
const iterations=Number(flag('--iterations','20'))
assert.ok(Number.isInteger(iterations)&&iterations>=4&&iterations<=80)
const ref=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true})
assert.equal(ref.status,0)
const fixture=await makeFixture()
const fs=fixture.fs, fcount=24, fsize=4096
const optimized=(await load('wsl-read-tool')).apply
const register=(apply,config)=>{
  let tool
  const tools={register(value){if(value.name==='read')tool=value},get(){return tool}}
  const ctx={fs,tools,get(k){return this[k]},
    workingDirectory:{async ensure(){return fixture.cwd}},
    systemPrompt:{section(){},getSectionOrder(){return 1}},emit(){}}
  apply(ctx,config)
  assert.ok(tool)
  return tool
}
const old=register(hostRead,{
  read:true,readImage:false,write:false,edit:false,readLimit:2000,
  readMaxLineLength:2000,readMaxBytes:51200,readStreamMinSize:10485760,
})
const next=register(optimized,{})
const pool=fs.wslRpcPool,original=pool.run.bind(pool),records={}
let measuring
pool.run=(where,request)=>{
  if(measuring)records[measuring].push(request.op)
  return original(where,request)
}
const exec={agent:{session:{header:{cwd:fixture.cwd}}},signal:new AbortController().signal}
const expected=Array.from({length:fcount},(_,i)=>('CP18_'+String(i).padStart(2,'0')).padEnd(fsize,'x'))
const summarize=values=>{const sort=[...values].sort((a,b)=>a-b)
  return {p50Ms:+sort[Math.ceil(sort.length*.5)-1].toFixed(3),
    p95Ms:+sort[Math.ceil(sort.length*.95)-1].toFixed(3),rawMs:values}}
try{
  await python(String.raw`import os,sys
r=sys.argv[1];os.makedirs(r+'/small',exist_ok=True)
for i in range(24):
    content=('CP18_%02d'%i).encode().ljust(4096,b'x')
    with open(r+'/small/'+str(i)+'.txt','wb') as file:file.write(content)
`,[fixture.root])
  const samples={old:[],next:[]},counts={old:[],next:[]}
  for(let i=-3;i<iterations;i++){
    for(const name of i%2===0?['old','next']:['next','old']){
      records[name]=[];measuring=name
      const now=performance.now()
      for(let index=0;index<fcount;index++){
        const args={file_path:'small/'+index+'.txt'}
        const answer=await (name==='old'?old:next).execute(args,exec)
        assert.equal(answer.lines.length,1)
        assert.equal(answer.lines[0].text,expected[index])
        assert.equal(answer.totalLines,1)
      }
      const elapsed=performance.now()-now
      measuring=undefined
      if(i>=0){samples[name].push(elapsed);counts[name].push({
        total:records[name].length,
        byOp:Object.fromEntries([...new Set(records[name])].sort().map(op=>[
          op,records[name].filter(x=>x===op).length,
        ])),
      })}
    }
  }
  assert.ok(counts.old.every(x=>x.total===fcount*3))
  assert.ok(counts.next.every(x=>x.total===fcount))
  const a={wall:summarize(samples.old),calls:counts.old}
  const b={wall:summarize(samples.next),calls:counts.next}
  const diag=pool.diagnostics()
  assert.equal(diag.pending,0)
  assert.equal(diag.launches,1)
  assert.equal(diag.fallbacks,0)
  const report={scope:'warm serial registered host read vs WSL snapshot read; 24x4KiB; real WSL native pool; excludes LLM and GUI',
    platform:process.platform,distro:windows?distro:null,head:ref.stdout.trim(),node:process.version,
    iterations,files:fcount,fileBytes:fsize,before:a,after:b,pool:{workers:diag.workers,pending:diag.pending,launches:diag.launches}}
  if(flag('--output'))await writeFile(flag('--output'),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
}finally{
  measuring=undefined
  await fixture.cleanup()
}
