import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeFixture, writeRaw, python, codeIs } from './support/native-fixture.mjs'
import { load } from '../scripts/compatibility/plane.mjs'

const optimized = await load('wsl-read-tool')
function mount(fs, root, apply, settings) {
  const registry = new Map(), observations = []
  const context = {
    fs,
    tools: { register(value) { registry.set(value.name, value) }, get(name) { return registry.get(name) } },
    workingDirectory: { async ensure() { return root } },
    systemPrompt: { getSectionOrder() { return 1 }, section() {} },
    get(key) { return this[key] },
    emit(event, target, observation) {
      if (event === 'fs/observed') observations.push({ path: fs.processPath(target), ...observation })
    },
  }
  apply(context, settings)
  return { tool: registry.get('read'), observations }
}
/** Test-only adapter performing the host read tool's original fs sequence. */
function legacyFs(fs) {
  return {
    async readSnapshot(path,options) {
      const target=await fs.resolve(path,options)
      const info=await fs.stat(target,options.signal)
      const text=info?.type==='file' && info.size!==undefined && info.size<options.streamMinSize
        ? await fs.readText(target,options.signal) : undefined
      return {target,info,...text===undefined?{}:{text}}
    },
    streamText:fs.streamText.bind(fs),
    processPath:fs.processPath.bind(fs),
  }
}
function codes(error) { return error?.code }
const execute = async (tool, args, fs, operations) => {
  operations.length = 0
  return tool.execute(args, { agent: { session: { header: { cwd: fs.cwd } } },
    signal: new AbortController().signal })
}

test('native WSL read retains old read-tool result when three RPCs collapse to one', async t => {
  const f = await makeFixture()
  t.after(() => f.cleanup())
  await writeRaw(f.root+'/single.ts', Buffer.from('first\r\nsecond\n','utf8'))
  const old = mount(legacyFs(f.fs), f.cwd, optimized.apply, {})
  const next = mount(f.fs, f.cwd, optimized.apply, {})
  const calls = []
  const pool = f.fs.wslRpcPool, run = pool.run.bind(pool)
  pool.run = (where, req) => { calls.push(req.op); return run(where, req) }
  const args = { file_path: 'single.ts' }
  const before = await execute(old.tool,args,f.fs,calls)
  assert.deepEqual(calls,['fs.resolve','fs.stat','fs.read'])
  const after = await execute(next.tool,args,f.fs,calls)
  assert.deepEqual(calls,['fs.snapshot'])
  assert.deepEqual(after,before)
  assert.deepEqual(next.observations,old.observations)
  assert.deepEqual(next.tool.parameters,old.tool.parameters)
  assert.deepEqual(next.tool.output.schema,old.tool.output.schema)
  assert.deepEqual(next.tool.output.render(args,after),old.tool.output.render(args,before))
  const metaOld=old.tool.output.presentationMeta(args,before)
  const metaNext=next.tool.output.presentationMeta(args,after)
  assert.deepEqual(metaNext,metaOld)
  const shown={isError:false,meta:metaOld,content:old.tool.output.render(args,before)}
  assert.deepEqual(next.tool.presentResult(args,shown),old.tool.presentResult(args,shown))
  assert.deepEqual(next.tool.presentCall(args),old.tool.presentCall(args))
  assert.deepEqual(after, {path: f.root+'/single.ts',offset:1,totalLines:2,
    lines:[{number:1,text:'first'},{number:2,text:'second'}]})
  assert.deepEqual(next.tool.output.render(args,after),[{type:'text',text:
    '<path>'+f.root+'/single.ts</path>\n<type>file</type>\n<content>\n'
    +'1: first\n2: second\n\n(End of file - total 2 lines)\n</content>'}])
  assert.equal(pool.diagnostics().pending,0)
})

test('snapshot preserves windows, missing/type/text errors and stream fallback', async t => {
  const f = await makeFixture()
  t.after(() => f.cleanup())
  const caps = { readLimit: 50, readMaxLineLength: 9, readMaxBytes: 32, readStreamMinSize: 128 }
  const old = mount(legacyFs(f.fs), f.cwd, optimized.apply, caps)
  const next = mount(f.fs, f.cwd, optimized.apply, caps)
  await python('import os,sys;os.mkdir(sys.argv[1])', [f.root+'/directory'])
  const fixtures = [
    ['normal.ts', Buffer.from('a\n1234567890123\nthird\n')],
    ['bom.txt', Buffer.from('\ufefffirst\r\nsecond\n')],
    ['unicode.ts', Buffer.from('你好🙂\nline\r\n')],
    ['large.ts', Buffer.from('line\n'.repeat(160))],
    ['invalid.txt', Buffer.from([0x61,0xff])],
    ['binary.txt', Buffer.from([0x41,0,0x42])],
    ['empty.txt', Buffer.alloc(0)],
  ]
  for (const [file,body] of fixtures) await writeRaw(f.root+'/'+file,body)
  const options = [
    {file_path:'normal.ts'}, {file_path:'normal.ts',offset:2,limit:2},
    {file_path:'bom.txt'}, {file_path:'unicode.ts'}, {file_path:'large.ts',offset:3,limit:2},
    {file_path:'invalid.txt'}, {file_path:'binary.txt'}, {file_path:'empty.txt'},
    {file_path:'directory'}, {file_path:'missing.txt'},
    {file_path:'normal.ts',offset:99}, {file_path:'normal.ts',limit:51},
    {file_path:'normal.ts',offset:0},
  ]
  const run=async(tool,args)=>{
    try {return {ok:true,value:await tool.execute(args,{agent:{session:{header:{cwd:f.cwd}}},signal:new AbortController().signal})}}
    catch(e){return {ok:false,code:codes(e),message:e.message}}
  }
  for(const args of options){
    const a=await run(old.tool,args),b=await run(next.tool,args)
    assert.deepEqual(b,a,JSON.stringify(args))
    if(a.ok){
      assert.deepEqual(next.tool.output.render(args,b.value),old.tool.output.render(args,a.value),JSON.stringify(args))
      assert.deepEqual(next.tool.output.presentationMeta(args,b.value),
        old.tool.output.presentationMeta(args,a.value),JSON.stringify(args))
    }
  }
  assert.deepEqual(next.observations,old.observations,'fs/observed must preserve presence/version')
  const cancelled = new AbortController();cancelled.abort()
  await assert.rejects(f.fs.readSnapshot('normal.ts',{cwd:f.cwd,signal:cancelled.signal,streamMinSize:128}),
    codeIs('FS_ABORTED'))
})

test('snapshot does not replace the fresh read observation needed by guarded writes', async t => {
  const f = await makeFixture()
  t.after(() => f.cleanup())
  await writeRaw(f.root+'/edit.ts',Buffer.from('before\n'))
  const result = await f.fs.readSnapshot('edit.ts',{cwd:f.cwd,streamMinSize:1024})
  assert.equal(result.text,'before\n')
  assert.equal(result.info.type,'file')
  await writeRaw(f.root+'/edit.ts',Buffer.from('changed\n'))
  await assert.rejects(f.fs.writeText(result.target,'overwrite',
    {kind:'replaceIfVersion',version:result.info.version}),codeIs('FS_STALE_VERSION'))
  assert.equal(await f.fs.readText(result.target),'changed\n')
})
