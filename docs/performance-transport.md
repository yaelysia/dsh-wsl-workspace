# Persistent search transport

## Scope

The Windows DSH host and the existing `read`/`write`/`edit` UNC backend stay intact.
Only `grep` and `glob` gain a persistent transport. The same trusted Bash scripts,
file filters, GNU tools, output budgets, exact host matching and renderers are reused.
This is not a new AI agent, a command-execution tool, or a PTC sandbox.

## Runtime and selection

The default is `auto`. On the first search the plugin starts a Python 3 worker
inside the selected distribution, under the same configured Linux username as
one-shot search. Python runs with `-I -S` and uses only its standard library.
There is no pip install, root escalation, listening port, on-disk bootstrap or system service.
The startup shell preserves the guest locale before Python can coerce it.

A missing interpreter or failed handshake falls back to one-shot search, with a
warning and a 30-second retry cooldown per identity. Search execution failures,
cancellation and post-dispatch disconnects are **not** silently replayed.
The startup attempt consumes the same request deadline as the fallback.

`DSH_WSL_SEARCH_TRANSPORT=oneshot` forces the original path. `persistent` requires
the worker and surfaces startup failure. The provider config `transport` overrides
the environment variable. Minimal test callers without a scope cleanup hook keep
one-shot behavior in auto mode; a real DSH scope owns transport disposal.

## Resource and lifecycle bounds

Each provider keeps at most four worker entries, keyed by distribution and Linux
user, not by cwd. Each request supplies its own cwd. A worker accepts four in-flight
searches; auto mode falls back under capacity pressure rather than growing a queue.
An idle worker retires after 120 seconds; plugin scope disposal closes all workers.
The WSL distribution may therefore remain active during that idle window.

Requests are bounded JSON lines. Replies are a bounded JSON header followed by
raw stdout and stderr byte payloads. NUL/newline file names and non-UTF-8 bytes do
not turn into message delimiters. Each query runs in its own Linux process group,
with independent cancellation/deadline and bounded stream draining. Closing stdin
asks the worker to kill and reap active groups before exiting. No shell state or
response bytes are shared with the agent's persistent Bash.

The worker permits up to 64 MiB stdout and 1 MiB stderr per request. The existing
search's smaller raw-output limit is still applied. Auto mode uses the old path
for a configured larger stdout budget. File contents and search results are not
cached, and there is no automatic retry of an in-flight search.

## Verification

`npm run test:search-worker` runs real worker processes: byte/argv fidelity,
concurrency, cwd isolation, raw old/new script parity, cancellation and descendant
cleanup, output budgets, missing-runtime fallback, idle retirement, disposal and
post-dispatch crashes. It requires Python 3 inside WSL on Windows or locally on Linux.

The registered-tool contract can be run on either plane:

```sh
DSH_WSL_SEARCH_TRANSPORT=persistent node --experimental-strip-types scripts/compatibility/search-real.mjs
DSH_WSL_SEARCH_TRANSPORT=persistent DSH_WSL_TEST_PLANE=lib node --experimental-strip-types scripts/compatibility/search-real.mjs
```

`npm run bench:transport` alternates identical queries through both transports,
checks byte-identical answers, excludes two warm-up pairs, and records P50/P95 and
the first worker call separately. Default: 1,000 unrelated files and 20 measured
calls per case. It creates/removes its own temporary fixture, never user files.

A Linux-local control does not measure Windows-to-WSL launch overhead. It is not
an end-to-end DSH/model benchmark, and no machine-independent latency threshold is
used as a correctness gate. Windows results belong to the CI artifact for the
exact tested commit, not an extrapolation from the Linux control.
