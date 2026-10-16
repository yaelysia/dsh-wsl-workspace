import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GLOB_SCRIPT, GREP_SCRIPT } from '../src/shared/search-scripts.ts'
import { basenameFilters, expandBraces } from '../src/shared/search-patterns.ts'
import { fixture, runBash, globPaths, grepPaths, selectedPaths } from '../scripts/benchmark-search.mjs'

const cap = String(20_000_000)

test('native glob hints preserve final results, including ignored and hidden files', async () => {
  const root = await fixture(200)
  try {
    const baseline = await runBash(GLOB_SCRIPT, [root, cap])
    assert.equal(baseline.code, 0)
    const paths = globPaths(baseline.stdout)
    assert.ok(paths.some(path => path.endsWith('/src/.hidden.ts')))
    assert.ok(!paths.some(path => path.includes('/.git/')))
    assert.ok(!paths.some(path => path.includes('/linked-src/')))
    for (const pattern of ['src/**/*.ts', 'src/*.ts', 'src/*README', 'src/*a', 'src/prefix**bar.ts', '**/*.{ts,js}', '*.ts', '!*.log', 'src/m?in.ts', 'src/[ms]*.ts', 'src/odd\nname.ts', '**']) {
      const filtered = await runBash(GLOB_SCRIPT, [root, cap, ...basenameFilters([pattern])])
      assert.equal(filtered.code, 0, pattern)
      assert.deepEqual(selectedPaths(globPaths(filtered.stdout), pattern, root), selectedPaths(paths, pattern, root), pattern)
    }
    const pattern = 'src/**/*.ts'
    const broad = await runBash(GLOB_SCRIPT, [root, '2049'])
    const narrow = await runBash(GLOB_SCRIPT, [root, '2049', ...basenameFilters([pattern])])
    assert.equal(broad.stdout.length, 2049, 'control must overflow the 2048-byte tool budget')
    assert.ok(narrow.stdout.length < 2048)
    assert.deepEqual(selectedPaths(globPaths(narrow.stdout), pattern, root), selectedPaths(paths, pattern, root))
  } finally { await runBash('rm -rf -- "$1"', [root]) }
})

test('native grep hints preserve hidden-file rules and explicit file targets', async () => {
  const root = await fixture(200)
  try {
    const baseline = await runBash(GREP_SCRIPT, ['needle', '', root, cap])
    assert.equal(baseline.code, 0)
    for (const pattern of ['src/*README', 'src/*a', 'src/prefix**bar.ts']) {
      assert.equal(selectedPaths(grepPaths(baseline.stdout), pattern, root).length, 1, `fixture does not exercise ${pattern}`)
    }
    for (const pattern of ['src/**/*.ts', 'src/*.ts', 'src/*README', 'src/*a', 'src/prefix**bar.ts', 'src/main.ts', 'src/m?in.ts', 'src/.hidden.ts', 'src/odd\nname.ts']) {
      const filtered = await runBash(GREP_SCRIPT, ['needle', '', root, cap, ...basenameFilters([pattern], true)])
      assert.deepEqual(selectedPaths(grepPaths(filtered.stdout), pattern, root), selectedPaths(grepPaths(baseline.stdout), pattern, root), pattern)
    }
    // Both hints must cross wsl.exe as separate arguments, not one multi-line value.
    const union = '{src/**/*.ts,test/*.js}'
    const hints = basenameFilters(expandBraces(union), true)
    assert.equal(hints.length, 2)
    assert.ok(hints.every(value => !value.includes('\n')))
    const combined = await runBash(GREP_SCRIPT, ['needle', '', root, cap, ...hints])
    const selected = selectedPaths(grepPaths(combined.stdout), union, root)
    assert.ok(selected.some(path => path.endsWith('/test/main.js')))
    assert.ok(selected.some(path => path.endsWith('/src/main.ts')))
    assert.deepEqual(selected, selectedPaths(grepPaths(baseline.stdout), union, root))
    const hint = basenameFilters(['src/*.ts'], true)
    const explicit = await runBash(GREP_SCRIPT, ['needle', '', `${root}/src/.hidden.ts`, cap, ...hint])
    assert.equal(explicit.code, 0)
    assert.deepEqual(grepPaths(explicit.stdout), [`${root}/src/.hidden.ts`])
    const broad = await runBash(GREP_SCRIPT, ['needle', '', root, '2049'])
    const narrow = await runBash(GREP_SCRIPT, ['needle', '', root, '2049', ...hint])
    assert.equal(broad.stdout.length, 2049)
    assert.ok(narrow.stdout.length < 2048)
    assert.ok(!grepPaths(narrow.stdout).some(path => path.endsWith('/.hidden.ts')))
  } finally { await runBash('rm -rf -- "$1"', [root]) }
})
