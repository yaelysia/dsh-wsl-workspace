# 原生文件阶段检查点 / Continuation checkpoint

## 当前状态：四阶段改进与 Desktop 提示词修复已合入 main

续做与安装基线：`main`。原工作分支 `perf/phase4-native-files` 保留作历史检查点；[PR #5](https://github.com/yaelysia/dsh-wsl-workspace/pull/5) 已合并。

- 2026-10-18 按用户明确要求，将 PR #1、#3、#4、#5 按依赖顺序合入 `main`，保留 merge commit 和原提交历史；未强推、未删除历史分支。
- 主分支完整合并提交：`10e22b906fa5ff3436c47b22520741a5526c9822`。合并后的文件树为 `c52268a2ace4b4301abb76d659d65aa02eacaee6`，与已验证功能分支 `0fb7c16c6b44cb2388a9130b745031abb40c0201` 完全一致。随后仅同步中英文 README 安装入口和本检查点，不修改生产代码或 `lib/`。
- 最新生产修复及配套 `lib/`：`677a2178b16a443746460e3b62e0415278d3b566`，仅移除插件追加提示语中未注册的 `{{cwd}}`，保留原预设变量和其余 WSL 指导。
- 合并前已重新确认 `0fb7c16c` 的四套检查全部 success：原生文件 `39115570224`、搜索 `39115570103`、提示词兼容 `39115570124`、完整兼容矩阵 `39115570097`。这些是功能提交的实际检查；不将它们描述为之后文档提交的独立 CI。
- **未修改的 `0676ed1f` 在用户 Desktop 0.2.1-rc.2 上于调用工具前失败；之后通过的实机结果属于 `0676ed1f` 加本地一行修复。不能登记为原提交全通过。** 见 [脱敏 UAT 与修复记录](docs/uat-2026-10-18.md)。
- 用户反馈固定提交安装失败后要求合并。现在从主分支安装：`git+https://github.com/yaelysia/dsh-wsl-workspace.git#main`。合并不等于已确认该次安装故障的原因；未远程修改用户安装，也未将新主分支登记为用户 Desktop 已再次实测。
- 未发布 npm。版本号仍为开发用 `0.7.7`，以来源/SHA 区分构建。用 `git log -1 -- CHECKPOINT.md` 查本文档所在提交。

用户指定的原生文件读取、写入、编辑和 README 整理均已落地；不要从第三阶段重新实现，也不要让用户手工应用补丁。

## 已完成的检查点

| 检查点 | 提交 | 内容 |
|---|---|---|
| 原生实现 | `a342fdb4e848ebf8d63e88c917739a66e530d09a` | 原生文件事务与 RPC |
| README/测试环境修整 | `521256e29e9cb1db0d1d53f00f326a009297a968` | 中英文入口重组、宿主磁盘对照测试、配套构建 |
| warm executor | `b473fa02911983c7f410e9a82e36f26ec5038ecf` | 复用最多四个 Linux 文件执行进程，修复重复启动 Python 的小文件回退 |
| CP0 恢复 | `0a3648a95bf4d7d78e38cf97121d2be746a47116` | 恢复已完成工作，建立根目录检查点 |
| CP1 补修 | `2d3948d00be3642ddee83cbefed56cebde8e6178` | 目录中指向 Windows 磁盘的链接与直接解析使用相同后端/版本；新增真实回归和 lib |
| CP2 收尾 | `0676ed1fbed7960a7070259f1216699de8cb16d0` | 中英文导航、最终性能与验证范围、机器可读持久证据、接手说明 |
| CP3 实机验收 | `8ddde35c388c0a8222e25eb482d8c761f683f919` | 登记提示词阻断、原始/本地修复基线差异及未测项；不上传私人日志 |
| CP4 提示词修复 | `677a2178b16a443746460e3b62e0415278d3b566` | 源码一行修正、配套 lib、六种变量边界回归和真实宿主渲染测试 |
| CP5 主分支合并 | `10e22b906fa5ff3436c47b22520741a5526c9822` | 四阶段和提示词修复完整合入 main；源码/构建与通过四套检查的功能提交一致 |

本次依赖链的合并提交：PR #1 `75320d44da7d654898a030ccf4b9f1603a73f529` → PR #3 `771934edbb20afe83eeb438e0de89178703c50fb` → PR #4 `df6488e5f126cce1fd62c19f70bdfec9cafd1e79` → PR #5 `10e22b906fa5ff3436c47b22520741a5526c9822`。各 PR 均直接合入 main，而非仅合入中间功能分支。

CP1 的新增回归覆盖文件链接、目录链接、悬空链接、读取、版本保护写入、编辑、过期版本拒绝和条件创建。普通 Linux 条目没有新增逐项 RPC。原生 `lstat` 仍保留 Linux 链接身份。

## 最新提示词修复验证

交付运行 `39115027757` 全部通过并推送 CP4；源码和测试的五个修改文件已与下载的构建 artifact 逐字节核对，`lib/index.js` 已确认不再追加 `{{cwd}}`。

- 240 项便携测试通过，1 项既有依赖跳过；新增的六个 inline/block × prefix/suffix/text 用例保留上游变量，不再引入 cwd 依赖。
- 真正的 `renderPrompt` 分别来自 DSH `0.2.0-rc.2` 和 `0.2.1-rc.2`。每个版本运行三个测试入口，覆盖源码/构建包各七种生成预设；恢复坏插值的负向对照必须报原错误。不是只检查字符串存在，也没有放宽宿主插值器。
- 30 项 RPC、108 项固定宿主测试及集成通过；Linux 原生文件 source/lib 各 21 通过、1 项 Windows 专用跳过；重复构建、安装和原有类型门槛通过。
- `.github/workflows/persona-compat.yml` 将同样的两版本渲染回归加入 Linux/Windows 常规 CI；新版渲染器所需的 scope peer 仅安装到独立测试树，不改变运行依赖或旧版固定依赖。

上述新版检查验证的是提示词渲染，不等于对整个 Desktop 0.2.1-rc.2 的全自动端到端测试。真实 GUI 工作流证据仍来自用户上传的本地修复基线。**209-error 类型基线、原有台账缺陷和平台跳过项没有清零。**

## 历史原生文件验证（不替代新宿主 UAT）

下面三套运行均对应 `e9f58fc3`，最终状态为 success：

- [原生文件 Linux / WSL1 / WSL2，source / lib](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39052167196)：Windows 四条路径各 **22 通过、0 失败、0 跳过**；Linux source/lib 各 21 通过、1 项新增 Windows 专用测试明确跳过。
- [搜索与默认自动 RPC](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39052167163)。
- [完整兼容矩阵](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39052167175)。

[CP1 交付构建](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39052042681) 在推送前通过 Node 24 构建/重复构建、234 项便携测试（另有1项既有依赖跳过）、30 项 RPC、2 项预筛选、108 项锁定宿主测试及集成、干净安装和原有类型门槛。**209-error 类型基线和既有文档/平台跳过项没有清零。**

[持久验证记录](docs/native-files-validation.md) 与 [JSON 摘要](docs/evidence/native-files-validation.json) 分开保留 `085c18ad` 和 `e9f58fc3` 的数值、平台、artifact ID/摘要；不要混算不同运行器的结果。构建 artifact `native-routing-build`（ID `12107848458`）来自上述交付运行；关键证据不再只依赖会过期的 artifact。

## 接手先读与复现

先读取 main 的当前 HEAD 和本文件，检查有无新增提交；后续修改从 main 新建工作分支。主要入口：`src/fs.ts`、`src/shared/native-files.ts`、`src/shared/native-file-worker.ts`、`src/shared/rpc-transport.ts`、`src/shared/rpc-worker.ts`。本次提示词入口是 `src/host/variants.ts`、`tests/variants.test.ts`、`tests/persona-render.test.mjs`；文件测试为 `tests/native-files.test.mjs`。完整行为见 [原生合同](docs/performance-phase4.md)。

在 Node 24 的开发/CI 检出环境：

```text
npm ci
node ci/install-pinned.mjs
npm run test:persona
npm run test:native-files
DSH_WSL_TEST_PLANE=lib npm run test:native-files
npm run test:search-transport
npm run test:node
npm run typecheck:gate
npm run test:docs
npm run test:docs-claims
npm run verify:install
```

上面的环境赋值是 Bash 写法；Windows PowerShell 用 `$env:DSH_WSL_TEST_PLANE='lib'`。Windows 用实际 `WSL_COMPAT_DISTRO`，不要使用旧机器的硬编码目录。修改生产源码后必须重建、校验并提交配套 `lib/`，再跑 source/lib 两条验证。Linux 跳过的 Windows 测试必须到 WSL1/WSL2 验证。

## 尚未做 / 不要扩大完成声明

新 GitHub 构建的 Desktop 安装复测、未列出的宿主版本和正式发布不在已完成验证内。用户已完成的是本地修复后的基本文件/搜索、项目只读操作、工作区切换、取消、空闲回收及重启恢复；忙碌 RPC 超过 120 秒、刻意重叠的混合并发、可选 Windows 挂载测试尚未覆盖。

实际 Desktop 诊断显示搜索和文件各启动一个 worker；这与同权限域共池的预期存在差异，但不构成已证实的泄漏或功能失败。后续先核查实际服务归属/初始化顺序，不得通过跨权限域全局单例强行合池，也不要把未实现的优化写成已完成。

原生 watch、Skill/inotify、PTC 沙箱和正文缓存未实现；本轮没有将这些功能迁移到 Linux。Skill 原生化不在用户确定的后续路线中。后续改动应从本检查点继续，按小段提交实现、回归和验证记录。

不可破坏的边界：已下发写入不自动重放；未知结果重读核对；原生目标失败后不改走 UNC 写入。Linux 权限/物理路径策略、条件创建、版本保护、属主/属性保留和流式版本检查保留。Windows 磁盘继续使用 Windows 后端。完整读取和写入/编辑输入限16 MiB；并非对任意外部编辑器的通用原子 CAS，也不是完整 OS 沙箱。
