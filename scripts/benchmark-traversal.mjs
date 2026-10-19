// Alternating full provider/tool A/B against an exact checkout. Timings are informational.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { makeFixture, python, rpcOptions, windows, distro } from '../tests/support/native-fixture.mjs'
import { load } from './compatibility/plane.mjs'
import { NATIVE_FILE_PROGRAM } from '../src/shared/native-file-worker.ts'
const flag = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i+1] }
const iterations = Number(flag('--iterations', '20'))
assert.ok(Number.isInteger(iterations) && iterations >= 4 && iterations <= 100)
const baseline = resolve(flag('--baseline', '.cp14-baseline'))
const imported = p => import(pathToFileURL(join(baseline, p)).href)
const old = await imported('src/fs.ts'), oldSearch = await imported('src/host/wsl-search.ts')
const oldFile = await imported('src/shared/native-file-worker.ts')
const search = await load('search')
const git = spawnSync('git', ['-C', baseline, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true })
assert.equal(git.status, 0)
assert.equal(git.stdout.trim(), 'f7c051a05c279bec181a2ef0257d6b4240fc9ad4', 'benchmark baseline must be CP13')
const f = await makeFixture(), oldCtx = new Context(), cleanup = []
const before = new old.WslFileSystem(oldCtx, { cwd: f.cwd, backend: 'native', diffBasisMaxBytes: 1024 * 1024 }, rpcOptions)
const providers = { before, after: f.fs }
const tool = (module, fs) => {
  const tools = new Map()
  module.apply({ get(name) { return name === 'tools' ? { register: t => tools.set(t.name, t) } : name === 'fs' ? fs : undefined },
    effect(fn) { cleanup.push(fn()) } }, { globMaxResults: 50000, rawOutputMaxBytes: 20_000_000 })
  return tools.get('glob')
}
const tools = { before: tool(oldSearch, before), after: tool(search, f.fs) }
const lastWire = {}, bytes = {}, records = {}
for (const [name, fs] of Object.entries(providers)) {
  const run = fs.wslRpcPool.run.bind(fs.wslRpcPool)
  fs.wslRpcPool.run = async (target, request) => {
    const result = await run(target, request)
    if (request.op === 'glob') lastWire[name] = result.stdout
    return result
  }
}
const summarize = rawMs => {
  const a = [...rawMs].sort((x,y)=>x-y)
  return { samples: a.length, p50Ms: +a[Math.ceil(a.length*.5)-1].toFixed(3),
    p95Ms: +a[Math.ceil(a.length*.95)-1].toFixed(3), rawMs }
}
try {
  await python(String.raw`
import os,sys
p=sys.argv[1]
for directory,count,extension in [('search/src/components',120,'.tsx'),('small',24,'.txt'),('deep/a/b/c/d/e/f/g/h/list',2000,'.txt')]:
    os.makedirs(p+'/'+directory)
    for i in range(count): open(p+'/'+directory+'/'+str(i)+extension,'w').write('content\n')
for group in range(100):
    root=p+'/search/vendor-'+str(group);os.makedirs(root)
    for i in range(160): open(root+'/'+str(i)+'.tsx','w').write('unrelated\n')
os.symlink('src',p+'/search/linked-src')
`, [f.root])
  const rows = [], exec = { agent: { session: { header: { cwd: f.cwd } } } }
  const cases = [
    { operation: 'list-small-24', kind: 'list', path: 'small' },
    { operation: 'list-deep-2000', kind: 'list', path: 'deep/a/b/c/d/e/f/g/h/list' },
    { operation: 'glob-fixed-prefix', kind: 'glob', pattern: 'src/components/**/*.tsx' },
    { operation: 'glob-leading-wildcard-control', kind: 'glob', pattern: '**/components/**/*.tsx' },
  ]
  for (const c of cases) {
    const samples = { before: [], after: [] }, answers = {}
    for (let i=-3;i<iterations;i++) for (const name of i%2===0 ? ['before','after'] : ['after','before']) {
      const fs=providers[name], started=performance.now()
      const answer = c.kind === 'list'
        ? await fs.listDir(await fs.resolve(c.path))
        : await tools[name].execute({ pattern:c.pattern, path:f.root+'/search' },exec)
      const elapsed=performance.now()-started
      answers[name]=answer
      if(i>=0)samples[name].push(elapsed)
    }
    assert.deepEqual(answers.before,answers.after,'canonical results differ: '+c.operation)
    const wire = c.kind === 'glob' ? Object.fromEntries(['before','after'].map(name=>[name,{
      stdoutBytes:lastWire[name].length,
      candidateFiles:lastWire[name].toString('utf8').split('\0').slice(1).filter(Boolean).length,
    }])) : undefined
    rows.push({ operation:c.operation, ...Object.fromEntries(Object.entries(samples).map(([n,s])=>[n,summarize(s)])),
      ...(wire ? {wire} : {}), resultCount:c.kind==='list'?answers.after.length:answers.after.paths.length })
  }
  // Real C-function calls in the bundled file programs, outside timed provider measurements.
  const workCounts = JSON.parse((await python(String.raw`
import json,os,sys
programs=json.loads(sys.stdin.buffer.read());result={}
for name,program in programs.items():
    ns={};exec(program.split("\nif sys.argv[1] == '--persistent':")[0],ns)
    counts={'lstat':0,'stat':0,'fstat':0}
    def profile(frame,event,fn):
        if event=='c_call':
            for key in counts:
                if fn is getattr(os,key): counts[key]+=1
    sys.setprofile(profile)
    rows=ns['run']('fs.list',{'path':sys.argv[1]})
    sys.setprofile(None)
    result[name]={'entries':len(rows),**counts}
print(json.dumps(result))
`, [f.root+'/deep/a/b/c/d/e/f/g/h/list'], JSON.stringify({before:oldFile.NATIVE_FILE_PROGRAM,after:NATIVE_FILE_PROGRAM}))).toString())
  const pools=Object.fromEntries(Object.entries(providers).map(([n,fs])=>{
    const d=fs.wslRpcPool.diagnostics();assert.equal(d.launches,1);assert.equal(d.pending,0);assert.equal(d.fallbacks,0)
    return [n,{launches:d.launches,workers:d.workers,pending:d.pending,fallbacks:d.fallbacks}]
  }))
  const result={ scope:'warm actual registered glob and resolve+listDir; same disk fixture; CP13 vs CP14; not model/GUI latency',
    platform:process.platform,node:process.version,distro:windows?distro:null,plane:process.env.DSH_WSL_TEST_PLANE||'src',baselineSha:git.stdout.trim(),iterations,
    fixture:{selectedFiles:120,unrelatedSameExtensionFiles:16000,unrelatedDirectories:100,largeListEntries:2000},rows,workCounts,pools }
  const json=JSON.stringify(result,null,2)+'\n'
  if(flag('--output'))await writeFile(flag('--output'),json)
  console.log(json)
} finally { for(const fn of cleanup)fn?.();before.wslRpcPool.dispose();await f.cleanup() }
