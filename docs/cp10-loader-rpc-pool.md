# CP10: CP8 retest and actual Loader entry repair

Branch: `fix/cp8-loader-rpc-pool`, based on main `cc5a25e415cb9ab3a0b526eeedc59ac38468df91`. Runtime/build delivery: **`1c257fadddf6c9a786b691f9700c8460ae7527ff`**. This record replaces the initial investigation-only status, without claiming a new Desktop installation or main merge.

## Accepted user evidence (2026-10-19)

The user reinstalled the exact main revision on DSH Desktop/host 0.2.1-rc.2. Both lockfiles resolve it and all 18 installed JavaScript files match its GitHub tree. No local patch or relevant configuration/environment override was reported. Raw performance snapshots confirm separate search and filesystem pools during basic work, after idle recovery, and after a complete restart.

Preserve **R0=P, R1=F, R2=F, R3=P, R4=F**. Reads/writes/edits, workspace isolation, old sessions, idle recovery and restart persistence work. R1/R2/R4 fail the shared-pool criterion. Both pools finish with pending=0 and fallbacks=0. This is one remaining pooling defect across three scenarios, not three independent filesystem failures. The installation had no hot-reload error; this does not close the separate host updater defects from CP9.

| Snapshot | Search | Native files |
|---|---|---|
| Basic | launches=1, workers=1; grep/glob each 3 | launches=1, workers=1; read=4, write=1, edit=1 |
| Idle (about 186 seconds without file/search traffic) | workers=0, idleReleases=1 | workers=0, idleReleases=1 |
| Recovery | launches=2, workers=1; grep/glob each 5 total | launches=2, workers=1; read=6 total |
| Restart before tools | launches=0, no stages | launches=0, no stages |
| Restart after tools | launches=1, workers=1; grep/glob each 1 | launches=1, workers=1; read=3, write=1 |

No provider contains both families. These anonymized counters are enough to preserve the failure; raw profiles, local paths, tool traces and evidence archives are not committed publicly.

## Cause and narrow repair

The exact main source blob `9d942ee2a67c25963108682d1e5a1fb53d93d4c1` declared named `inject = ['tools', 'fs']` and named `Config`, but ended with `export default apply`. Actual Cordis Loader `unwrapExports()` chooses the default. That function has neither metadata field, so its fs dependency is not registered and search may allocate a standalone pool before the isolated filesystem owner exists.

The previous owner test passed the entire module namespace to `ctx.plugin(search, ...)`. That retained metadata which real file-entry loading discarded, explaining why its green result did not prevent the user's repeated failure.

Only the selected default changes:

```diff
-export default apply
+// Loader selects the default export; keep dependency and schema metadata on it.
+export default { apply, inject, Config }
```

The existing native owner pool and its configuration/identity checks remain unchanged. No global singleton, relaxed authorization, additional process pool or host modification is introduced. Named imports still work, and the default retains the existing apply function and schema.

## Regression exercises the actual boundary

`tests/rpc-loader-entry.test.mjs` contains four cases: metadata on the actual Loader-selected object, a negative control of the old bare default, and two real entry-loading scenarios with reversed provider startup order.

The positive scenarios use the generated isolated WSL group and real `loader.create()` against the source/build search file URL. Only the tools observation sink and Linux-only launch adapter are fixtures. File reads/writes/edits and grep/glob really run; all five operation stages must belong to one pool with one launch, zero pending and zero fallbacks. A parent-realm filesystem deliberately throws if isolation is breached.

Disabling the filesystem owner must remove dependent search tools and dispose its pool. Re-enabling creates a new owner, rebinds search, and again performs actual operations with one shared launch. Disabling only search must leave owner reads usable without a new launch.

`run-rpc-loader-host.mjs` repeats source/lib tests from a temporary copy resolving all DSH peers through one isolated host installation. It checks the requested host version, keeps the plugin's own YAML major, and does not edit a user profile or the main node_modules tree.

## Delivery evidence

[Delivery 39191505119](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39191505119) passed and published `1c257fad`. The pre-repair source failed three positive Loader checks while its old-export control passed; repaired source and build passed all four. Both tested dependency families pass:

| Host | Cordis | Loader | Planes |
|---|---|---|---|
| Pinned 0.2.0-rc.2 | 4.0.4 | 1.0.5 | source and committed build |
| Reported 0.2.1-rc.2 | 4.0.5 | 1.0.6 | source and committed build |

Existing delivery checks also passed: 244 portable tests (one inherited dependency skip), 108 pinned-host tests and integration drivers, 30 RPC cases, native source/lib with Linux's one Windows-only skip per plane, owner/mixed regressions, persona rendering, documentation gates, clean installation and repeated-build hashes. The inherited type gate remains at 209 errors; this does not mean full-project type errors were eliminated.

The first run [39190980888](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39190980888) passed validation but failed publication because the Actions token could not modify a workflow. The workflow edit was then committed via the connector and removed from the job's mutations; the successful second delivery published the tested runtime files. The failed run is not reclassified. Temporary delivery scripts/workflows are removed after delivery.

Cross-platform gates are permanent: `native-files.yml` runs Loader cases along with native/owner/mixed/busy contracts on Linux/WSL1/WSL2 source/lib; `rpc-loader-compat.yml` runs the reported host with real Loader on Linux and Windows/WSL. Final results belong to the exact PR HEAD, not to a previous delivery or to an unrun Desktop session.

## Remaining user confirmation

The accepted installed revision remains `cc5a25e4`, with its failures unchanged. After this repair is approved and installed, repeat only the shared-pool portions of R1, R2 and R4: ordinary file/search calls, idle recovery, and a full restart. Record mixed file/search stages in one owner, launches before/after idle and zero pending/fallbacks. No repeat of the already successful full A/B or old-session suite is required for this export-only correction.

Do not request manual patches or send a package. Source and build are in GitHub. The absence of a hot-reload error in this report is not a deployed fix for the host's separate updater/rollback bugs. Continue from [CHECKPOINT.md](../CHECKPOINT.md) and the PR's exact verification state.
