# CP14 — Reduce traversal work, not just buffer copies

Baseline: CP13 `f7c051a05c279bec181a2ef0257d6b4240fc9ad4` (PR #10). Branch: `perf/cp14-prune-enumeration`. This is an incremental candidate, not a reimplementation or an accepted Desktop release.

## Two bounded changes

1. For `glob` patterns with a provable literal directory prefix, pass that prefix as data to the existing Linux script. GNU find still starts at the original physical root, keeps the original header/paths and does not follow nested directory symlinks. It prunes unrelated subtrees before enumeration and transport; final matching, mtime ordering, VCS pruning and byte caps remain authoritative. Negative, ambiguous and leading-wildcard patterns retain the original full-root traversal. No grep regex-engine change is included.
2. Enumerate native directory entries through an open directory descriptor, with one fresh descriptor-relative metadata lookup per ordinary entry. Symlinks still use full physical resolution and target metadata. Verify parent inode/physical identity before returning; a replaced directory returns FS_STALE_VERSION instead of returning metadata under a redirected parent. No metadata or file-content cache survives the call.

Targeted glob no longer probes unrelated subtrees, including their permission failures. Errors in the explicit search root and traversed directories are not hidden. Unsupported patterns still use full traversal. Enumeration is not an atomic snapshot of all concurrent child modifications; mutation authorization/version/atomic-publication protections are unchanged.

## Acceptance

- Compare actual registered glob tools and resolve+listDir against the exact CP13 checkout on the same fixture and same host. Alternate order, exclude warm-ups and retain every sample; compare full returned values, not only result counts.
- Fixture: 120 selected TSX files and 16,000 unrelated TSX files in 100 directories, so the existing basename prefilter cannot explain the gain. Include a leading-wildcard control with no fixed prefix.
- Directory controls: 24 shallow entries and 2,000 entries under a deep parent. Count real os.lstat/os.stat/os.fstat calls in the actual bundled Python programs separately from end-to-end timings.
- Regressions: special-character root paths, brace/negative/complex patterns, missing roots, hidden/VCS files, non-followed directory links, real registered source/lib tools, unchanged byte cap and shared pool; fresh metadata, dangling links and deterministic parent replacement.
- Preserve existing native/Loader/owner/mixed/cancellation/write-guard and build contracts. Do not call a timing run successful merely because assertions pass; report unchanged/regressed controls too.

## Continuation and boundaries

The preparation transform verifies the exact Git blob identity and unique source replacements. Run it only in the isolated build checkout. Publish source and matching lib only after behavior and build checks; remove temporary delivery files afterwards. Retain the tested SHA, completed CI runs and measurements here or in the PR/checkpoint.

No protocol redesign, persistent file handles across requests, file-content caching, cross-owner pool, new dependency, user-facing setting, Skill/watch/PTC work, or DSH installer/hot-reload change. Earlier Desktop acceptance is historical, not evidence for this candidate.

No performance results are claimed by this preparation checkpoint.
