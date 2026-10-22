import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GLOB_SCRIPT, GREP_SCRIPT } from '../src/shared/search-scripts.ts'
import { basenameFilters, commonLiteralDirectory, compileGlob, expandBraces, grepDirectoryPrefix } from '../src/shared/search-patterns.ts'
import { fixture, runBash } from '../scripts/benchmark-search.mjs'
import { makeFixture, python } from './support/native-fixture.mjs'
import { load } from '../scripts/compatibility/plane.mjs'
import { parseGlobRecords, parseGrepRecords } from '../src/host/wsl-search.ts'
import { posix } from 'node:path'

const cap = String(20_000_000)
const matching = (result, root, pattern) => {
  const accepts = compileGlob(pattern)
  return parseGrepRecords(result.stdout).filter(record => accepts(posix.relative(root, record.path)))
    .map(({ path, lineNumber, line }) => [path, lineNumber, line]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

test('grep literal prefix is safe for unions and refuses ambiguous/hidden roots', () => {
  const cases = [
    ['src/services/**/*.ts', 'src/services'],
    ['src/*.ts', 'src'],
    ['src/*/test.ts', 'src'],
    ['{src/services/**/*.ts,src/components/**/*.tsx}', 'src'],
    ['{src/services/**/*.ts,other/**/*.tsx}', undefined],
    ['{src/services/**/*.ts,README}', undefined],
    ['**/services/**/*.ts', undefined],
    ['!src/services/**/*.ts', undefined],
    ['src/node_modules/**/*.ts', undefined],
    ['src/.private/**/*.ts', undefined],
    ['src/../services/**/*.ts', undefined],
    ['src/**/services/*.ts', 'src'],
    ['src/[ab]/test.ts', 'src'],
    ['src/x\\y/**/*.ts', undefined],
  ]
  for (const [pattern, expected] of cases) {
    assert.equal(grepDirectoryPrefix(expandBraces(pattern)), expected, pattern)
  }
})

test('direct GNU grep pruning returns exactly the same matching records', async () => {
  const root = await fixture(150)
  try {
    const init = await runBash(String.raw`set -eu
root=$1
mkdir -p "$root/src/services/deep" "$root/src/components" "$root/src/other" "$root/src/node_modules/dep" "$root/src/.private"
printf 'needle targeted\n' > "$root/src/services/main.ts"
printf 'needle nested\n' > "$root/src/services/deep/item.ts"
printf 'needle other\n' > "$root/src/other/main.ts"
printf 'needle components\n' > "$root/src/components/a.tsx"
printf 'needle hidden dir\n' > "$root/src/.private/hidden.ts"
printf 'needle node dep\n' > "$root/src/node_modules/dep/ignored.ts"
ln -s services "$root/src/alias"
`, [root])
    assert.equal(init.code, 0)
    const cases = ['src/services/**/*.ts', 'src/*.ts', 'src/*/main.ts', '{src/services/**/*.ts,src/components/**/*.tsx}']
    for (const pattern of cases) {
      const alternatives = expandBraces(pattern)
      const prefix = grepDirectoryPrefix(alternatives)
      assert.ok(prefix, pattern)
      const hints = basenameFilters(alternatives, true)
      const broad = await runBash(GREP_SCRIPT, ['needle', '', root, cap, ...hints])
      const narrow = await runBash(GREP_SCRIPT, ['needle', '', root, cap, '', prefix, ...hints])
      assert.equal(broad.code, narrow.code, pattern)
      assert.deepEqual(matching(narrow, root, pattern), matching(broad, root, pattern), pattern)
    }
    const hints = basenameFilters(['src/services/**/*.ts'], true)
    const broad = await runBash(GREP_SCRIPT, ['needle', '', root, cap, ...hints])
    for (const unsafe of ['src/alias', 'src/missing', 'src/.private', 'src/node_modules']) {
      const narrowed = await runBash(GREP_SCRIPT, ['needle', '', root, cap, '', unsafe, ...hints])
      assert.equal(narrowed.code, broad.code, unsafe)
      assert.deepEqual(narrowed.stdout, broad.stdout, unsafe + ' must fall back, not follow/exclude a new root')
    }
    const file = root + '/src/services/main.ts'
    const control = await runBash(GREP_SCRIPT, ['needle', '', file, cap])
    const forced = await runBash(GREP_SCRIPT, ['needle', '', file, cap, '', 'src/services'])
    assert.deepEqual(control.stdout, forced.stdout, 'explicit file argument must remain a file')
    assert.equal(control.code, forced.code)
    const noTarget = await runBash(GREP_SCRIPT, ['needle', '', root, cap])
    const missing = await runBash(GREP_SCRIPT, ['needle', '', root, cap, '', 'absent/tree'])
    assert.deepEqual(noTarget.stdout, missing.stdout, 'missing prefix must not change search behavior')
  } finally { await runBash('rm -rf -- "$1"', [root]) }
})

test('registered source/built grep narrows by prefix and preserves real shared pool', async t => {
  const fixture = await makeFixture()
  t.after(() => fixture.cleanup())
  await python(String.raw`import os,sys
r=sys.argv[1]
for path in ('src/services/deep','src/other','src/components'):
  os.makedirs(r+'/'+path)
for path in ('src/services/deep/needle.ts','src/other/needle.ts','src/components/needle.tsx'):
  with open(r+'/'+path,'w') as file: file.write('CP15_TARGET\n')
`, [fixture.root])
  const search = await load('search')
  const tools = new Map()
  const disposers = []
  t.after(() => { for (const fn of disposers) fn?.() })
  search.apply({
    get(name) { return name === 'tools' ? { register: tool => tools.set(tool.name, tool) } : name === 'fs' ? fixture.fs : undefined },
    effect(fn) { disposers.push(fn()) },
  }, { grepMaxMatches: 3000, rawOutputMaxBytes: 20_000_000 })
  const grep = tools.get('grep')
  assert.ok(grep)
  let args, globArgs
  const original = fixture.fs.wslRpcPool.run.bind(fixture.fs.wslRpcPool)
  fixture.fs.wslRpcPool.run = async (target, request) => {
    if (request.op === 'grep') args = request.args
    if (request.op === 'glob') globArgs = request.args
    return original(target, request)
  }
  const exec = { agent: { session: { header: { cwd: fixture.cwd } } }, signal: new AbortController().signal }
  const result = await grep.execute({ pattern: 'CP15_TARGET', include: 'src/services/**/*.ts' }, exec)
  assert.equal(result.matches.length, 1)
  assert.ok(result.matches[0].path.endsWith('src/services/deep/needle.ts'))
  assert.deepEqual(args.slice(4, 6), ['', 'src/services'])
  const both = await grep.execute({ pattern: 'CP15_TARGET', include: '{src/services/**/*.ts,src/components/**/*.tsx}' }, exec)
  assert.equal(both.matches.length, 2)
  assert.deepEqual(args.slice(4, 6), ['', 'src'])
  const explicit = await grep.execute({ pattern: 'CP15_TARGET', include: 'src/services/**/*.ts', path: '.' }, exec)
  assert.equal(explicit.matches.length, 1)
  assert.notDeepEqual(args.slice(4, 6), ['', 'src/services'], 'explicit path does not inherit session-root pruning')
  const wildcard = await grep.execute({ pattern: 'CP15_TARGET', include: '**/services/**/*.ts' }, exec)
  assert.equal(wildcard.matches.length, 1)
  assert.deepEqual(args.slice(4, 8), ['', '', '', 'services'])
  const glob = tools.get('glob')
  assert.ok(glob)
  const listing = await glob.execute({ pattern: '**/services/**/*.ts' }, exec)
  assert.equal(listing.paths.length, 1)
  assert.ok(listing.paths[0].endsWith('src/services/deep/needle.ts'))
  assert.deepEqual(globArgs.slice(2, 6), ['', '', '', 'services'])
  const file = await fixture.fs.resolve('src/services/deep/needle.ts')
  assert.equal(await fixture.fs.readText(file), 'CP15_TARGET\n')
  const diagnostics = fixture.fs.wslRpcPool.diagnostics()
  assert.equal(diagnostics.workers, 1)
  assert.equal(diagnostics.launches, 1)
  assert.equal(diagnostics.pending, 0)
  assert.equal(diagnostics.fallbacks, 0)
  assert.ok(diagnostics.metrics.stages['tool.grep']?.count >= 3)
  assert.ok(diagnostics.metrics.stages['file.read']?.count >= 1)
})

test('target-only pruning lowers candidate bytes before the original output cap', async () => {
  const root = await fixture(0)
  try {
    const created = await runBash(String.raw`set -eu
root=$1
mkdir -p "$root/src/unrelated" "$root/src/services"
for ((i=0;i<120;i++)); do printf 'needle unrelated\n' > "$root/src/unrelated/$i.ts"; done
printf 'needle target\n' > "$root/src/services/target.ts"
`, [root])
    assert.equal(created.code, 0)
    const hint=basenameFilters(['src/services/**/*.ts'],true)
    const limited='1024'
    const broad=await runBash(GREP_SCRIPT,['needle','',root,limited,...hint])
    const narrowed=await runBash(GREP_SCRIPT,['needle','',root,limited,'','src/services',...hint])
    assert.equal(broad.stdout.length,1024)
    assert.ok(narrowed.stdout.length<1024)
    assert.equal(matching(narrowed,root,'src/services/**/*.ts').length,1)
  } finally {await runBash('rm -rf -- "$1"',[root])}
})
