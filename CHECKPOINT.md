# Windows DSH → WSL continuation checkpoint

## CP13: validated native I/O allocation/performance pass

Active branch: `perf/cp13-native-io`; [PR #10](https://github.com/yaelysia/dsh-wsl-workspace/pull/10), currently stacked on CP12 [PR #9](https://github.com/yaelysia/dsh-wsl-workspace/pull/9). A branch or green check does not establish a main merge or a new Desktop acceptance. Check live refs before continuing.

**Read [final cross-platform evidence](docs/performance-cp13-validation.md) first.** All six workflows at `d6b872c1434109eca6735a9fb2f03fdab2e412d1` completed successfully, including actual Windows-to-WSL2 paired measurements. Runtime and matching lib were published at `a7e5d8ea524c13b11f565768f52306a52a19b26a`; the current evidence update only modifies Markdown, not src/lib. Subsequent documentation-triggered checks are separate from that completed runtime matrix.

### What is established

The main benefit is reduced temporary allocation and repeated code-generation work. In the final Windows run, 4 KiB write/edit medians improved about 5.5%/7.0%, but larger-file timings were mixed and some regressed. Do not claim a uniform end-to-end speedup, a decoding acceleration or improved DSH total RSS.

- Newline sampling on 4 MiB text allocated a peak 8,396,870 bytes before and 12,760 after, for that expression only.
- Immutable bundled bootstrap compression is cached per module; no file bodies, usernames, mutable worker state or cross-owner pool is cached.
- One-chunk RPC frames avoid Buffer.concat; private Linux read buffers and short-lived transfer memoryviews avoid full-buffer copies.
- Canonical Base64 keeps native decode/re-encode validation, with an early size guard. A JavaScript full alphabet scanner was measured, found slower, and rejected. Valid-data decoding is not claimed faster.

Protocol 3, request/file limits, physical-path authorization, version guards, atomic publication, identity/owner isolation, real Loader metadata, startup-only fallback, cancellation acknowledgement and no-replay behavior remain unchanged. No Skill/watch/PTC/UI or DSH host installation/hot-reload changes. User accepts a full DSH restart and leaves the host issue to upstream.

### Reproduce

Use Node 24, `npm ci`, then `node ci/install-pinned.mjs`. Existing `test:unit`, `test:node`, `test:search-transport`, `test:native-files`, `test:rpc-loader`, `test:rpc-owner`, `test:rpc-mixed`, `test:rpc-busy`, `typecheck:gate` and `verify:install` remain the regression entrypoints. Repeat native/Loader/owner/mixed/busy with `DSH_WSL_TEST_PLANE=lib`; the busy test actually exceeds 120 seconds. Windows must use a real distribution, not the Linux launcher as a substitute.

`npm run bench:native-rpc -- --baseline <CP12-worktree> --iterations 24 --output <json>` compares actual warm resolve+stat+read/guarded-write/edit sequences against `30b9abf7496d818c1f43a69ee50745e924e8a37a`, alternating order and verifying returned/disk bytes and versions. Follow `.github/workflows/native-rpc-performance.yml` for dependency/WSL2 setup; its repository permission is read-only. The permanent script retains raw samples. Artifact IDs/digests and all rows, including regressions, are in the final evidence document.

### Handoff and earlier checkpoints

Temporary delivery scripts/workflows were removed before d6b872c1. No plugin package is sent to the user, no npm release is made and no local installation/profile is edited. Source and committed lib must remain synchronized. The 209-error historical type baseline was not raised or cleared. CP11's previous Desktop acceptance is not a new CP12/CP13 test.

- [CP13 implementation and experiment log](docs/performance-cp13.md) preserves the rejected scanner and earlier Linux comparison.
- [Complete pre-validation CP13 checkpoint](https://github.com/yaelysia/dsh-wsl-workspace/blob/d6b872c1434109eca6735a9fb2f03fdab2e412d1/CHECKPOINT.md) preserves delivery SHAs and detailed commands.
- [CP12 checkpoint](https://github.com/yaelysia/dsh-wsl-workspace/blob/30b9abf7496d818c1f43a69ee50745e924e8a37a/CHECKPOINT.md) preserves simplification, CP11 user acceptance, CP10 Loader repair and links to CP0–CP9.
- CP12's stalled WSL2 setup job was ultimately cancelled; rerunning the original job without code/assertion changes closed its five-workflow matrix successfully. [Recorded on PR #9](https://github.com/yaelysia/dsh-wsl-workspace/pull/9#issuecomment-6261897179). That is validation, not a main merge.
