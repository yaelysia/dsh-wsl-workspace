# 当前检查点 / Continuation checkpoint

## 接手入口

- 工作分支：`perf/phase4-native-files`；[PR #5](https://github.com/yaelysia/dsh-wsl-workspace/pull/5)，叠加在第三阶段之上。
- 用户目标：接着已有工作完成原生文件读取、写入、编辑，整理 README，并保留可接手的检查点。不要从第三阶段重做。
- 本轮恢复到的已验证提交：`085c18ad20c5f73a01c24e32549ab4c79573d80a`。
- 其中生产代码与构建产物来自 `b473fa02911983c7f410e9a82e36f26ec5038ecf`；后续仅删除临时交付 workflow。
- `main`、前序分支及用户本机安装未改动；本检查点不授权自动合并或发布。

## 已完成并存入 Git 的工作

原生 `resolve/stat/lstat/read/range/list/write/edit`、固定后端/发行版/用户身份、写入版本保护与原子发布、取消回执及未知结果处理已实现。文件和搜索复用 owner-scoped RPC。最近的改动进一步复用最多四个 Linux 文件执行进程，修复逐操作启动 Python 导致的小文件性能回退；不要恢复为逐操作启动。

中英文 README 已重整，七种其他语言已标明上游快照。实现合同见 [原生文件说明](docs/performance-phase4.md)。

## CP0：恢复与核验完成

对上述 `085c18ad`，以下运行的最终状态已实际读取，均为 success：

- [完整兼容矩阵](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39050302754)
- [原生文件 Linux / WSL1 / WSL2、source / lib](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39050302741)
- [搜索及默认 auto 回归](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39050302727)
- [warm executor 构建与宿主集成](https://github.com/yaelysia/dsh-wsl-workspace/actions/runs/39050176646)

构建 artifact：`native-files-warm-build`，ID `12106794671`，含 source.tar、插件 tgz、commit.txt 和日志。WSL2 原生性能 artifact：`native-files-wsl2`，ID `12107731751`。Artifacts 有保存期限，不应将它们作为唯一长期交接材料。

## 下一检查点的具体工作

1. 核对已提交 warm-executor 代码与最终原生文件测试；只补真实缺口，不重复实现已完成的后端。
2. 将最终 WSL1/WSL2 测量与验证提交写入持久文档，更新仍指向旧提交/运行状态的 PR 说明。
3. 在中英文 README 增加本检查点入口，核验配置、限制和性能描述与实际实现一致。
4. 修改后运行可执行的检查，提交后记录新的 SHA 和 CI 结果；未完成的检查明确列出。

## 不得在续做中丢失的边界

- 不自动重放已下发的写入；未知结果必须重读核对。原生目标不能故障后改走 UNC 写入。
- 写入授权、条件创建、版本保护、属主/权限/扩展属性保留，以及分段读取的一致性检查不可因提速跳过。
- Windows 盘保留 Windows 后端；Skill/inotify、PTC 和正文缓存不在本轮。
- 完整读取和写入/编辑输入限 16 MiB；不是对任意外部编辑器的通用原子 CAS，也不是完整 OS 沙箱。
- 固定 Node 24 / DSH 依赖验证与本地 Linux 控制测试分开记录；原有 209-error 类型基线和既有跳过项不伪装为全清零。

续做时先读取此文件和当前分支 HEAD，确认是否有更新，再修改。每个有意义的完成段应有独立提交及相应验证记录。

## CP1：目录条目跨 Windows 磁盘的路由修复

原生目录枚举中解析到 `/mnt/<drive>` 的条目现在与直接 `resolve` 使用同一 Windows 后端，并重新取得该后端的版本，避免将 Linux 版本交给 Windows 条件写入。普通 Linux 条目不增加逐文件 RPC。

新增真实 Windows/WSL 用例覆盖文件链接、目录链接、悬空链接、版本匹配、读取、条件写入、编辑和条件创建。此用例在 Linux 明确跳过，不冒充跨系统验证。源码与配套 lib 在本提交中一起生成；推送前需通过 Node 24 构建、Linux 原生 source/lib、RPC、宿主集成、类型基线及安装检查。Windows 与完整矩阵须检查本提交之后的 PR CI；未完成前不算通过。
