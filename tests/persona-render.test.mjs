/** Render the plugin's actual generated personas with the installed host renderer.
 * Run after ci/install-pinned.mjs; an alternate umbrella tree may be supplied via
 * DSH_WSL_PROMPT_HOST_DIR. No model call, WSL process or user profile is involved.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const hostRoot = resolve(process.env.DSH_WSL_PROMPT_HOST_DIR ?? join(root, 'ci', 'deps'))
const hostRequire = createRequire(join(hostRoot, 'package.json'))
const promptEntry = hostRequire.resolve('@deepseek-ai/dsh-system-prompt')
const { renderPrompt } = await import(pathToFileURL(promptEntry).href)
assert.equal(typeof renderPrompt, 'function', 'use the real host renderer, never a permissive replacement')
const manifest = JSON.parse(readFileSync(join(dirname(promptEntry), '..', 'package.json'), 'utf8'))
assert.equal(manifest.name, '@deepseek-ai/dsh-system-prompt')
if (process.env.DSH_WSL_PROMPT_EXPECT_VERSION) {
  assert.equal(manifest.version, process.env.DSH_WSL_PROMPT_EXPECT_VERSION)
}
console.log(`persona renderer: ${manifest.name}@${manifest.version}`)

const variables = { provider: 'fixture-provider', model: 'fixture-model' }
function render(text, field = 'prefix') {
  return renderPrompt({
    sections: [{ name: `deployment:persona-${field}`, text }],
    contexts: [], tools: [], variables,
  })
}
const unknownCwd = /unknown prompt variable "\{\{cwd\}\}"/

test('negative control: the installed renderer rejects an unregistered cwd', () => {
  assert.throws(() => render('Your working directory {{cwd}} is inside a WSL.'), unknownCwd)
})

const fixtures = []
for (const field of ['prefix', 'suffix', 'text']) {
  for (const block of [false, true]) {
    const id = `${field}-${block ? 'block' : 'inline'}`
    const text = 'Model {{model}} from {{provider}}.'
    fixtures.push({ id, field, content: `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    ${field}: ${block ? `>-\n      ${text}` : text}

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
` })
  }
}
fixtures.push({ id: 'complete', field: 'text', complete: true, content: `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: Model {{model}} from {{provider}}.
    complete: true
` })

// Real apply() generates the registered rows on both planes. Only the roster and
// effect lifecycle are fixtures; prompt interpolation is the unmodified host's.
for (const plane of ['src', 'lib']) {
  test(`${plane}: all generated persona shapes render with provider/model only`, { timeout: 25_000 }, async t => {
    const { apply } = await import(new URL(plane === 'src' ? '../src/index.ts' : '../lib/index.js', import.meta.url))
    const home = mkdtempSync(join(tmpdir(), 'dsh-persona-render-'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const disposers = []
    const registered = new Map()
    let published
    const ready = new Promise(resolveReady => { published = resolveReady })
    const presets = {
      list: async () => fixtures.map(row => ({ id: row.id, name: row.id })),
      readDocument: async id => ({ agentPreset: id, content: fixtures.find(row => row.id === id).content }),
      register: async definition => {
        registered.set(definition.id, definition)
        if (registered.size === fixtures.length) published()
        return () => { registered.delete(definition.id) }
      },
    }
    const ctx = {
      get: key => key === 'agentPresets' ? presets
        : key === 'webServer' ? { register: () => () => {} } : undefined,
      effect: fn => {
        const dispose = fn()
        if (typeof dispose === 'function') disposers.push(dispose)
        return () => {}
      },
    }
    t.after(async () => {
      try { for (const dispose of disposers.reverse()) await dispose() }
      finally {
        if (previousHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousHome
        rmSync(home, { recursive: true, force: true })
      }
    })
    let timer
    try {
      apply(ctx, {})
      await Promise.race([ready, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${plane}: persona declarations did not complete`)), 20_000)
      })])
    } finally { clearTimeout(timer) }
    assert.equal(registered.size, fixtures.length)
    for (const fixture of fixtures) {
      const persona = registered.get(`wsl-${fixture.id}`).plugins.find(row => row.id === 'persona')
      assert.ok(persona, `${plane}/${fixture.id}: persona retained`)
      const text = persona.config[fixture.field]
      const result = render(text, fixture.field === 'text' ? 'prefix' : fixture.field)
      assert.ok(result.includes('fixture-model') && result.includes('fixture-provider'))
      if (fixture.complete) {
        assert.equal(persona.config.complete, true)
        assert.ok(!result.includes('inside a WSL'), 'complete persona remains untouched')
      } else {
        assert.ok(result.includes('Your working directory is inside a WSL'))
        assert.ok(result.includes('file read/write/edit tools use Linux paths'))
        assert.ok(result.includes('/mnt/<drive>'))
        // Restore the original defect in the generated text, not a synthetic renderer.
        const broken = text.replace('Your working directory is inside a WSL', 'Your working directory {{cwd}} is inside a WSL')
        assert.notEqual(broken, text)
        assert.throws(() => render(broken), unknownCwd, `${plane}/${fixture.id}: regression sentinel`)
      }
    }
    console.log(`persona render OK: ${plane}, ${fixtures.length} shapes, provider/model only`)
  })
}
