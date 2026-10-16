/** Fixed Bash scripts: all model-controlled values are argv, never interpolated code. */

/**
 * GNU grep emits path\0line:text records. Optional arguments 5 onward are conservative
 * basename hints for directory searches only; the host remains the exact matcher.
 * Hints retain the original hidden-file rule; explicit file targets stay visible.
 * The cap is enforced in Linux and PIPESTATUS preserves grep's exit status.
 */
export const GREP_SCRIPT = [
  'set -u',
  'pattern=$1; include=$2; target=$3; cap=$4',
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
  'if [ "$dir" = 1 ] && [ -z "$include" ] && [ "$#" -gt 4 ]; then',
  '  printf -v include "%s\\n" "${@:5}"',
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
  'if find --version 2>/dev/null | head -n 1 | grep -q GNU; then',
  "  { printf 'G%s\\0' \"$target\"; find \"$target\" \\( \"${prune[@]}\" \\) -prune -o -type f \"${names[@]}\" -printf '%T@\\t%p\\0'; } | head -c \"$cap\"",
  'else',
  "  { printf 'P%s\\0' \"$target\"; find \"$target\" \\( \"${prune[@]}\" \\) -prune -o -type f \"${names[@]}\" -print0; } | head -c \"$cap\"",
  'fi',
  'exit "${PIPESTATUS[0]}"',
].join('\n')
