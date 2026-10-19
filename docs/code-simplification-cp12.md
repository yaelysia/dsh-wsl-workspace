# CP12 — Code simplification

## Scope and checkpoints

Base: `main` at `22c3349874e4968f0ca751f3aaa873d43adacd42` (the rewritten README and the previously accepted RPC-pool fix). Work branch: `refactor/simplify-rpc-files`. This is a bounded refactor, not a feature removal or a new transport implementation.

- Preparation: `a70fbb33d904c926304e98a9a1fd2a59f8542fba` stored the exact reviewed transform, guarded by the input Git blob hashes.
- Tested source and matching build: `3223cbb874c5c27a6d7cbfe7d2f2bff081ab7954`, published by [delivery run 39209266568](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39209266568) only after the tests passed and the remote branch still matched the checked-out head.
- Cleanup: the temporary transform and publishing workflow are removed. Permanent source/tests and this record remain; the cleanup does not change the tested runtime or build.

Start with [CHECKPOINT.md](../CHECKPOINT.md). CP11's user acceptance remains historical evidence of its own build, not a fresh Desktop test of this refactor. DSH host hot reload is outside this work; the user accepts a complete restart for updates and leaves host changes to upstream.

## Actual simplifications

| Area | Before | After |
|---|---|---|
| Process output model | A separate search-only WslRun duplicated RPC result fields | Search uses the existing RpcRun type; stderr still stays as bytes until its existing decoder |
| Execution statistics | One-shot search and RPC each classified abort/overflow/exit codes | One rpcRunOutcome function, preserving order and grep's successful no-match exit 1 |
| Byte validation | RPC envelopes and native file bodies each decoded and canonicalized base64 | One decodeRpcBytes function; native callers still translate validation failures to the original FS_IO_ERROR/message |
| Worker termination | break and dispose separately traversed/settled pending calls before shared shutdown | One idempotent close path, retaining error-vs-cancel distinctions and unknown outcomes for dispatched mutations |
| File coordinates | processPath independently decoded native/UNC/drive identities | It reuses the existing worldPath resolver used by containment |
| Glob projection | An accumulator/push loop after matching and sorting | A direct map with unchanged order and contents |

Five runtime TypeScript files changed, with 37 added and 61 removed source lines (net **24 fewer**); regression tests add 52 lines. These are code/diff counts, not performance results. No new runtime file, dependency, worker, cache or public configuration is introduced. Hashed lib chunk names and their imports change as a normal rebuild consequence.

## Validation

The successful delivery run first executed the base unit/RPC tests, then applied the exact change, built, and passed:

- Portable unit tests plus the new result-classification table; the existing inherited dependency skip remains.
- Pinned-host tests and integrations, including persona, search prefilter, owner lifecycle, mixed workload and the actual Loader file-entry path.
- RPC transport tests, including two new byte-decoding regressions. The native-client parser test supplies response data through a stub pool; it is not presented as a real WSL execution test.
- Source and committed-build native files, owner, Loader and mixed-workload suites on Linux. The Windows-only file case remains a platform skip on Linux.
- An isolated DSH `0.2.1-rc.2` dependency tree running the actual Loader test on both source and lib.
- Existing typecheck gate (historical 209-error baseline not raised), documentation gates, clean package installation and byte-for-byte repeated build.

The final PR runs the existing Windows/WSL1/WSL2 source/lib matrices, search, native files (including real 125-second busy lifetime), and reported-host Loader checks. Read their completed results on the exact final PR head; this delivery's Linux pass is not a substitute for those runs or a Desktop GUI test.

No speedup is claimed. No assertion was removed or relaxed; the worker ownership/identity, Loader default metadata, startup-only fallback, path permissions, write versions, atomic publication and no-replay guarantees stay in place. README, Skill behavior, watch, PTC, host installer and hot reload are unchanged.
