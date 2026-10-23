#!/usr/bin/env node
// Require a plugin version increase for each non-documentation PR, not each
// intermediate commit. Root manifest/lockfile consistency is always required.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = message => { console.error('version-gate: RED — ' + message); process.exit(1) }
const local = path => JSON.parse(readFileSync(join(root, path), 'utf8'))
const manifest = local('package.json')
const lock = local('package-lock.json')
if (manifest.name !== lock.name || manifest.name !== lock.packages?.['']?.name
    || manifest.version !== lock.version || manifest.version !== lock.packages?.['']?.version) {
  fail('package.json and package-lock.json root name/version do not agree')
}
function tuple(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)
  if (!match) fail('expected numeric major.minor.patch plugin version, got ' + version)
  return match.slice(1).map(Number)
}
const current = tuple(manifest.version)
const args = process.argv.slice(2)
if (args.length === 0) {
  console.log('version-gate: OK — manifest and lockfile agree at ' + manifest.version)
  process.exit(0)
}
if (args.length !== 2 || args[0] !== '--base') fail('usage: node scripts/check-version-bump.mjs [--base <git-revision>]')
const base = args[1]
const git = argv => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim()
let previous, changed
try {
  previous = JSON.parse(git(['show', base + ':package.json']))
  changed = git(['diff', '--name-only', base, 'HEAD', '--']).split(/\r?\n/).filter(Boolean)
} catch (error) {
  fail('cannot compare with base ' + base + ': ' + String(error))
}
const old = tuple(previous.version)
let compared = 0
for (let i = 0; i < 3; i++) {
  if (current[i] !== old[i]) { compared = current[i] > old[i] ? 1 : -1; break }
}
if (compared < 0) fail('version moved backwards: ' + previous.version + ' → ' + manifest.version)
const docsOnly = path => path.endsWith('.md') || path.startsWith('docs/') || path === 'LICENSE'
  || path === 'NOTICE' || /^image-\d+\.(png|jpe?g|webp)$/.test(path)
const codeChanges = changed.filter(path => !docsOnly(path))
if (codeChanges.length && compared === 0) {
  fail('non-documentation changes must increase plugin version from ' + previous.version
    + '; files: ' + codeChanges.slice(0, 10).join(', '))
}
console.log('version-gate: OK — ' + previous.version + ' → ' + manifest.version
  + (codeChanges.length ? ' (code/package changes)' : ' (documentation-only PR)'))
