// Temporary delivery recipe. Removed from the tested commit; not plugin runtime code.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
const p = 'src/host/wsl-search.ts'
let s = readFileSync(p, 'utf8')
const before = "/** Services these tools register into. */\nexport const inject = ['tools']"
assert.equal(s.split(before).length, 2, 'the expected service declaration must occur exactly once')
s = s.replace(before, "/** Wait for the filesystem owner before choosing its RPC pool; track its replacement/disposal. */\nexport const inject = ['tools', 'fs']")
writeFileSync(p, s)
const test = 'tests/rpc-owner-lifecycle.test.mjs'
s = readFileSync(test, 'utf8').replace('await searchFiber.dispose()', 'await (await searchFiber).dispose()')
writeFileSync(test, s)
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
pkg.scripts['test:rpc-owner'] = 'node --experimental-strip-types --test tests/rpc-owner-lifecycle.test.mjs'
pkg.scripts['test:node'] += ' && npm run test:rpc-owner'
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
