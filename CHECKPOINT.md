# Windows DSH → WSL continuation checkpoint

## CP10: actual Loader export repair; preserve the failed shared-pool UAT

Active continuation branch: **`fix/cp8-loader-rpc-pool`**, based on main `cc5a25e415cb9ab3a0b526eeedc59ac38468df91`. The runtime repair and matching build were delivered at **`1c257fadddf6c9a786b691f9700c8460ae7527ff`**. Read [CP10 cause, evidence and retest boundary](docs/cp10-loader-rpc-pool.md) first. Do not restart the four completed implementation stages or the CP7 repair.

### Latest actual user installation

On 2026-10-19, the user cleanly installed main `cc5a25e4` on Desktop/host **0.2.1-rc.2**. Both lockfiles and all 18 installed JavaScript artifacts were checked against that revision. No relevant configuration/environment overrides were found. This supersedes CP9's uncertainty about the files left by the previous failed update.

Keep the reported full acceptance result unchanged: **R0=P, R1=F, R2=F, R3=P, R4=F**. Core read/write/edit/search, A/B isolation, old sessions, idle reclamation/recovery and restart persistence work. R1/R2/R4 fail because file and search remain in two separate pools, before idle, after recovery and after a complete restart. Active pools finish with pending=0 and fallbacks=0. This was not a provider-count misunderstanding or an old installation.

No hot-reload error occurred during that installation. This is not proof that the separate host source-identity, rollback or root-Include defects are repaired. Do not request the already supplied report again, mark this revision's shared-pool UAT as passed, or tell the user to retest unchanged `cc5a25e4`.

### Delivered correction

`src/host/wsl-search.ts` previously exported named `inject` and `Config` but a bare `apply` as default. Actual Cordis Loader selects the default export and therefore discarded both metadata fields. The CP7 tests passed a whole module namespace to `ctx.plugin()` and did not exercise this boundary.

The production change is only:

```ts
// Loader selects the default export; keep dependency and schema metadata on it.
export default { apply, inject, Config }
```

No filesystem/RPC algorithm, native mutation policy, identity key, global pool, dependency version or installed host file is changed. Named exports remain available. `lib/wsl-search.js` and its source map were rebuilt and committed with the source.

### Regression and delivery evidence

- `tests/rpc-loader-entry.test.mjs` uses real Loader file-entry loading inside the generated isolated WSL group. It covers both startup orders, one actual file/search worker, owner disable/re-enable and rebinding, search disposal without killing its owner, and rejection of a parent-realm filesystem. A retained old-export control demonstrates premature tool registration.
- Before repair, the exact main source fails three positive checks; after repair all four cases pass on source and lib. The tests use the existing native backend and Linux operations, not mocked file results or a fake Loader.
- [Delivery 39191505119](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39191505119) completed successfully and pushed `1c257fad`. Pinned DSH 0.2.0-rc.2 / Cordis 4.0.4 / Loader 1.0.5 and isolated reported DSH 0.2.1-rc.2 / Cordis 4.0.5 / Loader 1.0.6 passed the same source/lib Loader regression.
- Existing portable, host, native-file, RPC, persona, documentation, repeated-build and clean-install checks passed in delivery. The inherited **209-error type baseline** and Linux's Windows-specific file-test skip are not cleared.
- `.github/workflows/native-files.yml` adds the real Loader test to Linux/WSL1/WSL2 source/lib loops. `.github/workflows/rpc-loader-compat.yml` independently runs the reported host on Linux and Windows with WSL. Read the final PR HEAD checks for those cross-platform results; submitted jobs are not automatically passes.

The first delivery's validation passed but its push was rejected because GITHUB_TOKEN cannot modify workflows. Workflow registration was committed through the GitHub connector; the next delivery passed and published source/lib without workflow changes. Temporary delivery files are now removed. Do not mislabel the first overall run as successful or mistake its unpushed commit for the delivered one.

### Resume and limited retest

Use Node 24 in a development checkout:

```text
npm ci
node ci/install-pinned.mjs
npm run test:rpc-loader
DSH_WSL_TEST_PLANE=lib npm run test:rpc-loader
npm run test:node
npm run test:native-files
npm run test:search-transport
npm run typecheck:gate
npm run verify:install
```

The reported-host peer closure is in `.github/workflows/rpc-loader-compat.yml`; `node scripts/run-rpc-loader-host.mjs .host-current 0.2.1-rc.2` tests it without touching a user profile. PowerShell uses `$env:DSH_WSL_TEST_PLANE='lib'` instead of Bash assignment. Windows checks use the actual `WSL_COMPAT_DISTRO`.

Once the repaired code reaches an installable approved revision, only shared-pool closure needs renewed Desktop evidence: R1 ordinary file/search operations in one new WSL Standard session, R2 idle/recovery, R4 full restart. Within one unchanged owner/identity/configuration, one provider must contain both file and search stages; first active use launches once, idle recovery adds one launch, later search reuses it. Preserve R0/R3's existing result. Do not count different permission owners as leaks or use a Bash sleep as a file-RPC lifetime test.

## Historical checkpoints and boundaries

[Full CP0–CP9 record at the accepted main revision](https://github.com/yaelysia/dsh-wsl-workspace/blob/cc5a25e415cb9ab3a0b526eeedc59ac38468df91/CHECKPOINT.md) preserves prior SHAs, merge history and verification limits. [CP8 merge](https://github.com/yaelysia/dsh-wsl-workspace/pull/6#issuecomment-6257194042) remains the main PR #6 merge record; [CP9 host findings](docs/install-update-failure-cp9.md) remain separate unresolved host concerns. [Native evidence](docs/native-files-validation.md), [initial UAT](docs/uat-2026-10-18.md), [earlier main UAT](docs/uat-main-2026-10-18.md) and [CP7 repair](docs/known-issues-repair.md) are historical, not replacements for the latest report.

Keep checkpoints and matching source/lib. Never replay dispatched mutations, switch to UNC after an unknown native write outcome, weaken path authorization/version checks or introduce cross-owner state. No Skill adaptation, inotify/watch, PTC migration, body cache or unrelated UI belongs to this fix. Raw user evidence remains private. No package is sent to the user, no npm release is made, and this checkpoint itself does not establish a new Desktop pass or a main merge.
