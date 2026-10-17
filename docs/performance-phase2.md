# Experimental persistent search transport

Implemented and published with rebuilt `lib/` on `perf/phase2-search-transport`.
The Node 24 build, pinned DSH integration and clean package installation have passed;
the native transport suite has passed on both Linux and Windows/WSL2. The default
remains `oneshot`. Consult [PR #3](https://github.com/yaelysia/dsh-wsl-workspace/pull/3)
for the current registered-tool and full compatibility check results.
This work builds on phase one, including its documentation update at
`3020a68b77bd55f0345d5f538803d4a4d827135b`.

## Scope

`grep` and `glob` keep their existing argument schemas, GNU scripts, parsing, exact path
matching, ordering, retention and presentation. The replaceable seam is how the fixed
scripts reach Linux. File reads/writes, permissions, skills and the interactive Bash
session are unchanged. This is not a general-purpose agent or a filesystem backend.

A new search provider owns a lazy pool keyed by WSL executable, distribution and username.
A worker is one `wsl.exe → python3 -I -S -u` connection, not one per query. It uses only
Python 3.8+ standard-library modules. No package, service, port or file is installed in WSL.
Each query still starts its own **Linux Bash** process, so cwd and shell options do not leak
between requests; the expensive Windows-to-WSL launch is what is reused.

Requests travel over stdin as JSON-lines. Responses carry base64 stdout/stderr, preserving
NUL/newline filenames and binary framing. Only the two bundled search scripts are callable;
search patterns are data, not shell source. Bootstrap code is single-line ASCII so it does
not rely on Windows/WSL preserving multiline command-line arguments.

## Enable and revert

The feature branch includes the rebuilt `lib/`; no source patch or manual build is needed
when installing that branch. Developers changing source must still run the repository's
usual `npm ci` and `npm run build` and commit the matching build output.

Set the environment of the **DSH host process**, then restart that process:

```powershell
$env:DSH_WSL_SEARCH_TRANSPORT = 'auto'
# Launch DSH from this environment, for example:
dsh web
```

`oneshot` is the unchanged default. `persistent` requires the worker and reports startup
errors directly. `auto` may fall back to oneshot **only before a request was dispatched**,
for example when Python is absent. Failed startups have a 60-second per-identity cooldown
and the provider logs its first fallback. Time spent attempting startup is deducted from
the fallback deadline; cancellation never turns into another execution attempt.

The search provider row can instead set `transport: auto|persistent|oneshot`; an explicit
row setting takes precedence over the environment. This is a search-provider setting,
not a new top-level setting of the workspace plugin. For Desktop, restarting only a
window is insufficient if the existing host process still has the old environment.

To revert, set `DSH_WSL_SEARCH_TRANSPORT=oneshot` and restart the host. No data migration
or background service removal is involved.

## Resource and recovery boundaries

Per mounted search provider: at most four distribution/user identities. Per worker: four
running native searches and sixteen outstanding requests total, including queued ones.
Overload is rejected rather than creating an unbounded process pool. Idle workers exit
after 30 seconds; a new request starts one again. The pool does not retain idle Node handles.

Cancellation and timeouts stop a request's Linux process group without stopping unrelated
requests. The cancelled slot stays reserved until acknowledgement. Provider disposal closes
stdin, causing the worker to cancel/reap its jobs; a bounded host-side shutdown timer is the
last resort for a broken worker. A worker crash or malformed response fails the affected
requests: they are **not replayed**. A subsequent new call can start a replacement worker.

The opt-in transport accepts at most 1 MiB of request JSON, 256 arguments, 64 MiB raw stdout
budget and 1 MiB stderr per request. The existing raw-output cap plus one overflow-witness
byte stays intact. Excess stderr is an explicit error, not silently truncated diagnostics.
These transport limits do not change the default oneshot backend.

## Verification commands

```powershell
npm run test:unit
npm run test:search-transport
npm run bench:search-transport -- --distro Ubuntu --files 1000 --iterations 30
```

On Windows, set `WSL_COMPAT_DISTRO` to the actual distribution for the native tests.
The benchmark's `--distro` has the same meaning. On Linux the native tests and benchmark
launch Python/Bash directly; they do not pretend to measure the Windows boundary.

The `search-performance` workflow runs transport tests on Linux and Windows/WSL2. It
also builds the plugin, installs the existing pinned DSH test dependencies and exercises
`scripts/compatibility/search-real.mjs` with `DSH_WSL_TEST_SEARCH_TRANSPORT=persistent`,
once against source and once against `lib/`. Its registered-tool result must be checked
separately; successful native transport tests alone do not establish host integration.

## Node 24 build and publication

The [delivery run](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39012625533)
built and tested commit `5ae116962d5d19650b0962bc6f48a21ceb3a2b47` on Node 24.21.0.
Repeated builds reproduced committed `lib/` byte-for-byte. The unit bucket passed 227
cases with one existing dependency skip, all 21 transport cases and both native prefilter
cases passed, and the pinned-host bucket passed 108 cases plus its existing integration
drivers. Clean npm installation also passed. The type gate retained its **209-error
baseline**, not a claim of zero project-wide type errors; the existing documentation/seam
ledgers retain their recorded defects and platform skips.

The run's final push was rejected because the Actions token could not publish workflow
changes. The GitHub connector then published the exact tested commit successfully; no
source or build output was changed to evade a test. Temporary delivery files and its
workflow are absent from the published tree. Neither `main` nor the user's local install
was changed. Windows compatibility and speedup are not inferred from this Linux run.

## Windows/WSL2 evidence

Measured on 2026-10-17 in [run 39012951540](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39012951540),
commit `e14258b128a9128ddfbf3e9ce9323c0ae153bb08` (production code unchanged from the
build commit above). Windows Node 24.21.0, Ubuntu-24.04, kernel
`6.18.40.1-microsoft-standard-WSL2`. All 21 native transport cases passed, including
cancellation, process-group cleanup, parallel requests and odd filenames.

Alternating A/B, two warm-up pairs discarded, 30 samples per backend, 1,000 unrelated logs:

| Operation | oneshot P50 / P95 | persistent P50 / P95 | identical stdout bytes |
|---|---:|---:|---:|
| glob | 133.630 / 150.362 ms | 12.100 / 13.390 ms | 488 |
| grep | 131.715 / 144.280 ms | 9.789 / 10.936 ms | 367 |

One persistent worker served all calls. Its first startup/query took 164.324 ms with the
distribution already warm from fixture setup. These are **native script plus transport**
readings, not DSH/model latency, UNC file I/O, a cold WSL boot or overall task speedup.
No fixed latency gate is added; results from one CI fixture are not a guarantee for all
workspaces. Raw JSON is the run's `search-performance-wsl2` artifact.

That run's registered-tool check later failed on its Windows-drive fixture: the workflow
had omitted `WSL_COMPAT_DRIVE_PATH`, leaving the driver's old machine-specific default.
The workflow now supplies the actual checkout's `tests` directory and asserts it exists;
the source/lib checks are retained with their logs archived. The native test/benchmark
results above are valid, but the failed run is **not** an overall compatibility pass.

## Local development control

Linux, Node 22.16.0, Python 3.13.5; the same 21 transport cases passed. The new transport
module closure also passed a separate strict TypeScript check. These local readings are
a development control, not Windows compatibility evidence.

| Operation | oneshot P50 / P95 | persistent P50 / P95 | stdout bytes |
|---|---:|---:|---:|
| glob | 7.155 / 10.234 ms | 6.973 / 7.984 ms | 488 |
| grep | 5.803 / 6.554 ms | 5.853 / 6.819 ms | 367 |

The same worker served all persistent calls (one launch). First worker/query startup was
37.761 ms with the filesystem already warm. A 5,000-log control showed glob P50
11.527 → 12.836 ms and grep 7.921 → 7.665 ms: **no stable major Linux speedup**.
The Windows benefit measured separately above comes from reusing the Windows-to-WSL
connection, not from replacing the search algorithm.
