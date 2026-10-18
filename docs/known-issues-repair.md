# Known-issue repair status (CP7)

Scope: make Windows DSH operate local WSL workspaces quickly and conveniently. Continue the existing `fix/uat-known-issues` / [PR #6](https://github.com/yaelysia/dsh-wsl-workspace/pull/6); no Skill native adaptation or unrelated feature expansion. The main baseline is `a4e650470c9f78a17fd848f960afa2ee4c70be93`, and the unpatched Desktop UAT installation is `767c68188c9a767bbcabeaf735a6aa598d7f39e8`.

## Status by issue

| Issue | Change / evidence | Honest completion boundary |
|---|---|---|
| File/search allocate separate workers during service startup | Search now explicitly depends on `fs` and `tools`, rather than selecting a pool before its filesystem owner becomes available. Real Context tests cover both initialization orders. | Plugin correction and matching build delivered; a new user-Desktop shared-pool observation is not yet available. |
| Owner disposal/replacement | Dependent search lifetime follows filesystem availability; disposing search leaves owner reads usable; distinct owners/metrics policy remain distinct. | Covered by owner lifecycle regression, without introducing a cross-realm singleton. |
| Overlapping work and cancellation | Kernel directory lock keeps a guarded write pending while grep and six reads complete. Cancellation preserves bytes; a later version-guarded edit succeeds. | Delivery validated source and lib on Linux; exact Windows/WSL results are recorded by the PR checks. No imaginary latency guarantee. |
| Busy operation exceeding idle timeout | A real 125-second held mutation at the default 120-second idle limit has no keepalive traffic. Tests require one launch, no idle release and a correct eventual receipt/disk value. | Wired into both planes in Linux, WSL1 and WSL2 CI; only a completed run constitutes a pass. |
| Incorrect help text | Correct default Bash background support, obsolete ten-second cache wording, prefilter description, native file policy and inherited compatibility scope in both languages. | Built help updated; all 13 claims must pass. The two old allowed failures are retired, not ignored. Skill behavior is unchanged. |
| Root Include hot reload | Exact host error reproduced under duplicate app-boot module evaluation; root-owned registration candidate passes isolated Linux/Windows controls. | Host-owned candidate only, not silently deployed by this plugin and not a confirmed diagnosis of the user's runtime. |

## Runtime change and test implementation

The ownership correction is intentionally small: `src/host/wsl-search.ts` declares `inject = ['tools', 'fs']`. Cordis waits for the real owner before `createSearchRunner()` chooses `owner.rpcPoolFor(config)`. Existing independent-owner and explicit configuration behavior remains intact. The file/search worker implementations, write authorization and unknown-result policies are not replaced.

The previous interrupted branch had already added owner and lifecycle suites. During continuation, the unregistered mixed/busy suites were added to npm entrypoints. The fixtures incorrectly read `pending` and `idleReleases` from `snapshot()` (which only exposes workers/launches), and used `oldText/newText` rather than the real exact-edit contract. They now use `diagnostics()`, `oldString/newString` and an expected `{ version }`. These were fixture corrections; the overlap, cancellation, byte verification and later-edit assertions remain. Failed runs were not relabelled as successes.

Documentation gate bookkeeping no longer requires retaining a real product defect merely to exercise allowed-debt arithmetic. `scripts/doc-claim-verdicts.mjs` is used by the actual gate and by synthetic controls for required success, new failure, owed failure, unexpectedly paid debt and unevaluable observations. Both repaired statements are mandatory green claims.

## Verified delivery

[Node 24 delivery 39144920040](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39144920040) checked out `7a532f5625956019c92ea960bdf4eee2c3b88465`, applied the exact hash-checked help corrections, rebuilt, validated and published **`f3888f84616e8b42fee20ea0c76d844ad7e54514`** after verifying that the remote branch had not advanced. The cleanup/checkpoint commit leaves production source and lib unchanged.

The successful delivery includes:

- 244 portable tests passed, one inherited dependency check skipped; 13/13 documentation claims passed with zero declared failures; the documentation link/parity checks passed.
- 108 existing pinned-host tests and the integration drivers, real persona rendering, RPC-owner and mixed-workload suites passed.
- RPC transport, native files in source/lib, owner/mixed on lib, existing type gate and clean installation passed.
- A repeated build reproduced the committed `lib/`; the generated output was committed rather than sent to the user as a separate package.

This delivery is not the long 125-second matrix or a Desktop GUI run. `.github/workflows/native-files.yml` runs file, owner, mixed and busy suites on Linux and both actual WSL versions, twice for source/lib. Read the checks on the exact final PR head for those outcomes. The 209-error type baseline and unrelated historical platform/dependency omissions are not cleared.

## Root Include investigation and tested host-owned candidate

The user's error occurs during profile recomposition before applying the new plugin tree. In the reported `@deepseek-ai/dsh-app-boot@0.2.1-rc.2`, the boot registration is held in a module-local `WeakMap`. The isolated reproduction uses an empty, uniquely created profile, not a user's DSH_HOME or configuration.

[Windows and Linux reproduction 39143663304](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39143663304) demonstrated:

1. Boot/recompose through the same module succeeds, including a service's root context.
2. Re-evaluating the same app-boot ESM under a second URL and recomposing the first root throws the exact missing-root-Include error, although the actual Include still exists.
3. A candidate keeps the exact boot registration on its root context using a stable symbol instead of a module-local WeakMap. A second evaluation can retrieve it; two roots retain distinct Includes; unbooted/disposed roots still reject; disposal removes only its own registration.

The candidate never searches for an arbitrary Include, creates an extra Include or disables the host activation checks. It is implemented inside `scripts/reproduce-profile-reload.mjs` on a separate test-only copy of the installed module and cleaned afterward. It is not imported by plugin runtime or packed `lib/`.

These controls prove a sufficient mechanism, not the identity of the module/context in the user's failure. A second module URL is a controlled reproduction, not a captured trace of their Desktop. Missing boot registration or a different context could still produce the same symptom. The proper fix belongs at the host's boot/module-resolution boundary; this repository contains the reproducer and candidate, not a claim that updating the WSL plugin repairs Desktop hot reload. Saving enablement followed by a full restart remains the demonstrated route.

The exact setup is version-pinned in `.github/workflows/host-reload-reproduction.yml`. Its early attempt lacked an app-boot peer and failed before reproduction; the peer closure was corrected, not mocked. No installed host, user file or local permission was changed.

## Checkpoints and continuation

The interrupted work was recovered from `a2e534ff819182da5e483b02fde7f89248247d94`. Its existing owner fix was retained. `7a532f5625956019c92ea960bdf4eee2c3b88465` completes the mixed test's real request contract; `f3888f84616e8b42fee20ea0c76d844ad7e54514` delivers the tested help/gate changes and rebuilt output. Final temporary build/environment workflows are removed, while ordinary tests and the isolated host reproduction remain.

Continue from [CHECKPOINT.md](../CHECKPOINT.md), not from an old phase branch or chat summary. Retain exact test head/platform, distinguish deployed fixes from candidates, and preserve the previously accepted main installation as a separate UAT record. Raw uploaded user evidence stays private.
