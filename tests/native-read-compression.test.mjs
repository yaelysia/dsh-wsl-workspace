import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'
import { NativeFileClient, NATIVE_MAX_BYTES } from '../src/shared/native-files.ts'
import { makeFixture, python, writeRaw, readRaw, collect, codeIs } from './support/native-fixture.mjs'

const expectedData = bytes => Buffer.from(bytes)
const intercepted = fs => {
  const receipts = []
  const pool = fs.wslRpcPool, run = pool.run.bind(pool)
  pool.run = async (where, request) => {
    const reply = await run(where, request)
    if (['fs.read', 'fs.range', 'fs.snapshot'].includes(request.op) && reply.code === 0) {
      const parsed = JSON.parse(reply.stdout.toString('utf8'))
      if (parsed.ok) receipts.push({ operation: request.op, result: parsed.value,
        decodedRpcBytes: reply.stdout.length })
    }
    return reply
  }
  return receipts
}

test('adaptive codec is exercised only for compressible and large read-only receipts', async t => {
  const f = await makeFixture()
  t.after(() => f.cleanup())
  const { fs, root } = f
  const structured = Buffer.from('const item = aValue + 42;\n'.repeat(180000)).subarray(0,4*1024*1024)
  const random = await python('import os,sys;sys.stdout.buffer.write(os.urandom(int(sys.argv[1])))', [String(4*1024*1024)])
  const mixed = Buffer.concat([random.subarray(0,32*1024),structured.subarray(0,4*1024*1024-32*1024)])
  const tiny = Buffer.alloc(4096,0x61)
  for(const [name,data] of [['structured.ts',structured],['random.bin',random],['mixed.bin',mixed],['tiny.txt',tiny]]) {
    await writeRaw(root+'/'+name,data)
  }
  const receipts = intercepted(fs)
  for(const [name,bytes] of [['structured.ts',structured],['random.bin',random],['mixed.bin',mixed],['tiny.txt',tiny]]){
    const target = await fs.resolve(name)
    const found = await fs.readBytes(target,undefined,bytes.length)
    assert.deepEqual(expectedData(found),bytes)
    const receipt=receipts.at(-1)
    assert.equal(receipt.operation,'fs.read')
    if(name==='structured.ts'){
      assert.equal(typeof receipt.result.dataZ,'string','large source compresses before nested Base64 JSON')
      assert.equal(receipt.result.rawBytes,bytes.length)
      assert.ok(receipt.decodedRpcBytes < bytes.length/4,'source receipt is much smaller than raw bytes')
      assert.equal(receipt.result.data,undefined)
      const snapshot=await fs.readSnapshot(name,{cwd:f.cwd,streamMinSize:10*1024*1024})
      assert.equal(snapshot.text,bytes.toString())
      assert.equal(snapshot.info.type,'file')
      assert.equal(receipts.at(-1).operation,'fs.snapshot')
      assert.equal(typeof receipts.at(-1).result.dataZ,'string')
      const streamed=await collect(await fs.streamText(target))
      assert.equal(streamed,bytes.toString(),'streamed 256KiB ranges also decode compressed chunks')
      assert.ok(receipts.some(row=>row.operation==='fs.range' && typeof row.result.dataZ==='string'))
      assert.deepEqual(await fs.readByteRange(target,{offset:4096,length:128*1024}),bytes.subarray(4096,4096+128*1024))
    } else {
      assert.equal(typeof receipt.result.data,'string',name+' uses original raw Base64 receipt')
      assert.equal(receipt.result.dataZ,undefined)
      if(name==='random.bin')assert.ok(receipt.decodedRpcBytes > bytes.length, 'incompressible retains raw path')
    }
  }
  assert.deepEqual(await readRaw(root+'/structured.ts'),structured)
  assert.deepEqual(await readRaw(root+'/random.bin'),random)
  assert.equal(fs.wslRpcPool.diagnostics().pending,0)
  assert.equal(fs.wslRpcPool.diagnostics().fallbacks,0)
})

test('bounded inflate rejects malformed or over-cap compressed receipts (read + snapshot)', async () => {
  const original=Buffer.alloc(128*1024,0x65), zipped=deflateSync(original,{level:1}).toString('base64')
  const target={wslPath:'wsl.exe',distro:'Ubuntu',linuxCwd:'/'}
  let receipt
  const pool={ metrics:{record(){}}, async run(_target,request) {
    assert.ok(['fs.read','fs.snapshot'].includes(request.op))
    return {code:0,aborted:false,signal:null,stderr:Buffer.alloc(0),
      stdout:Buffer.from(JSON.stringify({ok:true,committed:false,
        value:request.op==='fs.snapshot'?{path:'/example',info:{type:'file',version:'v1',size:original.length},...receipt}:receipt}))}
  } }
  const client=new NativeFileClient(pool)
  const malformed=[
    {dataZ:zipped,rawBytes:original.length-1},
    {dataZ:zipped,rawBytes:original.length+1},
    {dataZ:zipped,rawBytes:NATIVE_MAX_BYTES+1},
    {dataZ:zipped,rawBytes:4*1024},
    {dataZ:'_',rawBytes:original.length},
    {dataZ:Buffer.from('no zlib').toString('base64'),rawBytes:original.length},
    {data:original.toString('base64'),dataZ:zipped,rawBytes:original.length},
    {dataZ:zipped},
    {data:original.toString('base64'),rawBytes:original.length},
  ]
  for (const item of malformed) {
    receipt=item
    await assert.rejects(client.read(target,'/example',NATIVE_MAX_BYTES),codeIs('FS_IO_ERROR'))
    await assert.rejects(client.snapshot(target,'/example',10*1024*1024),codeIs('FS_IO_ERROR'))
  }
  receipt={dataZ:zipped,rawBytes:original.length}
  assert.deepEqual(await client.read(target,'/example',NATIVE_MAX_BYTES),original)
  const snap=await client.snapshot(target,'/example',10*1024*1024)
  assert.deepEqual(snap.data,original)
  receipt={data:null}
  assert.equal((await client.snapshot(target,'/example',10*1024*1024)).data,null)
  await assert.rejects(client.read(target,'/example',NATIVE_MAX_BYTES),codeIs('FS_IO_ERROR'))
})

test('compressed content still enforces caller byte limits and stale versions', async t => {
  const f=await makeFixture()
  t.after(()=>f.cleanup())
  const {root,fs}=f
  const body=Buffer.from('large source text\n'.repeat(240000)).subarray(0,3*1024*1024)
  await writeRaw(root+'/guard.ts',body)
  const target=await fs.resolve('guard.ts')
  const info=await fs.stat(target)
  await assert.rejects(fs.readBytes(target,undefined,4096),codeIs('FS_TOO_LARGE'))
  assert.deepEqual(Buffer.from(await fs.readByteRange(target,{offset:65536,length:256*1024})),body.subarray(65536,65536+256*1024))
  const chunks=(await fs.streamText(target))[Symbol.asyncIterator]()
  assert.equal((await chunks.next()).done,false)
  await writeRaw(root+'/guard.ts',Buffer.from('changed after observation'))
  await assert.rejects(chunks.next(),codeIs('FS_STALE_VERSION'))
  await assert.rejects(fs.writeText(target,'forbidden',{kind:'replaceIfVersion',version:info.version}),
    codeIs('FS_STALE_VERSION'))
  assert.deepEqual(await readRaw(root+'/guard.ts'),Buffer.from('changed after observation'))
})
