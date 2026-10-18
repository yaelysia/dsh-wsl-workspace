// Full provider sequences, not bare Python I/O. Timings are informational, never CI gates.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { writeFile } from 'node:fs/promises'
import { makeFixture, windows, python } from '../tests/support/native-fixture.mjs'
const flag = (name, value) => { const i = process.argv.indexOf(name); return i < 0 ? value : process.argv[i+1] }
const iterations = Number(flag('--iterations', '20'))
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 200) throw new Error('iterations must be 1..200')
const fixture = await makeFixture()
const { root, fs:native, provider } = fixture
const reference = windows ? provider({backend:'unc'}) : null
try {
  // Linux is a native-only smoke control; it cannot impersonate Windows UNC performance.
  const backends = { native, ...reference ? {unc:reference} : {} }
  const body = 'line: needle\n'.repeat(300)
  await python('import os,sys;p=sys.argv[1];os.mkdir(p+"/listing");[(open(p+"/listing/"+str(i)+".txt","w").write("x")) for i in range(200)]', [root])
  for (const [name, fs] of Object.entries(backends)) {
    for (const op of ['read','write','edit']) await fs.writeText(await fs.resolve(`${root}/${name}-${op}.txt`), body)
  }
  const samples = {}, expected = {}
  for (const op of ['read', 'write', 'edit', 'list']) {
    samples[op] = Object.fromEntries(Object.keys(backends).map(name => [name, []]))
    for (let i = -2; i < iterations; i++) {
      const ordered = i % 2 === 0 ? Object.entries(backends) : Object.entries(backends).reverse()
      for (const [name, fs] of ordered) {
        const started = performance.now()
        const target = await fs.resolve(op === 'list' ? `${root}/listing` : `${root}/${name}-${op}.txt`)
        let answer
        if (op === 'read') {
          const stat = await fs.stat(target); assert.equal(stat.type,'file')
          answer = await fs.readText(target)
        } else if (op === 'write') {
          const stat = await fs.stat(target)
          answer = (await fs.writeText(target, body + `iteration=${i}\n`, {kind:'replaceIfVersion',version:stat.version})).after
        } else if (op === 'edit') {
          const stat = await fs.stat(target)
          const oldString = expected[name] ?? 'needle', newString = `n${i+3}`
          answer = (await fs.editText(target, {oldString,newString,replaceAll:true},{version:stat.version})).after
          expected[name] = newString
        } else answer = (await fs.listDir(target)).map(r => r.name)
        const elapsed = performance.now()-started
        if (i >= 0) samples[op][name].push(elapsed)
        if (op === 'read') assert.equal(answer, body)
        if (op === 'write') assert.equal(answer,body+`iteration=${i}\n`)
        if (op === 'edit') assert.equal(answer,body.replaceAll('needle',expected[name]))
        if (op === 'list') assert.equal(answer.length,200)
      }
    }
  }
  const summarize = values => { const sorted=[...values].sort((a,b)=>a-b);return {samples:values.length,
    p50Ms:+sorted[Math.ceil(sorted.length*0.5)-1].toFixed(3),p95Ms:+sorted[Math.ceil(sorted.length*0.95)-1].toFixed(3)} }
  const result = {scope:'resolved provider sequences: resolve+stat+read/guarded-write/edit; resolve+list; warm fixture; not DSH/model',
    platform:process.platform,node:process.version,bodyBytes:Buffer.byteLength(body),listingFiles:200,iterations,
    rows:Object.entries(samples).map(([operation, values])=>({operation,...Object.fromEntries(Object.entries(values).map(([k,v])=>[k,summarize(v)]))})),
    nativePool:native.wslRpcPool.diagnostics()}
  const json=JSON.stringify(result,null,2)+'\n'
  const output=flag('--output',undefined)
  if(output) await writeFile(output,json)
  process.stdout.write(json)
} finally { await fixture.cleanup() }
