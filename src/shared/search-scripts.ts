/** Fixed Bash scripts: all model-controlled values are argv, never interpolated code. */

/**
 * GNU grep emits path\0line:text records. After the first four argv fields,
 * optional ["", literal-directory-prefix] or ["", "", "", anchor-name] restricts the Linux walk only when
 * safe, followed by conservative basename hints. The host remains the exact matcher.
 * Hints retain the original hidden-file rule; explicit file targets stay visible.
 * The cap is enforced in Linux and PIPESTATUS preserves grep's exit status.
 */
export const GREP_SCRIPT = [
  'set -u',
  'pattern=$1; include=$2; target=$3; cap=$4; shift 4',
  'prefix=; anchor=',
  'if [ "$#" -ge 2 ] && [ "$1" = "" ]; then prefix=$2; shift 2; fi',
  'if [ "$#" -ge 2 ] && [ "$1" = "" ]; then anchor=$2; shift 2; fi',
  '[ -n "$target" ] || target=.',
  'if [ -d "$target" ]; then',
  '  target=$(cd -- "$target" && pwd -P)',
  '  dir=1',
  'else',
  '  case $target in /*) ;; *) target=$PWD/$target ;; esac',
  '  dir=0',
  'fi',
  'if ! grep --version 2>/dev/null | head -n 1 | grep -q GNU; then',
  '  printf "grep is not GNU grep: %s\\n" "$(grep --version 2>/dev/null | head -n 1)" >&2',
  '  exit 3',
  'fi',
  // Join inside Linux: newline-delimited hints must not cross wsl.exe argv.
  'if [ "$dir" = 1 ] && [ -z "$include" ] && [ "$#" -gt 0 ]; then',
  '  printf -v include "%s\\n" "$@"',
  'fi',
  'opts=(-rnIEH -Z)',
  'if [ "$dir" = 1 ]; then',
  '  opts+=(--exclude-dir=node_modules)',
  '  case ${target##*/} in .*) ;; *) opts+=(--exclude-dir=".*") ;; esac',
  '  [ -n "$include" ] || opts+=(--include="[!.]*")',
  'fi',
  'if [ -n "$include" ]; then',
  '  while IFS= read -r one; do [ -n "$one" ] && opts+=(--include="$one"); done <<<"$include"',
  'fi',
  // Do not follow a nested directory symlink by turning it into a command-line
  // grep root. Keep all originally applied --include/--exclude-dir options.
  // If the candidate is unavailable/unsafe, run the unchanged full-root walk.
  'if [ "$dir" = 1 ] && [ -n "$prefix" ]; then',
  '  candidate=${target%/}; safe=1',
  '  IFS=/ read -r -a segments <<<"$prefix"',
  '  for segment in "${segments[@]}"; do',
  '    case $segment in ""|"."|".."|node_modules|.*) safe=0; break ;; esac',
  '    candidate=$candidate/$segment',
  '    if [ -L "$candidate" ] || [ ! -d "$candidate" ]; then safe=0; break; fi',
  '  done',
  '  if [ "$safe" = 1 ] && [ "$(cd -- "$candidate" && pwd -P)" = "$candidate" ]; then target=$candidate; fi',
  'fi',
  // Discover a single non-symlink directory named in EVERY path-shaped alternative.
  // Enumerate directories only: unlike grep -r, do not open irrelevant files.
  // For zero/multiple roots, changed paths, or discovery failure: retain broad search.
  'if [ "$dir" = 1 ] && [ -z "$prefix" ] && [ -n "$anchor" ]; then',
  '  excludes=(-type d -name node_modules)',
  '  case ${target##*/} in .*) ;; *) excludes+=(-o -type d -name ".*") ;; esac',
  '  dirs=()',
  '  mapfile -d "" -t dirs < <(find "$target" -mindepth 1 \\( "${excludes[@]}" \\) -prune -o -type d -name "$anchor" -print0 -prune 2>/dev/null)',
  '  walkPid=$!',
  '  if wait "$walkPid" && [ "${#dirs[@]}" -eq 1 ]; then',
  '    selected=${dirs[0]}',
  '    if [ ! -L "$selected" ] && [ -d "$selected" ] && [ "$(cd -- "$selected" && pwd -P)" = "$selected" ]; then target=$selected; fi',
  '  fi',
  'fi',
  'grep "${opts[@]}" --regexp="$pattern" -- "$target" | head -c "$cap"',
  'exit "${PIPESTATUS[0]}"',
].join('\n')

/**
 * List files with GNU find's mtime (plain NUL listing on non-GNU find).
 * Optional basename hints are OR-ed; VCS pruning and symlink traversal stay unchanged.
 * Filter before the byte cap, preserving both the root header and record framing.
 */
export const GLOB_SCRIPT = [
  'set -u',
  'target=$1; cap=$2; shift 2',
  "prefix=; anchor=",
  "if [ \"$#\" -ge 2 ] && [ \"$1\" = \"\" ]; then prefix=$2; shift 2; fi",
  "if [ \"$#\" -ge 2 ] && [ \"$1\" = \"\" ]; then anchor=$2; shift 2; fi",
  'names=()',
  'if [ "$#" -gt 0 ]; then',
  '  names=(\"(\")',
  '  for name in "$@"; do names+=(-name "$name" -o); done',
  "  unset 'names[-1]'",
  '  names+=(\")\")',
  'fi',
  '[ -n "$target" ] || target=.',
  'if [ -d "$target" ]; then target=$(cd -- "$target" && pwd -P); else',
  '  case $target in /*) ;; *) target=$PWD/$target ;; esac',
  'fi',
  'prune=(-name .git -o -name .hg -o -name .svn -o -name .bzr -o -name .jj -o -name .sl)',
  "scope=()",
  "if [ -n \"$prefix\" ]; then",
  "  literal_path() {",
  "    escaped=$1",
  "    escaped=${escaped//\\\\/\\\\\\\\}",
  "    escaped=${escaped//\\*/\\\\*}",
  "    escaped=${escaped//\\?/\\\\?}",
  "    escaped=${escaped//\\[/\\\\[}",
  "  }",
  "  literal_path \"$target\"",
  "  allowed=(-path \"$escaped\")",
  "  cursor=${target%/}",
  "  IFS=/ read -r -a parts <<<\"$prefix\"",
  "  for part in \"${parts[@]}\"; do",
  "    cursor=$cursor/$part",
  "    literal_path \"$cursor\"",
  "    allowed+=(-o -path \"$escaped\")",
  "  done",
  "  # Keep the original root: a directory symlink must never become a traversal root.",
  "  allowed+=(-o -path \"$escaped/*\")",
  "  scope=(-type d ! '(' \"${allowed[@]}\" ')' -prune -o -path \"$escaped/*\")",
  "fi",
  // Discover only directories bearing a mandatory literal name, then scan
  // their files while keeping the original search-root header and final matcher.
  'scanTarget=$target',
  'if [ -n "$anchor" ] && [ -d "$target" ]; then',
  '  dirs=()',
  '  mapfile -d "" -t dirs < <(find "$target" -mindepth 1 \\( "${prune[@]}" \\) -prune -o -type d -name "$anchor" -print0 -prune 2>/dev/null)',
  '  walkPid=$!',
  '  if wait "$walkPid" && [ "${#dirs[@]}" -eq 1 ]; then',
  '    selected=${dirs[0]}',
  '    if [ ! -L "$selected" ] && [ -d "$selected" ] && [ "$(cd -- "$selected" && pwd -P)" = "$selected" ]; then scanTarget=$selected; fi',
  '  fi',
  'fi',
  'if find --version 2>/dev/null | head -n 1 | grep -q GNU; then',
  "  { printf 'G%s\\0' \"$target\"; find \"$scanTarget\" \\( \"${prune[@]}\" \\) -prune -o \"${scope[@]}\" -type f \"${names[@]}\" -printf '%T@\\t%p\\0'; } | head -c \"$cap\"",
  'else',
  "  { printf 'P%s\\0' \"$target\"; find \"$scanTarget\" \\( \"${prune[@]}\" \\) -prune -o \"${scope[@]}\" -type f \"${names[@]}\" -print0; } | head -c \"$cap\"",
  'fi',
  'exit "${PIPESTATUS[0]}"',
].join('\n')
