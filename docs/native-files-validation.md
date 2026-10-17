# Native file validation and continuation

This record is append-only by validated code snapshot; measurements from an older snapshot
are never silently labelled as results of a later fix. Start at [CHECKPOINT.md](../CHECKPOINT.md)
for the active branch and next action. The runtime contract remains in
[performance-phase4.md](performance-phase4.md).

## Warm-executor baseline: 085c18ad

Production code and matching lib: `b473fa02911983c7f410e9a82e36f26ec5038ecf`.
Tested checkpoint: `085c18ad20c5f73a01c24e32549ab4c79573d80a` (temporary workflow cleanup only).

All three final runs completed successfully:

- [Native file source/lib on Linux, WSL1 and WSL2](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39050302741).
- [Full compatibility matrix](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39050302754).
- [Search and automatic RPC regression](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39050302727).

Native source/lib each passed 21 cases on Windows/WSL1 and Windows/WSL2. The warm-executor
[build](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39050176646) passed Node 24
build/rebuild equality, 234 portable cases (one existing dependency skip), 30 RPC cases,
108 pinned-host cases and integration drivers, type baseline and clean installation.
The existing 209-error type baseline and pre-existing ledger/platform skips remain; this
is not a claim of zero project-wide defects or validation of the user's Desktop install.

### Complete provider measurements

Measured 2026-10-17 on Windows Node 24.21.0, Ubuntu-24.04. Each backend has 20 samples after
two warm-up pairs, with alternating order. Text is 3,900 bytes; listing has 200 files.
Read means resolve + stat + read; writes/edits include resolve + stat + guarded mutation;
listing includes resolve + listDir. These are not bare Python syscalls or cold boot times.

| WSL | Operation | UNC P50 / P95 (ms) | Native P50 / P95 (ms) |
|---|---|---:|---:|
| 1 | Read | 10.045 / 11.531 | 2.397 / 2.847 |
| 1 | Guarded write | 42.464 / 46.085 | 16.636 / 20.261 |
| 1 | Guarded edit | 42.209 / 45.861 | 15.841 / 19.164 |
| 1 | List 200 files | 1600.435 / 1627.460 | 10.709 / 11.161 |
| 2 | Read | 17.007 / 17.834 | 3.628 / 3.894 |
| 2 | Guarded write | 61.239 / 66.724 | 20.984 / 24.389 |
| 2 | Guarded edit | 62.216 / 65.405 | 20.918 / 23.663 |
| 2 | List 200 files | 2771.103 / 2954.491 | 6.004 / 6.900 |

Each run ended with one RPC launch, zero pending requests and zero fallback. Results are
fixture-specific, especially directory enumeration over UNC; do not generalize the ratio
to all files, projects, disks, model latency or the whole DSH task.

[The checked-in JSON summary](evidence/native-files-validation.json) preserves the values,
platform versions, artifact IDs and SHA-256 digests. It copies reported summary values,
not unrecorded individual timings. The source artifacts also contain original benchmark JSON
and both contract logs; they expire, which is why the essential evidence is stored here.

## Directory-entry drive-routing correction: 2d3948d0

Production code and matching lib: `2d3948d00be3642ddee83cbefed56cebde8e6178`.
Temporary workflow cleanup: `e9f58fc38a3b3478515d595c80f6f65d303bba80`.

Review during continuation found that resolve() sent a physical /mnt/<drive> target to
Windows, but listDir() could wrap the same listed symlink as a native target with a Linux
version. The correction routes only those drive-backed rows through the existing Windows
resolver/stat. Ordinary Linux rows still use the single native listing, without per-entry
RPC. This preserves the same target/version contract for both discovery paths.

The added real Windows test covers file links, directory links and dangling links, native
neighbours, read, guarded write/edit, rejection of an old version and conditional creation.
Linux explicitly skips this Windows-specific case; it is not counted as a Linux pass.

[Node 24 delivery validation](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39052042681)
passed before publication: native source/lib each 21 pass plus the explicit Windows skip,
234 portable pass plus the existing dependency skip, 30 RPC pass, pinned-host integration,
unchanged type baseline and clean installation. Source and matching lib were committed
together; no unbuilt production source was published as an installable result.

The correction's own native-file, search and full-matrix runs all completed successfully:
[native files](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39052167196),
[search](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39052167163),
[full matrix](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39052167175).
Windows/WSL1 and Windows/WSL2 each passed **22 cases in both source and committed lib**, with
zero failures and zero skips. The new drive-routing case ran on each of those four paths.
The final documentation checkpoint changes no production source or built JavaScript.

### Corrected-checkpoint measurements

The same sampling protocol was run again for `e9f58fc3`: 20 samples per backend, two warm-up
pairs excluded, 3,900-byte content and 200-file listing, on Windows Node 24.21.0/Ubuntu-24.04.
Do not treat differences between separately provisioned CI runners as improvement caused by
the routing fix; that fix addresses backend/version correctness, not ordinary-file speed.

| WSL | Operation | UNC P50 / P95 (ms) | Native P50 / P95 (ms) |
|---|---|---:|---:|
| 1 | Read | 5.104 / 5.965 | 1.392 / 1.556 |
| 1 | Guarded write | 20.657 / 24.100 | 9.766 / 10.862 |
| 1 | Guarded edit | 22.650 / 25.990 | 8.547 / 12.403 |
| 1 | List 200 files | 797.343 / 836.814 | 6.109 / 7.154 |
| 2 | Read | 16.399 / 20.666 | 3.348 / 4.016 |
| 2 | Guarded write | 57.653 / 69.524 | 23.614 / 27.047 |
| 2 | Guarded edit | 69.603 / 82.205 | 22.297 / 30.780 |
| 2 | List 200 files | 2762.954 / 3041.239 | 7.481 / 10.882 |

Both corrected runs also ended with one RPC launch, zero pending calls and zero fallback.
The checked-in JSON has a separate snapshot for each tested commit. It retains reported
summary measurements and artifact SHA-256 values, not invented per-sample timing records.

## Checkpoint policy

The root checkpoint records completed production changes, the tested SHA, exact CI runs and
next actions. Update it at each meaningful implementation boundary. Commit source and matching
lib together, record unavailable checks instead of calling them passes, and never require the
user to reconstruct a finished change from chat messages or apply an external patch manually.
README evidence and this record are documentation-only additions on top of the tested code.
