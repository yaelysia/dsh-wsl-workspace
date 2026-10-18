// Isolated host investigation. Uses an empty temporary profile, never the user's DSH_HOME.
// A successful candidate check is not a fix deployed into Desktop.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const hostRoot = resolve(process.env.DSH_WSL_RELOAD_HOST_DIR || '.host-current')
const require = createRequire(join(hostRoot, 'package.json'))
const bootPath = require.resolve('@deepseek-ai/dsh-app-boot')
const { Service } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const bootUrl = pathToFileURL(bootPath).href
const boot = await import(bootUrl)
const temporary = mkdtempSync(join(tmpdir(), 'dsh-root-include-'))
const scopes = []
let candidatePath
const result = { package: '@deepseek-ai/dsh-app-boot', version: JSON.parse(readFileSync(join(dirname(bootPath), '../package.json'), 'utf8')).version }
try {
  const config = join(temporary, 'cordis.yml')
  writeFileSync(config, '[]\n')
  const ctx = await boot.boot('fixture', config, [])
  scopes.push(ctx)
  const include = ctx.loader.resolve('include')
  assert.ok(include)
  await boot.recomposeProfile(ctx, [], 'fixture')
  result.sameModule = 'pass'
  class ReloadCaller extends Service {
    constructor(scope) { super(scope, 'reloadCaller'); this.owner = scope }
    async reload() {
      const same = this.owner.root === ctx
      await boot.recomposeProfile(this.owner.root, [], 'fixture')
      return same
    }
  }
  await ctx.plugin(ReloadCaller)
  try { result.serviceCall = { status: 'pass', sameRoot: await ctx.get('reloadCaller').reload() } }
  catch (error) { result.serviceCall = { status: 'error', message: error.message } }

  const duplicate = await import(bootUrl + '?known-issues-duplicate')
  await assert.rejects(duplicate.recomposeProfile(ctx, [], 'fixture'), /profile reload requires the root Include entry/)
  result.separateModule = 'reproduces exact root-Include error'
  assert.equal(ctx.loader.resolve('include'), include, 'rejected reload must not replace the root Include')

  // Candidate for the HOST maintainers: attach the exact boot registration to the
  // root object with a stable symbol, rather than keeping it in one module's WeakMap.
  // This does not find/create an arbitrary Include or relax activation validation.
  const original = readFileSync(bootPath, 'utf8')
  const declaration = /const bootstrapIncludes =[^\n]*new WeakMap\(\);?/
  assert.equal((original.match(new RegExp(declaration.source, 'g')) || []).length, 1)
  let candidate = original.replace(declaration, `const ROOT_INCLUDE = Symbol.for('deepseek.harness.root-include.test-candidate');\nconst bootstrapIncludes = {\n  get(ctx) { return Object.getOwnPropertyDescriptor(ctx.root, ROOT_INCLUDE)?.value; },\n  set(ctx, entry) {\n    const root = ctx.root;\n    const previous = this.get(root);\n    if (previous && previous !== entry) throw new Error('conflicting root Include registration');\n    Object.defineProperty(root, ROOT_INCLUDE, { value: entry, configurable: true });\n    root.effect(() => () => {\n      if (Object.getOwnPropertyDescriptor(root, ROOT_INCLUDE)?.value === entry) delete root[ROOT_INCLUDE];\n    });\n    return this;\n  }\n};`)
  candidatePath = join(dirname(bootPath), '__root-include-candidate.mjs')
  writeFileSync(candidatePath, candidate, { flag: 'wx' })
  const candidateUrl = pathToFileURL(candidatePath).href
  const fixed = await import(candidateUrl)
  const fixedDuplicate = await import(candidateUrl + '?second-instance')
  const first = await fixed.boot('fixture', config, [])
  const second = await fixed.boot('fixture', config, [])
  scopes.push(first, second)
  const firstInclude = first.loader.resolve('include')
  const secondInclude = second.loader.resolve('include')
  await fixedDuplicate.recomposeProfile(first, [], 'fixture')
  await fixedDuplicate.recomposeProfile(second, [], 'fixture')
  assert.equal(first.loader.resolve('include'), firstInclude)
  assert.equal(second.loader.resolve('include'), secondInclude)
  assert.notEqual(firstInclude, secondInclude)
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
  const unbooted = new Context(); scopes.push(unbooted)
  await assert.rejects(fixedDuplicate.recomposeProfile(unbooted, [], 'fixture'), /profile reload requires the root Include entry/)
  await first.fiber.dispose()
  await assert.rejects(fixedDuplicate.recomposeProfile(first, [], 'fixture'), /profile reload requires the root Include entry/)
  result.candidate = 'two module evaluations and two roots pass; absent/disposed roots still reject'
  result.limit = 'isolated host mechanism reproduction and candidate only; no Desktop runtime/profile files changed'
  console.log(JSON.stringify(result, null, 2))
} finally {
  for (const ctx of scopes.reverse()) await ctx.fiber.dispose()
  if (candidatePath) rmSync(candidatePath, { force: true })
  rmSync(temporary, { recursive: true, force: true })
}
