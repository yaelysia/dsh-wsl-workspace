import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { randomBytes } from 'node:crypto'
import { RPC_METHODS } from '../src/shared/rpc-metrics.ts'
import { SearchWorkerPool } from '../src/shared/search-transport.ts'
import { readMetadata } from '../src/shared/rpc-files.ts'
import { searchWorkerCode } from '../src/shared/search-worker.ts'
import { GLOB_SCRIPT, GREP_SCRIPT } from '../src/shared/search-scripts.ts'
import { fixture, runBash } from '../scripts/benchmark-search.mjs'

const windows = process.platform === 'win32'
const distro = process.env.WSL_COMPAT_DISTRO || 'Ubuntu'
const target = cwd => ({ wslPath: 'wsl.exe', distro, linuxCwd: cwd })
const request = (op = 'glob', args = ['.', '1000001'], extra = {}) => ({ op, args, timeoutMs: 10_000, maxBytes: 1_000_000, ...extra })
const linuxLaunch = (_, code) => spawn('python3', ['-I', '-S', '-u', '-c', code], { stdio: 'pipe' })
const nativePool = options => new SearchWorkerPool({ ...windows ? {} : { launch: linuxLaunch }, ...options })
const fake = code => () => spawn(process.execPath, ['-e', code], { stdio: 'pipe' })
const ready = `process.stdout.write(JSON.stringify({ready:3,pid:process.pid,methods:${JSON.stringify(RPC_METHODS)}})+'\\n');`
const response = String.raw`JSON.stringify({id:r.id,code:0,aborted:false,stdout:Buffer.from(r.cwd).toString('base64'),stderr:''})+'\n'`
const echo = ready + `require('node:readline').createInterface({input:process.stdin}).on('line',s=>{const r=JSON.parse(s);process.stdout.write(${response})});`

async function eventually(predicate, message, budget = 5000) {
  const until = Date.now() + budget
  while (Date.now() < until) {
    if (await predicate()) return
    await delay(20)
  }
  assert.fail(message)
}
async function grepProcesses(token) {
  const result = await runBash('ps -eo pid,args', [], distro)
  return result.stdout.toString().split('\n').filter(line => /^\s*\d+\s+grep\s/.test(line) && line.includes(token))
}

// Native cases use the actual bundled program and scripts, not a protocol mock.
test('native worker reuses one process and preserves search bytes, cwd and odd filenames', async () => {
  const root = await fixture(40, distro)
  const pool = nativePool()
  try {
    for (const [op, args] of [
      ['glob', [root, '1000001', '*.ts']],
      ['grep', ['needle', '', root, '1000001', '[!.]*.ts']],
      ['grep', ['needle', '', `${root}/src/odd\nname.ts`, '1000001']],
      ['grep', ['no-matches-here', '', root, '1000001']],
      ['grep', ['needle', '*.ts\n*.js', root, '1000001']],
    ]) {
      const baseline = await runBash(op === 'glob' ? GLOB_SCRIPT : GREP_SCRIPT, args, distro)
      const actual = await pool.run(target(root), request(op, args))
      assert.equal(actual.code, baseline.code)
      assert.deepEqual(actual.stdout, baseline.stdout)
      assert.deepEqual(actual.stderr, baseline.stderr)
    }
    const parallel = await Promise.all(['src', 'test', 'src/sub', 'logs'].map(dir =>
      pool.run(target(`${root}/${dir}`), request())))
    for (const [i, dir] of ['src', 'test', 'src/sub', 'logs'].entries()) {
      assert.ok(parallel[i].stdout.toString().startsWith(`G${root}/${dir}\0`))
    }
    assert.equal(pool.snapshot().launches, 1)
  } finally { pool.dispose(); await runBash('rm -rf -- "$1"', [root], distro) }
})

test('native worker preserves invalid-pattern, missing-root and overflow outcomes', async () => {
  const root = await fixture(2, distro)
  const pool = nativePool()
  try {
    const invalid = await pool.run(target(root), request('grep', ['[', '', root, '1000001']))
    assert.equal(invalid.code, 2)
    assert.match(invalid.stderr.toString(), /Invalid|Unmatched/)
    const missing = await pool.run(target(root), request('glob', [`${root}/absent`, '1000001']))
    assert.equal(missing.code, 1)
    assert.match(missing.stderr.toString(), /No such file/)
    const overflow = await pool.run(target(root), request('grep', ['needle', '', root, '129'], { maxBytes: 128 }))
    assert.equal(overflow.stdout.length, 129)
    assert.equal(overflow.aborted, false, 'the extra byte must remain an overflow, not cancellation')
    const unknown = pool.run(target(root), request('execute', ['touch', `${root}/nope`]))
    await assert.rejects(unknown, /invalid or excess/)
    await assert.rejects(pool.run(target(root), request('grep', ['a\0b'])), /invalid or excess/)
    assert.equal((await pool.run(target(root), request())).code, 0)
  } finally { pool.dispose(); await runBash('rm -rf -- "$1"', [root], distro) }
})

test('native cancellation kills the search group, does not block another request and keeps the worker', async () => {
  const root = await fixture(2, distro)
  const pool = nativePool()
  const stop = new AbortController()
  const token = `search_cancel_${randomBytes(6).toString('hex')}`
  try {
    await runBash('mkfifo "$1/wait"', [root], distro)
    await pool.run(target(root), request())
    let finished = false
    const waiting = pool.run(target(root), request('grep', [token, '', `${root}/wait`, '1000001'], { signal: stop.signal }))
      .then(result => { finished = true; return result })
    await eventually(async () => (await grepProcesses(token)).length === 1, 'blocking grep never started')
    assert.equal((await pool.run(target(`${root}/src`), request())).code, 0)
    assert.equal(finished, false, 'the healthy request must not queue behind the blocked grep')
    stop.abort()
    assert.equal((await waiting).aborted, true)
    await eventually(async () => (await grepProcesses(token)).length === 0, 'cancelled grep survived')
    assert.equal((await pool.run(target(root), request())).code, 0)
    assert.equal(pool.snapshot().launches, 1)
  } finally { stop.abort(); pool.dispose(); await runBash('rm -rf -- "$1"', [root], distro) }
})

test('native deadline and provider disposal reap blocked searches', async () => {
  const root = await fixture(1, distro)
  const pool = nativePool()
  const token = `search_timeout_${randomBytes(6).toString('hex')}`
  try {
    await runBash('mkfifo "$1/wait"', [root], distro)
    await pool.run(target(root), request())
    const limited = await pool.run(target(root), request('grep', [token, '', `${root}/wait`, '1000001'], { timeoutMs: 300 }))
    assert.equal(limited.aborted, true)
    await eventually(async () => (await grepProcesses(token)).length === 0, 'timed-out grep survived')
    const waiting = pool.run(target(root), request('grep', [token, '', `${root}/wait`, '1000001']))
    await eventually(async () => (await grepProcesses(token)).length === 1, 'grep did not start')
    pool.dispose()
    assert.equal((await waiting).aborted, true)
    await eventually(async () => (await grepProcesses(token)).length === 0, 'grep survived stdin EOF')
    await assert.rejects(pool.run(target(root), request()), /disposed/)
  } finally { pool.dispose(); await runBash('rm -rf -- "$1"', [root], distro) }
})

test('native pending requests are bounded and queued cancellation does not execute the cancelled grep', async () => {
  const root = await fixture(1, distro)
  const pool = nativePool()
  const controllers = Array.from({length:16}, () => new AbortController())
  const token = `search_queue_${randomBytes(6).toString('hex')}`
  let calls = []
  try {
    await runBash('mkfifo "$1/wait"', [root], distro)
    await pool.run(target(root), request())
    calls = controllers.map((controller, i) => pool.run(target(root), request('grep',
      [`${token}_${i}`, '', `${root}/wait`, '1000001'], { signal: controller.signal })))
    await assert.rejects(pool.run(target(root), request()), /queue is full/)
    await eventually(async () => (await grepProcesses(token)).length === 4, 'worker did not enforce four native jobs')
    controllers[15].abort()
    assert.equal((await calls[15]).aborted, true)
    assert.equal((await grepProcesses(`${token}_15`)).length, 0)
    for (const controller of controllers) controller.abort()
    assert.ok((await Promise.all(calls)).every(result => result.aborted))
    await eventually(async () => (await grepProcesses(token)).length === 0, 'queued jobs survived cancellation')
    assert.equal((await pool.run(target(root), request())).code, 0)
  } finally {
    for (const controller of controllers) controller.abort()
    await Promise.allSettled(calls)
    pool.dispose(); await runBash('rm -rf -- "$1"', [root], distro)
  }
})

test('launch code is single-line ASCII and below the Windows command-line limit', () => {
  const code = searchWorkerCode()
  assert.match(code, /^[\x20-\x7e]+$/)
  assert.ok(code.length < 28_000)
})

test('same identity shares a startup; different user and distribution identities do not', async () => {
  const pool = new SearchWorkerPool({ launch: fake(echo) })
  try {
    const results = await Promise.all(Array.from({length:12}, (_, i) => pool.run(target(`/root/${i}`), request())))
    results.forEach((r, i) => assert.equal(r.stdout.toString(), `/root/${i}`))
    assert.equal(pool.snapshot().launches, 1)
    await pool.run({...target('/'), username:'someone'}, request())
    await pool.run({...target('/'), distro:'another'}, request())
    assert.equal(pool.snapshot().launches, 3)
  } finally { pool.dispose() }
})

test('idle expiry releases workers; LRU replacement does not grow the pool', async () => {
  const pool = new SearchWorkerPool({ launch: fake(echo), idleMs:80, maxWorkers:1 })
  try {
    await pool.run(target('/'), request())
    await pool.run({...target('/'), distro:'other'}, request())
    assert.deepEqual(pool.snapshot(), {workers:1, launches:2})
    await eventually(() => pool.snapshot().workers === 0, 'idle worker was retained')
    await pool.run(target('/'), request())
    assert.equal(pool.snapshot().launches, 3)
  } finally { pool.dispose() }
})

test('missing Python is a startup-only failure, cached before safe fallback', async () => {
  const pool = new SearchWorkerPool({ launch: fake('process.stderr.write("python3 missing");process.exit(127)') })
  let fallbacks = 0
  try {
    for (let i=0;i<3;i++) {
      const r = await pool.runAuto(target('/'), request(), async (remaining, reason) => {
        assert.ok(remaining > 0 && remaining <= 10_000)
        assert.match(reason, /python3 missing/)
        fallbacks++
        return { code:0, stdout:Buffer.from('fallback'), stderr:Buffer.alloc(0), aborted:false, signal:null }
      })
      assert.equal(r.stdout.toString(), 'fallback')
    }
    assert.equal(fallbacks, 3)
    assert.equal(pool.snapshot().launches, 1)
  } finally { pool.dispose() }
})

test('startup timeout consumes the caller deadline; cancelled boot never falls back', async () => {
  const pool = new SearchWorkerPool({ launch: fake('setInterval(()=>{},1000)'), bootMs:50 })
  try {
    await pool.runAuto(target('/'), request('glob', [], {timeoutMs:1000}), async remaining => {
      assert.ok(remaining < 1000 && remaining > 0)
      return {code:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),aborted:false,signal:null}
    })
    const stop = new AbortController(); stop.abort()
    assert.equal((await pool.runAuto(target('/'), request('glob', [], {signal:stop.signal}), () => assert.fail('cancelled fallback'))).aborted, true)
  } finally { pool.dispose() }
})

test('caller cancellation interrupts startup without waiting for the shared boot deadline', async () => {
  const pool = new SearchWorkerPool({ launch: fake('setInterval(()=>{},1000)'), bootMs:5000 })
  const stop = new AbortController()
  try {
    const waiting = pool.run(target('/'), request('glob', [], {signal:stop.signal}))
    stop.abort()
    await assert.rejects(waiting, error => error.code === 'RPC_ABORTED')
  } finally { pool.dispose() }
})

for (const [name, reply] of [
  ['invalid JSON', String.raw`process.stdout.write('not-json\n')`],
  ['unknown id', String.raw`process.stdout.write(JSON.stringify({id:999,code:0,aborted:false,stdout:'',stderr:''})+'\n')`],
  ['oversized frame', `process.stdout.write('x'.repeat(5*1024*1024))`],
  ['broken base64', String.raw`process.stdout.write(JSON.stringify({id:r.id,code:0,aborted:false,stdout:'$bad',stderr:''})+'\n')`],
  ['worker crash', 'process.exit(1)'],
]) {
  test(`in-flight ${name} fails without replay or fallback`, async () => {
    const launch = fake(ready + `require('node:readline').createInterface({input:process.stdin}).on('line',s=>{const r=JSON.parse(s);${reply}})`)
    const pool = new SearchWorkerPool({ launch })
    try {
      await assert.rejects(pool.runAuto(target('/'), request(), () => assert.fail('in-flight fallback')), error => error.stage === 'request')
      assert.equal(pool.snapshot().launches, 1)
    } finally { pool.dispose() }
  })
}

test('fragmented responses retain every byte', async () => {
  const launch = fake(ready + `require('node:readline').createInterface({input:process.stdin}).on('line',s=>{const r=JSON.parse(s);const b=${response};let i=0;const t=setInterval(()=>{process.stdout.write(b.slice(i,i+3));i+=3;if(i>=b.length)clearInterval(t)},1)})`)
  const pool = new SearchWorkerPool({ launch })
  try { assert.equal((await pool.run(target('/中文/line\nbreak'), request())).stdout.toString(), '/中文/line\nbreak') }
  finally { pool.dispose() }
})

test('oversized requests fail before dispatch and an idle worker remains usable', async () => {
  const pool = new SearchWorkerPool({ launch: fake(echo) })
  try {
    await assert.rejects(pool.run(target('/'), request('grep', ['x'.repeat(1_048_576)])), /exceeds its byte limit/)
    assert.equal((await pool.run(target('/'), request())).code, 0)
  } finally { pool.dispose() }
})

test('synchronous launch failure is eligible for startup fallback', async () => {
  const pool = new SearchWorkerPool({launch: () => {throw new Error('spawn denied')}})
  try {
    const actual = await pool.runAuto(target('/'), request(), async (_, reason) => {
      assert.match(reason, /spawn denied/)
      return {code:0,stdout:Buffer.from('safe'),stderr:Buffer.alloc(0),aborted:false,signal:null}
    })
    assert.equal(actual.stdout.toString(), 'safe')
  } finally {pool.dispose()}
})

test('dead workers recover only for a new request, never by replaying the failed one', async () => {
  let n = 0
  const pool = new SearchWorkerPool({launch: (...args) => (++n === 1 ?
    fake(ready + `process.stdin.once('data',()=>process.exit(2))`) : fake(echo))(...args)})
  try {
    await assert.rejects(pool.run(target('/'), request()), error => error.stage === 'request')
    assert.equal((await pool.run(target('/new-request'), request())).stdout.toString(), '/new-request')
    assert.equal(pool.snapshot().launches, 2)
  } finally {pool.dispose()}
})

test('native search arguments cannot execute shell substitutions', async () => {
  const root = await fixture(1, distro)
  const pool = nativePool()
  try {
    await pool.run(target(root), request('grep', [`$(touch ${root}/injected)`, '', root, '1000001']))
    assert.equal((await runBash('test ! -e "$1/injected"', [root], distro)).code, 0)
  } finally {pool.dispose(); await runBash('rm -rf -- "$1"', [root], distro)}
})


test('search and batched metadata share one RPC process and preserve individual path errors', async () => {
  const root = await fixture(1, distro)
  const pool = nativePool()
  try {
    await runBash('ln -s "src/odd\nname.ts" "$1/alias"', [root], distro)
    await pool.run(target(root), request())
    const paths = [root, `${root}/src/odd\nname.ts`, `${root}/alias`, `${root}/missing`]
    const rows = await readMetadata(pool, target(root), paths)
    assert.deepEqual(rows.map(row=>row.path),paths)
    assert.equal(rows[0].kind,'directory')
    assert.equal(rows[1].kind,'file')
    assert.equal(rows[2].symlink,true)
    assert.equal(rows[2].realpath,rows[1].realpath)
    assert.equal(rows[2].inode,rows[1].inode)
    assert.equal(rows[3].error,'ENOENT')
    assert.equal(pool.snapshot().launches,1)
    const stats = pool.diagnostics()
    assert.equal(stats.idleMs,120000)
    assert.equal(stats.metrics.stages['rpc.fs.metadata.total'].count,1)
    assert.equal(stats.metrics.stages['rpc.glob.execute'].samples,1)
    assert.ok(!JSON.stringify(stats).includes(root), 'diagnostics leaked a path')
    await assert.rejects(readMetadata(pool,target(root),['relative']),/absolute/)
    await assert.rejects(readMetadata(pool,target(root),Array(65).fill(root)),/1-64/)
    assert.equal(pool.snapshot().launches,1)
  } finally { pool.dispose(); await runBash('rm -rf -- "$1"',[root],distro) }
})

test('metadata remains cancellable and does not silently accept a malformed result', async () => {
  const pool = new SearchWorkerPool({launch:fake(echo)})
  try {
    await assert.rejects(readMetadata(pool,target('/'),['/']),/invalid metadata/)
    const controller = new AbortController(); controller.abort()
    await assert.rejects(readMetadata(pool,target('/'),['/'],{signal:controller.signal}), e=>e.code==='RPC_ABORTED')
  } finally {pool.dispose()}
})

test('active calls survive idle timeout; idle expiry and LRU eviction have separate counters', async () => {
  const delayed = ready + `require('node:readline').createInterface({input:process.stdin}).on('line',s=>{const r=JSON.parse(s);setTimeout(()=>process.stdout.write(${response}),140)})`
  const pool = new SearchWorkerPool({launch:fake(delayed),idleMs:60,maxWorkers:1})
  try {
    const pending = pool.run(target('/'),request())
    await delay(90)
    assert.equal(pool.snapshot().workers,1)
    assert.equal(pool.diagnostics().pending,1)
    assert.equal((await pending).code,0)
    await pool.run({...target('/'),distro:'other'},request())
    assert.equal(pool.diagnostics().lruReleases,1)
    assert.equal(pool.diagnostics().idleReleases,0)
    await eventually(()=>pool.snapshot().workers===0,'idle timeout did not release worker')
    assert.equal(pool.diagnostics().idleReleases,1)
  } finally {pool.dispose()}
})

test('successive requests reset the idle deadline rather than rebuilding between gaps', async () => {
  const pool = new SearchWorkerPool({launch:fake(echo),idleMs:160})
  try {
    for(let i=0;i<3;i++) { await pool.run(target('/'),request()); await delay(65) }
    assert.equal(pool.snapshot().launches,1)
    await eventually(()=>pool.snapshot().workers===0,'idle worker did not expire')
    await pool.run(target('/'),request())
    assert.equal(pool.snapshot().launches,2)
  } finally {pool.dispose()}
})

test('old protocols fail before dispatch and auto falls back only once per call', async () => {
  const pool = new SearchWorkerPool({launch:fake(String.raw`process.stdout.write('{"ready":1,"pid":1}\n');setInterval(()=>{},1000)`)})
  try {
    await pool.runAuto(target('/'),request(),async()=>({code:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),aborted:false,signal:null}))
    assert.equal(pool.diagnostics().fallbacks,1)
    assert.equal(pool.snapshot().launches,1)
  } finally {pool.dispose()}
})

test('wire timing does not require synchronized clocks and metrics can be disabled', async () => {
  const root=await fixture(1,distro)
  const pool=nativePool({metrics:false})
  try {
    const result=await pool.run(target(root),request())
    for(const field of ['readyMs','roundTripMs','queueMs','executionMs']) assert.ok(result.timing[field]>=0)
    assert.deepEqual(pool.diagnostics().metrics.stages,{})
  } finally {pool.dispose();await runBash('rm -rf -- "$1"',[root],distro)}
})

// File transactions keep their cancellable process isolation, but reuse a warm
// Linux interpreter instead of paying imports/startup again for every stat/read.
test('native file executors reuse interpreters and reset mutation state between requests', async () => {
  const { NativeFileClient } = await import('../src/shared/native-files.ts')
  const root = await fixture(2, distro), where = target(root), pool = nativePool()
  const files = new NativeFileClient(pool)
  try {
    const first = await files.resolve(where, '/proc/self')
    assert.match(first, /^\/proc\/\d+$/)
    for (let i = 0; i < 10; i++) assert.equal(await files.resolve(where, '/proc/self'), first)
    const written = await files.write(where, `${root}/reused.txt`, 'alpha\r\n', { kind:'createIfAbsent' }, undefined, 1024)
    assert.equal((await files.read(where, `${root}/reused.txt`)).toString(), 'alpha\r\n')
    await assert.rejects(files.write(where, `${root}/reused.txt`, 'forbidden', undefined,
      { mode:'read-only', roots:[] }, 1024), error => error.code === 'FS_SANDBOX_DENIED')
    assert.equal((await files.stat(where, `${root}/reused.txt`)).version, written.version)
    assert.equal(await files.resolve(where, '/proc/self'), first, 'ordinary failures must reset state without replacing the interpreter')
    await pool.run(target(`${root}/src`), request())
    assert.equal(await files.resolve(target(`${root}/src`), '/proc/self/cwd'), `${root}/src`)
    assert.equal(await files.resolve(where, '/proc/self/cwd'), root)
  } finally { pool.dispose(); await runBash('rm -rf -- "$1"', [root], distro) }
})

test('native executor frames preserve large replies and an overflow cannot poison the next call', async () => {
  const { NativeFileClient } = await import('../src/shared/native-files.ts')
  const root = await fixture(1, distro), where = target(root), pool = nativePool()
  const files = new NativeFileClient(pool)
  try {
    const body = '🙂中文\\\n'.repeat(50000)
    await files.write(where, `${root}/large.txt`, body, undefined, undefined, 1024)
    assert.equal((await files.read(where, `${root}/large.txt`)).toString(), body)
    const overflow = await pool.run(where, request('fs.read', [JSON.stringify({path:`${root}/large.txt`,maxBytes:16*1024*1024})], {maxBytes:128}))
    assert.equal(overflow.stdout.length, 129)
    assert.equal(overflow.aborted, false)
    assert.equal((await files.read(where, `${root}/large.txt`)).toString(), body)
    assert.equal(pool.snapshot().launches, 1, 'only the private executor is retired, not the WSL connection')
  } finally { pool.dispose(); await runBash('rm -rf -- "$1"', [root], distro) }
})

test('pool disposal reaps warm native executors, including idle interpreters', async () => {
  const { NativeFileClient } = await import('../src/shared/native-files.ts')
  const root = await fixture(1, distro), pool = nativePool(), files = new NativeFileClient(pool)
  try {
    const ids = new Set(await Promise.all(Array.from({length:8}, () => files.resolve(target(root), '/proc/self'))))
    assert.ok(ids.size <= 4 && ids.size >= 1, 'native executors share the four-slot admission bound')
    pool.dispose()
    for (const proc of ids) {
      await eventually(async () => (await runBash('test ! -d "$1"', [proc], distro)).code === 0,
        `warm executor ${proc} survived provider disposal`)
    }
  } finally { pool.dispose(); await runBash('rm -rf -- "$1"', [root], distro) }
})
