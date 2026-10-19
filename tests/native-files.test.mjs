import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { joinUnc, windowsToMntPath } from '../src/shared/paths.ts'
import { WslRpcPool } from '../src/shared/rpc-transport.ts'
import { RPC_METHODS } from '../src/shared/rpc-metrics.ts'
import { NativeFileClient, NATIVE_MAX_BYTES } from '../src/shared/native-files.ts'
import { nativeCoordinate, nativeKey, resolveFileConfig } from '../src/shared/native-file-config.ts'
import { spawn } from 'node:child_process'
import { makeFixture, python, writeRaw, readRaw, removeRaw, pyJson, collect, codeIs, lockedDirectory,
  windows, distro, rpcOptions, WslFileSystem } from './support/native-fixture.mjs'

const replace = version => ({ kind: 'replaceIfVersion', version })
const create = { kind: 'createIfAbsent' }
async function fixture(t, options) { const f = await makeFixture(options); t.after(() => f.cleanup()); return f }
const targetOf = root => ({ wslPath: 'wsl.exe', distro, linuxCwd: root })

// LocalFileSystem requires its native host substrate (Win32 DACLs on Windows).
// Never use a bare LocalFileSystem on a WSL UNC path as the edit oracle: its
// publication can fail before the text contract is exercised. The native side
// still runs on real Linux; bytes and outcomes are compared across both disks.
async function hostReference(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-reference-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return {
    fs: new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }),
    write: (name, bytes) => writeFile(join(root, name), bytes),
    read: name => readFile(join(root, name)),
  }
}

// No mock filesystem: these run the bundled Python program, filesystem provider and real Linux I/O.
test('native provider creates parents, returns fresh versions and keeps observations backend-pinned', async t => {
  const { fs, root } = await fixture(t)
  const target = await fs.resolve('nested/notes.txt')
  assert.equal(fs.processPath(target), `${root}/nested/notes.txt`)
  assert.equal(await fs.stat(target), undefined)
  const created = await fs.writeText(target, 'first\r\n', create)
  assert.equal(created.operation, 'create'); assert.equal(created.before, null); assert.equal(created.after, 'first\n')
  assert.equal((await fs.stat(target)).version, created.version)
  assert.equal(await fs.readText(target), 'first\r\n')
  const changed = await fs.writeText(target, 'second\n', replace(created.version))
  assert.equal(changed.before, 'first\n'); assert.equal(changed.operation, 'update')
  assert.equal((await fs.stat(target)).version, changed.version)
  assert.equal(fs.wslRpcPool.snapshot().launches, 1)
  assert.ok(nativeCoordinate(String(target.targetKey)), 'actual provider must use native, not UNC')
  const stats = fs.wslRpcPool.diagnostics()
  assert.equal(stats.pending, 0)
})

test('native reads preserve bytes; strict UTF-8, BOM and sampled binary rules match the host', async t => {
  const { fs, root } = await fixture(t)
  const hostData = await hostReference(t), host = hostData.fs
  const cases = [Buffer.from('\ufeff中文\r\n🙂\n'), Buffer.from([0x61, 0xff]), Buffer.from('abc\0def'),
    Buffer.concat([Buffer.alloc(9000, 97), Buffer.from([0])]), Buffer.alloc(0)]
  for (let i = 0; i < cases.length; i++) {
    const name = `read-${i}.txt`; await writeRaw(`${root}/${name}`, cases[i]); await hostData.write(name, cases[i])
    const target = await fs.resolve(name), reference = await host.resolve(name)
    assert.deepEqual(Buffer.from(await fs.readBytes(target, undefined, cases[i].length)), cases[i])
    const outcomes = await Promise.allSettled([fs.readText(target), host.readText(reference)])
    assert.equal(outcomes[0].status, outcomes[1].status)
    if (outcomes[0].status === 'fulfilled') assert.equal(outcomes[0].value, outcomes[1].value)
    else assert.equal(outcomes[0].reason.code, outcomes[1].reason.code)
  }
  const file = await fs.resolve('read-0.txt')
  assert.deepEqual(Buffer.from(await fs.readByteRange(file, { offset: 3, length: 6 })), cases[0].subarray(3, 9))
  assert.equal((await fs.readByteRange(file, { offset: 1000, length: 20 })).length, 0)
  assert.equal((await fs.readByteRange(file, { offset: 0, length: 0 })).length, 0)
  await assert.rejects(fs.readBytes(file, undefined, 1), codeIs('FS_TOO_LARGE'))
  await assert.rejects(fs.readText(await fs.resolve(root)), codeIs('FS_NOT_REGULAR_FILE'))
})

test('native stream handles UTF-8 split boundaries and refuses a changed file between chunks', async t => {
  const { fs, root } = await fixture(t)
  const text = 'a'.repeat(256 * 1024 - 1) + '🙂中文' + 'b'.repeat(300_000)
  await writeRaw(`${root}/stream.txt`, text)
  const target = await fs.resolve('stream.txt')
  assert.equal(await collect(await fs.streamText(target)), text)
  const iterator = (await fs.streamText(target))[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).done, false)
  await writeRaw(`${root}/stream.txt`, 'changed')
  await assert.rejects(iterator.next(), codeIs('FS_STALE_VERSION'))
  const stop = new AbortController(); stop.abort()
  await assert.rejects(fs.readText(target, stop.signal), codeIs('FS_ABORTED'))
  await assert.rejects(collect(await fs.streamText(target, stop.signal)), codeIs('FS_ABORTED'))
  assert.deepEqual(await readRaw(`${root}/stream.txt`), Buffer.from('changed'))
})

test('native exact edit matches pinned host newline, BOM, ambiguity and not-found semantics', async t => {
  const { fs, root } = await fixture(t)
  const hostData = await hostReference(t), host = hostData.fs
  const cases = [
    ['\ufeffalpha\r\nalpha\r\n', { oldString: 'alpha\n', newString: 'beta\n', replaceAll: true }],
    ['a\ra\r', { oldString: 'a', newString: 'b', replaceAll: true }],
    ['x\nx\r\nx\r\n', { oldString: 'x', newString: 'y\nz', replaceAll: true }],
    ['aaa', { oldString: 'aa', newString: 'Z', replaceAll: false }],
    ['same same', { oldString: 'same', newString: 'X', replaceAll: false }],
    ['body', { oldString: '', newString: 'X', replaceAll: false }],
    ['body', { oldString: 'absent', newString: 'X', replaceAll: true }],
    ['binary\0text', { oldString: 'binary', newString: 'X', replaceAll: false }],
  ]
  for (let i = 0; i < cases.length; i++) {
    const [body, edit] = cases[i]
    const a = `native-edit-${i}`, b = `host-edit-${i}`
    await writeRaw(`${root}/${a}`, body); await hostData.write(b, body)
    const native = await fs.resolve(a), local = await host.resolve(b)
    const outcomes = await Promise.allSettled([fs.editText(native, edit), host.editText(local, edit)])
    assert.equal(outcomes[0].status, outcomes[1].status,
      `case ${i}: native=${outcomes[0].reason?.message ?? 'ok'}; host=${outcomes[1].reason?.message ?? 'ok'}`)
    if (outcomes[0].status === 'fulfilled') {
      assert.equal(outcomes[0].value.before, outcomes[1].value.before)
      assert.equal(outcomes[0].value.after, outcomes[1].value.after)
      assert.equal((await fs.stat(native)).version, outcomes[0].value.version)
    } else assert.equal(outcomes[0].reason.code, outcomes[1].reason.code, `case ${i}`)
    assert.deepEqual(await readRaw(`${root}/${a}`), await hostData.read(b), `stored bytes case ${i}`)
  }
})

test('native guards precede edit matching and never overwrite an unobserved or changed file', async t => {
  const { fs, root } = await fixture(t)
  const target = await fs.resolve('guard.txt')
  const first = await fs.writeText(target, 'one', create)
  await assert.rejects(fs.writeText(target, 'bad', create), codeIs('FS_NOT_OBSERVED'))
  await writeRaw(`${root}/guard.txt`, 'external')
  await assert.rejects(fs.writeText(target, 'bad', replace(first.version)), codeIs('FS_STALE_VERSION'))
  await assert.rejects(fs.editText(target, { oldString: 'notfound', newString: 'bad', replaceAll: false },
    { version: first.version }), codeIs('FS_STALE_VERSION'))
  assert.equal(await fs.readText(target), 'external')
  await removeRaw(`${root}/guard.txt`)
  await assert.rejects(fs.editText(target, { oldString: 'x', newString: 'y', replaceAll: false }), codeIs('FS_STALE_VERSION'))
  await assert.rejects(fs.writeText(target, 'bad', replace(first.version)), codeIs('FS_STALE_VERSION'))
  assert.equal(await fs.stat(target), undefined)
})

test('independent native pools serialize guarded writes without persistent lock files', async t => {
  const { fs, provider, root } = await fixture(t)
  const other = provider()
  const target = await fs.resolve('concurrent.txt')
  const initial = await fs.writeText(target, 'start', create)
  const all = await Promise.allSettled([fs, other, fs, other].map((p, i) => p.writeText(target, `writer${i}`, replace(initial.version))))
  assert.equal(all.filter(r => r.status === 'fulfilled').length, 1)
  assert.ok(all.filter(r => r.status === 'rejected').every(r => r.reason.code === 'FS_STALE_VERSION'))
  assert.match(await fs.readText(target), /^writer[0-3]$/)
  const names = await pyJson('import os,json,sys;print(json.dumps(os.listdir(sys.argv[1])))', [root])
  assert.deepEqual(names, ['concurrent.txt'])
})

test('native opaque identity preserves case, backslashes, spaces, Unicode and newline filenames', async t => {
  const { fs, root } = await fixture(t)
  const names = ['Case.txt', 'case.txt', 'literal\\slash.txt', '空 格🙂.txt', 'line\nbreak.txt', 'single\'quote.txt']
  for (const [i, name] of names.entries()) {
    const target = await fs.resolve(`${root}/${name}`)
    assert.equal(fs.processPath(target), `${root}/${name}`)
    await fs.writeText(target, `value${i}`, create)
    assert.equal(await fs.readText(target), `value${i}`)
    assert.equal(decodeURIComponent(fs.fileUrl(target).slice(7)), `${root}/${name}`)
  }
  const rows = await fs.listDir(await fs.resolve(root))
  assert.deepEqual(rows.map(r => r.name), [...names].sort((a,b) => a.localeCompare(b)))
  assert.equal(new Set(rows.map(r => r.target.targetKey)).size, names.length)
  for (const row of rows) assert.equal((await fs.stat(row.target)).version, row.version)
  assert.equal(fs.contains(await fs.resolve(`${root}/Case.txt`), await fs.resolve(`${root}/case.txt`)), false)
})

test('native symlinks resolve physically, lstat does not follow, and dangling writes preserve links', async t => {
  const { fs, root } = await fixture(t)
  await python('import os,sys;p=sys.argv[1];os.makedirs(p+"/actual/sub");open(p+"/actual/item","w").write("real");os.symlink(p+"/actual/sub",p+"/alias");os.symlink(p+"/new/item",p+"/dangling");os.symlink(p+"/loop",p+"/loop")', [root])
  const linked = await fs.resolve('alias/../item')
  assert.equal(fs.processPath(linked), `${root}/actual/item`)
  assert.equal(await fs.readText(linked), 'real')
  assert.equal((await fs.lstat('alias')).type, 'symlink')
  assert.equal((await fs.lstat('dangling')).type, 'symlink')
  const target = await fs.resolve('dangling')
  await fs.writeText(target, 'created', create)
  assert.equal((await fs.lstat('dangling')).type, 'symlink')
  assert.equal(await fs.readText(await fs.resolve('new/item')), 'created')
  await assert.rejects(fs.resolve('loop'), codeIs('FS_IO_ERROR'))
})

test('listed Windows-drive links keep the same backend and versions as direct resolution',
  { skip: !windows && 'requires the real Windows file backend and a WSL mount' }, async t => {
    const { fs, root } = await fixture(t)
    const host = await hostReference(t)
    await host.write('mounted.txt', 'before\n')
    const driveFile = windowsToMntPath(host.fs.processPath(await host.fs.resolve('mounted.txt')))
    const driveDir = windowsToMntPath(host.fs.processPath(await host.fs.resolve('.')))
    assert.ok(driveFile); assert.ok(driveDir)
    await python('import os,sys;root,file,directory=sys.argv[1:];os.symlink(file,root+"/mounted.txt");os.symlink(directory,root+"/mounted-dir");os.symlink(file+"-missing",root+"/missing.txt")',
      [root, driveFile, driveDir])
    await writeRaw(`${root}/linux.txt`, 'native')
    const rows = await fs.listDir(await fs.resolve(root))
    assert.ok(nativeCoordinate(String(rows.find(row => row.name === 'linux.txt').target.targetKey)))
    for (const name of ['mounted.txt', 'mounted-dir', 'missing.txt']) {
      const row = rows.find(entry => entry.name === name)
      assert.ok(row, name)
      const direct = await fs.resolve(name)
      assert.equal(nativeCoordinate(String(row.target.targetKey)), undefined, name)
      assert.equal(row.target.targetKey, direct.targetKey, name)
      const info = await fs.stat(direct)
      assert.equal(row.type, info?.type ?? 'other', name)
      assert.equal(row.version, info?.version, name)
      if (info?.type === 'file') assert.equal(row.size, info.size, name)
    }
    assert.equal((await fs.lstat('mounted.txt')).type, 'symlink', 'lstat still describes the Linux link')
    const file = rows.find(row => row.name === 'mounted.txt')
    assert.equal(await fs.readText(file.target), 'before\n')
    const written = await fs.writeText(file.target, 'written\n', replace(file.version))
    await assert.rejects(fs.writeText(file.target, 'stale', replace(file.version)), codeIs('FS_STALE_VERSION'))
    await fs.editText(file.target, { oldString: 'written', newString: 'edited', replaceAll: false },
      { version: written.version })
    assert.equal((await host.read('mounted.txt')).toString(), 'edited\n')
    const directory = rows.find(row => row.name === 'mounted-dir')
    assert.ok((await fs.listDir(directory.target)).some(row => row.name === 'mounted.txt'))
    const missing = rows.find(row => row.name === 'missing.txt')
    await fs.writeText(missing.target, 'created', create)
    assert.equal((await host.read('mounted.txt-missing')).toString(), 'created')
  })

test('native policy denies outside, case-confusable and retargeted paths without side effects', async t => {
  const { fs, root } = await fixture(t)
  await python('import os,sys;p=sys.argv[1];os.makedirs(p+"/Workspace");os.makedirs(p+"/workspace");open(p+"/workspace/out","w").write("outside");os.symlink(p+"/workspace",p+"/Workspace/link")', [root])
  const policy = { mode: 'workspace-write', workspaceRoot: joinUnc(distro, `${root}/Workspace`) }
  const inside = await fs.resolve(`${root}/Workspace/in`)
  await fs.writeText(inside, 'allowed', create, undefined, policy)
  for (const p of [`${root}/workspace/out`, `${root}/Workspace/link/out`, `${root}/outside/new`]) {
    await assert.rejects(fs.writeText(await fs.resolve(p), 'bad', undefined, undefined, policy), codeIs('FS_SANDBOX_DENIED'))
  }
  await assert.rejects(fs.writeText(inside, 'bad', undefined, undefined, { mode: 'read-only' }), codeIs('FS_SANDBOX_DENIED'))
  await assert.rejects(fs.editText(inside, { oldString:'allowed', newString:'bad', replaceAll:false }, undefined, undefined,
    { mode:'read-only' }), codeIs('FS_SANDBOX_DENIED'))
  await python('import os,sys;os.unlink(sys.argv[1]);os.symlink(sys.argv[2],sys.argv[1])', [`${root}/Workspace/in`, `${root}/workspace/out`])
  await assert.rejects(fs.writeText(inside, 'bad', undefined, undefined, policy), codeIs('FS_SANDBOX_DENIED'))
  assert.equal((await readRaw(`${root}/workspace/out`)).toString(), 'outside')
  assert.equal(await fs.lstat(`${root}/outside`), undefined, 'denied request must not create outside parents')
})

test('native replacement preserves executable permissions and extended attributes', async t => {
  const { fs, root } = await fixture(t)
  await writeRaw(`${root}/script.sh`, '#!/bin/sh\necho before\n')
  await python('import os,sys;os.chmod(sys.argv[1],0o751);os.setxattr(sys.argv[1],"user.dsh-test",b"kept")', [`${root}/script.sh`])
  const target = await fs.resolve('script.sh')
  const before = await pyJson('import os,json,sys;s=os.stat(sys.argv[1]);print(json.dumps([s.st_uid,s.st_gid,s.st_mode&0o777]))', [`${root}/script.sh`])
  await fs.editText(target, { oldString:'before', newString:'after', replaceAll:false })
  const after = await pyJson('import os,json,sys;s=os.stat(sys.argv[1]);print(json.dumps([s.st_uid,s.st_gid,s.st_mode&0o777]))', [`${root}/script.sh`])
  assert.deepEqual(after, before)
  assert.equal((await python('import os,sys;sys.stdout.buffer.write(os.getxattr(sys.argv[1],"user.dsh-test"))', [`${root}/script.sh`])).toString(), 'kept')
})

test('large native content travels over stdin; oversized mutations fail before publication', async t => {
  const { fs, root } = await fixture(t)
  const content = '中文abc\r\n'.repeat(160_000)
  const target = await fs.resolve('large.txt')
  assert.ok(Buffer.byteLength(content) > 1024 * 1024)
  const result = await fs.writeText(target, content, create)
  assert.equal(result.after, content.replaceAll('\r\n', '\n'))
  assert.equal(await fs.readText(target), content)
  await assert.rejects(fs.writeText(target, 'x'.repeat(NATIVE_MAX_BYTES + 1)), codeIs('FS_TOO_LARGE'))
  assert.equal(await fs.readText(target), content)
  await python('import os,sys;f=open(sys.argv[1],"wb");f.truncate(17*1024*1024);f.close()', [`${root}/sparse`])
  const sparse = await fs.resolve('sparse')
  assert.equal((await fs.readByteRange(sparse, { offset: 16*1024*1024, length: 32 })).length, 32)
  await assert.rejects(fs.readBytes(sparse, undefined, 20 * 1024 * 1024), codeIs('FS_TOO_LARGE'))
})

test('native write diff basis obeys the exclusive host limit and binary before suppression', async t => {
  const { fs, provider, root } = await fixture(t)
  const small = provider({ diffBasisMaxBytes: 4 })
  const target = await fs.resolve('basis')
  await fs.writeText(target, 'abc')
  assert.equal((await small.writeText(target, 'xyz')).before, 'abc')
  assert.equal((await small.writeText(target, '1234')).before, null)
  await writeRaw(`${root}/basis`, 'a\0b')
  assert.equal((await fs.writeText(target, 'text')).before, null)
})

test('blocked native mutation acknowledges cancellation and keeps the original file', async t => {
  const { fs, root } = await fixture(t)
  const target = await fs.resolve('locked')
  const first = await fs.writeText(target, 'original', create)
  const unlock = await lockedDirectory(root)
  const stop = new AbortController()
  try {
    const pending = fs.writeText(target, 'must not commit', replace(first.version), stop.signal)
    const checked = assert.rejects(pending, codeIs('FS_ABORTED'))
    await delay(250); stop.abort(); await checked
    assert.equal((await readRaw(`${root}/locked`)).toString(), 'original')
  } finally { stop.abort(); await unlock() }
  assert.equal((await fs.stat(target)).version, first.version)
  const names = await pyJson('import os,json,sys;print(json.dumps(os.listdir(sys.argv[1])))', [root])
  assert.deepEqual(names, ['locked'])
})

test('directory relocation while a write waits for its lock cannot redirect publication', async t => {
  const { fs, root } = await fixture(t)
  await writeRaw(`${root}/inside/a`, 'original')
  const target = await fs.resolve('inside/a')
  const initial = await fs.stat(target)
  const unlock = await lockedDirectory(`${root}/inside`)
  const pending = fs.writeText(target, 'bad', replace(initial.version))
  const checked = assert.rejects(pending, codeIs('FS_STALE_VERSION'))
  await delay(250)
  await python('import os,sys;os.rename(sys.argv[1]+"/inside",sys.argv[1]+"/moved");os.mkdir(sys.argv[1]+"/inside")', [root])
  await unlock(); await checked
  assert.equal((await readRaw(`${root}/moved/a`)).toString(), 'original')
  assert.equal(await fs.stat(await fs.resolve('inside/a')), undefined)
})

test('lost mutation receipt is unknown and never replayed or downgraded to UNC', async () => {
  let launches = 0
  const ready = `process.stdout.write(JSON.stringify({ready:3,pid:process.pid,methods:${JSON.stringify(RPC_METHODS)}})+'\\n');`
  const pool = new WslRpcPool({ launch: () => {
    launches++
    return spawn(process.execPath, ['-e', ready + `require('node:readline').createInterface({input:process.stdin}).once('line',()=>process.exit(7));`], { stdio:'pipe' })
  } })
  try {
    const client = new NativeFileClient(pool)
    await assert.rejects(client.write(targetOf('/'), '/test', 'value', undefined, undefined, 1024),
      error => error.code === 'RPC_MUTATION_UNKNOWN' && /re-read before retrying/.test(error.message))
    assert.equal(launches, 1)
  } finally { pool.dispose() }
})

test('native routing configuration and opaque keys reject invalid values without changing mode', () => {
  assert.equal(resolveFileConfig({}, {}).backend, 'auto')
  assert.equal(resolveFileConfig({}, { DSH_WSL_FILE_BACKEND:'unc' }).backend, 'unc')
  assert.equal(resolveFileConfig({backend:'native'}, { DSH_WSL_FILE_BACKEND:'unc' }).backend, 'native')
  assert.throws(() => resolveFileConfig({ backend:'anything' }, {}))
  const value = { distro:'Ubuntu', username:'user', path:'/a/Case\\x\ny' }
  assert.deepEqual(nativeCoordinate(nativeKey(value)), value)
  assert.throws(() => nativeCoordinate('wsl-native:["Ubuntu","--root","/a"]'))
  assert.throws(() => nativeCoordinate('wsl-native:["../../escape",null,"/a"]'))
  assert.equal(nativeCoordinate('C:\\project'), undefined)
})

test('registered default auto search and native files actually share their owner pool', async t => {
  const { fs, root, cwd } = await fixture(t, { backend:'auto' })
  const { load } = await import('../scripts/compatibility/plane.mjs')
  const search = await load('search')
  const target = await fs.resolve('shared.txt'); await fs.writeText(target, 'needle', create)
  const tools = [], disposers = []
  const ctx = { get: name => name === 'fs' ? fs : name === 'tools' ? {register: tool => tools.push(tool)} : undefined,
    effect: fn => { const dispose = fn(); if (dispose) disposers.push(dispose) } }
  search.apply(ctx)
  const exec = { agent: { session: { header: { cwd } } }, signal: new AbortController().signal }
  const result = await tools.find(tool => tool.name === 'grep').execute({ pattern:'needle', path:root }, exec)
  assert.deepEqual(result.matches.map(m => m.path), ['shared.txt'])
  assert.equal(fs.wslRpcPool.snapshot().launches, 1)
  assert.equal(fs.wslRpcPool.diagnostics().metrics.stages['tool.grep'].count, 1)
  for (const dispose of disposers) dispose()
  assert.equal(await fs.readText(target), 'needle', 'disposing search must not dispose the filesystem-owned pool')
  assert.equal(fs.rpcPoolFor({ idleMs: 120000, metrics:false }), undefined, 'consumer overrides must not silently inherit enabled metrics')
})

test('queued native mutation cancellation does not execute later after workers become free', async t => {
  const { fs, root } = await fixture(t)
  const target = await fs.resolve('queue.txt'); await fs.writeText(target, 'original', create)
  const unlock = await lockedDirectory(root)
  const blockers = Array.from({length:4}, () => new AbortController())
  const calls = blockers.map(c => fs.writeText(target, 'blocked', undefined, c.signal))
  const observed = Promise.allSettled(calls)
  const stop = new AbortController()
  try {
    await delay(300)
    const queued = fs.writeText(target, 'cancelled queue', undefined, stop.signal)
    const checked = assert.rejects(queued, codeIs('FS_ABORTED'))
    stop.abort(); await checked
    for (const c of blockers) c.abort()
    const results = await observed
    assert.ok(results.every(r => r.status === 'rejected' && r.reason.code === 'FS_ABORTED'))
  } finally {
    for (const c of blockers) c.abort()
    await unlock(); await observed
  }
  assert.equal((await readRaw(`${root}/queue.txt`)).toString(), 'original')
})

test('native Linux user permissions are reported as denial, not missing files or automatic fallback', async t => {
  const root = (await python('import tempfile,os;p=tempfile.mkdtemp(prefix="dsh-native-perms-");os.chmod(p,0o755);print(p)')).toString().trim()
  t.after(() => python('import shutil,sys;shutil.rmtree(sys.argv[1])', [root]))
  await writeRaw(`${root}/private`, 'secret')
  await python('import os,sys;os.chmod(sys.argv[1],0)', [`${root}/private`])
  const uid = Number((await python('import os;print(os.getuid())')).toString())
  const identity = uid === 0 ? { username:'nobody' } : {}
  const pool = new WslRpcPool(windows ? {} : { launch: (_target, code) => spawn('python3', ['-I','-S','-u','-c',
    (uid === 0 ? 'import os;os.setgroups([]);os.setgid(65534);os.setuid(65534);' : '') + code], {stdio:'pipe'}) })
  t.after(() => pool.dispose())
  const client = new NativeFileClient(pool)
  await assert.rejects(client.read({ ...targetOf(root), ...identity }, `${root}/private`), codeIs('FS_PERMISSION_DENIED'))
  await assert.rejects(client.write({ ...targetOf(root), ...identity }, `${root}/private`, 'bad', undefined, undefined, 1024),
    codeIs('FS_PERMISSION_DENIED'))
  assert.equal(pool.snapshot().launches, 1)
  await python('import os,sys;os.chmod(sys.argv[1],0o600)', [`${root}/private`])
  assert.equal((await readRaw(`${root}/private`)).toString(), 'secret')
})

test('filesystem preset options reach both native and compatibility configurations', async () => {
  const { transformPresetForWsl } = await import('../src/host/variants.ts')
  const text = transformPresetForWsl('', '/shell', '/fs', undefined, '/search', undefined, undefined, undefined,
    { backend:'unc', idleMs:300000, metrics:false, wslPath:'wsl.exe' })
  assert.match(text, /id: fs-wsl\n +name: '\/fs'\n +config:\n +backend: 'unc'\n +idleMs: 300000\n +metrics: false/)
})

test('native auto selects UNC only before target creation on a failed startup, never after dispatch', async t => {
  const { root, cwd } = await fixture(t)
  let launches = 0, fallback = 0
  class Probed extends WslFileSystem {
    async resolveUnc(path) { fallback++; return { targetKey:'unc-test-key', displayPath:path } }
    async lstatUnc() { fallback++; return undefined }
  }
  const p = new Probed(new Context(), { cwd, backend:'auto', diffBasisMaxBytes:1024 },
    { launch: () => { launches++; throw new Error('python missing') } })
  t.after(() => p.wslRpcPool.dispose())
  assert.equal((await p.resolve(`${root}/x`)).targetKey, 'unc-test-key')
  assert.equal(await p.lstat(`${root}/x`), undefined)
  assert.equal(launches, 1, 'failed starts should retain their cooldown')
  assert.equal(fallback, 2)
  const key = { targetKey:nativeKey({distro, path:`${root}/x`}), displayPath:`${root}/x` }
  await assert.rejects(p.writeText(key, 'bad'), /python missing/)
  assert.equal(fallback, 2, 'an observed native target cannot switch to UNC')
})


test('bounded newline sampling preserves the host UTF-16 boundary with non-BMP text', async t => {
  const { fs, root } = await fixture(t)
  const hostData = await hostReference(t), host = hostData.fs
  // A truncated surrogate, CRLF crossing the 4096-code-unit boundary, and
  // opposite newline styles after the sample must all match the actual host.
  const bodies = [
    'a'.repeat(4095) + '🙂\r\n' + 'b\r\n'.repeat(10000),
    '🙂'.repeat(2047) + '\r\n' + 'b\n'.repeat(10000),
    '🙂'.repeat(2047) + 'a\r\n' + 'b\r\n'.repeat(10000),
    'x\r\n'.repeat(1400) + '中\n'.repeat(10000),
  ].map(body => body + 'TOKEN_A0')
  for (const [i, body] of bodies.entries()) {
    const name = 'sample-' + i + '.txt'
    await writeRaw(root + '/' + name, body); await hostData.write(name, body)
    const native = await fs.resolve(name), local = await host.resolve(name)
    const edit = { oldString: 'TOKEN_A0', newString: 'TOKEN_B0', replaceAll: false }
    const [a, b] = await Promise.all([fs.editText(native, edit), host.editText(local, edit)])
    assert.equal(a.before, b.before); assert.equal(a.after, b.after)
    assert.deepEqual(await readRaw(root + '/' + name), await hostData.read(name))
  }
})
