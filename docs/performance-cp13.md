# CP13 — Native I/O hot-path performance

## Continuation

Base: CP12 `30b9abf7496d818c1f43a69ee50745e924e8a37a`, not a new implementation from main. Branch: `perf/cp13-native-io`. CP12 remains separately tracked in PR #9. Source/build publication and final CI results must be verified before merging; preparation alone is not a performance result.

## Changes under measurement

- The existing native Base64 round-trip validation is retained. A constant-time encoded-length check rejects oversized input before allocating; malformed data and pad bits still follow the old exact canonicality rule. A full JavaScript alphabet scanner was measured and rejected, not shipped as a speedup.
- A complete one-chunk RPC frame is parsed from its existing Buffer instead of an unconditional Buffer.concat copy. Fragmented frames retain the existing bounded accumulator.
- Linux native reads return their private bytearray directly to buffer-compatible consumers. RPC forwarding uses short-lived memoryviews instead of duplicating whole native receipts; stdin slices use the same approach.
- Edit newline detection samples only the necessary prefix before UTF-16 conversion. It still uses precisely the first 4096 UTF-16 code units, including a possible split surrogate pair.
- The immutable bundled/compressed bootstrap string is generated once per module. This is not a file-content cache, shared mutable worker state or a cross-owner pool.

No changes to protocol version 3, file/RPC size limits, user/distro ownership, permissions, filesystem version checks, atomic publication, dispatch/cancel acknowledgement, startup-only fallback or mutation no-replay behavior. No Skill, watch, PTC or host hot-reload work.

## Measurement

`npm run bench:native-rpc -- --baseline <CP12 checkout> --iterations 12 --output <result.json>` compares two actual native filesystem providers in the same process/platform, in alternating order. Both checkouts need the pinned host dependencies; the baseline must be a git checkout at the recorded SHA. Source plane is used for comparison; source/build behavior is checked separately.

File samples cover 4 KiB, 256 KiB and 4 MiB text. Every timed sequence is resolve + stat + read or version-guarded write/edit, with warm-up excluded. Returned content, independently read disk bytes and resulting versions are verified. Raw timing samples are retained in the CI artifact. The decoder and bootstrap microbenchmarks are separate from file timings; Python tracemalloc measures only the actual bundled newline-sample expressions, not the total worker memory.

No fixed latency threshold: an improvement is reported only for the measured scenario, including unchanged/regressed rows. Results are not UNC comparison, model latency or Desktop GUI timings. Memory allocations eliminated by inspection are not presented as measured total process RSS.

## Validation

Existing native file, search, actual Loader, owner, mixed load, real busy timeout and build/host contracts remain. Added regressions compare 8192 encoded padding combinations against the old round-trip rule; reject malformed/oversized bytes without decoding; check repeated bootstrap validity; and compare non-BMP/CRLF sample-boundary edits against the actual host filesystem implementation.

Runtime changes are applied from a blob-hash-guarded transform in an isolated CI checkout, built and tested before publishing matching src/lib. Temporary delivery files are removed after publication. Final source/build SHAs, completed checks and measured results are appended here or in the PR; no Desktop pass is assumed from earlier acceptance.

## Rejected first candidate: Linux measurements

Actual baseline: `30b9abf7496d818c1f43a69ee50745e924e8a37a`. Node `v24.21.0`, platform `linux`. Each row has 16 samples per backend after two warm-ups, in alternating order. Its original [raw readings](https://github.com/yaelysia/dsh-wsl-workspace/blob/5ab03baf29cfeced9c5714ce258bd969dabaae97/docs/performance-cp13-linux.json) remain in Git history. This is Linux native-RPC execution, not a Windows or Desktop timing claim.

| Bytes | Operation | Before P50 / P95 ms | After P50 / P95 ms |
|---:|---|---:|---:|
| 4096 | read | 1.45494 / 1.724939 | 1.506838 / 1.747198 |
| 4096 | write | 2.489311 / 3.828643 | 2.48878 / 2.903397 |
| 4096 | edit | 2.337195 / 3.820668 | 2.382949 / 2.89405 |
| 262144 | read | 8.683361 / 12.438229 | 9.066861 / 10.193545 |
| 262144 | write | 20.733659 / 21.779282 | 23.411303 / 27.749995 |
| 262144 | edit | 14.569796 / 16.77893 | 14.775752 / 20.356222 |
| 4194304 | read | 79.362015 / 85.633412 | 88.28158 / 89.906579 |
| 4194304 | write | 169.852443 / 174.369007 | 174.029943 / 180.217862 |
| 4194304 | edit | 147.867717 / 154.140848 | 158.547536 / 164.156416 |

The first candidate increased 4 MiB read/write/edit latency. The JavaScript alphabet scan is therefore removed before the second comparison; no performance claim is based on the rejected candidate. Other bounded-copy/sampling changes and their regressions remain.

## First measured Linux result

Actual baseline: `30b9abf7496d818c1f43a69ee50745e924e8a37a`. Node `v24.21.0`, platform `linux`. Each row has 16 samples per backend after two warm-ups, in alternating order. See [raw readings](performance-cp13-linux.json). This is Linux native-RPC execution, not a Windows or Desktop timing claim.

| Bytes | Operation | Before P50 / P95 ms | After P50 / P95 ms |
|---:|---|---:|---:|
| 4096 | read | 1.06734 / 1.401166 | 1.057786 / 1.214206 |
| 4096 | write | 2.015194 / 4.078969 | 2.092117 / 233.392478 |
| 4096 | edit | 1.953253 / 2.64532 | 1.920955 / 2.426288 |
| 262144 | read | 7.494381 / 8.244294 | 7.482574 / 8.500942 |
| 262144 | write | 19.23706 / 280.378439 | 20.499194 / 22.901577 |
| 262144 | edit | 13.453774 / 286.726104 | 13.100194 / 16.14726 |
| 4194304 | read | 68.048275 / 74.373507 | 67.07245 / 72.52576 |
| 4194304 | write | 150.732808 / 346.524938 | 150.736193 / 323.603644 |
| 4194304 | edit | 140.197183 / 403.706794 | 137.341249 / 335.147811 |
