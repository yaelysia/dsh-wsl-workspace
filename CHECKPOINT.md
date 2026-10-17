# 原生文件阶段检查点 / Continuation checkpoint

## 当前状态：实现、补修与文档收尾完成

工作分支：`perf/phase4-native-files`；[PR #5](https://github.com/yaelysia/dsh-wsl-workspace/pull/5)，基于第三阶段 `8d8b3a7c5b88cb1096eaed4d757f86586959505f`。

- 最新生产代码及配套 `lib/`：`2d3948d00be3642ddee83cbefed56cebde8e6178`。
- 最后经三套完整 CI 验证的检查点：`e9f58fc38a3b3478515d595c80f6f65d303bba80`；它只删除临时交付 workflow，生产代码与上项一致。
- 本文档收尾提交仅更新 README、检查点和持久证据，不修改 `src/` 或 `lib/`。用 `git log -1 -- CHECKPOINT.md` 获取本文档的提交，不将旧 CI 冒充后续提交的独立运行。
- `main`、前序分支、用户本机安装未改动；PR 未合并、未发布 npm。版本号仍为开发用 `0.7.7`，以 SHA 区分构建。

用户指定的原生文件读取、写入、编辑和 README 整理均已落地；不要从第三阶段重新实现，也不要让用户手工应用补丁。

## 已完成的检查点

| 检查点 | 提交 | 内容 |
|---|---|---|
| 原生实现 | `a342fdb4e848ebf8d63e88c917739a66e530d09a` | 原生文件事务与 RPC |
| README/测试环境修整 | `521256e29e9cb1db0d1d53f00f326a009297a968` | 中英文入口重组、宿主磁盘对照测试、配套构建 |
| warm executor | `b473fa02911983c7f410e9a82e36f26ec5038ecf` | 复用最多四个 Linux 文件执行进程，修复重复启动 Python 的小文件回退 |
| CP0 恢复 | `0a3648a95bf4d7d78e38cf97121d2be746a47116` | 恢复已完成工作，建立根目录检查点 |
| CP1 补修 | `2d3948d00be3642ddee83cbefed56cebde8e6178` | 目录中指向 Windows 磁盘的链接与直接解析使用相同后端/版本；新增真实回归和 lib |
| CP2 收尾 | 本文档所在提交 | 中英文导航、最终性能与验证范围、机器可读持久证据、接手说明 |

CP1 的新增回归覆盖文件链接、目录链接、悬空链接、读取、版本保护写入、编辑、过期版本拒绝和条件创建。普通 Linux 条目没有新增逐项 RPC。原生 `lstat` 仍保留 Linux 链接身份。

## 已实际确认的验证

下面三套运行均对应 `e9f58fc3`，最终状态为 success：

- [原生文件 Linux / WSL1 / WSL2，source / lib](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39052167196)：Windows 四条路径各 **22 通过、0 失败、0 跳过**；Linux source/lib 各 21 通过、1 项新增 Windows 专用测试明确跳过。
- [搜索与默认自动 RPC](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39052167163)。
- [完整兼容矩阵](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39052167175)。

[CP1 交付构建](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39052042681) 在推送前通过 Node 24 构建/重复构建、234 项便携测试（另有1项既有依赖跳过）、30 项 RPC、2 项预筛选、108 项锁定宿主测试及集成、干净安装和原有类型门槛。**209-error 类型基线和既有文档/平台跳过项没有清零。**

[持久验证记录](docs/native-files-validation.md) 与 [JSON 摘要](docs/evidence/native-files-validation.json) 分开保留 `085c18ad` 和 `e9f58fc3` 的数值、平台、artifact ID/摘要；不要混算不同运行器的结果。构建 artifact `native-routing-build`（ID `12107848458`）来自上述交付运行；关键证据不再只依赖会过期的 artifact。

## 接手先读与复现

先读取当前分支 HEAD 和本文件，检查有无新增提交。主要入口：`src/fs.ts`、`src/shared/native-files.ts`、`src/shared/native-file-worker.ts`、`src/shared/rpc-transport.ts`、`src/shared/rpc-worker.ts`。测试为 `tests/native-files.test.mjs`；完整行为见 [原生合同](docs/performance-phase4.md)。

在 Node 24 的开发/CI 检出环境：

```text
npm ci
node ci/install-pinned.mjs
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

用户实际 DSH Desktop 安装、未列出的宿主版本、主分支合并和正式发布不在已完成验证内。原生 watch、Skill/inotify、PTC 沙箱和正文缓存未实现；本轮没有将这些功能迁移到 Linux。后续改动应从本检查点继续，按小段提交实现、回归和验证记录。

不可破坏的边界：已下发写入不自动重放；未知结果重读核对；原生目标失败后不改走 UNC 写入。Linux 权限/物理路径策略、条件创建、版本保护、属主/属性保留和流式版本检查保留。Windows 磁盘继续使用 Windows 后端。完整读取和写入/编辑输入限16 MiB；并非对任意外部编辑器的通用原子 CAS，也不是完整 OS 沙箱。
