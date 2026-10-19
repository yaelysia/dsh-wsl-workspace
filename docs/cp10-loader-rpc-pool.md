# CP10: CP8 retest and actual Loader entry repair

Continuation branch: `fix/cp8-loader-rpc-pool`, based on main `cc5a25e415cb9ab3a0b526eeedc59ac38468df91`.

## Accepted evidence (2026-10-19)

The user reinstalled the exact main revision on DSH Desktop 0.2.1-rc.2. Both lockfiles resolve that revision and all 18 installed JavaScript artifacts match its GitHub tree. No local patch or RPC configuration/environment override was reported. Raw performance snapshots confirm separate active search and filesystem providers before idle, after recovery, and after a complete restart.

Preserve the user's full acceptance results: **R0=P, R1=F, R2=F, R3=P, R4=F**. Reads/writes/edits, workspace isolation, old sessions, idle reclamation/recovery and restart persistence work; R1/R2/R4 fail the shared-pool requirement. Active pools finish with pending=0 and fallbacks=0. Installation reported no hot-reload error this time; this does not prove the separate host updater defects are repaired.

The private report and raw tool traces stay outside this public repository. Do not reinterpret the failure as old installed code, a configuration override, a provider-count misunderstanding or three independent filesystem failures.

## Reproduced export-boundary defect

At the exact main source blob `9d942ee2a67c25963108682d1e5a1fb53d93d4c1`, `wsl-search.ts` exports named `inject = ['tools', 'fs']`, but its default export is the bare `apply` function. Actual Cordis Loader `unwrapExports()` selects that default; the function has neither `inject` nor `Config`. This is reproduced with real Loader 1.0.5 and 1.0.6. Previous owner tests pass the module namespace directly to `ctx.plugin()`, preserving metadata that real entry loading discards.

This explains why the prior declaration-only correction did not protect actual loading. The next checkpoint must exercise the real Loader entry path, including an isolated WSL realm, both provider orders and disposal/replacement. Do not add a global pool or weaken owner/identity/configuration isolation.

## Current work boundary

Investigation checkpoint only. No production source/lib change has yet been delivered on this branch. Next: preserve metadata in the Loader-selected default, add a regression that fails on the exact previous entry, verify source and committed lib against the actual host dependency families, rebuild and submit matching artifacts. Do not mark a new Desktop UAT as passed before the user tests it.
