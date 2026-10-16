import assert from 'node:assert/strict'
import { test } from 'node:test'
import { basenameFilters, compileGlob, expandBraces, matchGlob } from '../src/shared/search-patterns.ts'

test('compiled matchers retain basename, path, brace and negation rules across calls', () => {
  const cases: [string, string[], string[]][] = [
    ['**/*.ts', ['a.ts', 'src/a.ts', 'src/.a.ts'], ['a.js']],
    ['src/*.ts', ['src/a.ts'], ['lib/a.ts', 'src/sub/a.ts']],
    ['*.{ts,js}', ['a.ts', 'src/a.js'], ['a.md']],
    ['!*.log', ['a.ts', 'src/b.md'], ['a.log', 'src/b.log']],
    ['a?.[tj]s', ['ab.ts', 'src/ac.js'], ['abc.ts']],
  ]
  for (const [pattern, yes, no] of cases) {
    const matches = compileGlob(pattern)
    for (let repeat = 0; repeat < 3; repeat += 1) {
      for (const path of yes) { assert.equal(matches(path), true, `${pattern}: ${path}`); assert.equal(matchGlob(pattern, path), true) }
      for (const path of no) { assert.equal(matches(path), false, `${pattern}: ${path}`); assert.equal(matchGlob(pattern, path), false) }
    }
  }
})

test('safe filename filters preserve every union alternative and remove duplicates', () => {
  assert.deepEqual(basenameFilters(expandBraces('src/**/*.{ts,js}')), ['*.ts', '*.js'])
  assert.deepEqual(basenameFilters(['src/*.ts', 'test/*.ts']), ['*.ts'])
  assert.deepEqual(basenameFilters(['src/space name.ts']), ['space name.ts'])
  assert.deepEqual(basenameFilters(['src/**']), ['*'])
})

test('unsafe or negated syntax disables the entire prefilter rather than losing matches', () => {
  for (const unsupported of ['!*.log', 'src/a?.ts', 'src/[ab].ts', 'src/a\\b.ts', 'src/a\nb.ts', 'src/', 'src/foo**bar.ts']) {
    assert.deepEqual(basenameFilters(['src/*.ts', unsupported]), [], unsupported)
  }
})

test('directory grep hints keep the original hidden-file exclusion', () => {
  assert.deepEqual(basenameFilters(['src/*.ts'], true), ['[!.]*.ts'])
  assert.deepEqual(basenameFilters(['src/main.ts'], true), ['main.ts'])
  assert.deepEqual(basenameFilters(['src/.config'], true), [])
  assert.deepEqual(basenameFilters(['src/*README'], true), [])
  assert.deepEqual(basenameFilters(['src/*a'], true), [])
  assert.deepEqual(basenameFilters(['src/*'], true), ['[!.]*'])
})
