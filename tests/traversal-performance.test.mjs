import assert from 'node:assert/strict'
import { test } from 'node:test'
import { globDirectoryPrefix, basenameFilters, compileGlob } from '../src/shared/search-patterns.ts'
import { GLOB_SCRIPT } from '../src/shared/search-scripts.ts'
import { NATIVE_FILE_PROGRAM } from '../src/shared/native-file-worker.ts'
import { fixture, runBash, globPaths, selectedPaths } from '../scripts/benchmark-search.mjs'
import { makeFixture, python, pyJson, readRaw, writeRaw } from './support/native-fixture.mjs'
import { load } from '../scripts/compatibility/plane.mjs'

const cap = '20000000'
const scopeArgs = pattern => {
  const prefix = globDirectoryPrefix(pattern)
  return [...(prefix === undefined ? [] : ['', prefix]), ...basenameFilters([pattern])]
}

test('directory prefix is conservative for negative, ambiguous and literal-path patterns', () => {
  for (const [pattern, prefix] of [
    ['src/components/**/*.tsx', 'src/components'], ['src/main.ts', 'src'],
    ['src/{a,b}/**/*.ts', 'src'], ['空间/child space/*.ts', '空间/child space'],
    ['*.ts', undefined], ['**/*.ts', undefined], ['!src/**/*.ts', undefined],
    ['{src,test}/**', undefined], ['src*/a/*.ts', undefined], ['src/../*.ts', undefined],
    ['/src/*.ts', undefined], ['./src/*.ts', undefined], ['src//*.ts', undefined],
    ['src\\x/*.ts', undefined], ['src/line\nname/*.ts', undefined], ['src/', undefined],
  ]) assert.equal(globDirectoryPrefix(pattern), prefix, pattern)
  const candidates = ['src/a.ts', 'src/deep/a.ts', 'src/main.ts', 'other/a.ts', 'src2/a.ts', '空间/child space/a.ts']
  for (const pattern of ['src/*.ts', 'src/**/*.ts', 'src/{deep,other}/**', '空间/child space/*', '!src/**', '**/*.ts']) {
    const prefix = globDirectoryPrefix(pattern)
    for (const path of candidates) if (compileGlob(pattern)(path) && prefix) {
      assert.ok(path.startsWith(prefix + '/'), pattern + ': unsafe prefix rejected a real match ' + path)
    }
  }
})

test('actual find pruning preserves root, sorting inputs, hidden/VCS and non-followed links', async () => {
  const root = await fixture(300)
  try {
    const broad = await runBash(GLOB_SCRIPT, [root, cap])
    assert.equal(broad.code, 0)
    const all = globPaths(broad.stdout)
    for (const pattern of ['src/**/*.ts', 'src/sub/*.ts', 'src/m?in.ts', 'src/[ms]*.ts',
      'src/*README', 'src/prefix**bar.ts', 'src/.hidden.ts', 'linked-src/**/*.ts',
      'missing/deeper/*.ts', '.git/**/*.ts', '*.ts', '!*.log', '{src,test}/**/*.{ts,js}']) {
      const scoped = await runBash(GLOB_SCRIPT, [root, cap, ...scopeArgs(pattern)])
      assert.equal(scoped.code, 0, pattern)
      assert.equal(scoped.stdout.subarray(0, scoped.stdout.indexOf(0)).toString(), broad.stdout.subarray(0, broad.stdout.indexOf(0)).toString())
      assert.deepEqual(selectedPaths(globPaths(scoped.stdout), pattern, root), selectedPaths(all, pattern, root), pattern)
    }
    const missing = await runBash(GLOB_SCRIPT, [root + '/absent-root', cap, '', 'src', '*.ts'])
    assert.notEqual(missing.code, 0, 'an absent explicit root must not turn into successful no-matches')
  } finally { await runBash('rm -rf -- "$1"', [root]) }
})

test('find path escaping handles metacharacters in the physical root without widening scope', async () => {
  const f = await makeFixture()
  const root = f.root + '/odd [x]*?\\ space'
  try {
    await python('import os,sys;p=sys.argv[1];os.makedirs(p+"/child space/sub");os.makedirs(p+"/other");open(p+"/child space/sub/a.ts","w").write("a");open(p+"/other/a.ts","w").write("b");os.symlink(p+"/other",p+"/alias")', [root])
    const broad = await runBash(GLOB_SCRIPT, [root, cap])
    for (const pattern of ['child space/**/*.ts', 'alias/**/*.ts']) {
      const scoped = await runBash(GLOB_SCRIPT, [root, cap, ...scopeArgs(pattern)])
      assert.equal(scoped.code, 0)
      assert.deepEqual(selectedPaths(globPaths(scoped.stdout), pattern, root), selectedPaths(globPaths(broad.stdout), pattern, root))
    }
  } finally { await f.cleanup() }
})

test('registered glob avoids unrelated same-extension output without changing the byte cap or pool', async () => {
  const f = await makeFixture()
  const search = await load('search')
  const tools = new Map(), disposers = []
  try {
    await python('import os,sys;p=sys.argv[1];os.mkdir(p+"/src");os.mkdir(p+"/other");open(p+"/src/one.ts","w").write("needle");[(open(p+"/other/"+str(i)+".ts","w").write("x")) for i in range(500)]', [f.root])
    // The registration sink only observes actual tool calls; filesystem/RPC execution is real.
    search.apply({ get(name) { return name === 'tools' ? { register: tool => tools.set(tool.name, tool) } : name === 'fs' ? f.fs : undefined },
      effect(fn) { disposers.push(fn()) } }, { rawOutputMaxBytes: 2048 })
    const exec = { agent: { session: { header: { cwd: f.cwd } } } }
    const found = await tools.get('glob').execute({ pattern: 'src/**/*.ts' }, exec)
    assert.deepEqual(found.paths, ['src/one.ts'])
    await assert.rejects(tools.get('glob').execute({ pattern: '*.ts' }, exec), e => e.code === 'SEARCH_RAW_OUTPUT_OVERFLOW')
    assert.equal(await f.fs.readText(await f.fs.resolve('src/one.ts')), 'needle')
    const d = f.fs.wslRpcPool.diagnostics()
    assert.equal(d.launches, 1); assert.equal(d.pending, 0)
    assert.ok(d.metrics.stages['tool.glob'].count >= 2)
  } finally { for (const dispose of disposers) dispose?.(); await f.cleanup() }
})

test('directory listing preserves symlink metadata and observes subsequent edits without a content cache', async () => {
  const f = await makeFixture()
  try {
    await python('import os,sys;p=sys.argv[1];os.mkdir(p+"/list");os.mkdir(p+"/target");open(p+"/target/data","w").write("one");os.symlink("../target/data",p+"/list/file-link");os.symlink("../target",p+"/list/dir-link");os.symlink("../missing",p+"/list/dangling");open(p+"/list/normal","w").write("x")', [f.root])
    const target = await f.fs.resolve('list')
    const first = await f.fs.listDir(target)
    for (const row of first) {
      const direct = await f.fs.resolve('list/' + row.name)
      assert.equal(String(row.target.targetKey), String(direct.targetKey))
      assert.equal(row.version, (await f.fs.stat(direct))?.version)
    }
    const old = first.find(r => r.name === 'normal').version
    await writeRaw(f.root + '/list/normal', 'external change')
    const again = await f.fs.listDir(target)
    assert.notEqual(again.find(r => r.name === 'normal').version, old)
    assert.equal((await readRaw(f.root + '/list/normal')).toString(), 'external change')
  } finally { await f.cleanup() }
})

test('ordinary entries use one fresh metadata call each instead of N full parent walks', async () => {
  const f = await makeFixture()
  try {
    const result = JSON.parse((await python(String.raw`
import json,os,sys
source = json.loads(sys.stdin.buffer.read())
p = sys.argv[1] + '/a/b/c/d/e/f/g/h/list'
os.makedirs(p)
for i in range(500): open(p+'/'+str(i),'w').close()
ns = {}
exec(source.split("\nif sys.argv[1] == '--persistent':")[0], ns)
counts = {'lstat':0, 'stat':0, 'fstat':0}
def profile(frame, event, fn):
    if event == 'c_call':
        for name in counts:
            if fn is getattr(os,name): counts[name] += 1
sys.setprofile(profile)
rows = ns['run']('fs.list', {'path':p})
sys.setprofile(None)
assert len(rows)==500 and all(r['type']=='file' for r in rows)
print(json.dumps({'counts':counts,'depth':len(p.split('/')),'entries':len(rows)}))
`, [f.root], JSON.stringify(NATIVE_FILE_PROGRAM))).toString())
    assert.ok(result.counts.lstat <= result.depth * 2 + 2, JSON.stringify(result))
    assert.ok(result.counts.stat <= result.entries + 3, JSON.stringify(result))
  } finally { await f.cleanup() }
})

test('a directory replaced during enumeration cannot return metadata under a redirected parent', async () => {
  const f = await makeFixture()
  try {
    const result = JSON.parse((await python(String.raw`
import json,os,sys
source=json.loads(sys.stdin.buffer.read());p=sys.argv[1]+'/race';other=sys.argv[1]+'/other'
os.mkdir(p);os.mkdir(other)
for name in ['a','b']: open(p+'/'+name,'w').write('original');open(other+'/'+name,'w').write('foreign')
ns={};exec(source.split("\nif sys.argv[1] == '--persistent':")[0],ns)
original_scandir=os.scandir
class MovingIterator:
    def __init__(self,path): self.it=original_scandir(path);self.changed=False
    def __enter__(self): return self
    def __exit__(self,*args): self.it.close()
    def __iter__(self): return self
    def __next__(self):
        row=next(self.it)
        if not self.changed:
            self.changed=True;os.rename(p,p+'.saved');os.symlink(other,p)
        return row
os.scandir=MovingIterator
try:
    reply,code=ns['dispatch']('fs.list',json.dumps({'path':p}))
finally: os.scandir=original_scandir
assert not reply['ok'] and reply['code']=='FS_STALE_VERSION',reply
assert open(other+'/a').read()=='foreign'
print(json.dumps({'error':reply['code']}))
`, [f.root], JSON.stringify(NATIVE_FILE_PROGRAM))).toString())
    assert.equal(result.error, 'FS_STALE_VERSION')
  } finally { await f.cleanup() }
})
