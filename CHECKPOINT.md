# Windows DSH → WSL continuation checkpoint

## CP7: resumed known-issue repairs; keep host and plugin outcomes separate

Active work: `fix/uat-known-issues`, [PR #6](https://github.com/yaelysia/dsh-wsl-workspace/pull/6), based on main `a4e650470c9f78a17fd848f960afa2ee4c70be93`. Do not restart the four completed implementation stages. The user's accepted installed build remains `767c68188c9a767bbcabeaf735a6aa598d7f39e8`; this branch has not been deployed to their Desktop or merged into main.

The latest tested runtime/build checkpoint is **`f3888f84616e8b42fee20ea0c76d844ad7e54514`**. It includes the previously interrupted RPC-owner correction and the resumed help corrections. [Delivery run 39144920040](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39144920040) verified and pushed that commit. This document/cleanup commit does not alter `src/` or `lib/`. Its own additional cross-platform checks must be read from PR #6, not inferred from an earlier green run.

### Completed in this branch

- `src/host/wsl-search.ts` declares `inject = ['tools', 'fs']`. Real Cordis lifecycle waits for the filesystem before selecting its RPC pool, and tracks its replacement/disposal. No global pool or cross-permission sharing was added.
- `tests/rpc-owner-lifecycle.test.mjs` checks both initialization orders, one shared launch after file/search use, search disposal without killing its owner, separate owners and explicit metrics policies.
- `tests/rpc-mixed-lifecycle.test.mjs` holds a real directory lock while a guarded mutation overlaps grep and six reads, cancels the mutation, independently verifies unchanged disk content and performs a later guarded edit. Use `diagnostics().pending`, not the deliberately smaller `snapshot()`. Exact edits use `oldString/newString` and an expected `{ version }`.
- `tests/rpc-busy-idle.test.mjs` holds a mutation for a real 125 seconds at the 120-second idle default, with no keepalive request. Source/lib runs are wired into Linux and WSL1/WSL2 CI. A submitted test is not a passed test; final results live in the exact PR run.
- Bilingual help now describes the shipped background option, cache invalidation, native-file policy, search prefilter and inherited compatibility scope. The two previously allowed documentation defects are required regressions. All 13 documentation claims passed in delivery; synthetic observations still verify the real gate's failure accounting.
- Matching `lib/` is rebuilt and committed. Temporary delivery/environment workflows and the temporary transform are retired after their work; ordinary regression workflows remain.

### Host reload: reproduction and candidate, NOT a deployed fix

`profile reload requires the root Include entry` remains unresolved on the user's installed host. In isolated DSH `0.2.1-rc.2`, a second evaluation of app-boot loses the first evaluation's module-local WeakMap registration and reproduces the exact error. A host-owned candidate stores the exact boot registration on the root context with a stable symbol, preserving root separation and disposal checks. The same-module and service-root controls, duplicate-module failure, candidate two-root success and absent/disposed-root rejection passed on Linux and Windows in [39143663304](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39143663304).

This establishes a sufficient failure mechanism, not that the user's Desktop has that precise module duplication. The plugin does not rewrite installed host JavaScript, create a second root Include, suppress the error or relax activation validation. The candidate is contained in the isolated reproduction script, outside shipped `lib/`. A real host repair requires host-owned integration and verification against the failing runtime. Preserve the accepted full-restart route meanwhile.

### Resume commands and source locations

Read current branch HEAD, this file, [known issue status](docs/known-issues-repair.md), and PR #6 checks first. Node 24 development checkout:

```text
npm ci
node ci/install-pinned.mjs
npm run test:unit
npm run test:node
npm run test:rpc-owner
npm run test:rpc-mixed
npm run test:rpc-busy
npm run test:native-files
npm run test:search-transport
npm run test:docs-claims
npm run typecheck:gate
npm run verify:install
```

Run file/owner/mixed/busy suites again with `DSH_WSL_TEST_PLANE=lib`. In PowerShell set `$env:DSH_WSL_TEST_PLANE='lib'`; use the actual `WSL_COMPAT_DISTRO`. Linux execution is not a substitute for Windows/WSL. `test:rpc-busy` deliberately takes more than 125 seconds per plane. The host reproduction's isolated peer setup is in `.github/workflows/host-reload-reproduction.yml`; run `node --expose-internals scripts/reproduce-profile-reload.mjs` only against that isolated test tree, not a user profile.

Core file code remains in `src/fs.ts`, `src/shared/native-files.ts`, `native-file-worker.ts`, `rpc-transport.ts`, `rpc-worker.ts`. Do not hand-edit only `lib/`; rebuild after source changes and retain source/lib checks.

### Remaining boundaries

The historical 209-error type baseline is not cleared. Busy/mixed CI scenarios do not retroactively mark the earlier Desktop UAT as having run them. The user's actual one-pool outcome after this correction remains to be checked. The existing Windows-mount contracts are not a new Desktop UAT. Formal release and unlisted host versions are not claimed.

Do not automatically replay a dispatched mutation, rewrite it through UNC after a native result is unknown, weaken Linux physical-path authorization or version guards, or introduce cross-owner state. Native files remain bounded to 16 MiB full reads/write/edit inputs. No Skill native adaptation, inotify/watch, PTC sandbox migration, body cache or unrelated UI project belongs to this work.

## Earlier checkpoints and accepted baseline

[CP0–CP6 full checkpoint at the main baseline](https://github.com/yaelysia/dsh-wsl-workspace/blob/a4e650470c9f78a17fd848f960afa2ee4c70be93/CHECKPOINT.md) preserves all prior SHAs, merge history and validation scope. Durable evidence: [native file validation](docs/native-files-validation.md), [first UAT and persona fix](docs/uat-2026-10-18.md), [unpatched main UAT](docs/uat-main-2026-10-18.md).

| Checkpoint | Exact baseline | Meaning |
|---|---|---|
| Native implementation | `a342fdb4e848ebf8d63e88c917739a66e530d09a` | Guarded native files and RPC |
| Warm executors | `b473fa02911983c7f410e9a82e36f26ec5038ecf` | Reused Linux file interpreters |
| CP1 routing | `2d3948d00be3642ddee83cbefed56cebde8e6178` | Windows-drive directory entries use consistent targets/versions |
| CP4 persona | `677a2178b16a443746460e3b62e0415278d3b566` | Removed plugin-added undeclared cwd interpolation |
| CP5 main merge | `10e22b906fa5ff3436c47b22520741a5526c9822` | PR #1/#3/#4/#5 merged with history preserved |
| CP6 actual installation | `767c68188c9a767bbcabeaf735a6aa598d7f39e8` | Main installed without a local patch; minimum tools/restart passed |
| CP7 resumed repairs | `f3888f84616e8b42fee20ea0c76d844ad7e54514` | Owner dependency, lifecycle regressions, help and matching build |

Raw user profiles, workstation paths and conversation logs remain private and are not committed. Use `git log -1 -- CHECKPOINT.md` to identify this continuation record.
