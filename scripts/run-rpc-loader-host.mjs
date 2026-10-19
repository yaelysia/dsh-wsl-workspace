/** Run the same source/lib Loader-entry regression against one isolated host tree.
 * Usage: node scripts/run-rpc-loader-host.mjs .host-current 0.2.1-rc.2
 * No installation, user profile mutation or editing of root node_modules.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const host = resolve(process.argv[2] ?? '.host-current')
const requireHost = createRequire(join(host, 'package.json'))
const version = JSON.parse(readFileSync(requireHost.resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version
assert.ok(process.argv[3], 'an explicit expected DSH version is required')
assert.equal(version, process.argv[3])
const run = mkdtempSync(join(tmpdir(), 'dsh-rpc-loader-'))
let status = 0
try {
  for (const path of ['package.json', 'src', 'lib', 'scripts/compatibility/plane.mjs',
    'tests/rpc-loader-entry.test.mjs', 'tests/support/native-fixture.mjs']) {
    const target = join(run, path)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(root, path), target, { recursive: true })
  }
  mkdirSync(join(run, 'node_modules'))
  const link = (source, name) => symlinkSync(source, join(run, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir')
  link(join(host, 'node_modules', '@deepseek-ai'), '@deepseek-ai')
  // Preserve the plugin's own YAML major, not an unrelated host's copy.
  link(join(root, 'node_modules', 'js-yaml'), 'js-yaml')
  console.log(`Isolated Loader contract host: DSH ${version}`)
  for (const plane of ['src', 'lib']) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', 'tests/rpc-loader-entry.test.mjs'], {
      cwd: run, stdio: 'inherit', timeout: 120000,
      env: { ...process.env, DSH_WSL_TEST_PLANE: plane },
    })
    if (result.error) throw result.error
    if (result.status !== 0) status = 1
  }
} finally {
  // Do not traverse the linked dependency trees when removing the scratch copy.
  rmSync(run, { recursive: true, force: true })
}
process.exitCode = status
