// Temporary exact, reviewed source change applied only in this branch's delivery job.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
const path = 'src/host/wsl-search.ts'
const bytes = readFileSync(path)
const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
assert.equal(blob, '9d942ee2a67c25963108682d1e5a1fb53d93d4c1', 'the reviewed main source must be unchanged')
const source = bytes.toString('utf8')
assert.equal(source.split('export default apply').length, 2)
writeFileSync(path, source.replace('export default apply', '// Loader selects the default export; keep dependency and schema metadata on it.\nexport default { apply, inject, Config }'))
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
assert.equal(manifest.scripts['test:rpc-loader'], undefined)
manifest.scripts['test:rpc-loader'] = 'node --experimental-strip-types --test tests/rpc-loader-entry.test.mjs'
manifest.scripts['test:rpc-loader-host'] = 'node scripts/run-rpc-loader-host.mjs .host-current 0.2.1-rc.2'
manifest.scripts['test:node'] += ' && npm run test:rpc-loader'
writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\n')
const workflow = '.github/workflows/native-files.yml'
const previous = readFileSync(workflow, 'utf8')
const line = '          npm run test:rpc-mixed 2>&1 | tee logs/mixed-$plane.log'
assert.equal(previous.split(line).length, 3, 'both native source/lib loops must be present')
writeFileSync(workflow, previous.replaceAll(line, line + '\n          npm run test:rpc-loader 2>&1 | tee logs/loader-$plane.log'))
console.log('Applied only the default-export metadata repair and regression entrypoints; no RPC/FS algorithm changed.')
