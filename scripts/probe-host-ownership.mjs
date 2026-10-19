// Read-only investigation of the installed test dependencies, never a user profile.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'

const root = new Context()
console.log('CONTEXT API', Object.getOwnPropertyNames(Context.prototype))
console.log('CONTEXT IDENTITY', { rootIsSelf: root.root === root, proto: Object.keys(root),
  extendedRoot: root.extend ? root.extend({}).root === root : undefined })
console.log('SERVICE API', Object.getOwnPropertyNames(Service.prototype))
const req = createRequire(resolve('.host-current/package.json'))
for (const name of ['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-hmr', '@deepseek-ai/cordis']) {
  const file = req.resolve(name)
  const src = readFileSync(file, 'utf8')
  console.log('\nPACKAGE', name, file)
  const patterns = name.endsWith('app-boot') ? ['bootstrapIncludes', 'function pin', 'Include entry', 'set(ctx,', 'async function boot', 'async function start']
    : name.endsWith('hmr') ? ['ownerContext', 'recomposeProfile(', 'async reloadProfile']
    : ['set(name', 'get(name', 'class Service', 'class Context']
  for (const pattern of patterns) {
    let at = src.indexOf(pattern), n = 0
    while (at >= 0 && n++ < 3) {
      console.log('EXCERPT', pattern, '\n' + src.slice(Math.max(0, at - 200), at + 1600))
      at = src.indexOf(pattern, at + pattern.length)
    }
  }
  if (name.endsWith('app-boot')) {
    const module = await import(pathToFileURL(file).href)
    console.log('BOOT EXPORTS', Object.keys(module))
  }
}
const { apply } = await import('../src/host/wsl-search.ts')
const tools = []
// The registry is injected through the real Context service lookup, not a fake ctx.get.
root.set('tools', { register(tool) { tools.push(tool); return () => {} } })
apply(root, { transport: 'auto' })
console.log('SEARCH TOOLS REGISTERED', tools.map(t => t.name))
console.log('DISPOSAL', await root.fiber.dispose())
