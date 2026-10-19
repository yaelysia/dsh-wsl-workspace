# CP13 — Final cross-platform evidence

## Result and exact code

The clearest verified benefit is **less temporary allocation and repeated bootstrap generation**, not consistently lower end-to-end file-operation latency. Keep the mixed results below visible rather than selecting only faster rows.

- Baseline: CP12 `30b9abf7496d818c1f43a69ee50745e924e8a37a`.
- Revised runtime and matching lib: `a7e5d8ea524c13b11f565768f52306a52a19b26a`.
- Fully validated PR head: `d6b872c1434109eca6735a9fb2f03fdab2e412d1`.
- PR test merge: `0fcec9c10e6c6f34a6c731c7f0965636184492f9` into the CP12 branch.
- This evidence/checkpoint update is documentation-only and does not modify that runtime or lib.

The first alphabet-scanning candidate was rejected after it made calls slower. Its measurements remain in [the experiment record](performance-cp13.md) and exact Git history. The retained Base64 implementation still uses native decode/re-encode canonical validation plus an early byte-bound check. Its valid-data microbenchmark was also slower in the measurements below; the byte-bound check is an allocation guard, **not a claimed decoding speedup**.

## Method

[Measurement run 39215206635](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39215206635) completed successfully on both platforms. The same process alternates baseline/current native providers, each with its own isolated fixture and pool. Timed file sequences include resolve + stat + read or version-guarded write/edit. There are 24 samples per backend/operation/size after two warm-up pairs. Results, independently read disk bytes and published versions are checked. Both pools ended with one worker, one launch, zero pending calls and zero fallbacks.

Windows measured the actual Windows-to-WSL2 stdio path: Windows Server 2025, Node v24.21.0, Ubuntu-24.04, kernel `6.18.40.1-microsoft-standard-WSL2`; the job explicitly verified WSL version 2. Linux measured native local subprocess execution on Ubuntu with the same Node version. Both used pinned DSH 0.2.0-rc.2 dependencies. The separate actual-Loader compatibility suite also checked the reported 0.2.1-rc.2 host version.

These are warm provider benchmarks, **not** Desktop GUI, model/network latency, UNC comparisons, or statistical guarantees on other machines. No latency threshold was weakened to make a job pass; correctness checks and timing observations are separate.

## Windows to WSL2 — all file results

All times are milliseconds. P50 is the median; P95 is the nearest-rank 95th percentile over 24 samples and remains sensitive to outliers.

| Bytes | Operation | Before P50 | After P50 | Before P95 | After P95 |
|---:|---|---:|---:|---:|---:|
| 4096 | read | 3.1630 | 3.1583 | 4.0292 | 4.0634 |
| 4096 | write | 22.2588 | 21.0289 | 55.8842 | 48.2393 |
| 4096 | edit | 23.6337 | 21.9680 | 72.5895 | 27.0572 |
| 262144 | read | 12.6854 | 13.4480 | 15.4259 | 17.8308 |
| 262144 | write | 150.4448 | 149.0484 | 183.9406 | 199.7246 |
| 262144 | edit | 39.1880 | 38.4567 | 127.9819 | 55.8414 |
| 4194304 | read | 144.6001 | 145.5478 | 154.4275 | 166.2597 |
| 4194304 | write | 256.4597 | 263.0898 | 353.8024 | 368.5766 |
| 4194304 | edit | 260.1296 | 259.0027 | 280.0012 | 270.2972 |

In this run the 4 KiB write/edit medians improved by approximately 5.5%/7.0%. Large-file timings did not improve consistently; the 256 KiB read and 4 MiB write/read rows regressed. Do not describe this as a general file speedup or stable tail-latency improvement.

## Linux — all file results

| Bytes | Operation | Before P50 | After P50 | Before P95 | After P95 |
|---:|---|---:|---:|---:|---:|
| 4096 | read | 1.078185 | 1.067588 | 1.286708 | 1.349212 |
| 4096 | write | 1.970488 | 1.946081 | 2.190278 | 2.499104 |
| 4096 | edit | 1.949987 | 1.938219 | 2.204770 | 2.124479 |
| 262144 | read | 7.039612 | 6.996947 | 8.012156 | 7.862551 |
| 262144 | write | 18.312098 | 18.509054 | 47.259531 | 58.844322 |
| 262144 | edit | 12.753119 | 12.715903 | 40.116302 | 54.975972 |
| 4194304 | read | 66.826142 | 68.131336 | 70.073899 | 73.288946 |
| 4194304 | write | 158.628513 | 155.439546 | 309.753516 | 272.431852 |
| 4194304 | edit | 135.496296 | 137.286139 | 199.867504 | 335.884672 |

These final-head 24-sample results supplement, not overwrite, the earlier 16-sample Linux delivery readings in [performance-cp13-linux.json](performance-cp13-linux.json). Different runs need not have identical absolute latencies.

## Allocation and repeated-work measurements

The benchmark extracts the actual bundled newline-sampling expression from both revisions and applies it to 4 MiB text with Python tracemalloc. Both platform runs observed the same result: **8,396,870 bytes before; 12,760 bytes after**, with identical 4096-code-point samples. This is about 8 MiB to 12.5 KiB for that expression alone, **not total worker/DSH RSS**. Removing other full-buffer copies is visible in the code but no total-process peak memory reduction was measured.

The warmed bootstrap benchmark makes 20 repeated calls per sample, over 30 samples. It measures construction/compression of immutable bundled code, not wsl.exe/Python startup or first-call latency:

| Platform | Before P50 ms | After P50 ms | Before P95 ms | After P95 ms |
|---|---:|---:|---:|---:|
| Windows | 13.9148 | 0.0015 | 16.6015 | 0.0260 |
| Linux | 9.577944 | 0.000981 | 10.517309 | 0.011447 |

The valid 4 MiB decoder microbenchmark (40 samples, separate from file measurements) showed **3.5846 to 5.0985 ms** P50 on Windows and **1.983387 to 3.319259 ms** on Linux. No causal explanation or decoding acceleration is established. The constant-time encoded-size guard does reject oversized input without allocating a decoded Buffer; a regression test verifies that specific property.

## Completed checks on d6b872c1

All six workflows were read back as completed/success:

| Suite | Run |
|---|---|
| Full artifact, pinned-host and WSL1/WSL2 source/lib matrix | [39215206477](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39215206477) |
| Native files, Loader, owner/mixed load and real 125-second busy lifetime | [39215206429](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39215206429) |
| Reported-host Loader compatibility | [39215206453](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39215206453) |
| Search and persistent RPC | [39215206512](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39215206512) |
| Persona compatibility | [39215206417](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39215206417) |
| Paired Linux and Windows/WSL2 performance | [39215206635](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39215206635) |

Existing 209-error type baseline is neither increased nor cleared; inherited platform/optional-dependency skips remain explicit. Added tests cover canonical Base64 padding equivalence, pre-allocation bounds, bootstrap validity, and real-host Unicode/CRLF edit boundaries. Passing these checks is not a fresh Desktop GUI acceptance.

## Raw artifact provenance

The summary values above were read from the successful job logs, alongside the recorded environment and assertions. Artifact metadata was independently read back; the ZIPs contain all raw samples and stage diagnostics. Expiring artifacts are supplemented by this persistent summary.

- Windows job `117937334817`, artifact `12169890088`, name `native-rpc-performance-windows-latest`, SHA-256 `ee9f5d8c5ca5c7a7753ea0637e6aaf746e5734ec2d9e0dbb0a5e2453823c7cdd`.
- Linux job `117937334530`, artifact `12169462106`, name `native-rpc-performance-ubuntu-latest`, SHA-256 `300df3060d0a3d58f999e783c61b43bb7ac5f4f9ff9c66407cb1d55dba933430`.

[Checkpoint](../CHECKPOINT.md) · [Implementation and rejected-candidate record](performance-cp13.md) · [PR #10](https://github.com/yaelysia/dsh-wsl-workspace/pull/10)
