// CP21 / issue: an obsolete Host preset build must not publish after a reload.
// Delays the first roster query, retires that generation, registers the next,
// and only then lets the obsolete roster answer.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const apply=(await import(pathToFileURL(resolve('lib/index.js')).href)).apply
const tick=()=>new Promise(r=>setTimeout(r,10))
const until=async(predicate)=>{
  for(let i=0;i<1000;i++){if(predicate())return;await tick()}
  throw new Error('deferred preset test did not reach expected state')
}
test('retired preset generation cannot register stale rows or clobber the next status',async()=>{
  const originalHome=process.env.DSH_HOME
  const home=mkdtempSync(join(tmpdir(),'wsl-generation-'))
  process.env.DSH_HOME=home
  const effects=[], registered=[],routes=[],disposed=[]
  let started=0
  let releaseOld
  const staleList=new Promise(resolve=>{releaseOld=resolve})
  const presets={
    async list(){started++;return started===1?staleList:[{id:'active',name:'Active'}]},
    async readDocument(id){return {agentPreset:id,name:id,content: "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: Hi\n"}},
    async register(item){registered.push(item.id);return async()=>disposed.push(item.id)},
  }
  const ctx={
    get(key){
      if(key==='webServer')return {register(route){routes.push(route);return ()=>{}}}
      if(key==='agentPresets')return presets
      return undefined
    },
    effect(setup){const release=setup();if(typeof release==='function')effects.push(release);return ()=>{}},
  }
  const status=async()=>{
    const chunks=[]
    const req={
      method:'POST',socket:{remoteAddress:'127.0.0.1'},
      headers:{host:'127.0.0.1','content-type':'application/json'},
      async *[Symbol.asyncIterator](){yield Buffer.from('{"method":"variantStatus"}')},
    }
    const res={writeHead(){},end(body){chunks.push(body)}}
    await routes.at(-1).handler(req,res)
    return JSON.parse(chunks.join('')).value
  }
  try{
    apply(ctx,{})
    await until(()=>started===1)
    const releaseFirst=effects[0]
    assert.equal(typeof releaseFirst,'function','old variant task has a disposer')
    releaseFirst()
    apply(ctx,{})
    await until(()=>registered.length===1)
    assert.deepEqual(registered,['wsl-active'])
    const fresh=await status()
    assert.equal(fresh.state,'ok')
    releaseOld([{id:'stale',name:'Stale'}])
    await tick();await tick()
    assert.deepEqual(registered,['wsl-active'],'late roster cannot publish old variant')
    assert.deepEqual(await status(),fresh,'retired generation cannot replace current status')
  }finally{
    releaseOld([])
    for(const effect of effects.reverse())effect()
    rmSync(home,{recursive:true,force:true})
    if(originalHome===undefined)delete process.env.DSH_HOME
    else process.env.DSH_HOME=originalHome
  }
})
