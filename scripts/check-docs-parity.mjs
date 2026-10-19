#!/usr/bin/env node
// Documentation gate for the independently maintained fork.
// Verify current install/source/attribution contracts and links without forcing
// the upstream README's historical layout or translating a large release ledger.
//
// node scripts/check-docs-parity.mjs [--root DIR]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const arg = process.argv.indexOf('--root')
const root = arg > 0 ? path.resolve(process.argv[arg + 1]) : path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const FORK = 'https://github.com/yaelysia/dsh-wsl-workspace'
const ORIGINAL = 'https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace'
const INSTALL = 'git+https://github.com/yaelysia/dsh-wsl-workspace.git#main'

// Each language has its own editorial structure. All nine pages are written
// for THIS fork; the seven short translations refer to the maintained full
// English/Chinese guides rather than preserving obsolete upstream install text.
const PAGES = {
  'README.md': [
    '## What this fork does', '## Requirements', '## Install',
    '## Create your first WSL workspace', '## Configuration', '## Diagnostics',
    '## Compatibility', '## Limits and recovery', '## Documentation',
    '## Origin and license',
  ],
  'README.zh.md': [
    '## 这个版本能做什么', '## 运行要求', '## 安装与更新', '## 开始使用',
    '## 配置', '## 性能与诊断', '## 兼容性', '## 已知边界',
    '## 相关文档', '## 原项目与许可',
  ],
  'README.ja.md': ['## 必要なもの', '## インストール', '## 使い方', '## 元プロジェクトとライセンス'],
  'README.ko.md': ['## 요구 사항', '## 설치', '## 사용 방법', '## 원본 프로젝트 및 라이선스'],
  'README.fr.md': ['## Prérequis', '## Installation', '## Utilisation', '## Projet d’origine et licence'],
  'README.de.md': ['## Voraussetzungen', '## Installation', '## Verwendung', '## Ursprungsprojekt und Lizenz'],
  'README.es.md': ['## Requisitos', '## Instalación', '## Uso', '## Proyecto original y licencia'],
  'README.pt.md': ['## Requisitos', '## Instalação', '## Como usar', '## Origem e licença'],
  'README.ru.md': ['## Требования', '## Установка', '## Использование', '## Исходный проект и лицензия'],
}
const FULL = new Map([['README.md','## Compatibility'], ['README.zh.md','## 兼容性']])
const REQUIRE_EVERYWHERE = [
  FORK, ORIGINAL, INSTALL,
  'README.md', 'README.zh.md', 'python3',
  '/mnt/c/', 'grep', 'glob', '[LICENSE](LICENSE)', '[NOTICE](NOTICE)',
]
const REQUIRE_FULL = [
  'fileBackend', 'searchTransport', 'searchIdleMs', 'searchMetrics',
  '120000', '{"method":"performance"}', '16 MiB',
  'docs/README.md', 'TESTING.md', 'CHECKPOINT.md', 'CHANGELOG.md',
]

const red = [], green = []
const fail = x => red.push(x)
const pass = x => green.push(x)
const exists = filename => fs.existsSync(path.join(root, filename))
const read = filename => fs.readFileSync(path.join(root, filename), 'utf8')
const manifest = JSON.parse(read('package.json'))
const declared = Object.keys(manifest.dsh.compatibility.dshReleases).sort()
const expectedRepo = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(manifest.repository.url)?.[1]
if (expectedRepo !== 'yaelysia/dsh-wsl-workspace') fail('package.json repository URL disagrees with this fork')

function sectionBody(text, heading) {
  const lines = text.split('\n')
  const start = lines.indexOf(heading)
  if (start < 0) return null
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start + 1, next < 0 ? lines.length : next).join('\n')
}

for (const [filename, expected] of Object.entries(PAGES)) {
  if (!exists(filename)) { fail(`${filename}: missing`); continue }
  const before = red.length
  const text = read(filename)
  const headings = text.split('\n').filter(line => line.startsWith('## '))
  if (JSON.stringify(headings) !== JSON.stringify(expected)) {
    fail(`${filename}: sections differ from the current fork's documented layout`)
  }
  for (const token of REQUIRE_EVERYWHERE) {
    if (!text.includes(token)) fail(`${filename}: missing ${token}`)
  }
  if (/dsh\.so\/badge|raw\.githubusercontent\.com\/dsh-wsl-workspace-maintainers\//.test(text)) {
    fail(`${filename}: obsolete upstream badge or hosted image remains`)
  }
  if (/^\s*dsh plugin(?:\s+--profile\s+\S+)?\s+add\s+dsh-wsl-workspace\s*$/m.test(text)) {
    fail(`${filename}: recommends the upstream npm name instead of the fork`)
  }
  if (!text.includes('MIT')) fail(`${filename}: missing license name`)
  if (FULL.has(filename)) {
    for (const token of REQUIRE_FULL) if (!text.includes(token)) fail(`${filename}: missing ${token}`)
    const compatibility = sectionBody(text, FULL.get(filename))
    if (compatibility === null) {
      fail(`${filename}: compatibility section absent`)
    } else {
      const listed = [...new Set([...compatibility.matchAll(/`([^`]+)`/g)].map(m=>m[1]).filter(x=>/^0\.\d+\.\d+/.test(x)))].sort()
      if (listed.join('|') !== declared.join('|')) fail(`${filename}: compatibility list != package.json declaration`)
    }
  } else {
    if (!text.includes('[English](README.md)') || !text.includes('[简体中文](README.zh.md)')) {
      fail(`${filename}: concise translation must point to the full guides`)
    }
  }
  if (red.length === before) pass(`${filename}: correct fork identity, installation and structure`)
}

function markdownFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const found = path.join(dir, entry.name)
    if (entry.isDirectory()) markdownFiles(found, acc)
    else if (entry.name.endsWith('.md')) acc.push(found)
  }
  return acc
}

let links = 0
for (const file of markdownFiles(root)) {
  const archived = file.includes(`${path.sep}archive${path.sep}`)
  for (const hit of fs.readFileSync(file, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = hit[1]
    if (/^(?:https?:|mailto:|#)/.test(target)) continue
    if (archived && !target.includes('../')) continue
    links++
    const pathname = decodeURIComponent(target.split('#')[0])
    if (!fs.existsSync(path.resolve(path.dirname(file), pathname))) {
      fail(`${path.relative(root, file)}: broken relative link ${target}`)
    }
  }
}
if (links === 0) fail('no relative Markdown links checked')
else pass(`${links} relative Markdown links inspected`)

function changeVersions(filename) {
  return exists(filename) ? [...read(filename).matchAll(/^## (0\.[^\s—]+) —/gm)].map(m=>m[1]) : null
}
const en = changeVersions('CHANGELOG.md')
const zh = changeVersions('CHANGELOG.zh.md')
if (!en || !zh || en.join('|') !== zh.join('|') || en[0] !== manifest.version) {
  fail('English/Chinese CHANGELOG versions disagree with each other or package.json')
} else {
  pass(`${en.length} CHANGELOG releases agree with package.json`)
}

for (const message of green) console.log('  ok   ' + message)
for (const message of red) console.log('  RED  ' + message)
console.log(red.length ? `docs-parity: ${red.length} RED, ${green.length} ok` : `docs-parity: all ${green.length} checks green`)
process.exit(red.length ? 1 : 0)
