# Windows DSH → WSL continuation checkpoint

## CP14: validated traversal reduction

Active branch: `perf/cp14-prune-enumeration`; [PR #11](https://github.com/yaelysia/dsh-wsl-workspace/pull/11), stacked on CP13 [PR #10](https://github.com/yaelysia/dsh-wsl-workspace/pull/10). Base is `f7c051a05c279bec181a2ef0257d6b4240fc9ad4`. Runtime and matching lib were published at **`f01c7f415374cbff467ecb6456e8685da58057f8`**. The complete tested head is **`f0b0921ed537baf71511e651233637f650867ee8`**; its PR test merge was `2de4da04f614b5f6cc507a36d09012626b388705`. This evidence update changes only Markdown, not that runtime or lib. Check live refs before continuing; none of these facts establishes a main merge or new Desktop GUI acceptance.

Read [final Windows/Linux measurements and evidence](docs/performance-cp14-validation.md) first. [Implementation and initial Linux readings](docs/performance-cp14.md) retain the earlier experiment separately.

### Delivered behavior

- A provable literal-directory prefix from glob patterns is passed as data to the existing Linux find script. Unrelated subtrees are pruned before their files become traversal/transport candidates. The original physical search root, headers, final matcher, sorting, VCS rules and nested-symlink no-follow behavior remain. Negative or uncertain prefixes retain broad traversal. Grep is unchanged.
- Native listDir opens its parent once and uses fresh descriptor-relative metadata for ordinary entries instead of rewalking their common ancestors. Symlinks still receive physical resolution and target metadata. Parent inode/physical-path replacement is detected before returning. No file content or metadata cache survives the call.
- Directed queries no longer encounter permission failures inside unrelated pruned subtrees. Explicit root and traversed-directory errors remain. Enumeration can return FS_STALE_VERSION if its parent is replaced; it is not an atomic snapshot of all changing children.

### Measured result, not an inferred blanket speedup

Windows-to-WSL2, 24 alternating samples after three warm-up pairs, full returned results equal on the same disk fixture:

| Operation | CP13 P50 ms | CP14 P50 ms |
|---|---:|---:|
| Shallow directory, 24 entries | 2.718 | 2.431 |
| Deep directory, 2,000 entries | 131.896 | 26.675 |
| Fixed-prefix glob | 153.668 | 14.135 |
| No-fixed-prefix control | 153.076 | 154.603 |

The first glob scenario has 120 selected .tsx files plus 16,000 irrelevant .tsx files. Returned search candidates fall from 16,120 to 120; raw stdout payload from 1,180,805 to 9,405 bytes. These are decoded search payload bytes, not a physical wire trace. For the deep enumeration, actual os.lstat calls fall from 26,012 to 24 while one fresh stat per entry remains. The no-prefix control has no gain. All P95s, Linux results, full methodology and artifact digests are preserved in the final evidence document.

### Completed regression status at f0b0921e

All jobs of the following seven workflows were read back completed/success:

| Check | Run |
|---|---|
| Traversal contracts and Linux/Windows-WSL2 paired measurement | [39222709579](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39222709579) |
| Full committed-artifact, pinned-host and WSL1/WSL2 compatibility | [39222709414](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39222709414) |
| Native files, owner/mixed lifecycle and real 125-second busy lifetime | [39222709434](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39222709434) |
| Reported-host actual Loader | [39222709474](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39222709474) |
| Search/RPC | [39222709760](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39222709760) |
| Existing native-RPC comparison | [39222709477](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39222709477) |
| Persona compatibility | [39222709586](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39222709586) |

New traversal regressions are 7/7 on both source and shipped-library provider/tool paths under Linux, Windows/WSL1 and Windows/WSL2. WSL1 timing comparison is intentionally not run. Pure helper/profiler checks read source; the actual provider and registered glob are tested on both planes. Existing platform/dependency skips stay explicit, and the historical 209-error type baseline is neither increased nor cleared. Documentation-triggered later jobs are distinct from this completed runtime validation.

The first preparation run 39221746263 failed before applying runtime changes; its logs remain. Successful delivery [39222238912](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39222238912) tested a clean CP13 baseline, applied exact hash-guarded edits, built and ran old/new contracts, measured and published matching src/lib with a branch lease. Temporary publishing files were deleted at f0b0921e; the retained traversal workflow has read-only repository permissions.

### Reproduce and continue

Use Node 24, `npm ci`, then `node ci/install-pinned.mjs`. Run `npm run test:traversal`, then repeat with `DSH_WSL_TEST_PLANE=lib`. Existing `test:unit`, `test:node`, `test:search-transport`, `test:native-files`, `test:rpc-loader`, `test:rpc-owner`, `test:rpc-mixed`, `test:rpc-busy`, `typecheck:gate`, `test:docs`, `test:docs-claims`, `verify:install` and reproducible build remain required.

For measurement use `npm run bench:traversal -- --baseline <CP13-worktree> --iterations 24 --output <json>`; baseline must equal f7c051a0. See `.github/workflows/traversal-performance.yml` for shared dependency setup and actual WSL-version verification. Do not substitute Linux-native timings for Windows or count model/GUI wait in these provider timings.

No mutation/permission/version/atomic-publication or unknown-result/no-replay changes; no extra worker, dependency, configuration, global cross-owner pool, Skill/watch/PTC or host hot-reload work. DSH host updates stay with upstream; the user accepts full restart. No user profile, local installation, private evidence or npm release was changed. Do not send an installable package.

### Earlier checkpoints

[Complete checkpoint before this evidence update](https://github.com/yaelysia/dsh-wsl-workspace/blob/f0b0921ed537baf71511e651233637f650867ee8/CHECKPOINT.md) preserves CP13 validation and links to CP12, CP11 Desktop acceptance, CP10 Loader repair and CP0–CP9. [CP13 results](docs/performance-cp13-validation.md) remain an allocation-oriented pass with mixed latency, not the much larger gains of this separately measured traversal pass. Earlier PRs #9 and #10 remain independent stacked dependencies; inspect live states before merging.
