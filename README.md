# dsh-wsl-workspace

[English](README.md) · [中文](README.zh.md) · [Upstream translations](#documentation) · [Continuation checkpoint](CHECKPOINT.md)

Keep **DeepSeek Harness on Windows** and work in a **local WSL distribution**. The plugin
provides WSL workspaces, persistent Bash, native file tools and persistent code search,
while retaining Windows files through `/mnt/<drive>`.

**This is the enhanced [yaelysia fork](https://github.com/yaelysia/dsh-wsl-workspace),
built on the [upstream plugin](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace).**
The four improvement stages, including native files and the Desktop persona fix, are now
merged into **`main`** through [PR #5](https://github.com/yaelysia/dsh-wsl-workspace/pull/5).
Install this repository's main branch; the upstream npm package does **not** contain these changes.
The development package still carries the upstream version number; use its source/commit,
not that number, to identify the build.

| Operation | Linux workspace | Windows drive |
|---|---|---|
| Text/byte/stream reads, directory listing | Native Linux I/O over shared RPC | Existing Windows backend |
| Write and exact-string edit | Guarded Linux transaction and atomic publication | Existing Windows backend |
| `grep` / `glob` | GNU tools over persistent RPC (`auto`) | WSL accesses the mounted drive |
| `bash` / interactive terminal | WSL shell under the workspace user | Accessible from WSL |
| Skill discovery | Existing bounded UNC polling | Existing host behavior |

## Install

### Requirements

Windows DSH, an available local WSL distribution, and **Linux Python 3.8+** for native
files and persistent RPC. No second DSH, Linux Node installation, pip package, listening
port or system service is required. Python must already be available as `python3` in the
distribution; the plugin does not install it automatically.

```powershell
# Replace Ubuntu with the distribution name shown by wsl -l -v.
wsl -d Ubuntu --exec python3 --version
```

### Install from main

In Windows DSH's plugin page, choose **Add plugin / Install third-party plugin** and enter:

```text
git+https://github.com/yaelysia/dsh-wsl-workspace.git#main
```

If the same package is already installed, record its source/settings, uninstall that copy
through the plugin page, then install the source above. Do not delete the whole DSH profile.
Main includes rebuilt `lib/`; no manual source patch or local build is required.

Alternatively, install a local checkout of the same main branch:

```powershell
$plugin = Join-Path $env:USERPROFILE 'dsh-wsl-workspace'
git clone --branch main --single-branch https://github.com/yaelysia/dsh-wsl-workspace.git $plugin
# Windows CLI / Web profile:
dsh plugin --profile web add $plugin
```

For DSH Desktop, add that local plugin directory in Desktop's plugin management. Fully
restart the **host process**, not just a window, after installing or changing environment
settings. Web and Desktop profiles are separate. Do not enable the upstream package and
this copy together: both register the same plugin identity.

To update an unchanged checkout, use `git -C $plugin pull --ff-only`, then restart DSH.
Developers modifying source must run the build and commit matching `lib/`; see [TESTING.md](TESTING.md).

## Usage

Open the **W** button beside Settings, choose a distribution, and enter or browse to an
absolute Linux directory such as `/home/me/project`. Check the directory, then choose
**Create & open**. Standard, PTC, Minimal and Creative retain their mode selection through
WSL variants; tool availability still depends on the selected mode.

The optional username selects the Linux identity for Bash, searches and **native file
operations**. Leaving it empty uses the distribution's default user. A Windows/UNC file
operation does not impersonate this Linux user. Workspace selections are stored in
`<dshHome>/wsl-workspaces.json`.

Linux targets are pinned to their backend, distribution and user when resolved. Changing
backend/user settings requires a new resolution/session; a file already observed natively
is never silently rewritten through UNC after an RPC failure. `/mnt/c/...` and `C:\...`
file targets retain direct Windows access, including Linux symlinks resolving onto a drive.
Directory listing follows the same routing: drive-backed entries carry Windows target keys
and Windows-observed versions, not native versions that would break guarded writes.

## Configuration

These are **top-level plugin settings**, not model tool arguments:

```yaml
fileBackend: auto       # auto | native | unc
searchTransport: auto   # auto | persistent | oneshot
searchIdleMs: 120000    # shared RPC idle lifetime, 1000..3600000 ms
searchMetrics: true     # bounded in-memory file/search/RPC statistics
```

| Setting | Environment fallback | Behavior |
|---|---|---|
| `fileBackend` | `DSH_WSL_FILE_BACKEND` | `auto` prefers native; `native` requires it; `unc` selects compatibility I/O |
| `searchTransport` | `DSH_WSL_SEARCH_TRANSPORT` | `auto` prefers persistent search; `oneshot` keeps the original launch path |
| `searchIdleMs` | `DSH_WSL_RPC_IDLE_MS` | Default 120 seconds; busy or queued work is not idle |
| `searchMetrics` | `DSH_WSL_RPC_METRICS` | Set `false`, or environment `0`, to stop timing collection |

Explicit configuration wins over environment, then defaults. Invalid settings report an
error. In default presets, files and search share an owner-scoped pool when their idle and
metrics settings agree; there is no global cross-realm pool. Limits remain four identities
per pool, four running jobs per worker and sixteen outstanding requests. Idle/LRU disposal
never evicts busy work.

`auto` fallback is **startup-only**. File fallback can happen before creating a native
target and only without an explicit Linux username. Permission errors, stale versions,
timeouts and lost mutation receipts are not reasons to switch backends and write again.
Use `fileBackend: unc` and `searchTransport: oneshot` to deliberately return to the original
paths, then restart the host/start a fresh session.

Native file operations additionally reuse up to four private Linux Python executors per RPC
worker. These children process one request each at a time, keep no file-body cache and are
reaped with their owner; cancellation or a damaged reply retires the affected executor
without replaying the operation. This avoids re-importing Python for every small file call.

## Behavior notes

- **Bash:** uses the WSL distribution and workspace user. The session tool carries shell state; its supported arguments and differences from the host are listed in [bash parity](docs/bash-parity.md).
- **File tools:** native `resolve/stat/lstat/read/list/write/edit` use the shared RPC and preserve Linux path case, literal backslashes and symbolic links. UNC compatibility uses `LocalFileSystem` and `readlink` assistance. Both retain the host file-policy boundary and `FS_SANDBOX_DENIED` errors.
- **Search:** `wsl-search` keeps GNU grep/find scripts, output framing, exact filtering and result limits. Persistent `auto` removes repeated Windows-to-WSL launches; it does not change ignore or regex semantics into ripgrep semantics.
- **Skills:** discovery remains on UNC, with a bounded directory walk, at most 32 monitors, approximately 3-second change checks and 30-second rediscovery. Skill bodies are re-read. Native watching/inotify is not part of this change.
- **Shell lifetime:** persistent shells belong to their agents, not the whole application. Cancellation, timeout recovery and any explicitly announced terminal rerun retain the existing behavior; see [terminal troubleshooting](docs/tty-triage.md).
- **Interactive input:** `wsl_terminal` opens/sends/reads/signals/closes terminals through `wsl-relay`. A program needing input requires this terminal path; secrets typed there become part of the conversation record.
- **Tracked jobs:** use `bash_background` with `job_list`, `job_output` and `job_kill`. The session Bash implementation also supports its declared `run_in_background` option; do not infer that an untracked shell `&` is a managed job.
- **Older hosts:** use the existing one-shot shell fallback where the persistent terminal substrate is absent. Native file support is independently capability-checked; the inherited release list below is not a new test run of every native feature on every historical SDK.
- **Startup output:** WSL can print a localhost-forwarding warning while a distribution starts. Diagnose a failed tool from its actual status and error, rather than treating this banner alone as failure.

## Native file guarantees and limits

Reads are byte-preserving; text decoding is strict UTF-8 with the host's BOM/binary rules.
Edits retain the host's exact-match, ambiguity, not-found, newline and before/after outcome
contract. A conditional create never replaces an existing file, and an observed-version
write/edit rejects a changed target.

Writes re-authorize the **physical Linux path**, use descriptor-relative/no-follow directory
traversal, serialize cooperating writers, stage privately in the destination directory, then
publish atomically. Replacements preserve ordinary permission bits, owner/group and extended
attributes when the filesystem permits this; preservation failure aborts instead of silently
broadening access. New files are private (`0600`); privilege bits are not copied. A denied
operation does not create an outside target. Parent directories already created for an
otherwise permitted write can remain after a later failure.

Cancellation before publication returns a definite cancellation when acknowledged. If the
connection/worker disappears after dispatch, the mutation result can be **unknown**: re-read
and reconcile before retrying. No automatic replay or alternate-backend rewrite occurs.
These are cooperative version/atomic-publication guarantees, **not** a universal atomic CAS
against unrelated editors, protection against every hostile concurrent filesystem mutation,
or a replacement for an OS sandbox.

Complete native reads, writes and edit inputs are bounded to **16 MiB**, with additional
request/reply byte budgets. Byte-range/stream reads can handle larger files; streams read in
256 KiB chunks and reject version changes between chunks. Native `watch` is unsupported.
The underlying filesystem must support the required descriptor, lock and publication
operations; unsupported filesystems fail rather than weakening write guarantees.

PTC `run_code` still has the existing Windows ACL/WSL-share limitation. Moving file tools
into Linux does not move the code-execution sandbox. See [native file design and tests](docs/performance-phase4.md).

## Diagnostics and performance

The existing local POST API accepts `{"method":"performance"}` at the configured plugin
route (default `/wsl-workspace/api`) on the **actual DSH host port**. It reports anonymous
provider IDs, pool status, launches/fallbacks and timing stages. `file.*` and `rpc.fs.*`
cover native files; `tool.grep/glob` cover search execution. Counts cover provider lifetime;
P50/P95 cover the latest **256 samples per stage**. Nested stages must not be added together.

No file paths, usernames, search terms or contents are retained in statistics; nothing is
written to disk or uploaded. Statistics are not a trace of model/network time or all DSH
scheduling. They disappear with the provider.

Reproduce file measurements with `npm run bench:native-files -- --iterations 20` on Windows.
This compares complete provider sequences, not isolated Python syscalls, using alternating
native/UNC runs and content checks. Linux runs are native-only controls. There is no fixed
latency gate, and search speedups are not file speedups. Evidence and scope live in the
[phase-one](docs/performance-phase1.md), [persistent-search](docs/performance-phase2.md),
[RPC/metrics](docs/performance-phase3.md) and [native-file](docs/performance-phase4.md) records.

### Verified file performance and resuming work

The corrected native-file checkpoint `e9f58fc3` passed native-file, search and full
compatibility checks. On one Windows/WSL2 fixture, native versus UNC P50 was **3.348 vs
16.399 ms** for `resolve + stat + read`, **23.614 vs 57.653 ms** for guarded write, and
**22.297 vs 69.603 ms** for guarded edit. This used 3,900-byte text, two warm-up pairs and
20 alternating samples per backend; it is not cold-start, model or end-to-end DSH latency.

See [the durable validation record](docs/native-files-validation.md) for WSL1/WSL2 results,
exact commits, artifact digests and scope. [CHECKPOINT.md](CHECKPOINT.md) is the starting
point for continuation: completed changes, validated code, remaining boundaries and commands.
Earlier measurements remain labelled with their own commits rather than being reused as
results of a later fix.

## Compatibility

The manifest inherits this upstream integration release list:

`0.1.0-rc.7` · `0.1.0-rc.8` · `0.1.1-rc.1` · `0.1.1-rc.2` · `0.1.2-rc.1` · `0.1.3-alpha.2` ·
`0.1.5-rc.1` · `0.1.5-rc.2` · `0.1.7-rc.1` · `0.1.7-rc.2` · `0.2.0-rc.2`

It is kept in sync with `package.json`. Historical evidence is in
[compatibility-evidence.md](docs/compatibility-evidence.md). This native-file phase uses
Node 24 and the pinned DSH `0.2.0-rc.2` packages, with Linux and Windows/WSL1/WSL2 source/lib
checks. [PR #5](https://github.com/yaelysia/dsh-wsl-workspace/pull/5) records the exact tested
commit and current results; a green historical release entry is not fresh validation of
this fork's new backend. Unlisted host releases and the user's installed Desktop build
require their own verification.

## Changelog

[CHANGELOG.md](CHANGELOG.md) and [CHANGELOG.zh.md](CHANGELOG.zh.md) retain the upstream release
history. The linked performance records and feature PRs describe unreleased fork changes.

## Documentation

[docs/README.md](docs/README.md) is the index; [TESTING.md](TESTING.md) defines build and test
requirements. English and Chinese READMEs describe this fork. The other translations are
explicitly marked upstream snapshots, not instructions for the native-file branch:
[日本語](README.ja.md), [한국어](README.ko.md), [Français](README.fr.md), [Deutsch](README.de.md),
[Español](README.es.md), [Português](README.pt.md), [Русский](README.ru.md).

## License & attribution

MIT. Keep [LICENSE](LICENSE) and [NOTICE](NOTICE) when redistributing. This fork builds on
[dsh-wsl-workspace](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace) and
adapts DeepSeek Harness filesystem/executor contracts. The native transaction implementation
and copied/adapted portions are identified in NOTICE; design references remain separately
credited. No new dependency license is implied by this README rewrite.

## Acknowledgments

Thanks to the upstream maintainers and the projects credited in NOTICE. The upstream
[dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale) UI theme acknowledgment is
retained; that separate project uses CC BY-NC-SA 4.0 and is not included in this plugin.
