# CP15 — Path-scoped grep and read-path profiling

## Goal

1. Safely restrict path-shaped `grep include` queries to a common, literal directory prefix **inside Linux**, not after scanning and transporting the entire workspace.
2. Measure the actual WSL native file provider for serial and bounded-concurrent multi-file reads, normal 4 MiB reads, and the 256 KiB-step 4 MiB `streamText()` path, with per-RPC stage timing/counts and host-only CPU/memory deltas.

Base: merged CP14 main `59f70928687480bd46fc5c77c46727f2c9daa2f3`. Branch: `perf/cp15-grep-read-profiling`. This checkpoint is preparation, **not** a benchmark result or Desktop acceptance.

## Grep scope and fallbacks

- `include=src/services/**/*.ts` may restrict the Linux grep root to `src/services` if the search root is the active session cwd and all literal ancestors are existing physical directories.
- Brace alternatives only narrow when every alternative shares the same provable literal directory prefix. Leading wildcard, negative, hidden, `node_modules`, missing, mixed basename/path, symlink-component, or explicitly scoped path cases use the old full-root search.
- GNU grep's original include/exclude options are constructed using the original root and retained after restricting the physical target. Final path filter, output cap, error handling and model tool schema are unchanged.
- Treat same-results assertions as necessary but not sufficient: check original filtered match records, CLI grep exit codes, output truncation, directory symlink no-follow, missing roots, and same actual Loader/owner pool.

## Profiling boundary

- `npm run bench:grep-prune -- --baseline <merged-CP14-checkout> --iterations 20 --output results.json` compares **registered** grep tools against the exact previous commit on a synthetic project with 120 target files and 16000 unrelated **same-extension** files. The no-prefix pattern is the control; full returned matches must agree.
- `npm run profile:reads -- --iterations 5 --output results.json` measures 24 files × 4 KiB read serially and in batches of eight; also measures `readText` and `streamText` of a 4 MiB file whose target is pre-resolved.
- Capture tool wall clock, RPC call count by method, summed RPC durations, decoded stdout bytes and approximate JSON request size. Parallel summed method durations can exceed wall clock. Memory figures are before/after deltas (not peak RSS), and CPU covers Windows Node only (not Linux workers).
- Source/lib and pinned-host tests must pass; Windows WSL2 results may only be claimed from **completed** actual Windows WSL2 measurements. Linux is a separate comparison.
- No binary RPC, file content caching, modification of the file mutation protocol, new user setting, Skill, PTC, watch or DSH hot reload work.

## Release rule

When source/build, semantics, compatibility and paired measurements are verified, remove temporary delivery infrastructure, publish a matching `lib/`, merge the PR to `main` as already authorized, and report the merged SHA. Do not call profiling an optimization until it identifies a measured opportunity; profiling does not by itself change read semantics.
