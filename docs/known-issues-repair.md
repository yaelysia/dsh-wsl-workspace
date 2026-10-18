# Known-issue repair checkpoint (CP7)

Base: `main` at `a4e650470c9f78a17fd848f960afa2ee4c70be93`.
Work branch: `fix/uat-known-issues`. Continue the accepted native-files implementation; do not restart it.

## Scope and evidence

The user requested attempts to repair all currently known problems after CP6. The target remains Windows DSH operating WSL project files and commands. No Skill backend migration, native watch, new code-execution sandbox or content cache is planned.

1. Host profile hot reload: `profile reload requires the root Include entry` on Desktop 0.2.1-rc.2. Package acquisition and saved enablement work; full restart works. Locate and reproduce the registration/context/module-identity failure before selecting a correction. Do not invent another root Include, rewrite the user's configuration, swallow activation failures or weaken permissions.
2. Search/files RPC ownership: both UAT submissions show two separately launched workers. Reproduce real service initialization instead of the existing direct-injection fixture; preserve permission realms, identity isolation, explicit overrides and disposal ownership.
3. Coverage gaps: busy RPC crossing its idle deadline, overlapping search/read/write and cancellation, recovery, and mounted Windows targets. An untested scenario is not itself a confirmed defect. Add deterministic regressions and platform-specific checks; do not relabel Linux as Windows verification.
4. Existing help/diagnostic inaccuracies relevant to operating the plugin: correct statements proven inconsistent with the shipped implementation, without expanding the feature scope. Retain an explicit ledger for remaining historical debt rather than silently relaxing gates.

## Delivery rules

Keep each useful stage committed. Tests must demonstrate the failing behavior before a production change where feasible. Rebuild and verify matching `lib/` for runtime changes. Raw UAT archives and private paths/configuration stay outside the public repository. Record exact source SHA, test commands, platforms and limitations. Do not claim a host fix has run on the user's Desktop without a new UAT.

## Current progress

- CP7: recovered main and private evidence; created this work branch and issue inventory.
- Investigation and regression development in progress; no runtime fix claimed at this checkpoint.
- `CHECKPOINT.md` remains the accepted CP6 baseline until a tested successor is recorded.
