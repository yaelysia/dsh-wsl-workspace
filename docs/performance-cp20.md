# CP20 — Native WSL read-line windows (v0.7.10)

## Decision and delivered code

PR [#18](https://github.com/yaelysia/dsh-wsl-workspace/pull/18) is **merged** into `main` at `8933ab8d2c3c68e40fabba032d7b5a4fd8f8cde1`. The **final verified runtime head** was `4a1b19f8446c6e97c83ec15cdeac7939794ba1b9`; comparison baseline for the implementation is `368a242f8523c555c6d77a9120fae50b37448d2d`, the already-merged independent enhanced-package v0.7.9 main. A documentation-only follow-up commit writes this report; it does **not** modify runtime code. Package identity is `dsh-wsl-workspace-enhanced@0.7.10` in both `package.json` and lock root. Version 0.7.9's enhanced package name, DSH mount identity, browser module identity and README distribution directions were preserved during PR re-alignment. A Git merge is **not** evidence of an npm registry publication or a Desktop installation.

**Previous behavior:** The registered DSH-compatible `read` already fused path/metadata/body into one `fs.snapshot` for files below the streaming threshold, but transferred the entire file (using CP19's adaptive compression where beneficial) before computing requested line windows in Windows. Above the configured streaming threshold (default 10 MiB), the old path used `fs.snapshot` metadata, a fresh `fs.stat`, then repeated 256 KiB `fs.range` RPCs to count all lines. This was especially wasteful for `offset` near the end, `limit` of 20 lines, or incompressible multi-MiB source files.

**New behavior:** `src/shared/native-file-worker.ts` exposes a read-only `fs.window` request that physically canonicalizes and opens a regular Linux file, validates UTF-8, counts the exact total number of LF-delimited lines while scanning the complete file and retains only bounded requested-window content. Non-target line runs are counted inside CPython without materializing individual strings. It returns `path`, fresh `info` (including version), bounded `lines`, `totalLines`, `truncatedByBytes` and `outOfRange` rather than whole-file bytes. `src/shared/native-files.ts` bounds and validates the result; `src/fs.ts` provides `readWindow` with existing startup-only fallback; `src/host/wsl-read-tool.ts` keeps the old schema and presentation, `fs/observed`, error behavior and optional original snapshot/stream route for non-native paths. `src/shared/rpc-worker.ts` and `rpc-metrics.ts` register the new operation. Built `lib/` is committed and checked against the corresponding source.

The operation **still scans each full file once**, so it avoids transfer and rendering work rather than claiming O(requested lines) time or random-access indexing. There is no persistent line index, content cache, extra worker, per-file event subscription, new npm dependency, or change to mutation execution. UTF-8/BOM, CRLF, Unicode JS UTF-16 unit truncation, byte/line response caps, invalid-text rejection, Linux physical path handling, owner identity, cancellation, fresh version checks, observed present/absent events, guarded write stale-version refusal and original UNC/Windows-drive fallback were exercised in regression tests. Native whole-file read, write and edit stay limited to **16 MiB**; a window read may inspect a larger file without raising that limit. File contents do not reach Windows unless selected for the requested window.

## Paired benchmark methodology

[Actions run 40461301195](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/40461301195): Ubuntu native Linux and **actual Windows→WSL2 Ubuntu-24.04** finished `completed/success`. Runs use `npm run bench:read-window -- --iterations 12` and the existing real native pool / **registered WSL read tool**, comparing a legacy `fs.snapshot`/`streamText` adapter to CP20 `fs.window` against the same generated Linux fixture. Three warm-up pairs, then 12 alternating paired samples; exact returned `read` results verified on every invocation and the active pool showed one owner-scoped worker, zero fallback and zero pending work. Window requested 20 lines in each case, generally near EOF. Repeated-source data is synthetic; the 4 MiB ASCII scenario uses random lowercase letters with a newline every 80 bytes. Timing is complete warm registered-read wall time, not CPU-only file scanning, cold WSL bootstrap, DSH Desktop UI, or LLM response latency.

### Windows→WSL2 paired results

| File/workload | CP19 P50/P95 (ms) | CP20 P50/P95 (ms) | P50 speed ratio (old/new) | CP19 → CP20 RPCs | Native decoded receipt bytes CP19 → CP20 |
|---|---:|---:|---:|---:|---:|
| 4 KiB repeated source | 1.332 / 1.578 | 1.391 / 1.593 | 0.96× (**slower**) | 1 → 1 | 5,722 → 1,913 |
| 256 KiB repeated source | 2.641 / 3.318 | 1.925 / 4.239 | 1.37× (**P95 slower**) | 1 → 1 | 2,379 → 1,970 |
| 4 MiB repeated source | 14.865 / 19.083 | 4.384 / 7.185 | 3.39× | 1 → 1 | 32,860 → 1,991 |
| 20 MiB repeated source | 175.502 / 183.349 | 12.928 / 13.819 | **13.58×** | **83 → 1** | 178,137 → 2,015 |
| 4 MiB random ASCII | 201.137 / 209.429 | 4.826 / 10.022 | **41.68×** | 1 → 1 | 3,702,942 → 2,397 |

A `1 → 1` single-read RPC row is not an RPC reduction: in these cases only the payload size and amount of local decoding/window rendering changed. For 20 MiB, the old path issued 1 snapshot + 1 stat + 81 range calls; CP20 issues one read window. The `receipt bytes` field records **decoded native JSON response data after the outer RPC Base64 layer**, not a direct network packet count or entire user-visible result size. A small file and a 256 KiB P95 regression are real measured counterexamples; do not advertise universal latency improvement.

### Linux paired results

| File/workload | CP19 P50/P95 (ms) | CP20 P50/P95 (ms) |
|---|---:|---:|
| 4 KiB repeated source | 0.484 / 0.723 | 0.517 / 0.703 |
| 256 KiB repeated source | 1.178 / 1.859 | 0.775 / 2.536 |
| 4 MiB repeated source | 7.561 / 10.093 | 2.729 / 4.579 |
| 20 MiB repeated source | 65.885 / 73.559 | 9.823 / 10.488 |
| 4 MiB random ASCII | 114.418 / 124.275 | 3.264 / 7.637 |

Use these figures only as evidence for the exact tested path and file class; a file whose requested window spans nearly all the content, a different filesystem/WSL configuration or a GUI/LLM-dominated read may behave differently. The new worker scans the complete file to preserve exact `totalLines` and whole-file text validity, even when few lines are sent.

## Regression and CI closure

On **final head** `4a1b19f8446c6e97c83ec15cdeac7939794ba1b9`, **12/12 applicable workflows finished successfully**:

- [checks](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/40461301274): both Ubuntu jobs and all four real Windows WSL1/WSL2 `src`/`lib` hard-gate jobs `completed/success`.
- [native-files](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/40461301183): Linux, Windows WSL1 and Windows WSL2 all `completed/success`.
- [read-window-performance](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/40461301195): native registered-tool parity plus full paired benchmarking on Linux and Windows WSL2 `completed/success`.
- [native-rpc-performance](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/40461301234), [read-snapshot](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/40461301167), [read-batch](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/40461301186), [rpc-loader](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/40461301208), [grep/read](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/40461301163), [search](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/40461301276), [traversal](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/40461301199), [wildcard anchor](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/40461301232) and [persona](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/40461301281) all `completed/success`.

The new benchmark workflow initially had malformed GitHub Actions expressions such as `runs-on: ${ matrix.os }}`, which incorrectly produced literal runner labels and left both jobs in the queue. It was fixed in the workflow-only final-head commit (proper `\$\{\{ matrix.os \}\}` expression, plus corrected concurrency and artifact names), and the corrected **Linux and Windows** jobs truly ran and passed. This was a **CI configuration error**, not evidence for or against native read runtime behavior. The final workflow-only correction triggered the complete final-head CI rerun, which also passed.

Other validation: `npm run test:read-window` covers source/built-library equality with the old registered read including BOM, CRLF, partial UTF-16 surrogate truncation, empty/missing/binary/invalid UTF-8, >20 MiB bounded result, offset bounds, cancellation, observed versions and stale-write protection; existing snapshot, real Loader and native files suites remain. Original **209 TypeScript-error baseline** is not increased. The CP20 client/help and manifests consistently show version **0.7.10**. No real DSH Desktop GUI hands-on verification or npm registry release was performed as part of PR #18.

## Reproduce / next profiling target

With Node 24 and WSL2 available, run `npm ci`, `node ci/install-pinned.mjs`, then `DSH_WSL_TEST_PLANE=src npm run test:read-window` and `DSH_WSL_TEST_PLANE=lib npm run test:read-window`. On real Linux and Windows→WSL2 run `npm run bench:read-window -- --iterations 12 --output cp20.json`; compare full result objects and keep negative controls. Pairing samples are within one benchmark process and one owner-scoped native pool, not two independently checked-out executable plugin versions, and the baseline adapter uses the prior full-file `fs.snapshot`/`streamText` path.

Follow-up if useful: profile scans over **real** source files and cold/repeated pages before deciding whether a persistent index is worth the invalidation and memory overhead. Do not presume CP20 accelerates every file. CP21 Skills native scanning remains a separate design candidate; DSH hot-reload and PTC execution were outside CP20.
