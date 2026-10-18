# Automatic search, idle policy, diagnostics and shared RPC

This phase builds on `b439fb4819da26758953d53183f7707dcb3a59d2`. See the feature PR's checks
for validation of this phase; phase-two benchmarks are not measurements of this change.

## Defaults and overrides

Healthy WSL searches now use **auto** without environment opt-in. Python is discovered by
starting the worker once, not by a separate per-query probe. Missing/unsupported Python or a
failed version/capability handshake can fall back only before dispatch. Startup failures have
the existing 60-second per-identity cooldown. Cancelled or already dispatched calls are not
replayed. Hosts without an effect/disposal scope use oneshot in auto mode, but reject forced
persistent mode. This does not change interactive Bash or file-write authorization.

Top-level plugin configuration (also exposed by its schema):

```yaml
searchTransport: auto
searchIdleMs: 120000
searchMetrics: true
```

The corresponding search-provider row fields are `transport`, `idleMs`, `metrics`.
Explicit plugin values flow into both legacy and declarative WSL presets. Resolution order
is explicit configuration, then `DSH_WSL_SEARCH_TRANSPORT` / `DSH_WSL_RPC_IDLE_MS` /
`DSH_WSL_RPC_METRICS`, then defaults. Invalid values throw, rather than silently changing the
backend. Environment variables must be present in the actual DSH host process before start.

Idle lifetime is a fixed **120 seconds**, adjustable from 1000 to 3600000 milliseconds.
It is intentionally not an unmeasured adaptive heuristic. Only a worker with no startup
waiters or outstanding calls is idle. Each call resets its idle deadline; active searches
are never evicted to satisfy this timer. Existing limits remain: four identities per pool,
four Linux jobs per worker, sixteen outstanding requests. Under identity pressure the oldest
idle worker can be released before the timer; busy workers are not evicted. Host disposal
still closes/reaps resources immediately. Idle handles are unreferenced and do not keep Node
alive. A two-minute setting is a chosen starting point, not a proven universal optimum.

## Performance statistics

No telemetry, disk log, polling timer, path, username, pattern or file content is collected.
Statistics live only in the running host and disappear when their provider is disposed.
Counters cover that provider's lifetime; P50/P95 describe the **latest 256 samples per stage**,
not a full-history percentile. Sorting happens on snapshot, not on every request. Set
`searchMetrics: false` (or `DSH_WSL_RPC_METRICS=0`) to disable sample collection.

The existing loopback-only POST data API accepts a new read-only `performance` method:

```json
{"method":"performance"}
```

Use the configured plugin route (default `/wsl-workspace/api`) on the DSH host's actual port.
The response contains anonymous provider IDs; selected/effective mode; launches, pending
requests, idle/LRU releases and auto-fallback counts; and per-stage counts/outcomes/P50/P95.

- `tool.grep/glob`: execute, including argument/path resolution, filtering, sorting and spill.
  It excludes model time, scheduler time before execute, and UI rendering after it returns.
- `oneshot.grep/glob`: the original subprocess path, also used after safe startup fallback.
- `rpc.<method>.total`: pool call including startup/cooldown/error handling.
- `ready` / `roundTrip`: startup wait and the host's dispatch-to-response duration.
- `queue` / `execute`: durations measured inside Linux using its monotonic clock. No timestamps
  from different operating systems are subtracted. Native execution excludes response encoding.

A parent duration includes child durations; do **not** sum these rows. Native stage samples
are present only for completed replies with timing data; host errors/cancellations still
appear in the total outcome counters. The scope is search execution and RPC, not UNC read,
write, edit, Skill scanning or all DSH latency. A transport success does not imply every
path in a metadata batch exists; each path retains its own errno.

## Shared RPC boundary

`rpc-transport.ts` owns process reuse, framing, cancellation, limits and recovery;
`rpc-worker.ts` owns a version-2 handshake and fixed method allow-list. The old search module
names are thin compatibility exports, not a second implementation or a second agent.

The first non-search consumer, `readMetadata(pool, target, paths)`, batches up to 64 absolute
Linux paths through **the same supplied pool**. It returns canonical paths and stat facts,
with per-path `ENOENT`/`EACCES`/other errno rather than collapsing errors into absence. Metadata
runs in a cancellable Linux subprocess, so even a blocked filesystem operation cannot block
the protocol reader. No user-provided script or arbitrary RPC method is accepted.

Ownership remains per mounted search provider; this is **not** a process-wide singleton that
shares state across sandbox realms. Other consumers explicitly reuse their owner's pool.
The built search entry exports `WslRpcPool`, `readMetadata`, and `performanceSnapshot` for
integrations. This phase does not replace `ctx.fs`, native-read files, write/edit, run_code,
or the Skill scanner; it provides their reusable, tested transport seam first.

## Verification

```text
npm run test:unit
npm run test:search-transport
npm run test:node
npm run test:seams
npm run typecheck:gate
npm run bench:search-transport -- --distro Ubuntu --files 1000 --iterations 30
```

Regressions cover config precedence/rejection, generated preset settings, bounded percentile
windows, disabled/private statistics, cross-built-entry API visibility and disposal,
search/metadata reuse, per-path errors, active vs idle eviction, gap reuse, protocol mismatch,
all previous cancel/timeout/overload/failure cases, and actual default-auto source/lib calls
on Windows/WSL2. The benchmark also exports its structured timing/resource snapshot. Existing
project type-error and deliberate-defect baselines remain separate from these new modules.
