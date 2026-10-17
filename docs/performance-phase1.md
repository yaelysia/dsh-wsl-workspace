# Phase-one runtime performance

This change retains Windows DSH, the existing UNC filesystem backend, the persistent Bash
session and the model-facing tool schemas. It does not add a WSL daemon or require ripgrep.

## Search

- Reuse the existing glob implementation, now in `src/shared/search-patterns.ts`.
  Compile each query once, not once per candidate. For glob, filter before sorting;
  mtime ordering, tie-breaking, output caps, cards and spill formatting stay unchanged.
- Push a **conservative filename hint** into GNU find or GNU grep before output is
  transferred/capped. The complete path predicate remains authoritative in the host.
  This is not full directory pruning: a query can still overflow if too many files
  with the hinted name/extension live outside the requested path pattern.
- Negation, embedded filename `**`, character classes, `?`, backslashes, newlines and unresolved braces fall
  back without a hint. Glob does not expand braces just to optimize a query: that
  would introduce potentially exponential work where the old glob path had none.
- Directory grep keeps its existing hidden-file exclusion, while an explicitly
  named hidden file is still searchable. Glob keeps hidden and ignored files.
  `.gitignore` behaviour, symlink traversal and the GNU engine are unchanged.

## Skill monitor lifecycle

Cache eviction retires the corresponding timer; the monitor map also has its own
32-root LRU bound, because invalidation removes a cache entry but keeps its watcher.
Cache hits refresh monitor recency. Registration disposal uses one abort listener,
clears all owned resources and prevents in-flight polls from invalidating the registry
or late lookups from recreating a timer after disposal.

An evicted root is rediscovered on its next provider lookup. This is a bounded LRU,
not a claim that closing a UI tab immediately unsubscribes a workspace: the provider
interface does not expose that subscription lifecycle. Skill bodies are not cached.

## Repeatable measurements

```powershell
npm run test:search-prefilter
npm run bench:search -- --distro Ubuntu --files 1000 --iterations 10
```

On Windows these commands run through real `wsl.exe`; use the distribution's actual
name. On Linux they run directly through Bash. The benchmark creates its own temporary
fixture, alternates unfiltered/prefiltered calls, discards two warm-up pairs, validates
that final selected paths agree, and prints P50/P95 and stdout bytes as JSON.

This A/B measures the **native script and its process/transport overhead**, on a warmed
filesystem. It does not measure DSH's whole tool dispatch, UNC read/write/edit, cold WSL
startup, model generation, or total task time. No timing threshold is used in CI.

Local development control (Linux, Node 22.16.0, 1,000 unrelated log files, 10 samples):

| Script | stdout before | stdout after | P50 before | P50 after |
|---|---:|---:|---:|---:|
| glob | 73,558 B | 488 B | 9.027 ms | 7.379 ms |
| grep | 78,313 B | 367 B | 10.284 ms | 6.485 ms |

These are fixture measurements, **not Windows/WSL speedup claims**. The `search-performance` workflow explicitly selects WSL2 and records
its own JSON in `logs/search-benchmark.json`. Four lifecycle regression cases were
also run against the original provider (4 failures) and the fix (4 passes), so the tests
demonstrate a change rather than simply asserting the new implementation's shape.

Validation for commit `10c992f7b28427383febc54438f5c719fa4fe19e`: both the
[full checks workflow](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/38947051211)
and the [Windows/WSL2 search-performance workflow](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/38947051293)
completed successfully. These results apply to that commit, not to subsequent changes.

## Deferred

Persistent RPC, Linux-native file writes, inotify and PTC sandbox changes remain separate
work. This phase does not change write authorization or automatically retry mutations.
