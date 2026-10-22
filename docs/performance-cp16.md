# CP16 — coalescing concurrent read-only native RPC calls

## Purpose and inspected consumer

The CP15 profiler found that a 24-file 4 KiB workload invoked 24 `fs.resolve`, 24 `fs.stat`, and 24 `fs.read` native requests. The DSH model-facing `read` tool's source confirms that a normal small-file read resolves the path, observes file metadata, then reads file text. Tool calls may execute concurrently. The provider must not assume a future read when handling resolve, so **serial chains still require three separate observations**; optimizing serial calls without host-tool API changes or speculative caches would break this scope.

This change keeps the DSH `read` tool API and filesystem provider semantics intact. The owner-scoped native file client opportunistically batches requests arriving in the same microtask when their executable, distro, Linux user, cwd, operation and timeout match. Only `fs.resolve`, `fs.stat`, `fs.lstat` (max eight items), and `fs.read` (max two, since each could hold up to 16 MiB of content) participate. The shared RPC pool performs one `fs.batch` round trip for each such group; inside the existing Linux executor **each element separately runs the original operation** and returns its original result or error. Requests belonging to a different owner, identity, operation or timeout do not merge. A single-element group uses the original RPC method. No filesystem data or versions survive the call.

## Exact paired performance evidence

Both sides read the **same real Linux filesystem fixture** through the actual WSL-native `WslFileSystem` provider and worker. The baseline checkout is the exact merged CP15 SHA `2e7e279e0a62dcaa86452c090d1313c7b2aa8342`; the candidate is PR #13. Twenty alternating comparisons follow three warm-up pairs on the same 24×4 KiB files. Each read chain performs resolve, stat, readText, verifies the file type/size and asserts its full returned text. The RPC count is instrumented at `WslRpcPool.run`. Windows uses a verified **WSL2 Ubuntu-24.04** instance; Linux-native is a separate platform. Timings exclude model, GUI, host tool display/formatting and Desktop process startup.

| Platform / mode | CP15 P50 ms | CP16 P50 ms | CP15 P95 ms | CP16 P95 ms | RPC before → after |
| --- | ---: | ---: | ---: | ---: | --- |
| Windows→WSL2, 24 serial | 66.568 | 67.178 | 68.967 | 71.231 | 72 → 72 |
| Windows→WSL2, 24 at concurrency 8 | 77.859 | **23.209** | 82.083 | **23.984** | **72 → 18** |
| Linux, 24 serial | 26.565 | 27.658 | 29.601 | 30.034 | 72 → 72 |
| Linux, 24 at concurrency 8 | 22.726 | **10.786** | 23.901 | **11.921** | **72 → 18** |

Concurrent Windows WSL2 P50 is about **3.35× faster** (70.2% less wall time); Linux 8-way is about **2.11× faster**. Both reduce RPC calls by 75% and retain matching results. In this test each group of eight files generates one `fs.batch` for resolve, one for stat, and four two-file batches for reading: six native RPCs per group, eighteen for 24 files. Serial behavior is effectively unchanged/slightly slower, so no blanket performance gain is claimed. Earlier CP15 benchmark timings were measured on a different runner/date and must **not** be mixed with these paired readings. Large-file streaming and real Desktop GUI latency are not measured by this pass.

## Safeguards and regression coverage

- The `fs.batch` Linux handler rejects write/edit and malformed batch envelopes, validates every member's read-only operation and payload, and reuses the existing `canonical`, `probe` and `read_bytes` functions. File path traversal and version checks remain fresh; no file access is authorized from cached path metadata.
- Each member of the group returns an individual success/error envelope. Existing `NativeFileClient` validators, `FsError` codes, UTF-8 and sampled binary handling remain active per file.
- A caller's independent AbortSignal resolves its own read as aborted. The shared operation is canceled only after all members have aborted; a canceled sibling does not silently cancel a healthy one. No mutation requests participate; publication acknowledgement and unknown-write no-replay stay unchanged.
- Requests are coalesced only inside one owner-scoped client and match Linux executable, distro, user, cwd, RPC method and timeout. The persistent worker pool, queue bounds and fallback-on-startup-only contract are retained.
- New native-file tests exercise eight concurrent physical read chains, unchanged three-call serial chains, healthy/missing/directory/non-UTF-8 sibling errors and independent cancellation. Full native-file/source/library, real Loader, shared owner and mixed lifecycle regressions cover both Windows WSL versions as well as Linux.

Validated pre-checkpoint implementation+lib head: `b71533bfd918cd5d11815360a7ebd6fa12ed04f4`. All nine PR workflows completed/success:
- [read-batch-performance (Windows WSL2 + Linux, src and lib contracts)](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39736611319)
- [checks (reproducible committed lib; pinned host; WSL1/WSL2)](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39736611179)
- [native-files (Linux, Windows WSL1/WSL2)](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39736611180)
- [rpc-loader-compatibility](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39736611242)
- [native-rpc-performance](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39736611239)
- [traversal-performance](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39736611250)
- [search-performance](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39736611189)
- [grep-read-performance](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39736611243)
- [persona-compatibility](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39736611258)

Raw per-iteration timings and method counts are attached to the read-batch-performance workflow; artifacts have finite GitHub retention. The two checkpoint Markdown additions do not alter the runtime or committed `lib/`, but the final PR head CI must still be checked before merge.

## Reproduction and follow-up

Use Node 24, `npm ci` and `node ci/install-pinned.mjs`; build via `npm run build` and confirm committed `lib/` matches. Create a detached checkout of merged CP15 at `.cp16-baseline` with `node_modules` linked, then run `npm run bench:read-batch -- --baseline .cp16-baseline --iterations 20 --output <json-file>`. Run `npm run test:native-files` separately with `DSH_WSL_TEST_PLANE=src` and `lib`; full CI is mandatory for Windows WSL1/WSL2 acceptance.

No evidence justifies changing `streamText` protocol or claiming serial speedups. Further research could examine a caller-approved *batch read* tool operation, but it must preserve per-file absence/type/observed-version events, sandbox/owner boundaries, fallback semantics and cancellation; do not speculatively eliminate observations.
