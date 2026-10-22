# CP17 — safe wildcard directory-anchor pruning for grep and glob

## Problem and targeted optimization

CP14/15 accelerated literal-prefix queries like `src/services/**/*.tsx`, but the relative pattern `**/services/**/*.tsx` could not be reduced to a fixed starting subtree. GNU grep would read unrelated matching-extension file bodies; glob's GNU find would return unrelated names/mtimes over the WSL RPC channel, and host filtering happened **after** the Linux raw-output cap.

This revision infers a directory name that every **positive path-shaped glob alternative** must pass through. The extractor refuses negation, basename-only patterns, malformed/hidden components, `node_modules`, escapes, ambiguous braces, empty paths and mixed candidates. When no safe literal prefix exists, the DSH tool passes a separate optional `anchor` datum to the unchanged Bash execution boundary. All user input remains data in argv, never interpolated shell code.

For grep, a short `find` traversal discovers real directories bearing that name, using the same hidden and `node_modules` pruning that GNU grep applies. Glob similarly skips VCS metadata subtrees. **Only exactly one** physical non-symlink candidate can replace the recursive scan root; candidate disappearance, symlink rebind, multiple or zero candidates, or `find` errors trigger unchanged full-root search. Recursive descendants of the chosen root are scanned with the original GNU grep/find and basename hint options. No cache or persistent search index is introduced.

The original host-side glob matcher is still authoritative. An output budget is applied *after Linux pruning* as in CP15. Glob stdout retains the original search-root header and modification-time records. This does not attempt to optimize a query whose literal directory could exist under several disjoint subtrees.

## Paired real Windows→WSL2 and Linux measurements

**Baseline:** merged CP16 `053a71a5941c9bcec51a8e371c31aa279087ad36`, compared with [PR #14](https://github.com/yaelysia/dsh-wsl-workspace/pull/14). The same actual Linux filesystem fixture contains 120 `src/services/deep/*.tsx` files and 16,000 irrelevant same-extension files under `src/other`. Every fixture file contains the same search token. Both revisions execute the **registered DSH-compatible grep/glob tools**, the real shared owner-scoped native WSL RPC pool, transport, host parsing and final filtering. Full tool response equality and exact result counts are asserted.

Twenty alternating post-warmup samples (three warm-up pairs) were taken on each platform. P50 and P95 are in milliseconds. Windows jobs verified actual **WSL2 Ubuntu-24.04**, not WSL1, and source+`lib/` cases were checked. This is **not** a Desktop/model/GUI latency benchmark.

| Platform / query | CP16 P50 | CP17 P50 | CP16 P95 | CP17 P95 | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Windows→WSL2 grep `**/services/**/*.tsx` | 189.413 | **29.607** | 194.041 | 31.798 | **6.40× P50 faster** |
| Windows→WSL2 glob `**/services/**/*.tsx` | 155.556 | **43.777** | 165.542 | 46.040 | **3.55× P50 faster** |
| Windows→WSL2 grep `**/*.tsx` control | 217.501 | 217.769 | 226.317 | 225.533 | Essentially unchanged |
| Windows→WSL2 glob `**/*.tsx` control | 193.233 | 192.482 | 198.450 | 198.689 | Essentially unchanged |
| Linux grep selector | 143.050 | **24.128** | 148.587 | 28.019 | **5.93× P50 faster** |
| Linux glob selector | 109.218 | **37.504** | 113.604 | 41.764 | **2.91× P50 faster** |
| Linux grep all-files control | 163.762 | 163.492 | 168.154 | 168.674 | Essentially unchanged |
| Linux glob all-files control | 137.475 | 138.463 | 149.962 | 147.164 | Essentially unchanged |

On Windows, decoded RPC stdout bytes are **1,228,290 → 8,890** for the grep selector and **1,228,318 → 8,918** for the glob selector. These represent *decoded RPC stdout payload* before outer framing, not measured physical wire traffic. The controls' payload sizes remain unchanged. The matched result count is 120 for each selector and 16,120 for each full-file control.

The benchmark measures a deliberately selective pattern. Speedups vary with the number and location of candidate directories; if there are zero/multiple candidates or no provable anchor, traversal falls back to its original path and may incur discovery overhead first. The negative controls show no regression for **patterns without an anchor**; they do not independently quantify multi-root fallback overhead.

## Correctness and platform gates

Real Linux test additions verify optional hint safety, shared positive alternatives, negation, hidden/unsafe paths, nested services directories, ignored VCS/node_modules paths, directory symlink non-following, the identical filtered content and modification timestamps, fallback to identical raw grep/glob bytes for multiple candidates, and reducing raw output before the original cap. Registered source and committed `lib/` paths verify both tools send the expected hint and continue to share one worker with native file reads. The pinned real Loader and WSL1/WSL2 checks preserve existing host compatibility.

The tested runtime and artifact head was `dcf6a265922675785f757f9ccfefaf708d5a7033`. All applicable PR workflows completed **successfully**, including:
- [paired Windows→WSL2/Linux wildcard benchmark](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39755933727)
- [full committed-artifact + pinned-host + WSL1/WSL2 source/lib checks](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39755933683)
- [native file, mixed owner, busy lifetime](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39755933720)
- [search](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39755933747), [traversal](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39755933761), [grep/read](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39755933829), [actual Loader](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39755933828), [read batching](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39755933711), [persona](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39755933736).

The code was merged in [PR #14](https://github.com/yaelysia/dsh-wsl-workspace/pull/14) at `114bf6afb2b815bfd1cea98c35bc3b2c45ab4a08`. This later report/checkpoint update changes **Markdown only** and was not mixed into the tested runtime head.

## Reproduce, constraints, follow-up

Use Node 24, `npm ci`, `node ci/install-pinned.mjs`. Check `npm run test:grep-prune` in both `DSH_WSL_TEST_PLANE=src` and `lib` modes. To reproduce the paired benchmark, create `.cp17-baseline` as a detached worktree of `053a71a5941c9bcec51a8e371c31aa279087ad36` and provide its `node_modules`, then run `npm run bench:wildcard-anchor -- --baseline .cp17-baseline --iterations 20 --output result.json` with a real Linux or Windows→WSL2 provider. Raw repeated samples are attached to the corresponding CI workflow artifacts (time-limited retention).

No change to RPC owner isolation, native physical-path checks, write/edit transaction or cancellation protocol, streamText, DSH hot reload, Skills or PTC. No CP17 Desktop GUI acceptance is claimed. If optimizing multiple candidate roots later, measure its discovery penalty first and preserve per-root search ordering, permission/error behavior, symlink semantics and raw-output cap; do not generalize the single-root result to arbitrary patterns.
