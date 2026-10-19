# Windows DSH → WSL continuation checkpoint

## CP13: native I/O performance pass

Active branch: `perf/cp13-native-io`, based on CP12 `30b9abf7496d818c1f43a69ee50745e924e8a37a` (PR #9). This continues the already implemented/accepted file and shared-RPC architecture, not a new WSL agent. Source and matching `lib/` for the revised candidate are committed at **`a7e5d8ea524c13b11f565768f52306a52a19b26a`**. The following cleanup only removes temporary delivery files, adds repeatable cross-platform measurements and updates this record.

Read [scope, rejected candidate and measurements](docs/performance-cp13.md) first. A branch having files does not by itself establish a main merge or a new Desktop acceptance.

### Delivered changes

- Keep Node's existing canonical Base64 decode/re-encode validation. Add only a constant-time length precheck so oversized data is rejected before buffer allocation. A full JavaScript alphabet scan was tested and **rejected for slowing large-file calls**.
- Avoid Buffer.concat for a complete one-chunk RPC frame; fragmented framing retains the same accumulator and byte limits.
- Reuse the private Python bytearray returned by read_bytes and short-lived memoryview slices during RPC transfer, instead of copying full native buffers.
- Limit the source prefix before UTF-16 newline sampling while preserving the exact 4096-code-unit boundary and surrogate behavior.
- Cache the immutable bundled bootstrap string per module. No file-content cache, mutable global pool, user-specific state or new worker is introduced.

### Evidence already completed

- [First delivery](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39214043822): behavior passed, but the new alphabet scan made large-file timings worse. Its runtime `5ab03baf29cfeced9c5714ce258bd969dabaae97` and readings remain in history; do not present them as an accepted optimization.
- [Revised delivery](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39214557044): source/build, unit, fixed-host, native files, Loader, owner, mixed load, RPC, type-baseline, documentation, clean installation and reproducible build passed; published `a7e5d8ea` after checking the branch lease.
- The second Linux comparison has 16 alternating samples per backend and size. Large-file read/edit medians improved modestly, while writes were effectively flat and some rows had outliers. This is not Windows latency or a blanket speedup. Full readings: [Linux JSON](docs/performance-cp13-linux.json).
- Added regressions cover 8192 padding combinations against the original canonicality rule, pre-allocation oversized rejection, repeated valid bootstrap generation and actual-host non-BMP/CRLF edit comparisons. Protocol errors, guards, cancellation and no-replay tests remain.

The final PR runs existing cross-platform suites plus `native-rpc-performance` on Linux and Windows/WSL2. Read completed results for the exact PR head; not-yet-finished checks do not count as passes. Temporary publishing scripts are removed and the permanent measurement workflow has read-only repository permissions.

### Reproduce and continue

Node 24 development checkout:

```text
npm ci
node ci/install-pinned.mjs
npm run test:unit
npm run test:node
npm run test:search-transport
npm run test:native-files
npm run test:rpc-loader
npm run test:rpc-owner
npm run test:rpc-mixed
npm run test:rpc-busy
npm run typecheck:gate
npm run verify:install
```

Repeat native/Loader/owner/mixed/busy with `DSH_WSL_TEST_PLANE=lib`. `test:rpc-busy` actually runs beyond the 120-second idle timeout. Windows uses the real `WSL_COMPAT_DISTRO`; Linux cannot stand in for Windows results.

`npm run bench:native-rpc -- --baseline <CP12 worktree> --iterations 24 --output <json>` reuses the existing native fixture and compares actual resolve+stat+read/guarded-write/edit calls. See `.github/workflows/native-rpc-performance.yml` for baseline checkout and dependency setup. Timings and Python sampling allocations are separately labeled; none are model/GUI latency or total process RSS.

### Boundaries

Never replay a dispatched mutation, silently fall back to UNC after an unknown write, weaken physical-path authorization or version/atomic-publication guarantees, discard Loader default metadata or share workers across owners. Existing size/queue/identity limits and error mappings remain. The historical 209-error type baseline was not raised or cleared. No new raw user evidence was uploaded, and prior CP11 acceptance is not a fresh test of CP12 or CP13.

DSH host installation/hot reload stays with upstream; the user accepts complete restart. No Skill adaptation, watch, PTC migration, unrelated UI, npm release, local profile edit or downloadable plugin package belongs to this pass.

## Earlier checkpoints

[Complete pre-CP13 checkpoint at CP12](https://github.com/yaelysia/dsh-wsl-workspace/blob/30b9abf7496d818c1f43a69ee50745e924e8a37a/CHECKPOINT.md) preserves CP11 user acceptance, CP10 Loader repair and links to CP0–CP9.

[CP12 simplification](docs/code-simplification-cp12.md) remains separately tracked in [PR #9](https://github.com/yaelysia/dsh-wsl-workspace/pull/9). Its formerly stalled WSL2 environment job was requested to rerun without code/assertion changes; consult its latest status before describing that complete matrix as green. The original main baseline is `22c3349874e4968f0ca751f3aaa873d43adacd42` (README rewrite).
