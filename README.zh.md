# DSH WSL Workspace Enhanced

**DSH 运行在 Windows，代码和工具链留在 WSL。**

[简体中文](README.zh.md) · [English](README.md) · [其他语言](#其他语言)

这是一个独立维护的增强版，**fork 自原项目**
[dsh-wsl-workspace-maintainers/dsh-wsl-workspace](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace)。

**当前仓库：** https://github.com/yaelysia/dsh-wsl-workspace

目标很简单：**在 Windows 侧正常使用 DSH，就能直接操作 WSL 内的项目目录。**
界面、会话、模型和插件管理仍在 Windows；文件访问、代码搜索和命令执行进入指定
Linux 发行版。无需在 WSL 再安装一套 DSH，也不需要为了日常开发频繁转换路径。

## 这个版本能做什么

| 使用场景 | 实际能力 |
| --- | --- |
| 打开项目 | 通过 DSH 的 **W** 入口选择 WSL 发行版、用户和 Linux 目录 |
| 命令与测试 | 在对应 WSL 环境执行 Bash；支持持久 Shell，交互程序可用 `wsl_terminal` |
| 文件读写 | 普通 `read` / `write` / `edit` 工具直接使用 Linux 原生文件后端 |
| 代码检索 | `grep` / `glob` 在 Linux 内运行，复用常驻搜索执行环境 |
| Windows 文件 | 仍可访问 `/mnt/c/...` 等 Windows 挂载盘 |
| 降低重复启动开销 | 文件与搜索在同一归属域内共用 RPC worker；空闲自动回收，使用时再恢复 |

这里强调的是**日常完整工作流**，不是单独提供几个 WSL 命令，也不是在 Linux
里启动第二个 Agent。相对路径、执行用户、文件版本与搜索结果应和当前工作区一致。

## 运行要求

- Windows 已启用 **WSL**，并且至少有一个可以正常使用的发行版。
- Windows 版 **DeepSeek Harness（DSH）**，可安装第三方插件。
- WSL 发行版内有 **Python 3.8+**，且可直接调用 `python3`（用于原生文件与常驻 RPC）。

在 Windows PowerShell 检查：

```powershell
wsl --list --verbose
wsl -d Ubuntu --exec python3 --version
```

请将 `Ubuntu` 改为实际发行版名称。**不需要**在 WSL 安装 DSH、Node、pip
依赖、常驻系统服务，也不需要为插件开放端口。Node.js 24+ 只针对自行构建和开发测试。

## 安装与更新

**预发布版：**通过 GitHub Releases 分发。现有行为矩阵仍有 3 项未定，详见[发布行为矩阵](docs/release-behaviour-matrix.zh.md)。

1. 在 Windows DSH 打开**插件**页面，选择**添加／安装第三方插件**。
2. 填写此发布版本的 Git 来源：

   ```text
   git+https://github.com/yaelysia/dsh-wsl-workspace.git#v0.7.9
   ```

3. 启用插件，**完整退出并重新启动 DSH**，包括其宿主进程。

命令行安装：

```powershell
dsh plugin --profile web add git+https://github.com/yaelysia/dsh-wsl-workspace.git#v0.7.9
```

开发分支安装地址：`git+https://github.com/yaelysia/dsh-wsl-workspace.git#main`。
[GitHub Releases](https://github.com/yaelysia/dsh-wsl-workspace/releases) 提供固定版本下载。
此增强 fork 不发布到 npm。

**不要安装上游同名 npm 包来替代增强版。** 两者插件标识相同，不应同时启用。
当前插件版本以 [`package.json`](package.json) 为准。通过 Git 安装时，还应核对**Git 来源与
实际解析 SHA**，确认运行的确实是预期版本。

**更新方式：**将 Git 来源中的版本标签改为新 Release；若要跟随开发分支，继续使用 `#main`。如果 DSH 更新器无法识别已有的 Git
安装，可以先记录插件配置，从插件管理页面卸载旧副本，再重新安装这个地址。
宿主热重载由 DSH 官方负责；安装／更新后完整重启最稳妥。若安装界面明确报错，
先核对实际安装提交，不要把“文件下载过”当作更新成功。

## 开始使用

1. 在 DSH 设置旁点击 **W**。
2. 选择发行版；需要指定 Linux 身份时填写用户名，否则使用发行版默认用户。
3. 选择 Linux 绝对路径，例如 `/home/me/projects/demo`。
4. 点击**创建并打开**，选择包含所需工具的模式（例如 **WSL Standard**）。

现在可以直接用 `read` 查看源文件，用 `grep` 定位符号，用 `edit` 修改，
再用 `bash` 跑单元测试。**读写搜索都尽量使用 DSH 原有文件工具**，不需要把每次
操作写成一条 `wsl.exe` 或 Bash 命令。

Linux 文件保留区分大小写等语义，Windows 文件仍可以通过 `/mnt/c/...` 访问。
文件和搜索执行采用选定的 WSL 用户；不同工作区或权限归属不会通过全局单例
混用 worker。持久后台任务等能力取决于所选 DSH 模式。

## 配置

以下是**插件配置项**，不是调用文件工具时传入的参数。默认值适合直接使用：

```yaml
fileBackend: auto
searchTransport: auto
searchIdleMs: 120000
searchMetrics: true
```

| 配置 | 含义 |
| --- | --- |
| `fileBackend` | `auto` 优先原生 Linux I/O；`native` 强制原生；`unc` 使用兼容路径 |
| `searchTransport` | `auto` 优先常驻 RPC；`persistent` 强制常驻；`oneshot` 每次搜索单独启动 |
| `searchIdleMs` | RPC worker 空闲回收阈值，默认 **120000 毫秒（2 分钟）** |
| `searchMetrics` | 是否记录有界的文件、搜索和 RPC 性能统计 |

默认情况下不需要调参。原生后端仅允许在安全的启动阶段进行有限回退；如果写入
途中失去回执，**不会自动切换后端重写一次**。修改后端或用户配置后，建议开启新
会话或重新解析文件目标。

## 性能与诊断

插件提供本机接口 `POST /wsl-workspace/api`，请求体：

```json
{"method":"performance"}
```

使用 **DSH 实际宿主端口**。结果包含 worker 数、启动次数、空闲回收、回退次数及
`file.*`、`rpc.fs.*`、`tool.grep` / `tool.glob` 等统计。

在相同工作区归属、设置相容的前提下，普通文件操作和搜索操作应在**同一个 RPC 池**
留下统计。不要仅凭 provider 总数判断启动了多少进程。首次请求可能包含冷启动，
不能把模型思考或网络耗时算进文件后端。详细测量与回归范围见
[验证记录](docs/native-files-validation.md) 和 [开发测试](TESTING.md)。

## 兼容性

**已完成 Desktop 实机验收：** Windows DSH Desktop 0.2.1-rc.2，覆盖原生文件工具、
A/B 工作区与旧会话、空闲恢复、完整重启，以及 PR #7 修复后的文件/搜索 RPC 共池。

当前 `package.json` 还声明了以下**历史 DSH 集成版本**，这不代表新原生后端已在
所有旧版本逐项完成重新验证：

`0.1.0-rc.7` · `0.1.0-rc.8` · `0.1.1-rc.1` · `0.1.1-rc.2` · `0.1.2-rc.1` ·
`0.1.3-alpha.2` · `0.1.5-rc.1` · `0.1.5-rc.2` · `0.1.7-rc.1` · `0.1.7-rc.2` ·
`0.2.0-rc.2`

以 [`package.json`](package.json) 中声明为准；各阶段的测试依据见
[兼容性证据](docs/compatibility-evidence.md)。

## 已知边界

- 原生文件的完整读取、写入、精确编辑限制为 **16 MiB**；更大的文件可采用分段或流式读取。
- 原生写入有物理路径检查、版本保护与原子发布，但不等于完整 OS 沙箱，也无法阻止所有外部程序并发修改。
- 写入下发后若连接中断，结果可能处于**未知状态**，应先重新读取再决定是否重试。
- 尚未实现原生文件 `watch`；PTC `run_code` 也不会因为文件工具原生化而自动迁入 Linux 沙箱。
- DSH 宿主若出现 profile 热重载错误，可能需要**完整重启宿主**。这是宿主更新机制的问题，不影响已验证的 WSL 文件／搜索使用路线。

## 相关文档

[文档索引](docs/README.md) · [测试说明](TESTING.md) ·
[更新日志](CHANGELOG.md) · [最新开发检查点](CHECKPOINT.md)

### 其他语言

完整维护中英文说明；其他语言提供当前 fork 的简明安装指引：
[日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) ·
[Deutsch](README.de.md) · [Español](README.es.md) ·
[Português](README.pt.md) · [Русский](README.ru.md)

## 原项目与许可

**Fork 原项目地址：**
https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace

**当前增强版仓库：**
https://github.com/yaelysia/dsh-wsl-workspace

本仓库在原项目基础上独立维护增强功能，**不是 DSH 官方发行版**，也不代表原项目
已经包含这些增强。项目采用 **MIT** 许可，详见 [LICENSE](LICENSE)；衍生和引用
代码的出处见 [NOTICE](NOTICE)。
