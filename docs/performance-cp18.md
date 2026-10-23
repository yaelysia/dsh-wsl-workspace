# CP18 — serial native WSL read snapshot

## Purpose and host boundary

CP16 coalesced **independent concurrent** `resolve`, `stat` and `read` calls but retained 72 RPCs for 24 **serial** small-file reads. The stock model-facing DeepSeek Harness `@deepseek-ai/dsh-tool-fs` `read` API is sequential: resolve the caller path, stat for file type and observed version, then readText for small files or streamText for large ones. The stock tool emits `fs/observed`, renders a line-numbered window and supplies replay-safe metadata for a read result card.

CP18 changes the WSL world's *text read only*. Its isolated world disables the stock text `read` registration and mounts `read-wsl` under the same `read` tool name, while leaving official `write`/`edit` and their sandbox/mutation contracts untouched. The native file provider exposes `readSnapshot`, dispatching a read-only `fs.snapshot` operation. In Linux that operation physically resolves the requested path, captures fresh file metadata/version and reads small regular-file bytes inside one native RPC. There is **no cache** and no write batching. Client-side UTF-8/BOM/binary validation and bounded read-window logic remain.

Large or size-unknown files use the existing provider streaming path. Linux paths resolving to an actual `/mnt/<drive>` Windows drive retain the established Windows/UNC provider behavior, avoiding drvfs permission differences; unrelated Linux directories under `/mnt` remain eligible. Native startup-only fallback is retained before a read target is established. There is no post-dispatch replay, no filesystem permission escalation, and no mutation changes.

The fused WSL tool preserves the model-visible `file_path`, `offset`, `limit` parameters, returned `path`/line numbers/`totalLines`, text envelope, read card, syntax language metadata, present/absent observation event and version. MIT provenance of the adapted model-facing rendering and language identifiers is documented in `NOTICE`. A local language-ID mapping avoids pulling a second incompatible Cordis peer dependency graph into the plugin.

## Verified paired performance

The same real native filesystem fixture was used for both arms. Each arm invokes the *registered WSL read tool* for 24 small files, strictly serially. Each file is 4,096 bytes of valid UTF-8 text across 64 lines; full returned text and numbered lines are verified. The control uses the original `resolve → stat → readText` provider sequence, and the candidate uses one `readSnapshot`; both share the same read-tool parsing, rendering path, owner-scoped WSL RPC pool and test fixture, so the comparison isolates the provider call-chain improvement. These are **not** an independent side-by-side run of the original upstream DSH binary tool.

After three alternating warm-up pairs, 20 paired post-warm-up samples were collected on both platforms. P50/P95 are milliseconds; all below are warm worker timings, not UI/model waits.

| Platform | Arm | P50 ms | P95 ms | Native RPCs |
| --- | --- | ---: | ---: | ---: |
| Windows→WSL2, Ubuntu-24.04 | Original serial provider sequence | 78.101 | 82.716 | 72 = 24 resolve + 24 stat + 24 read |
| Windows→WSL2, Ubuntu-24.04 | **Fused `fs.snapshot`** | **31.907** | **34.740** | **24 snapshots** |
| Linux | Original serial provider sequence | 14.297 | 18.783 | 72 |
| Linux | **Fused `fs.snapshot`** | **6.684** | **9.209** | **24** |

Windows P50 improved **2.45×** (about **59.1%** less wall-clock time), Linux P50 improved **2.14×** (about **53.3%** less). The native request count fell **66.7%**. These ratios apply to small-file serial reads in this fixed workload, not large-file `streamText`, Desktop rendering, model generation or arbitrary mixed work.

- [Paired Windows WSL2 and native Linux benchmark with raw individual samples](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39805575214) — both jobs completed/success.
- At test time, the workflow checked the Windows runner was actually WSL2 rather than assuming it from the runner label.

## Correctness and release gates

- `tests/wsl-read-snapshot.test.mjs` verifies 3-to-1 native call counts, complete line-number and metadata parity between original three-step provider adapter and fused provider, `fs/observed` present/absent/version events, missing and directory errors, UTF-8/binary/BOM/CRLF, byte/line truncation, offset range, large-file stream fallback and cancellation.
- Guarded-write regression: a file mutated after its snapshot still refuses `replaceIfVersion` with a stale observation. The original atomic file publication path remains untouched.
- `tests/rpc-loader-entry.test.mjs` tests actual mounted Cordis Loader execution of the new registered `read` name from the isolated WSL world and records exactly one `fs.snapshot` request. Variant-materialization tests assert the stock `read` is disabled only when the replacement is mounted; official `write/edit` stay present.
- The same tests execute against both `DSH_WSL_TEST_PLANE=src` and the **committed** `lib/`. Reproducible artifact, pinned-host and Windows WSL1/WSL2 compatibility gates remain active; the inherited 209-error TypeScript typecheck budget was not increased.
- All **11 PR #15 workflows were completed/success** at code head `3b331a4da51de4556e1d648e2705df49b2250817`:
  - [read-snapshot-performance](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39805575214)
  - [checks — src/lib, Linux, WSL1 and WSL2](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39805574428)
  - [native-files](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39805574562)
  - [native-rpc-performance](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39805574251)
  - [rpc-loader-compatibility](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39805574873)
  - [read-batch-performance](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39805574795)
  - [grep-read-performance](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39805574347)
  - [search-performance](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39805574469)
  - [traversal-performance](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39805574352)
  - [wildcard-anchor-performance](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39805574391)
  - [persona-compatibility](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39805574487)

The implemented change merged in [PR #15](https://github.com/yaelysia/dsh-wsl-workspace/pull/15), merge commit `1cb65df9de8e92d1465b679359d3a7bb15030e7b`. The final CP18 checkpoint and report are documentation-only additions on top of that validated runtime; they do not assert a new Desktop GUI test. Historical CP17 Desktop acceptance **does not** validate CP18 UI.

## Reproduction and next validation

Using Node 24, run `npm ci` and `node ci/install-pinned.mjs`, then `DSH_WSL_TEST_PLANE=src npm run test:read-snapshot` and `DSH_WSL_TEST_PLANE=lib npm run test:read-snapshot`. Repeat `npm run bench:read-snapshot -- --iterations 20 --output cp18-read-results.json` on real Windows→WSL2 or Linux with the corresponding environment and build, and require full line-content assertions. The benchmark uses real native file RPC over a warm worker; its initial provisioning is not a measured user-interface cost. Performance run artifacts have finite retention.

The user-facing Desktop still requires its own separate CP18 hands-on acceptance if release validation demands it. No host hot reload, PTC, Skills, write/edit, or general stream protocol changes were introduced.
