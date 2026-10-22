/** Shared search matching; no host dependencies or filesystem effects. */
import { posix } from 'node:path'

/**
 * Expand one glob's `{a,b,c}` alternations into the equivalent list of plain
 * globs. ripgrep's globset understands braces; GNU grep's `--include` does not,
 * so the tool passes one `--include` per expansion (repeated includes are OR-ed).
 * @param glob - the glob to expand.
 * @returns every brace-free alternative, in source order.
 */
export function expandBraces(glob: string): string[] {
  const open = glob.indexOf('{')
  if (open < 0) return [glob]
  const close = glob.indexOf('}', open + 1)
  if (close < 0) return [glob]
  const head = glob.slice(0, open)
  const tail = glob.slice(close + 1)
  return glob.slice(open + 1, close).split(',').flatMap(part => expandBraces(`${head}${part}${tail}`))
}

/**
 * Translate one gitignore-style glob into a regular-expression source (no
 * anchors). `*` and `?` never cross a separator, `**` does (a `**` followed by a
 * separator also matches zero segments), `[...]` is a character class (negated
 * by a leading `!` or `^`), and `{a,b}` is an alternation.
 * @param pattern - the glob source.
 * @returns the unanchored regex source.
 */
function globSource(pattern: string): string {
  let source = ''
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index] ?? ''
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:[^/]*/)*'
          index += 3
          continue
        }
        source += '.*'
        index += 2
        continue
      }
      source += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      source += '[^/]'
      index += 1
      continue
    }
    if (char === '[') {
      const close = pattern.indexOf(']', index + 2)
      if (close > index + 1) {
        const body = pattern.slice(index + 1, close)
        const negated = body.startsWith('!') || body.startsWith('^')
        const chars = (negated ? body.slice(1) : body).replace(/[\\^\]]/g, '\\$&')
        source += `[${negated ? '^' : ''}${chars}]`
        index = close + 1
        continue
      }
      source += '\\['
      index += 1
      continue
    }
    if (char === '{') {
      const close = pattern.indexOf('}', index + 1)
      if (close > index + 1) {
        const alternatives = pattern.slice(index + 1, close).split(',').map(part => globSource(part))
        source += `(?:${alternatives.join('|')})`
        index = close + 1
        continue
      }
      source += '\\{'
      index += 1
      continue
    }
    source += /[.+^$()|\\]/.test(char) ? `\\${char}` : char
    index += 1
  }
  return source
}

/**
 * Compile one glob into a whole-string matcher.
 * @param pattern - the glob source.
 * @returns the anchored regular expression.
 */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${globSource(pattern)}$`)
}

/**
 * Whether one file passes a glob filter. A pattern containing `/` matches the
 * path relative to the search root; one without matches the basename at any
 * depth. A leading `!` negates the match, so `!*.log` keeps everything that is
 * not a log file.
 * @param pattern - the glob filter.
 * @returns a reusable predicate; one compilation per search, not per file.
 */
export function compileGlob(pattern: string): (relativePath: string) => boolean {
  let body = pattern
  let negated = false
  if (body.startsWith('!')) {
    negated = true
    body = body.slice(1)
  }
  const regex = globToRegExp(body)
  const pathShaped = body.includes('/')
  return relativePath => {
    const candidate = pathShaped ? relativePath : posix.basename(relativePath)
    const matched = regex.test(candidate)
    return negated ? !matched : matched
  }
}

/** Compatibility entry point for callers matching just one path. */
export function matchGlob(pattern: string, relativePath: string): boolean {
  return compileGlob(pattern)(relativePath)
}

/**
 * Conservative filename filters for GNU find/grep. The full path matcher remains
 * authoritative. Unsupported syntax falls back for the WHOLE union, never just
 * one alternative; dropping an alternative could silently lose real matches.
 *
 * GNU's byte/locale glob and JavaScript's UTF-16 glob need not agree on `?`,
 * character classes or escapes, so those shapes are deliberately not pushed down.
 * A basename `**` is broadened to `*`; this is safe because this layer may keep
 * extra candidates, but must never discard a match the original matcher keeps.
 */
export function basenameFilters(patterns: readonly string[], skipHidden = false): string[] {
  const names = new Set<string>()
  for (const pattern of patterns) {
    if (pattern === '' || pattern.startsWith('!') || /[?\[\]{}\\\r\n]/.test(pattern)) return []
    let name = posix.basename(pattern)
    if (name === '' || pattern.endsWith('/')) return []
    // The host matcher lets an embedded ** cross directory separators;
    // a filename-only filter would then reject valid nested matches.
    if (name.includes('**') && name !== '**') return []
    name = name.replace(/\*+/g, '*')
    if (skipHidden) {
      // Path-shaped grep previously used [!.]* by default. A new include must
      // not accidentally make hidden files visible. Explicit file targets do
      // not use this hint (GREP_SCRIPT only applies it to directory searches).
      if (name.startsWith('.')) return []
      // *README also matches README: prepending [!.] would lose that file.
      // Only a dot suffix guarantees the zero-length prefix was hidden anyway.
      if (name.startsWith('*') && name.length > 1 && name[1] !== '.') return []
      if (name.startsWith('*')) name = `[!.]*${name.slice(1)}`
    }
    names.add(name)
  }
  return [...names]
}

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
/**
 * Optional grep optimization: only a literal directory common to EVERY
 * path-shaped, positive brace alternative may constrain the Linux walk.
 * Patterns without a common provable prefix use the original full traversal.
 * Never turn hidden/node_modules directories into explicitly traversed roots.
 */
export function grepDirectoryPrefix(globs: readonly string[]): string | undefined {
  if (globs.length === 0 || globs.some(pattern => !pattern.includes('/'))) return undefined
  const first = globDirectoryPrefix(globs[0]!)
  if (!first) return undefined
  let common = first.split('/')
  for (const glob of globs.slice(1)) {
    const other = globDirectoryPrefix(glob)
    if (!other) return undefined
    const segments = other.split('/')
    let length = 0
    while (length < common.length && length < segments.length && common[length] === segments[length]) length++
    common = common.slice(0, length)
    if (common.length === 0) return undefined
  }
  if (common.some(part => part === 'node_modules' || part.startsWith('.'))) return undefined
  return common.join('/')
}

/**
 * A directory NAME that every positive, path-shaped alternative must visit.
 * Unlike a literal prefix, this may appear after leading wildcard directory segments.
 * For optional pruning only: ambiguous syntax falls back to the original walk.
 * The caller must keep the final complete glob matcher authoritative.
 */
export function commonLiteralDirectory(globs: readonly string[]): string | undefined {
  if (globs.length === 0 || globs.length > 32) return undefined
  const candidates = globs.map(pattern => {
    if (!pattern.includes('/') || pattern.startsWith('!') || /[\\\0\r\n{}]/.test(pattern)) return []
    const parts = pattern.split('/')
    if (parts.some(part => part === '' || part === '.' || part === '..')) return []
    return parts.slice(0, -1).filter(part =>
      !/[*?\[\]{}]/.test(part) && !part.startsWith('.') && part !== 'node_modules')
  })
  if (candidates.some(parts => parts.length === 0)) return undefined
  const common = candidates[0]!.filter(part => candidates.every(parts => parts.includes(part)))
  // A longer literal is usually the more selective directory name.
  return common.sort((a, b) => b.length - a.length)[0]
}
