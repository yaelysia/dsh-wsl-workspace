// CP20 paired native Linux line-window vs CP19 full-body snapshot/stream.
// Full registered WSL 'read' tool, identical files, stable warm worker.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { writeFile } from 'node:fs/promises'
import { makeFixture, windows, distro, writeRaw, python } from '../tests/support/native-fixture.mjs'
import { load } from './compatibility/plane.mjs'

const flag=(key,fallback)=>{const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1]}
const iterations=Number(flag('--iterations','12'))
assert.ok(Number.isInteger(iterations)&&iterations>=4&&iterations<=32)
const f=await makeFixture()
const apply=(await load('wsl-read-tool')).apply
const fs=f.fs,pool=fs.wslRpcPool,base=pool.run.bind(pool)
const active={name:null,ops:[],bytes:0}
pool.run=async(target,req)=>{
  const reply=await base(target,req)
  if(active.name) {active.ops.push(req.op);active.bytes+=reply.stdout.length}
  return reply
}
const legacy={
  readSnapshot:fs.readSnapshot.bind(fs),
  streamText:fs.streamText.bind(fs),
  processPath:fs.processPath.bind(fs),
}
function mount(provider){
  let tool
  const ctx={fs:provider,
    tools:{register(t){if(t.name==='read')tool=t},get(){return tool}},
    workingDirectory:{async ensure(){return f.cwd}},
    systemPrompt:{section(){},getSectionOrder(){return 1}},
    get(key){return this[key]},emit(){}}
  apply(ctx,{})
  assert.ok(tool)
  return tool
}
const tools={old:mount(legacy),native:mount(fs)}
const exec={agent:{session:{header:{cwd:f.cwd}}},signal:new AbortController().signal}
const summary=values=>{
  const sorted=[...values].sort((a,b)=>a-b)
  return {p50Ms:+sorted[Math.ceil(values.length*.5)-1].toFixed(3),
    p95Ms:+sorted[Math.ceil(values.length*.95)-1].toFixed(3),rawMs:values}
}
const cases=[]
try {
  // LF-terminated lines: count and returned values must match in both arms.
  const row='export const item = computeSomething(42) // component value\n'
  const fixtures=[
    {name:'source-4k.ts',bytes:4096,tail:false},
    {name:'source-256k.ts',bytes:256*1024,tail:true},
    {name:'source-4m.ts',bytes:4*1024*1024,tail:true},
    {name:'source-20m.ts',bytes:20*1024*1024,tail:true},
  ]
  for(const entry of fixtures){
    const count=Math.ceil(entry.bytes/Buffer.byteLength(row))
    const body=Buffer.from(row.repeat(count))
    await writeRaw(f.root+'/'+entry.name,body)
    cases.push({name:entry.name,fileBytes:body.length,
      args:{file_path:entry.name,offset:entry.tail?count-19:1,limit:20}})
  }
  const length=4*1024*1024,rand=randomBytes(length)
  // Deterministic shape, unpredictable ASCII contents: newline every 80 bytes.
  for(let i=0;i<rand.length;i++)rand[i]=i%80===79?10:97+(rand[i]%26)
  await writeRaw(f.root+'/random-ascii-4m.ts',rand)
  cases.push({name:'random-ascii-4m.ts',fileBytes:rand.length,
    args:{file_path:'random-ascii-4m.ts',offset:Math.floor(length/80)-19,limit:20}})
  const rows=[]
  for(const fixture of cases){
    const timings={old:[],native:[]},response={old:[],native:[]},calls={old:[],native:[]}
    let expected
    for(let trial=-3;trial<iterations;trial++){
      for(const name of trial%2===0?['old','native']:['native','old']){
        active.name=name;active.ops=[];active.bytes=0
        const at=performance.now()
        const value=await tools[name].execute(fixture.args,exec)
        const ms=performance.now()-at
        const operations=[...active.ops],bytes=active.bytes
        active.name=null
        if(expected===undefined)expected=value
        else assert.deepEqual(value,expected,'legacy/new mismatch '+fixture.name)
        assert.ok(value.lines.length===20,fixture.name+' must return entire requested window')
        if(trial>=0){
          timings[name].push(ms)
          response[name].push(bytes)
          calls[name].push({total:operations.length,
            byOp:Object.fromEntries([...new Set(operations)].sort().map(op=>
              [op,operations.filter(item=>item===op).length]))})
        }
      }
    }
    assert.ok(calls.native.every(row=>row.total===1 && row.byOp['fs.window']===1),
      fixture.name+' expected exactly one fs.window RPC')
    rows.push({scenario:fixture.name,fileBytes:fixture.fileBytes,iterations,
      offset:fixture.args.offset,limit:fixture.args.limit,fullLines:expected.totalLines,
      before:{wall:summary(timings.old),stdoutBytes:response.old,calls:calls.old},
      after:{wall:summary(timings.native),stdoutBytes:response.native,calls:calls.native}})
  }
  const diag=pool.diagnostics()
  assert.equal(diag.pending,0);assert.equal(diag.fallbacks,0);assert.equal(diag.launches,1)
  const report={scope:'paired registered WSL read: CP19 snapshot/stream adapter vs CP20 native line window; real Linux filesystem, full answer parity, excludes GUI/LLM',
    platform:process.platform,distro:windows?distro:null,iterations,rows,
    pool:{workers:diag.workers,launches:diag.launches,pending:diag.pending,fallbacks:diag.fallbacks},
    note:'One owner-scoped warm RPC worker; stdoutBytes count decoded native JSON receipt (post-outer-Base64), not physical transport; 20MiB includes 256KiB streaming legacy. Values are synthetic and not a production-latency guarantee.'}
  const out=flag('--output')
  if(out)await writeFile(out,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
}finally {
  active.name=null
  await f.cleanup()
}
