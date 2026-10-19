# CP14 — Measured traversal reductions

## Exact revisions and scope

Baseline: CP13 `f7c051a05c279bec181a2ef0257d6b4240fc9ad4`. Runtime and matching lib: `f01c7f415374cbff467ecb6456e8685da58057f8`. Cross-platform tested head: `f0b0921ed537baf71511e651233637f650867ee8`; its PR test merge was `2de4da04f614b5f6cc507a36d09012626b388705`. The evidence/checkpoint update does not change that runtime. [PR #11](https://github.com/yaelysia/dsh-wsl-workspace/pull/11) is stacked on PR #10, not a main-branch release.

The pass changes fixed-prefix glob traversal and native directory enumeration. It does not claim faster ordinary file read/write/edit, grep, arbitrary glob patterns or overall model/GUI response. Full streaming or a binary RPC protocol was not introduced.

## Reproducible comparison

[Traversal run 39222709579](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39222709579) completed successfully on Linux, Windows/WSL1 and Windows/WSL2. Every platform ran seven new regressions on both source and shipped-library provider/tool entrypoints; all passed, no case skipped. The timing comparison ran on Linux and Windows/WSL2; WSL1 ran correctness checks only.

Benchmark: `npm run bench:traversal -- --baseline <CP13-checkout> --iterations 24 --output <json>`. The baseline SHA is checked. Both revisions operate on the same real disk fixture, alternating order, with three warm-up pairs excluded. Each timing includes actual registered glob execution, or resolve plus listDir, including transport, parsing and result processing. Complete canonical results are deep-equal, not merely equal counts. Each revision has a separate owner pool; both ended with one worker/launch and zero pending/fallbacks.

The fixed-prefix query is `src/components/**/*.tsx`. Its fixture has 120 matching files and 16,000 unrelated files with the SAME .tsx extension across 100 directories. This removes the old basename prefilter as an explanation for the gain. The no-prefix control `**/components/**/*.tsx` returns the same final 120 files but retains broad traversal. Directory fixtures have 24 shallow entries and 2,000 entries beneath a deep parent.

Windows environment: Windows Server 2025 (10.0.26100), Node v24.21.0, Ubuntu-24.04, kernel `6.18.40.1-microsoft-standard-WSL2`. Actual WSL version 2 was explicitly verified. Linux environment: Ubuntu 24.04.5 with the same Node version. Dependencies were the pinned DSH 0.2.0-rc.2 closure; the separate actual-Loader suite also exercises reported host 0.2.1-rc.2. These are warm controlled measurements, not the user's Desktop GUI or all-workload speedups.

## Windows to WSL2: all four measured cases

Milliseconds, 24 alternating samples per revision. P95 uses nearest rank and is not a statistical guarantee across machines.

| Operation | Before P50 | After P50 | Before P95 | After P95 |
|---|---:|---:|---:|---:|
| Shallow directory, 24 entries | 2.718 | 2.431 | 3.398 | 2.718 |
| Deep directory, 2,000 entries | 131.896 | 26.675 | 136.427 | 31.410 |
| Fixed-prefix glob | 153.668 | 14.135 | 158.036 | 15.900 |
| Leading-wildcard control | 153.076 | 154.603 | 156.558 | 160.361 |

In this fixture, fixed-prefix glob took about 1/10.9 of the previous time; deep enumeration took about 1/4.9. The leading-wildcard control was about 1% slower, not an optimization win. The magnitude depends on how much unrelated traversal or repeated ancestor work a real project contains.

## Linux: final 24-sample comparison

| Operation | Before P50 | After P50 | Before P95 | After P95 |
|---|---:|---:|---:|---:|
| Shallow directory, 24 entries | 1.649 | 1.334 | 1.947 | 1.498 |
| Deep directory, 2,000 entries | 124.819 | 22.333 | 130.281 | 25.751 |
| Fixed-prefix glob | 113.449 | 9.747 | 120.920 | 13.884 |
| Leading-wildcard control | 115.981 | 116.214 | 120.121 | 120.186 |

The initial 20-sample Linux delivery run is separately retained in [performance-cp14-linux.json](performance-cp14-linux.json) and [the implementation record](performance-cp14.md). Do not combine independent runs' samples or substitute their absolute times for Windows results.

## Verified work reduction

Fixed-prefix glob returns the same 120 final files, while raw search candidates drop from 16,120 to 120. Windows raw search stdout shrinks from 1,180,805 to 9,405 bytes; Linux from 1,293,652 to 10,252 bytes. These are the decoded search payload bytes before outer RPC framing, not a capture of total physical wire traffic. The no-prefix control has identical payload size and 16,120 candidates before/after.

The benchmark separately profiles actual C calls from the bundled Python enumeration program using sys.setprofile. This is a count of os API calls, not complete kernel syscall tracing:

| Platform/revision | Returned entries | os.lstat | os.stat | os.fstat |
|---|---:|---:|---:|---:|
| Windows/WSL2 before | 2,000 | 26,012 | 2,001 | 0 |
| Windows/WSL2 after | 2,000 | 24 | 2,002 | 1 |
| Linux before | 2,000 | 28,013 | 2,001 | 0 |
| Linux after | 2,000 | 26 | 2,002 | 1 |

Different fixture-parent depth explains the platforms' different lstat counts. Ordinary entries still receive one fresh descriptor-relative metadata read each; no long-lived metadata or file-body cache was introduced.

## Correctness and deliberate boundaries

The search starts at the original physical root, preserves root headers, result paths, final matching, mtime ordering, byte caps and VCS pruning. A nested directory symlink is not turned into a new traversal root. A prefix is used only when safely provable; unsupported, negative or leading-wildcard patterns retain full traversal. Missing explicit roots remain errors. Directed queries no longer encounter errors in unrelated pruned subtrees; errors in traversed directories remain visible.

Enumeration opens the parent once, uses fresh relative metadata, resolves symlinks through the original physical resolver and checks parent inode/physical identity before returning. If the directory is replaced during enumeration, it returns FS_STALE_VERSION rather than mismatched metadata. This is not an atomic snapshot of all concurrent child modifications. Write authorization, version guards, atomic publication, cancellation acknowledgement, unknown-result/no-replay handling, limits and owner isolation are untouched.

The new seven tests include literal-prefix conservatism, actual find result parity, metacharacter physical roots, actual registered source/lib tools and unchanged overflow cap/shared pool, symlink/dangling/fresh metadata, real operation counts, and a deterministic real directory replacement. Helper and profiler-only checks use source code; registered tool/provider behavior is exercised on both source and lib, and existing real Loader tests still run.

## Delivery and evidence retention

The first preparation run 39221746263 failed during the pre-transform unit check; it never published runtime modifications. Its artifact 12172211646 remains available. The successful [delivery run 39222238912](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39222238912) ran the clean CP13 baseline separately, then the reviewed hash-guarded transform and behavior/build gates, measured real tools/providers and published matching source/lib only with a branch lease. No assertion was weakened. The temporary generator and publishing workflow were removed at f0b0921e. The retained traversal workflow has contents:read only.

Raw logs, summary.json and all timing samples are in the traversal run artifacts. Their metadata/digests were checked separately from the completed job logs:

- Windows/WSL2: artifact 12172900848 (`traversal-windows-latest-wsl2`), SHA256 `365f39c0e401464b9dfd7785ec4b8833a55f65ed128d879745c1a9864633ff50`.
- Linux: artifact 12171718972 (`traversal-ubuntu-latest-wsl0`), SHA256 `ef6d2b2e2c0b7d90f698a76746063114843fb97f3351cf4d23889acb0bdd4297`.
- Windows/WSL1 correctness: artifact 12172890472, SHA256 `d8a563b7245dad0290f097bfde5f0eaececd8192a6077e58d75151d6280959e2`.

These artifacts were set to expire 2026-11-02; this document permanently preserves all measured summary rows and the artifact identities. No private user evidence, local profile, npm release or installable package was uploaded. CHECKPOINT.md and the PR carry final exact-head regression status; earlier Desktop acceptance is not a new CP14 GUI test.
