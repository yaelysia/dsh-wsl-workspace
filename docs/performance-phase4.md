# Native file backend: contract and evidence

This phase extends the RPC runtime from `8d8b3a7c5b88cb1096eaed4d757f86586959505f`.
The initial native implementation is `a342fdb4e848ebf8d63e88c917739a66e530d09a`.
[PR #5](https://github.com/yaelysia/dsh-wsl-workspace/pull/5) records subsequent fixes, exact
CI commits and measurements. Consult the [English](../README.md) or [Chinese](../README.zh.md)
README for installation and settings; the upstream npm release does not include this branch.

## Actual execution path

`WslFileSystem` retains the host filesystem capability and its result types. Native targets
carry an opaque identity with distribution, Linux username and physical path. It avoids
Windows case-folding and path-separator normalization, and is kept separate from UNC target
keys/version observations. Linux `link/..` is resolved physically, not lexically first.

Native methods are `fs.resolve`, `fs.stat`, `fs.lstat`, `fs.read`, `fs.range`, `fs.list`,
`fs.write` and `fs.edit`. They use the existing versioned stdio transport and a fixed method
allow-list. The file provider owns the pool; compatible search-provider settings reuse it
through `rpcPoolFor`. Different permission realms do not share a global worker singleton.
File operations reuse up to four private Linux Python executors under that same RPC worker.
One request runs at a time per executor; sequential operations reuse both the Windows-to-WSL
connection and imported Python code. Cwd, commit/cancellation flags and input/output bodies
are reset per request, with no retained file-body cache. A cancelled, crashed or malformed
executor is retired; its in-flight operation is never replayed. Pool disposal/idle expiry
reaps these children as well. No fork is performed from a multi-threaded interpreter.

No file-body cache, port, installed Linux service or general command-execution RPC is added.
Windows drive targets, including symlinks resolved onto `/mnt/<drive>`, retain their Windows
backend. Skills and the right-sidebar file previews are not claimed to have moved off UNC.

## Backend selection

`fileBackend` accepts `auto` (default), `native`, or `unc`; its environment fallback is
`DSH_WSL_FILE_BACKEND`. The existing idle/metrics settings apply to the owned pool.

Auto may select UNC **while resolving a target**, only after a startup failure and without
an explicit Linux username. Once a target is native, later requests never fall back to UNC.
This avoids mixing file observations, identities and privileges after an error. Unsupported
hosts without a disposal scope retain the compatibility route; a forced native request
requires an owned lifecycle. Native operations use the workspace's Linux user and propagate
permission failures as `FS_PERMISSION_DENIED`, not as missing files or a reason to escalate.

## Reading contract

Byte APIs preserve every byte. Text decoding follows the pinned host's strict UTF-8, BOM
and initial binary sample behavior. `lstat` preserves final-link identity; `stat` and reads
follow the physically resolved target. Directory entries are sorted by the existing host
name-order rule and retain canonical targets and version observations.

Full reads are limited to 16 MiB. Byte-range reads allow larger source files and bound each
requested range; text streaming uses 256 KiB ranges and a stateful UTF-8 decoder. Each range
checks the initial file version, so a replaced/changed file cannot silently produce a stream
assembled from two versions. Cancellation closes the active operation and does not start an
unbounded prefetch. Native `watch` is deliberately unsupported.

## Mutation contract

The Linux transaction checks the selected host policy against case-sensitive, physical
paths. For `workspace-write`, the workspace and permitted temporary roots are the allowed
locations. Read-only and unknown policy modes do not authorize writes. Descriptor-relative
no-follow traversal pins the target directory after authorization.

A directory advisory lock serializes cooperating native writers even across different pools.
Under that lock the transaction checks the observed version or conditional-create intent,
reads the edit basis, and computes the complete result before publication. Exact-string
matching, non-overlapping match counts, ambiguity/not-found errors, CRLF conversion and
before/after text are compared against the pinned `LocalFileSystem` implementation, rather
than inferred from rendered tool text.

Data is staged in a private directory in the target's parent. Existing ordinary mode bits,
owner/group and extended attributes are preserved when supported; privilege bits are not
copied. A preservation failure aborts. New files use `0600`; temporary directories use `0700`.
Version and physical-parent checks are repeated immediately before publication. New files
are linked with no replacement, existing files use atomic rename/replace. Staged data is
synced before publication; directory-sync failures after publication do not invite a blind
retry. Temporary files are cleaned on ordinary success/failure/cancellation.

This is not an atomic compare-and-swap against arbitrary external editors: unrelated writers
need not take the directory lock, and a final external race is not ruled out. Neither this
provider nor the existing plugin is a full OS sandbox. If a permitted write creates parent
directories before a later failure, those parents can remain. A hard crash can leave a private
staging directory; automatic recursive cleanup of unknown files is intentionally not done.

Full write content and edit inputs are bounded to 16 MiB, with 32 MiB wire-request and 64 MiB
reply budgets. The output budget is checked before a mutation is published. Stream/range read
support does not imply streaming writes. Conditional-create conflicts, stale versions,
ambiguous edits and missing edit strings remain distinguishable errors.

## Cancellation and uncertain outcomes

Read/search cancellation can return immediately. A dispatched mutation instead waits for a
receipt: a confirmed pre-publication cancellation, a committed result, or an explicit unknown
outcome. SIGTERM is deferred across publication/receipt construction. Worker loss, malformed
receipts, unacknowledged cancellation or lost connection after dispatch never replay the write
and never select another backend. Re-read and reconcile an unknown result before retrying.

An acknowledged cancellation is not a claim that no parent directory was created. A transport
success is not a guarantee that an external editor has not subsequently changed the file.

## Diagnostics

The existing `performance` API includes `file.resolve/stat/lstat/read/range/list/write/edit`
and `rpc.fs.*` stages. The registry is shared across built host/file/search entries. It does
not collect paths, usernames, arguments or file contents, and does not write telemetry.
Percentiles describe a rolling window, not all historical calls; nested timing stages are
not additive. Native transaction time includes the Python child process and filesystem work.

## Verification and benchmark

```text
npm run test:native-files
DSH_WSL_TEST_PLANE=lib npm run test:native-files
npm run test:search-transport
npm run bench:native-files -- --iterations 20
```

The first two commands run the real native provider and worker, not mocked filesystem calls.
Linux runs are native-only controls. Windows tests set `WSL_COMPAT_DISTRO` and run the same
source/lib contracts on WSL1 and WSL2. The host text/edit oracle uses a host-local temporary
directory, because a bare Windows `LocalFileSystem` on a WSL share lacks the plugin's DACL
and atomic-publication adaptations. Content, returned errors and stored bytes are still
compared with the unmodified host implementation. The UNC comparison benchmark uses the
actual compatibility `WslFileSystem`, not that bare host class.

Regression coverage includes reads, BOM/UTF-8, chunk boundaries and version changes,
conditional creates, concurrent guarded writes, real symlinks and dangling targets,
case-confusable/outside paths, permissions/attributes, 16 MiB bounds, cancellation behind a
real lock, directory relocation, lost receipts, queue cancellation, explicit Linux users,
configuration routing, native/UNC startup selection and actual search/file pool reuse.

The Windows A/B compares `resolve + stat + read`, `resolve + stat + guarded write/edit`, and
`resolve + listDir`, with two warm-up pairs excluded and alternating backend order. It checks
the returned content and lists. These are complete provider sequences, **not** model latency,
whole-agent latency, cold WSL boot or a guarantee for all project layouts/file sizes. Do not
substitute phase-two search benchmarks for native file measurements. Raw results and exact
platform details are retained in each `native-files` workflow artifact.

## Continuation findings

The initial delivery's Linux build, native source/lib tests and pinned-host integration
passed. Its first Windows validation exposed two test-environment issues: redundant conversion
of an already-WSL1 distribution returned `WSL_E_VM_MODE_INVALID_STATE`; the edit oracle was a
bare Win32 filesystem provider aimed at an unsupported UNC substrate. The provisioning now
checks the actual version before conversion, and the oracle runs on its native host disk.
All content/error assertions are retained, with extra failure detail.

The original full-matrix failure was in the existing one-shot Bash large-output comparison,
where its host spill had fewer bytes than the persistent-shell result. Native file tests
were not the failing step there. The final PR reports rerun results without disguising an
initial failure as a pass. No latency assertions or compatibility failures are removed to
make the build green.

## File-startup regression found by full provider measurements

The first complete Windows A/B (run `39048433397`, commit `7a7a17d549740976d4da5b128ab64578f32aaf21`)
passed all file contracts but exposed a performance regression in single small-file calls.
With 3,900-byte content and 200 directory entries, WSL2 native P50 was 82.473 ms for the
read sequence, 107.221 ms for write and 110.991 ms for edit, versus UNC's 15.487, 59.362
and 65.519 ms. Listing was much faster: 60.320 versus 2,501.880 ms. WSL1 showed the same
small-file startup issue. These are historical pre-executor-reuse results, not current
speedup claims.

Segmented metrics showed Python startup/import work repeating on every resolve, stat and
read. The warm-executor change removes that repeated work while retaining process-isolated
cancellation and the complete transactional checks. Regression cases verify real executor
PID reuse, cwd/receipt-state reset, large framed replies, overflow recovery and cleanup of
idle child processes. The same source/lib native contract and Windows provider A/B gates
run again; PR #5 records their exact final commits and measurements.
