# CP19 — Adaptive large native WSL read payloads

## Summary

The Windows DSH → WSL native file transport previously Base64-encoded file data inside a Linux file executor's JSON receipt, then Base64-encoded that receipt again in the shared Python RPC frame. A 4 MiB read can therefore produce approximately 7.46 MB of Windows-received stdout data even for a very compressible file. CP19 reduces the transfer size only when the bytes themselves offer substantial redundancy. There is no general RPC count reduction.

Code merged via [PR #16](https://github.com/yaelysia/dsh-wsl-workspace/pull/16), code head `97f2bcf63a5419e4435e194d05a525d5bda8565b`, merge SHA `b18cd30f6aa079c7702199a64e903927b65f3df9`. Stable CP18 comparison baseline: `a11073dbad8bd1a54cce7cf62f9e8dc04735b450`. This report and the checkpoint are documentation-only post-merge changes.

## Implementation boundary

- `src/shared/native-file-worker.ts` returns original `data` (canonical Base64) or, for eligible reads, a compressed `dataZ` plus `rawBytes`. The codec is zlib level 1 on **read-only** `fs.read`, `fs.range`, and `fs.snapshot` receipts. The `streamText` provider reads 256 KiB ranges through the same facility. Mutating `fs.write` and `fs.edit` do **not** use this path.
- Inputs smaller than 64 KiB are always left raw. For eligible byte buffers, 8 KiB slices at the beginning, middle and end must **each** shrink by at least 20%; a complete compressed buffer is generated only after that prediction, and the result must still shrink by at least 20%. This heuristic avoids wasting full-buffer compression CPU on high-entropy data or adversarial compressible headers. It does not claim optimal codec selection for every file.
- `src/shared/native-files.ts` validates the exclusive raw/compressed receipt forms, uncompressed size as a safe integer within the caller's cap, canonical Base64, decompression output limit, and exact final restored byte count. Invalid receipts fail instead of allocating unbounded decompression buffers. The existing native 16 MiB file cap, RPC byte budget, timeout and cancellation, fresh inode/version checks, atomic writes, and owner worker boundaries remain.
- `tests/native-read-compression.test.mjs` exercises repetitive Unicode-safe code bytes, random content, mixed content, compressible prefix with high-entropy tail, small data, snapshot, range, streaming, stale-version rejection and malformed/oversized compressed receipts on source and committed `lib/`. Other CI covers Windows/WSL1/WSL2 and the real Cordis Loader.

## Paired measurements

[GitHub Actions 39883727913](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39883727913): Ubuntu Linux and **actual Windows→WSL2** jobs both completed/success. Real native providers read the **same Linux files** with 3 warm-up pairs and 20 alternating timed pairs, comparing the pre-CP19 CP18 implementation against the new one. Returned bytes/UTF-8 text are checked each time, with identical file names and data. Timing is warm provider wall time; it excludes model and Desktop UI overhead, cold WSL installation and LLM output. Source files are **synthetic and highly repetitive**, so their compression ratios are not representative of arbitrary project files.

| Windows→WSL2 workload | CP18 P50 / P95 ms | CP19 P50 / P95 ms | Observed RPC stdout bytes before → after |
| --- | ---: | ---: | ---: |
| 4 KiB small text | 1.157 / 1.305 | 1.181 / 1.362 | 7,486 → 7,485 |
| 256 KiB repetitive source | 11.320 / 12.963 | **2.687 / 3.520** | 466,236 → 3,281 |
| 4 MiB repetitive source | 148.565 / 163.766 | **17.469 / 18.901** | 7,456,742 → 47,308 |
| 4 MiB random binary | 179.288 / 189.568 | 181.749 / 202.674 | 7,456,743 → 7,456,744 |
| 4 MiB mixed (random prefix, repetitive remainder) | 146.463 / 159.143 | 144.607 / 158.638 | 7,456,744 → 7,456,744 |
| 4 MiB compressible header, random body | 177.216 / 184.656 | 176.868 / 184.504 | 7,456,744 → 7,456,745 |
| 4 MiB repetitive streamText | 138.662 / 147.357 | **36.849 / 42.172** | 7,460,321 → 53,032 |
| 4 MiB repetitive snapshot | 149.574 / 158.298 | **17.180 / 23.452** | 7,456,955 → 47,520 |

| Linux workload | CP18 P50 / P95 ms | CP19 P50 / P95 ms |
| --- | ---: | ---: |
| 4 KiB small text | 0.372 / 0.463 | 0.371 / 0.495 |
| 256 KiB repetitive source | 5.342 / 6.159 | **1.342 / 2.013** |
| 4 MiB repetitive source | 54.295 / 75.587 | **8.205 / 10.727** |
| 4 MiB random binary | 83.067 / 95.458 | 84.097 / 87.418 |
| 4 MiB repetitive streamText | 57.223 / 62.186 | **17.443 / 21.754** |
| 4 MiB repetitive snapshot | 51.215 / 60.949 | **9.209 / 16.760** |

The Windows 4 MiB repetitive-source P50 improvement is **8.50×**; the observed stdout reduction is **99.37%** on that particular compressible fixture. This is a transfer-volume and parsing improvement, **not an RPC-count reduction**: single calls remain 1 RPC and 4 MiB streaming remains 18 RPCs. The 4 MiB random file stayed on the original raw format and was slightly slower at P50 and P95; both observations must accompany the positive result. The mixed and compressed-header controls remained on the original receipt path. The scope is native Linux files, not UNC, generic remote files or GUI/model latency.

## CI and failure handling

At final PR head `97f2bcf63a5419e4435e194d05a525d5bda8565b`, **10/10 applicable workflows completed/success**:

1. [checks — Linux and Windows WSL1/WSL2, source and shipped lib](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39883728573)
2. [native-files — Linux, WSL1 and WSL2, guarded file writes and worker lifecycle](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39883727705)
3. [native-rpc-performance — source/lib adaptive codec test and CP18 paired benchmark](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39883727913)
4. [read-snapshot-performance](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39883727693)
5. [rpc-loader-compatibility](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39883728066)
6. [read-batch-performance](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39883727700)
7. [grep-read-performance](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39883727736)
8. [traversal-performance](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39883727692)
9. [wildcard-anchor-performance](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39883727889)
10. [persona-compatibility](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39883727830)

The existing CP13 native-RPC benchmarking script first matched the CP19 `sample` variable instead of the historic newline-sampling expression. It was corrected to only select the expression on `original`; both platform baselines passed again, without raising latency limits. The read-snapshot Windows job initially failed during Ubuntu package mirror synchronization (package size mismatch) *before* running read tests; a rerun of only the failed job completed/success. The initial `checks` WSL2 `src` job failed two Shell-session assertions (session ownership cleanup and background execution); those were not claimed to be caused by read compression, but neither were they waived. Re-run **attempt 2** of the failed job finished successfully; all other Windows WSL1/WSL2 jobs and Linux jobs were green. TypeScript's inherited **209-error baseline** was not increased.

The source artifact `lib/` was built and tested against its matching runtime source; CI avoids requiring a new Desktop GUI install to exercise its real Windows/WSL2 path. No CP19 Desktop hands-on acceptance has yet been reported.

## Reproduction

Using Node 24, install `npm ci`, then `node ci/install-pinned.mjs`. Run `DSH_WSL_TEST_PLANE=src npm run test:read-transport` and the matching `DSH_WSL_TEST_PLANE=lib` test. For baseline timing, check out exact CP18 `a11073dbad8bd1a54cce7cf62f9e8dc04735b450` into `.cp19-baseline`, link its node_modules to the tested workspace, then run `npm run bench:read-transport -- --baseline .cp19-baseline --iterations 20 --output cp19.json`. Run on a verified WSL2 Windows runner as well as Linux. Raw timing vectors and stdout byte measurements are kept in the attached Actions artifacts for their retention period.

No future CP20 optimization, Windows app hot-reload change, or live user acceptance is implied by merging this scoped change.
