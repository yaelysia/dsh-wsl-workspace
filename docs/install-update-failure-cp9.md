# CP9: failed main update; reconcile installation before further UAT

## State and evidence boundary

The user reports that updating the Git main installation failed, with three suspected causes: Windows path case aliases evaluated app-boot twice, Git URL/shorthand source identity failed, and rollback restored manifests/lockfiles but left changed node_modules. These are a new installation failure report, not a successful CP8 UAT.

- PR #6 was merged into main at `deaec609ef8c8eb8ced1a541e3d684f310c6da1f`; its tree equals the tested PR head. [CP8 merge and UAT handoff](https://github.com/yaelysia/dsh-wsl-workspace/pull/6#issuecomment-6257194042).
- Last accepted unpatched Desktop installation: `767c68188c9a767bbcabeaf735a6aa598d7f39e8`. This is a historical observation, not proof that the installation still resolves to that commit after the failed update.
- The source review below uses upstream commit `687f282e8625c6b8d11ff58211a90524be2e4317`. No newly uploaded failure trace, actual pair of resolved module URLs, or installed dependency inventory was available for this review. The earlier UAT report for `0676ed1f` is not evidence for this new update attempt.
- No host binary, user profile or installed node_modules was changed. This checkpoint and the root navigation update change documentation only. They do not deploy a host repair or establish that Windows path case was reproduced in this round.

## Source-confirmed defects and limits

### Root Include registration

`packages/boot/app-boot/src/index.ts` stores `bootstrapIncludes` in a module-local WeakMap and rejects recomposition when `bootstrapIncludes.get(ctx)` is absent. CP7 already reproduced separate module evaluations with a controlled URL and validated a root-owned-registration candidate. That establishes a mechanism, not the precise Windows path aliases in this latest report.

A host repair should canonicalize module identity at the loader boundary and retain the exact boot registration with its root context across legitimate module reevaluation. Do not create a guessed second Include, suppress the error, lower-case arbitrary Linux paths, or remove root/disposal isolation. The case-only Windows URL reproduction is still required.

### Git identity and unchanged manifest

`packages/boot/plugin-manager/src/index.ts`, `specPackageName()`, compares candidate specs to `dependencySpec()` output as strings. `install-spec.ts` recognizes Git forms but does not provide a canonical repository-plus-ref identity.

`installBundle()` derives installed targets from changed dependency strings; when no strings changed, it falls back to the same source comparison. A Git branch can resolve to a new commit without changing its manifest string. A full GitHub URL and a pnpm `github:owner/repo#main` representation therefore can fail this target identification path.

Important: source normalization alone does not implement updates. With HMR enabled, identifying an already installed target currently produces `already-installed`. The update lifecycle must explicitly handle an existing target, rather than accidentally bypassing that refusal through a different source spelling.

Use one shared source identity for inspection, target identification and updates; preserve the requested ref's case and meaning, distinguish different repositories/hosts/subdirectories, and reject ambiguous alias targets rather than choosing the first changed dependency. Keep the requested source, resolved revision and installed package identity separate.

### Rollback and activation boundary

`RESTORED_FILES` contains only package.json and pnpm-lock.yaml. `restoreFiles()` writes those files back or removes newly created ones; it does not restore the active dependency tree. The install catch uses that routine. Retaining a download cache is not the same as retaining new files or links in the active node_modules.

The later activation phase is outside the install rollback try/catch. Failed activation therefore has different persisted-state semantics from failed installation. These outcomes must be reported separately.

Additional reporting defect: `change()` computes `changed` from `diskState()`, which omits pnpm-lock.yaml and node_modules. An unchanged manifest and changed installed dependency can therefore still report `changed=false`. Do not rely on that flag as proof of complete rollback.

## Repair order and acceptance contract

1. Establish the current three-way state: requested/locked revision, installed package directory/bytes and live loaded module identity. Preserve the failed attempt's evidence first; do not blindly repeat uninstall/reinstall or delete the whole DSH profile.
2. Repair host transaction/rollback reporting. Prefer installing and validating a candidate in an isolated generation before switching the active resolution. Preserve a recoverable prior generation. Any minimal repair that reconstructs dependencies from an old lockfile must verify that restoration succeeded and handle cancellation/offline/restore failure explicitly; another successful command alone is not proof of byte/runtime identity.
3. Repair source equivalence and explicit existing-package update behavior together. A same-main update must be recognized even when the manifest is byte-identical; multiple matches must be rejected before mutation.
4. Repair host module identity and root registration, then validate actual Windows case aliases and the complete install/enable/remove reload path.

Required failure-injection checks:

- Full GitHub URL and github shorthand identify one repository/ref target; case-sensitive branch names and distinct sources remain distinct.
- Updating the same branch changes the resolved commit without requiring a changed manifest string.
- Failure after dependency installation restores or explicitly isolates the previous active dependency graph, lock and selection; failed restoration must not claim cancellation/no-change success.
- Failure during activation reports installation and activation separately, and does not silently leave a stale/new runtime mixture.
- Windows case-only imports reach the intended root Include; independent roots and disposed roots remain isolated.
- A failed attempt followed by a clean restart and another update is verified, not only a successful first installation.

## UAT status and next evidence

CP8 R0 is failed for the reported update; R1-R4 are blocked/not measured on a confirmed new installation. Do not merge the previous tool passes into this attempt. File/search backend tests remain historical valid evidence for their exact builds but do not validate the host update transaction.

The next useful private evidence is the current update error and phase, both app-boot module URLs, relevant pre/post manifest and lock entries, actual resolved plugin directory and file hashes, and any rollback output. Do not publish tokens, complete personal configuration, private project paths or raw session logs in this public repository.

Continue from this checkpoint without adding Skill adaptation, watch/inotify, another RPC backend or self-modifying installed-host code. Host repairs require a host-owned source/integration target; shipping the same fixes inside an ordinary WSL plugin cannot repair the installation code that must execute before that plugin loads.

## Source anchors

- [app-boot](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/index.ts)
- [plugin-manager](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/plugin-manager/src/index.ts)
- [install-spec](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/plugin-manager/src/install-spec.ts)
- [CP7 investigation and candidate](known-issues-repair.md)
