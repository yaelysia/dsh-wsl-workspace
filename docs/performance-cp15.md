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

## Final CP15 results (after complete CI)

**Runtime / matching \`lib/\` SHA:** \`c1b190bb08c7916d5946183b8ffcacae222bd9e0\`. **Seven CI workflows were completed/success** at \`452c24fa06820086ef699cdac182ecdb1ae828fc\` (this revision only adds an output-budget regression and more detailed read-phase summary). Subsequent documentation cleanup must not be represented as new runtime validation.

- [Checks / full matrix](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39378551350)
- [Native files / owner lifetime](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39378551507)
- [Real Loader](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39378551409)
- [Search](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39378551419)
- [Traversal](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39378551327)
- [Persona](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39378551430)
- [Grep + read profiling](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39378551400): both Linux and actual Windows→WSL2 jobs succeeded; source and shipped-library grep checks succeeded.

### Grep: measured registered-tool change

Twenty alternating post-warmup measurements on each platform against **the same fixture** and exact main baseline \`59f70928687480bd46fc5c77c46727f2c9daa2f3\`. The matching result set is the same 120 files; the fixture also has 16,000 irrelevant *same-extension* files, so old filename-only hints cannot explain the gain. Times are milliseconds, including real registered grep, RPC, host final filter, and parsing; **not Desktop/LLM latency**.

| Platform and include pattern | Before P50 / P95 | After P50 / P95 | Result |
| --- | ---: | ---: | --- |
| Windows→WSL2, \`src/services/**/*.tsx\` | 139.720 / 164.361 | **11.816 / 14.323** | 11.8× lower P50 |
| Windows→WSL2, leading-wildcard control | 139.503 / 162.258 | 137.719 / 150.209 | Essentially unchanged |
| Linux, \`src/services/**/*.tsx\` | 145.635 / 158.971 | **9.008 / 13.972** | 16.2× lower P50 |
| Linux, leading-wildcard control | 147.108 / 151.698 | 146.856 / 149.069 | Essentially unchanged |

Decoded RPC grep stdout on Windows fell from **1,196,050 to 8,650 bytes** for the fixed-prefix case; Linux fell from **1,308,890 to 9,490 bytes**. These are *decoded stdout* bytes before the RPC outer framing, not an instrumented physical wire count. No-prefix control output is unchanged. The amount saved depends on the amount of unrelated searchable content.

### Read workload profiling — observations, not runtime optimizations

The profiler was executed with its actual native file provider (warm worker; same synthetic fixture), not a mock. Five iterations per scenario after warmup; Windows→WSL2 and Linux have different total cost profiles. The 24-file scenarios read 24 separate 4 KiB files and each execute **24 resolve + 24 stat + 24 read = 72 native RPCs**. Eight-way execution overlaps requests but does not eliminate RPC calls.

| Scenario | Windows→WSL2 P50 / P95 ms | Linux P50 / P95 ms | Native calls |
| --- | ---: | ---: | --- |
| 24 small files, serial | 89.599 / 104.009 | 33.902 / 37.771 | 72 |
| 24 small files, eight-way | 81.782 / 84.910 | 29.468 / 30.614 | 72 |
| 4 MiB \`readText\` (pre-resolved target) | 154.711 / 185.345 | 86.229 / 88.687 | 1 \`fs.read\` |
| 4 MiB \`streamText\` (pre-resolved target) | 154.057 / 166.774 | 97.681 / 102.656 | 1 \`fs.stat\` + 17 \`fs.range\` |

Windows serial small-file stage P50 totals: \`resolve 31.475 ms\`, \`stat 27.247 ms\`, \`readText 30.632 ms\`. In eight-way mode, **summed per-call phase durations overlap**, so those sums can exceed wall time; they must not be treated as serialized latency. The profiler also saves per-method RPC duration sums, decoded response bytes, approximate request JSON bytes and Windows **Node-only** CPU and before/after memory deltas. These are not complete WSL process CPU figures or memory peaks.

**Conclusions:** for workflows that independently resolve/stat/read many small files, reducing round trips (after checking DSH's caller semantics) is the most concrete follow-on research target. \`streamText\` consumes many more RPC calls, but its 4 MiB wall time was essentially equal to \`readText\` in the Windows fixture, and slower in Linux; changing streaming protocol is **not yet justified solely by call count**. This pass intentionally did not alter the native read, write or stream contracts.

### Safety and reproducibility

The new checks require exact grep filtered-record parity; true directory components rather than a symlink-root rebind; safe fallback for missing, hidden, node_modules, mixed/ambiguous, negative and explicit-path cases; actual shared file/search owner pool and identical output budgets. The final tests add a **pre-final-filter cap case** demonstrating that pruning prevents unrelated content from consuming the limited Linux output allowance. No user paths, credentials or installed DSH profile were changed.

Raw repeated timings plus host-only CPU/memory readings are preserved in the workflow artifacts. At the time of validation:

- Windows WSL2 artifact \`12244089067\`, SHA256 \`4c2e24c2194edac4a0d6715ca80168b4d41ce39d7ba4faddc0c358bf22ca475b\`.
- Linux artifact \`12244640871\`, SHA256 \`4c4396ef182ab5eb39449cb566a37588bb8736e7e5312119646993a8ddfd51cf\`.

Their scheduled retention ends **2026-11-03**. The summary tables here and CI URLs remain as the permanent checkpoint. DSH hot reload, host updater, PTC, Skills and native write transaction behavior are outside this change. Original CP11 Desktop acceptance is historical and does not establish CP15 GUI acceptance.
