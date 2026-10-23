# DSH WSL Workspace Enhanced

**Run DeepSeek Harness on Windows. Work on your code in WSL.**

[English](README.md) · [简体中文](README.zh.md) · [Other languages](#other-languages)

This repository is an independently maintained **fork** of the original
[`dsh-wsl-workspace` project](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace).
**This fork:** https://github.com/yaelysia/dsh-wsl-workspace

DSH keeps its interface, models, sessions and plugin management on Windows. Your project
stays inside a local Linux distribution, where DSH uses Linux paths, shell commands,
file editing and code search. **You do not need to install a second DSH in WSL.**

## What this fork does

| Workflow | How it works |
| --- | --- |
| Open a Linux project | Choose a WSL distribution, Linux user and directory from the **W** workspace entry in DSH |
| Run commands | Use a persistent WSL Bash session; interactive programs can use `wsl_terminal` |
| Read and edit files | Use normal DSH `read` / `write` / `edit` tools backed by native Linux file I/O |
| Find code | Use `grep` and `glob` inside the distribution, with reusable search execution |
| Keep Windows access | Reach mounted drives such as `/mnt/c/Users/...` without moving your project |
| Avoid repeated startup | File and search operations share an owner-scoped RPC worker when their settings agree; idle workers can be released and recreated |

The emphasis is on a **normal DSH workflow**, not a parallel agent running in Linux.
The file and search backend is designed to keep results, execution identity and workspace
paths consistent across the same session.

## Requirements

- **Windows** with WSL installed and at least one working Linux distribution.
- **DeepSeek Harness for Windows**, with third-party plugin installation available.
- **Python 3.8+ inside the distribution** (`python3`), used by native file and persistent RPC workers.

Check your environment in Windows PowerShell:

```powershell
wsl --list --verbose
wsl -d Ubuntu --exec python3 --version
```

Replace `Ubuntu` with your distribution name. WSL does **not** need another DSH, Node.js,
a pip installation, a background service or an open network port. Node.js 24+ is needed
only when building or testing this repository as a developer.

## Install

**Pre-release:** use the npm `next` tag. The existing behaviour matrix still has three unresolved items; see [release behaviour matrix](docs/release-behaviour-matrix.zh.md).

1. Open the **Plugins** page in Windows DSH and select the option to add a third-party plugin.
2. Enter the npm package name (recommended):

   ```text
   dsh-wsl-workspace-enhanced@next
   ```

   Or install this repository's Git source:

   ```text
   git+https://github.com/yaelysia/dsh-wsl-workspace.git#main
   ```

3. Enable the plugin, then **fully exit and restart DSH** (including its host process).

CLI installation: `dsh plugin --profile web add dsh-wsl-workspace-enhanced@next`.
For a pinned Git release, replace `#main` with `#v0.7.9`.

[GitHub Releases](https://github.com/yaelysia/dsh-wsl-workspace/releases) ·
[npm](https://www.npmjs.com/package/dsh-wsl-workspace-enhanced)

The upstream npm package named `dsh-wsl-workspace` is **not** this fork. Do not enable
both copies under the same plugin identity. The installed plugin version is declared in [`package.json`](package.json). For Git installations,
**also check the Git source and resolved commit SHA** to verify which code was installed.

**Updating:** Update `dsh-wsl-workspace-enhanced@next` through the plugin manager. For Git installations, use the same Git source. If DSH's plugin updater cannot identify an
already-installed Git package, record your settings, remove the old copy through the
plugin manager and install this source again. A full restart is the reliable way to
activate changes; live profile reload is controlled by DSH itself. If an update reports
failure, verify the installed source/commit before treating it as updated.

## Create your first WSL workspace

1. Click **W** beside Settings in DSH.
2. Select the distribution and, optionally, the Linux username.
3. Enter a Linux absolute directory, for example `/home/me/projects/demo`.
4. Choose **Create & open**, then select a mode that exposes the tools you need (such as **WSL Standard**).

Try reading a source file, searching for a symbol with `grep`, editing it with `edit`,
and running a test with `bash`. Normal DSH file tools should be used directly: wrapping
every operation in `wsl.exe` or Bash defeats the point of the integration.

**Paths and identity:** Linux files use Linux path semantics, including case sensitivity.
Windows drives remain available at `/mnt/c/...`. File and search workers use the
selected WSL identity; distinct workspace owners remain isolated rather than sharing a
global worker. Mode-specific tools, including background jobs, depend on the chosen DSH mode.

## Configuration

The following are **plugin settings**, not tool-call parameters. The defaults work
without manual tuning:

```yaml
fileBackend: auto
searchTransport: auto
searchIdleMs: 120000
searchMetrics: true
```

| Setting | Choices / meaning |
| --- | --- |
| `fileBackend` | `auto` prefers native Linux I/O; `native` requires it; `unc` uses the compatibility path |
| `searchTransport` | `auto` prefers persistent RPC; `persistent` requires it; `oneshot` starts a new search for each call |
| `searchIdleMs` | Worker idle lifetime in milliseconds; default **120,000** (2 minutes) |
| `searchMetrics` | Capture bounded, in-memory file/search/RPC timing and worker counters |

Native startup fallback is deliberately limited. An interrupted or uncertain write is
**not retried automatically** through another backend. Changing filesystem identity or
backend settings should be followed by a new session or file resolution.

## Diagnostics

The plugin exposes a host-local endpoint at `POST /wsl-workspace/api` with body:

```json
{"method":"performance"}
```

Use your **actual DSH host port**. The response contains worker counts, launches,
idle releases, fallback counts, and timings (`file.*`, `rpc.fs.*`, `tool.grep` /
`tool.glob`). For an active session using compatible settings, file and search work
should be visible in the **same owner pool**; do not confuse the total number of
registered providers with the number of running workers.

Statistics exclude model thinking and network latency. A first call may include worker
startup cost, so compare warm calls separately. See
[performance and test evidence](docs/native-files-validation.md) and
[development testing](TESTING.md).

## Compatibility

**Desktop verification:** DSH Desktop 0.2.1-rc.2 was exercised on Windows/WSL,
including native tools, workspace isolation, idle recovery, restart and shared RPC.
The latest shared-pool fix was accepted in the user's Desktop verification after PR #7.

The package manifest also declares the following **historical DSH integration
releases**. These declarations do **not** mean every new native backend feature was
retested on every old release:

`0.1.0-rc.7` · `0.1.0-rc.8` · `0.1.1-rc.1` · `0.1.1-rc.2` · `0.1.2-rc.1` ·
`0.1.3-alpha.2` · `0.1.5-rc.1` · `0.1.5-rc.2` · `0.1.7-rc.1` · `0.1.7-rc.2` ·
`0.2.0-rc.2`

The authoritative declaration is in [`package.json`](package.json); see
[compatibility evidence](docs/compatibility-evidence.md) for test scope.

## Limits and recovery

- A full native file read, write or exact edit is limited to **16 MiB**; larger reads can use ranges or streaming.
- Writes use Linux-side path checks, version guards and atomic publication where supported. These are **not** a complete OS sandbox or a universal protection against unrelated external writers.
- After a disconnect during a mutation, its outcome may be unknown. **Read the file before deciding whether to retry.**
- A native file `watch` API has not been implemented. PTC `run_code` does not automatically acquire a Linux execution sandbox.
- A DSH profile hot-reload error can require a **complete host restart**. That host-side issue is separate from the WSL file/search functionality.

## Documentation

[Docs index](docs/README.md) · [Testing](TESTING.md) ·
[Changelog](CHANGELOG.md) · [Latest engineering checkpoint](CHECKPOINT.md)

### Other languages

Other-language quick guides (the English and Chinese guides contain the full details):
[日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) ·
[Deutsch](README.de.md) · [Español](README.es.md) ·
[Português](README.pt.md) · [Русский](README.ru.md)

## Origin and license

**Original project (fork parent):**
https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace

**This enhanced fork:**
https://github.com/yaelysia/dsh-wsl-workspace

The fork builds on the original project and is maintained independently; it is not an
official DSH release or a replacement for the upstream package. Licensed under **MIT**:
[LICENSE](LICENSE). Attribution and incorporated-work notices: [NOTICE](NOTICE).
