// CP13 second candidate: retain native canonicalization after its replacement measured slower.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
const path = 'src/shared/rpc-transport.ts'
const bytes = readFileSync(path)
assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
  '7d01e770c814f5d7a9b70b75e04a1070100f81f2', 'reviewed first candidate must be unchanged')
const source = bytes.toString('utf8')
const start = source.indexOf("const BASE64_ALPHABET = '")
const end = source.indexOf('\n\nclass Worker {', start)
assert.ok(start >= 0 && end > start)
const replacement = `export function decodeRpcBytes(raw: unknown, max: number): Buffer {
  if (typeof raw !== 'string') throw new Error('invalid byte payload')
  // Reject oversized frames before allocating; keep the faster native round-trip
  // canonicality check instead of scanning the whole string in JavaScript.
  const padding = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0
  if (raw.length / 4 * 3 - padding > max) throw new Error('invalid or oversized base64')
  const bytes = Buffer.from(raw, 'base64')
  if (bytes.length > max || bytes.toString('base64') !== raw) throw new Error('invalid or oversized base64')
  return bytes
}`
writeFileSync(path, source.slice(0, start) + replacement + source.slice(end))
const docPath = 'docs/performance-cp13.md'
let doc = readFileSync(docPath, 'utf8')
doc = doc.replace('- Strict canonical Base64 validation checks encoded length, alphabet, padding position and unused bits before decoding. It does not re-encode the entire decoded buffer solely to compare it. Invalid/oversized input retains the same public errors.',
  '- The existing native Base64 round-trip validation is retained. A constant-time encoded-length check rejects oversized input before allocating; malformed data and pad bits still follow the old exact canonicality rule. A full JavaScript alphabet scanner was measured and rejected, not shipped as a speedup.')
doc = doc.replace('## First measured Linux result', '## Rejected first candidate: Linux measurements')
doc = doc.replace('See [raw readings](performance-cp13-linux.json).', 'Its original [raw readings](https://github.com/yaelysia/dsh-wsl-workspace/blob/5ab03baf29cfeced9c5714ce258bd969dabaae97/docs/performance-cp13-linux.json) remain in Git history.')
doc += '\nThe first candidate increased 4 MiB read/write/edit latency. The JavaScript alphabet scan is therefore removed before the second comparison; no performance claim is based on the rejected candidate. Other bounded-copy/sampling changes and their regressions remain.\n'
writeFileSync(docPath, doc)
console.log('Removed slower scanner; kept pre-allocation byte limit and the original native canonical validation.')
