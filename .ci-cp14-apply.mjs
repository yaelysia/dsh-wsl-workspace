import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const read = p => readFileSync(p, 'utf8')
const files = {
  'src/shared/search-patterns.ts': '1e32b81b4542319e907b580f48dd8d29725e0d78',
  'src/shared/search-scripts.ts': 'a24cbc2eca99edcbf58c81a869c0f67cd2eae823',
  'src/host/wsl-search.ts': 'b919f54f5e0d37305e290b14d20798ecc82a09bd',
  'src/shared/native-file-worker.ts': '15231e3687c9367cb023581e624c559c56e21bd4',
}
for (const [path, sha] of Object.entries(files)) {
  const data = read(path)
  assert.equal(createHash('sha1').update('blob ' + Buffer.byteLength(data) + '\0').update(data).digest('hex'), sha, path)
}
const replace = (path, before, after) => {
  const text = read(path)
  assert.equal(text.split(before).length, 2, 'replacement must be unique: ' + path + ': ' + before.slice(0, 90))
  writeFileSync(path, text.replace(before, after))
}
writeFileSync('src/shared/search-patterns.ts', read('src/shared/search-patterns.ts') + String.raw`
/** Literal directory prefix only; complex/negative patterns retain the full-root search. */
export function globDirectoryPrefix(pattern: string): string | undefined {
  if (pattern.startsWith('!') || /[\\\0\r\n]/.test(pattern)) return undefined
  const parts = pattern.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) return undefined
  const prefix: string[] = []
  for (const part of parts.slice(0, -1)) {
    if (/[*?\[\]{}]/.test(part)) break
    prefix.push(part)
  }
  return prefix.length ? prefix.join('/') : undefined
}
`)
replace('src/host/wsl-search.ts',
  'import { basenameFilters, compileGlob, expandBraces }',
  'import { basenameFilters, compileGlob, expandBraces, globDirectoryPrefix }')
replace('src/host/wsl-search.ts',
  "      const values = [linuxTarget(input.path), String(config.rawOutputMaxBytes + 1), ...basenameFilters([input.pattern])]",
  "      const prefix = globDirectoryPrefix(input.pattern)\n      const values = [linuxTarget(input.path), String(config.rawOutputMaxBytes + 1),\n        ...(prefix === undefined ? [] : ['', prefix]), ...basenameFilters([input.pattern])]")
const prefixParse = [
  'prefix=',
  'if [ "$#" -ge 2 ] && [ "$1" = "" ]; then prefix=$2; shift 2; fi',
]
// @ before a variable is a generation placeholder; the @ inside [@] is real Bash syntax.
const scoped = String.raw`scope=()
if [ -n "@prefix" ]; then
  literal_path() {
    escaped=@1
    escaped=@{escaped//\\/\\\\}
    escaped=@{escaped//\*/\\*}
    escaped=@{escaped//\?/\\?}
    escaped=@{escaped//\[/\\[}
  }
  literal_path "@target"
  allowed=(-path "@escaped")
  cursor=@{target%/}
  IFS=/ read -r -a parts <<<"@prefix"
  for part in "@{parts[@]}"; do
    cursor=@cursor/@part
    literal_path "@cursor"
    allowed+=(-o -path "@escaped")
  done
  # Keep the original root: a directory symlink must never become a traversal root.
  allowed+=(-o -path "@escaped/*")
  scope=(-type d ! '(' "@{allowed[@]}" ')' -prune -o -path "@escaped/*")
fi`.replace(/@(?=[A-Za-z0-9{])/g, '$').split('\n')
const arrayLines = lines => lines.map(line => '  ' + JSON.stringify(line) + ',').join('\n')
replace('src/shared/search-scripts.ts', "  'target=$1; cap=$2; shift 2',", "  'target=$1; cap=$2; shift 2',\n" + arrayLines(prefixParse))
replace('src/shared/search-scripts.ts', "  'if find --version 2>/dev/null | head -n 1 | grep -q GNU; then',", arrayLines(scoped) + "\n  'if find --version 2>/dev/null | head -n 1 | grep -q GNU; then',")
const script = read('src/shared/search-scripts.ts')
assert.equal(script.split('-prune -o -type f').length, 3)
writeFileSync('src/shared/search-scripts.ts', script.replaceAll('-prune -o -type f', '-prune -o \\"${scope[@]}\\" -type f'))
replace('src/shared/native-file-worker.ts',
  'def probe(path, follow=True):\n    try: return os.stat(path, follow_symlinks=follow)',
  'def probe(path, follow=True, dir_fd=None):\n    try: return os.stat(path, dir_fd=dir_fd, follow_symlinks=follow)')
replace('src/shared/native-file-worker.ts', String.raw`        result = []
        with os.scandir(path) as entries:
            for entry in entries:
                resolved = canonical(entry.path)
                s = probe(resolved)
                row = {'name': entry.name, 'path': resolved, 'type': 'other'}
                if s is not None: row.update(info(s))
                result.append(row)
                if len(result) > 100000: fail('FS_TOO_LARGE', 'directory exceeds 100000 entries')
        return result`, String.raw`        result = []
        directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(directory)
            with os.scandir(directory) as entries:
                for entry in entries:
                    resolved = os.path.join(path, entry.name)
                    # Fresh descriptor-relative metadata; common ancestors are not walked N times.
                    s = probe(entry.name, False, directory)
                    if s is not None and stat.S_ISLNK(s.st_mode):
                        resolved = canonical(resolved)
                        s = probe(resolved)
                    row = {'name': entry.name, 'path': resolved, 'type': 'other'}
                    if s is not None: row.update(info(s))
                    result.append(row)
                    if len(result) > 100000: fail('FS_TOO_LARGE', 'directory exceeds 100000 entries')
            current = probe(path, False)
            if (current is None or (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino)
                    or canonical(path) != path):
                fail('FS_STALE_VERSION', 'directory changed during enumeration')
            return result
        finally:
            os.close(directory)`)
const pkg = JSON.parse(read('package.json'))
pkg.scripts['test:traversal'] = 'node --experimental-strip-types --test tests/traversal-performance.test.mjs'
pkg.scripts['bench:traversal'] = 'node --experimental-strip-types scripts/benchmark-traversal.mjs'
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
const cp = read('CHECKPOINT.md')
writeFileSync('CHECKPOINT.md', cp.replace('\n\n', '\n\n## CP14: traversal reduction in progress\n\nBranch `perf/cp14-prune-enumeration`, baseline CP13 `f7c051a05c279bec181a2ef0257d6b4240fc9ad4`. Read [CP14](docs/performance-cp14.md). This pass prunes fixed-prefix glob traversal and enumerates native directory entries relative to an open directory, with fresh entry metadata and parent identity checks. Do not infer speedup from tests or substitute old Desktop acceptance. Keep matching src/lib and exact before/after measurements. No protocol, mutation, Skill or host changes.\n\n'))
console.log('CP14 source transform applied with exact baseline hashes.')
