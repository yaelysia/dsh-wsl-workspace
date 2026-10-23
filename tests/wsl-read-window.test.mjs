// CP20 registered-read parity: CP19 snapshot/stream path vs one fs.window RPC.
// The suite runs in both src and lib planes on real Linux/WSL.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeFixture, python, writeRaw, readRaw, codeIs } from './support/native-fixture.mjs'
import { load } from '../scripts/compatibility/plane.mjs'

const apply = (await load('wsl-read-tool')).apply
function legacy(fs) {
  return {
    readSnapshot: fs.readSnapshot.bind(fs),
    streamText: fs.streamText.bind(fs),
    processPath: fs.processPath.bind(fs),
  }
}
function mount(fs,cwd,config={}) {
  const registry=new Map(),observations=[]
  const ctx={
    fs,
    tools:{ register(t){registry.set(t.name,t)},get(name){return registry.get(name)} },
    workingDirectory:{async ensure(){return cwd}},
    systemPrompt:{section(){},getSectionOrder(){return 1}},
    get(key){return this[key]},
    emit(event,target,observation){
      if(event==='fs/observed')observations.push({path:fs.processPath(target),...observation})
    },
  }
  apply(ctx,config)
  assert.ok(registry.get('read'))
  return {tool:registry.get('read'),observations}
}
function execution(cwd,signal) {
  return {agent:{session:{header:{cwd}}},signal:signal??new AbortController().signal}
}
async function result(tool,cwd,args) {
  try{return {ok:true,value:await tool.execute(args,execution(cwd))}}
  catch(error){return {ok:false,code:error?.code,message:error?.message}}
}

test('native window matches registered legacy read values, render, errors and observations',async t=>{
  const f=await makeFixture()
  t.after(()=>f.cleanup())
  const settings={readLimit:60,readMaxLineLength:9,readMaxBytes:40,readStreamMinSize:128}
  const old=mount(legacy(f.fs),f.cwd,settings),fresh=mount(f.fs,f.cwd,settings)
  await python('import os,sys;os.mkdir(sys.argv[1])',[f.root+'/directory'])
  const files=[
    ['simple.ts',Buffer.from('first\r\nsecond\nthird')],
    ['trailing.ts',Buffer.from('a\nb\n')],
    ['cr-only.ts',Buffer.from('a\rb\r')],
    ['blank.ts',Buffer.from('\n\n')],
    ['bom.ts',Buffer.from('\ufefffirst\r\nsecond\n')],
    ['unicode.ts',Buffer.from('你好🙂\na🙂b\r\nmore\n')],
    ['long.ts',Buffer.from('A'.repeat(64)+'\n'+('B'.repeat(20)))],
    ['long-cr.ts',Buffer.from('Z'.repeat(9)+'\r\nnext')],
    ['invalid.ts',Buffer.from([0x61,0xff])],
    ['binary.ts',Buffer.from([0x61,0,0x62])],
    ['late-nul.ts',Buffer.concat([Buffer.alloc(8192,0x61),Buffer.from('\0\ntext')])],
    ['empty.ts',Buffer.alloc(0)],
    ['only-bom.ts',Buffer.from('\ufeff')],
    ['late-invalid.ts',Buffer.concat([Buffer.alloc(1000,0x61),Buffer.from([0xc3,0x28])])],
    ['stream.ts',Buffer.from('line\r\n'.repeat(500))],
    ['unicode nested name.ts',Buffer.from('空 格🙂\n')],
  ]
  for(const [name,data]of files)await writeRaw(f.root+'/'+name,data)
  const cases=[
    ...files.flatMap(([name])=>[
      {file_path:name},{file_path:name,offset:2,limit:3},
      {file_path:name,offset:9,limit:2},
    ]),
    {file_path:'simple.ts',offset:1,limit:1},
    {file_path:'simple.ts',offset:3,limit:1},
    {file_path:'directory'}, {file_path:'not-here.ts'},
    {file_path:'empty.ts',offset:1},
    {file_path:'simple.ts',offset:0},
    {file_path:'simple.ts',limit:61},
    {file_path:'simple.ts',offset:-1},
  ]
  const pool=f.fs.wslRpcPool,baseRun=pool.run.bind(pool),ops=[]
  pool.run=(target,req)=>{ops.push(req.op);return baseRun(target,req)}
  for(const args of cases){
    ops.length=0
    const before=await result(old.tool,f.cwd,args)
    const oldOps=[...ops]
    ops.length=0
    const after=await result(fresh.tool,f.cwd,args)
    const newOps=[...ops]
    assert.deepEqual(after,before,'registered read mismatch: '+JSON.stringify(args))
    if(before.ok){
      assert.deepEqual(fresh.tool.output.render(args,after.value),old.tool.output.render(args,before.value))
      assert.deepEqual(fresh.tool.output.presentationMeta(args,after.value),
        old.tool.output.presentationMeta(args,before.value))
    }
    if(args.offset!==0&&args.offset!==-1&&args.limit!==61){
      assert.deepEqual(newOps,['fs.window'],'one window RPC: '+JSON.stringify(args))
      assert.ok(oldOps.length>=1)
    }
  }
  assert.deepEqual(fresh.observations,old.observations,'presence/absence/version events drifted')
  assert.equal(pool.diagnostics().pending,0)
  assert.equal(pool.diagnostics().fallbacks,0)
})

test('UTF-16 surrogate slicing, long lines and split CRLF retain exact JS read behavior',async t=>{
  const f=await makeFixture()
  t.after(()=>f.cleanup())
  const config={readMaxLineLength:3,readMaxBytes:100}
  const old=mount(legacy(f.fs),f.cwd,config),fresh=mount(f.fs,f.cwd,config)
  const body=Buffer.from('ab🙂middle\n'+('x'.repeat(65534))+'\r\nlast🙂\n')
  await writeRaw(f.root+'/surrogate.ts',body)
  for(const args of [
    {file_path:'surrogate.ts'},
    {file_path:'surrogate.ts',offset:1,limit:1},
    {file_path:'surrogate.ts',offset:2,limit:1},
    {file_path:'surrogate.ts',offset:3,limit:1},
  ]){
    const before=await result(old.tool,f.cwd,args)
    const after=await result(fresh.tool,f.cwd,args)
    assert.deepEqual(after,before,JSON.stringify(args))
  }
  const answer=await fresh.tool.execute({file_path:'surrogate.ts',offset:1,limit:1},execution(f.cwd))
  assert.deepEqual(answer.lines,[{
    number:1,text:'ab'+'🙂'.slice(0,1)+'... (line truncated to 3 chars)',
  }])
})

test('native readWindow scans beyond 16 MiB and sends only the bounded requested lines',async t=>{
  const f=await makeFixture()
  t.after(()=>f.cleanup())
  const count=460000,row='source content 0123456789 abcdefghijklmnopqrstuvwxyz\n'
  const pythonCode='import sys; row=b"source content 0123456789 abcdefghijklmnopqrstuvwxyz\\n"; open(sys.argv[1],"wb").write(row*int(sys.argv[2]))'
  await python(pythonCode,[f.root+'/large-source.ts',String(count)])
  assert.ok(Buffer.byteLength(row)*count>20*1024*1024)
  const mounted=mount(f.fs,f.cwd),pool=f.fs.wslRpcPool,base=pool.run.bind(pool)
  const operations=[],bytes=[]
  pool.run=async(target,req)=>{
    operations.push(req.op)
    const answer=await base(target,req)
    bytes.push(answer.stdout.length)
    return answer
  }
  const answer=await mounted.tool.execute({file_path:'large-source.ts',
    offset:count-3,limit:4},execution(f.cwd))
  assert.equal(answer.totalLines,count)
  assert.deepEqual(answer.lines,Array.from({length:4},(_,i)=>({
    number:count-3+i,text:row.trimEnd(),
  })))
  assert.deepEqual(operations,['fs.window'],'no 256 KiB streaming RPCs')
  assert.ok(bytes[0]<8192,'20 MiB file must remain inside Linux')
  assert.equal(mounted.observations.length,1)
  assert.equal(mounted.observations[0].kind,'present')
  assert.ok(mounted.observations[0].version)
})

test('window observation prevents stale writes and cancelled/fallback paths stay safe',async t=>{
  const f=await makeFixture()
  t.after(()=>f.cleanup())
  await writeRaw(f.root+'/editable.ts','before\n')
  const current=mount(f.fs,f.cwd)
  const first=await current.tool.execute({file_path:'editable.ts'},execution(f.cwd))
  assert.equal(first.lines[0].text,'before')
  assert.equal(current.observations.length,1)
  const target=await f.fs.resolve('editable.ts')
  await writeRaw(f.root+'/editable.ts','changed\n')
  await assert.rejects(f.fs.writeText(target,'must not publish',
    {kind:'replaceIfVersion',version:current.observations[0].version}),codeIs('FS_STALE_VERSION'))
  assert.deepEqual(await readRaw(f.root+'/editable.ts'),Buffer.from('changed\n'))

  const cancelled=new AbortController();cancelled.abort()
  await assert.rejects(current.tool.execute({file_path:'editable.ts'},execution(f.cwd,cancelled.signal)),
    codeIs('FS_ABORTED'))
  const prior=legacy(f.fs)
  prior.readWindow=async()=>undefined
  const fallback=mount(prior,f.cwd)
  const answer=await fallback.tool.execute({file_path:'editable.ts'},execution(f.cwd))
  assert.equal(answer.lines[0].text,'changed')
  assert.equal(fallback.observations.length,1)
})
