// Temporary, reviewed build transform. Never runs in a user's installed plugin.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const read = path => readFileSync(path, 'utf8')
const write = (path, text) => writeFileSync(path, text, 'utf8')
function once(text, before, after) {
  assert.equal(text.split(before).length - 1, 1, `expected one exact occurrence: ${before}`)
  return text.replace(before, after)
}
function checked(path, sha) {
  const data = readFileSync(path)
  assert.equal(createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'), sha, path)
  return data.toString('utf8')
}
let text = checked('src/client/locales.ts', '45194e2f0c4244d7d773f8eec3be93d9d5746380')
text = once(text, '并按扫描根缓存 10 秒', '按扫描根缓存并由变更检测失效')
text = once(text, 'and cached per scan root for 10 seconds', 'with a per-root cache invalidated by change detection')
text = once(text, 'bash 本身没有 run_in_background 参数，传了会被忽略。', '默认会话 bash 也支持 run_in_background: true；后台任务仍通过 job_list / job_output / job_kill 管理。')
text = once(text, '`bash` itself has no run_in_background parameter and ignores one;', 'The default session `bash` also supports run_in_background: true for tracked background jobs;')
text = once(text, '上方是这份构建声明兼容的 DSH 版本，每一条都在隔离实例上实测过（独立 DSH_HOME、依赖固定到该版本、跑满整套门禁，含真实 ConPTY 下的持久 shell）。', '上方列出继承的宿主兼容声明，不代表当前新增功能已在每个历史版本重测。原生文件、常驻搜索及 Desktop 的实际验证范围见本仓库 README 与 CHECKPOINT.md。')
text = once(text, 'The chips above are the DSH releases this build declares, each verified on an isolated instance (own DSH_HOME, dependencies pinned to that release, full check suite).', 'The chips above are inherited host compatibility declarations, not fresh verification of every new feature on every historical release. See this repository README and CHECKPOINT.md for native-file, persistent-search and Desktop validation scope.')
text = once(text, '因此那种调用会先扫描全部文件再筛。', '完整路径仍作精确筛选，安全模式先在 WSL 按文件名预筛选；复杂模式保留原路径。')
text = once(text, 'so that call scans every file first.', 'with safe filename prefilters applied inside WSL before exact path filtering; complex patterns retain the original path.')
text = once(text, 'bash 与文件工具的 shell 都在发行版内运行、不受 DSH 文件策略约束；文件工具（read/write/edit）受策略约束，工作区内修改模式下只能写工作区内。', 'bash 在发行版内执行命令；原生文件工具（read/write/edit）遵守文件策略，工作区内修改模式下只能写获准的工作区路径。原生文件策略不是 Linux 命令执行的完整操作系统沙箱。')
text = once(text, "Both it and the file tools\\' shell run inside the distribution, outside the DSH file policy; read/write/edit are inside it, and workspace-write only writes inside the workspace.", 'Bash executes commands inside the distribution. Native read/write/edit honor the file policy; workspace-write permits only authorized workspace paths. Native file policy is not a complete OS sandbox for Linux commands.')
write('src/client/locales.ts', text)

text = checked('tests/parity/claims.mjs', '1878689402d91a12c913d26a8e758412cd9a56ee')
for (const id of ['panel-denies-run-in-background', 'panel-claims-a-ten-second-cache']) {
  const begin = text.indexOf(`id: '${id}'`)
  assert.ok(begin >= 0)
  const debt = text.indexOf('    debt: {', begin)
  const run = text.indexOf('    async run()', debt)
  assert.ok(debt > begin && run > debt && !text.slice(debt, run).includes('defineClaim('))
  text = text.slice(0, debt) + '    // Repaired in CP7; keep the claim as a required regression, not an allowed failure.\n' + text.slice(run)
}
write('tests/parity/claims.mjs', text)

write('scripts/doc-claim-verdicts.mjs', `// One classifier shared by the documentation gate and its synthetic controls.
export function classifyObservations(observations) {
  return {
    held: observations.filter(o => !o.declared && o.evaluated && o.ok),
    owed: observations.filter(o => o.declared && o.evaluated && !o.ok),
    paid: observations.filter(o => o.declared && o.evaluated && o.ok),
    regressions: observations.filter(o => !o.declared && o.evaluated && !o.ok),
    unevaluable: observations.filter(o => !o.evaluated),
  }
}
`)
text = checked('scripts/run-docs-claims.mjs', 'f05698240e501ec92847a2ffaaa86cc56d37b56e')
text = once(text, "import { writeFileSync } from 'node:fs'", "import { writeFileSync } from 'node:fs'\nimport { classifyObservations } from './doc-claim-verdicts.mjs'")
const begin = text.indexOf('const declared = observations.filter')
const end = text.indexOf('console.log(`docs-claims:', begin)
assert.ok(begin >= 0 && end > begin)
text = text.slice(0, begin) + 'const undeclared = observations.filter(o => !o.declared)\nconst { owed, paid, regressions, unevaluable } = classifyObservations(observations)\n\n' + text.slice(end)
write('scripts/run-docs-claims.mjs', text)

text = checked('tests/docs-debt.test.mjs', '88774fefd5b25bc01b029c0b3bf7ccd0de752af5')
text = once(text, "import assert from 'node:assert/strict'", "import assert from 'node:assert/strict'\nimport { classifyObservations } from '../scripts/doc-claim-verdicts.mjs'")
text = once(text, "test('both halves of the registry are populated', () => {", "test('all applicable claims are accounted for even when no debt remains', () => {")
text = once(text, "  assert.ok(DECLARED_RED_CLAIMS.length >= 1,\n    'no declared red is registered, so the runner\\'s owed/retired arithmetic is never exercised')", "  assert.equal(GREEN_CLAIMS.length + DECLARED_RED_CLAIMS.length, CHECKED.length)")
const tail = text.indexOf("test('the four outcomes a claim can have are all reachable from this registry'")
assert.ok(tail > 0)
text = text.slice(0, tail) + `test('the real gate classifier rejects regressions, paid declarations and unevaluated claims', () => {
  const rows = [
    { id: 'held', declared: false, evaluated: true, ok: true },
    { id: 'regression', declared: false, evaluated: true, ok: false },
    { id: 'owed', declared: true, evaluated: true, ok: false },
    { id: 'paid', declared: true, evaluated: true, ok: true },
    { id: 'unreadable', declared: true, evaluated: false, ok: false },
    { id: 'unreadable-new', declared: false, evaluated: false, ok: false },
  ]
  const actual = classifyObservations(rows)
  assert.deepEqual(Object.fromEntries(Object.entries(actual).map(([key, values]) => [key, values.map(x => x.id)])), {
    held: ['held'], owed: ['owed'], paid: ['paid'], regressions: ['regression'],
    unevaluable: ['unreadable', 'unreadable-new'],
  })
  assert.equal(classifyObservations(rows.slice(0, 1)).held.length, 1)
})

test('any remaining declared debt is evaluated and genuinely failing', async () => {
  for (const claim of DECLARED_RED_CLAIMS) {
    const verdict = await claim.run()
    assert.notEqual(verdict.evaluated, false, claim.id)
    assert.equal(verdict.ok, false, 'retire paid declaration: ' + claim.id)
  }
})

test('repaired help statements are required and cannot silently become allowed failures', async () => {
  for (const id of ['panel-denies-run-in-background', 'panel-claims-a-ten-second-cache']) {
    const claim = GREEN_CLAIMS.find(item => item.id === id)
    assert.ok(claim, 'missing required claim: ' + id)
    assert.equal((await claim.run()).ok, true, id)
  }
  for (const dict of [zh, en]) {
    assert.match(dict['help.usage.body'], /run_in_background: true/)
    assert.match(dict['help.compat.body'], /CHECKPOINT\\.md/)
  }
})
`
// Tests of error accounting no longer require retaining a known product defect.
text = text.replace('so the\n *     count is asserted to be non-zero *and*', 'so explicit synthetic observations exercise')
write('tests/docs-debt.test.mjs', text)

const pkg = JSON.parse(read('package.json'))
pkg.scripts['test:confine-probe'] = 'node --experimental-strip-types tests/support/w78-confine-probe.mjs'
write('package.json', JSON.stringify(pkg, null, 2) + '\n')
console.log('Applied exact reviewed help and gate corrections; no filesystem or RPC mutation policy changed.')
