/** Host read-card language hints adapted from DeepSeek Harness's MIT licensed
 * @deepseek-ai/dsh-util-code-language. Keep the persisted short identifiers
 * byte-compatible without importing another Cordis peer dependency tree.
 */
const EXTENSIONS: Readonly<Record<string, string>> = {
  ts: 'ts mts cts',
  tsx: 'tsx',
  js: 'js mjs cjs',
  jsx: 'jsx',
  sh: 'sh bash zsh',
  fish: 'fish',
  json: 'json jsonc jsonl ndjson ipynb',
  csv: 'csv',
  py: 'py pyw pyi',
  rb: 'rb rake gemspec',
  go: 'go',
  rs: 'rs',
  java: 'java',
  c: 'c h',
  cpp: 'cc cpp cxx hh hpp hxx',
  cs: 'cs',
  kotlin: 'kt kts',
  swift: 'swift',
  php: 'php',
  yaml: 'yaml yml',
  toml: 'toml',
  ini: 'ini conf cfg properties',
  env: 'env',
  log: 'log',
  diff: 'diff patch',
  http: 'http',
  md: 'md markdown',
  mdx: 'mdx',
  rst: 'rst',
  tex: 'tex sty cls',
  bib: 'bib',
  adoc: 'adoc',
  html: 'html htm xhtml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  xml: 'xml xsd xsl xslt plist svg',
  lua: 'lua',
  bat: 'bat cmd',
  ps1: 'ps1 psm1 psd1',
  r: 'r',
  jl: 'jl',
  dart: 'dart',
  scala: 'scala',
  clj: 'clj cljs edn',
  erl: 'erl hrl',
  ex: 'ex exs',
  hs: 'hs',
  fs: 'fs fsi fsx',
  vb: 'vb',
  pl: 'pl pm',
  v: 'v',
  sv: 'sv svh',
  graphql: 'graphql gql',
  proto: 'proto',
  tf: 'tf',
  tfvars: 'tfvars',
  hcl: 'hcl',
  nix: 'nix',
  vue: 'vue',
  svelte: 'svelte',
  make: 'makefile mk',
  cmake: 'cmake',
  gradle: 'gradle',
  groovy: 'groovy',
}
const BY_EXTENSION = new Map(Object.entries(EXTENSIONS).flatMap(([language, names]) =>
  names.split(' ').map(name => [name, language] as const)))

/** Plain text for unknown extensions; both Unix and Windows separators match upstream. */
export function readLangHintForPath(path: string): string | undefined {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const base = path.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  return dot < 0 ? undefined : BY_EXTENSION.get(base.slice(dot + 1).toLowerCase())
}
