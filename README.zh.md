# dsh-wsl-workspace

[English](README.md) · [中文](README.zh.md) · [上游译文](#相关文档)

**DSH 留在 Windows，项目留在本机 WSL。** 插件提供 WSL 工作区、持久 Bash、原生文件工具和常驻代码搜索，同时保留 `/mnt/<drive>` 对 Windows 文件的访问。

**这是 [yaelysia 增强分支](https://github.com/yaelysia/dsh-wsl-workspace)**，基于 [上游插件](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace) 开发。原生文件功能位于 `perf/phase4-native-files`，见 [PR #5](https://github.com/yaelysia/dsh-wsl-workspace/pull/5)。**上游 npm 包及尚未合并的 `main` 不包含这些改动。** 开发包暂沿用上游版本号，请用分支或提交 SHA 区分构建，不要只看版本号。

| 操作 | Linux 工作区 | Windows 磁盘 |
|---|---|---|
| 文本、字节、流式读取及目录枚举 | 共享 RPC → Linux 原生 I/O | 原 Windows 文件后端 |
| 写入与精确文本编辑 | 带版本保护的 Linux 事务与原子发布 | 原 Windows 文件后端 |
| `grep` / `glob` | GNU 工具与常驻 RPC，默认 `auto` | WSL 通过挂载盘搜索 |
| `bash` / 交互终端 | 按工作区用户在 WSL 中执行 | 从 WSL 访问 |
| Skill 发现 | 原有的有界 UNC 轮询 | 原宿主行为 |

## 安装

### 环境要求

Windows 版 DSH、可用的本机 WSL 发行版，以及原生文件和常驻 RPC 所需的 **Linux Python 3.8+**。WSL 内不需要再安装 DSH、Node、pip 包或系统服务，也不需要开放端口。发行版中需要已存在 `python3`；插件不会自动安装它。

```powershell
# 将 Ubuntu 替换为 wsl -l -v 显示的发行版名称。
wsl -d Ubuntu --exec python3 --version
```

### 安装当前开发分支

分支中包含重建后的 `lib/`，不需要手工打补丁或自行构建。

```powershell
$plugin = Join-Path $env:USERPROFILE 'dsh-wsl-workspace'
git clone --branch perf/phase4-native-files --single-branch https://github.com/yaelysia/dsh-wsl-workspace.git $plugin
# Windows CLI / Web 配置：
dsh plugin --profile web add $plugin
```

DSH Desktop 在自己的插件管理中添加同一目录。安装或修改环境变量后，应退出并重启 **DSH 宿主进程**，不只是关闭窗口。Web 与 Desktop 使用不同配置；不要同时启用上游包和这个副本，两者注册的是同一个插件标识。

未自行修改的检出目录可以通过 `git -C $plugin pull --ff-only` 更新，再重启 DSH。开发者修改源码后仍需构建并提交配套 `lib/`，要求见 [TESTING.md](TESTING.md)。

## 使用

点击设置旁的 **W**，选择发行版，浏览或填写 Linux 绝对目录，例如 `/home/me/project`，检查后点击**创建并打开**。标准、PTC、极简、创造模式通过对应的 WSL 变体工作；具体工具仍由所选模式决定。

用户名可选：留空使用发行版默认用户，填写后 **Bash、搜索及原生文件操作**均使用该 Linux 身份。Windows/UNC 文件访问不模拟这个用户。工作区选择保存在 `<dshHome>/wsl-workspaces.json`。

文件解析后会绑定后端、发行版和用户。更换后端或身份设置后应重新解析目标或开始新会话；已通过原生后端读取的文件，不会因 RPC 失败而偷偷改用 UNC 重写。`/mnt/c/...`、`C:\...` 及解析到 Windows 磁盘的符号链接保留 Windows 直接访问路径。

## 配置

以下是**插件顶层配置**，不是让模型传给工具的参数：

```yaml
fileBackend: auto       # auto | native | unc
searchTransport: auto   # auto | persistent | oneshot
searchIdleMs: 120000    # 共享 RPC 空闲期限，1000..3600000 毫秒
searchMetrics: true     # 有界内存统计，覆盖原生文件、搜索和 RPC
```

| 配置项 | 对应环境变量 | 含义 |
|---|---|---|
| `fileBackend` | `DSH_WSL_FILE_BACKEND` | `auto` 优先原生；`native` 必须原生；`unc` 使用兼容后端 |
| `searchTransport` | `DSH_WSL_SEARCH_TRANSPORT` | `auto` 优先常驻搜索；`oneshot` 使用原来的单次启动路径 |
| `searchIdleMs` | `DSH_WSL_RPC_IDLE_MS` | 默认空闲 120 秒；正在执行或排队不算空闲 |
| `searchMetrics` | `DSH_WSL_RPC_METRICS` | 配置 `false` 或环境变量 `0` 停止采集耗时 |

优先级为显式配置、环境变量、默认值；非法值会报错。默认预设中的文件与搜索服务，在空闲与统计设置一致时共用当前权限域的 RPC 池，不使用跨权限域的全局单例。每池最多 4 个身份，每个工作进程最多 4 个执行任务、16 个在途请求；空闲或 LRU 回收不会淘汰忙碌进程。

`auto` **只在启动阶段回退**。文件回退只允许发生在创建原生目标之前，并且未明确指定 Linux 用户。权限拒绝、版本冲突、超时或写入回执丢失，都不能触发“换个后端再写一遍”。需要主动恢复原路径时，设置 `fileBackend: unc` 与 `searchTransport: oneshot`，重启宿主并开始新会话。

原生文件操作还会在每个 RPC 工作进程内复用最多 4 个私有 Linux Python 执行进程，避免每次读取小文件都重新加载 Python。每个执行进程同一时间只处理一个请求，不保留文件正文缓存，随所属 RPC 进程清理；取消或回执异常会回收对应执行进程，不重放该操作。

## 行为与权限说明

- **Bash：**按发行版和工作区用户执行，会话工具保留 Shell 状态；参数与宿主差异见 [Bash 行为对照](docs/bash-parity.md)。
- **文件工具：**原生 `resolve/stat/lstat/read/list/write/edit` 通过共享 RPC 执行，保留 Linux 大小写、字面反斜杠和符号链接语义。UNC 兼容后端继续使用 `LocalFileSystem` 与 `readlink` 辅助解析；文件策略拒绝仍返回 `FS_SANDBOX_DENIED`。
- **搜索：**`wsl-search` 复用 GNU grep/find 脚本、输出协议、精确筛选和结果上限。默认常驻 `auto` 消除重复跨系统启动，不将忽略规则或正则语义暗改为 ripgrep。
- **Skills：**仍通过 UNC 做有界目录扫描，最多保留 32 个监控器，约每 3 秒检查变更、每 30 秒重新发现；正文按需重读。本轮不包含原生文件监控或 inotify。
- **Shell 生命周期：**每个 agent 拥有自己的持久 Shell；取消、超时恢复及明确告知的终端重跑沿用已有行为，见 [终端排障](docs/tty-triage.md)。
- **交互输入：**`wsl_terminal` 通过 `wsl-relay` 打开、输入、读取、发信号及关闭终端。需要键盘输入的程序使用此路径；输入其中的秘密信息会进入会话记录。
- **后台任务：**使用 `bash_background` 配合 `job_list`、`job_output`、`job_kill` 管理；会话 Bash 也支持其已声明的 `run_in_background` 参数。普通 Shell `&` 不等于已登记的受管任务。
- **旧宿主：**缺少持久终端能力时保留原有单次 Shell 回退。原生文件能力独立检查；下面继承的版本列表不代表本轮在每个历史 SDK 上重测了全部新功能。
- **启动提示：**WSL 冷启动可能向 stderr 输出 localhost 转发提示，应结合工具状态和实际错误判断，不能仅凭这条提示判定执行失败。

## 原生文件保证与边界

字节读取保持原始内容；文本遵循宿主的严格 UTF-8、BOM 与二进制判断规则。编辑保留精确匹配、多处匹配歧义、找不到文本、换行符以及 `before/after` 返回约定。条件创建不覆盖已存在文件；带观察版本的写入和编辑拒绝覆盖已变化的目标。

写操作在 Linux 内重新验证**物理路径**及授权，通过目录描述符与 no-follow 遍历固定目标目录，串行处理协作写入，在目标目录中私有暂存后原子发布。替换时在文件系统允许的前提下保留普通权限位、属主/属组及扩展属性；保留失败则中止，而不是静默放宽权限。新文件为私有权限 `0600`，不复制提权权限位。拒绝的操作不创建越界目标；一次原本获准的写入若后续失败，已创建的父目录可能保留。

发布前收到并确认的取消会明确返回取消；请求下发后发生断连或工作进程消失，结果可能是**写入状态未知**，必须重新读取并核对后再决定是否重试，不自动重放，也不切换后端补写。这是协作版本保护与原子发布，**不是**针对任意外部编辑器的通用原子 CAS、对所有恶意并发文件系统修改的防护，或完整操作系统沙箱。

原生完整读取、写入和编辑输入上限为 **16 MiB**，同时受请求/回执字节预算约束。更大的文件可以分段或流式读取；流式读取按 256 KiB 分块并检查块间版本变化。原生 `watch` 尚未实现。底层文件系统需要支持相应描述符、锁及发布操作；不支持时会明确失败，不降低写入保证。

PTC `run_code` 仍受现有 Windows ACL/WSL 共享限制；文件工具原生化不等于代码执行沙箱也迁入 Linux。完整设计与测试见 [原生文件说明](docs/performance-phase4.md)。

## 诊断与性能

现有本机 POST API 在插件路由（默认 `/wsl-workspace/api`）接收 `{"method":"performance"}`；使用 **DSH 实际宿主端口**。结果包含匿名 provider ID、进程池状态、启动/回退次数和分段耗时。`file.*`、`rpc.fs.*` 对应原生文件，`tool.grep/glob` 对应搜索执行。计数覆盖 provider 生命周期，P50/P95 只覆盖各阶段最近 **256 次样本**，嵌套阶段不能直接相加。

统计不保存文件路径、用户名、搜索词或正文，不落盘、不上传，随 provider 清理。它不是模型、网络或 DSH 全部调度耗时的追踪器。

在 Windows 上用 `npm run bench:native-files -- --iterations 20` 重现文件测量：交替运行 native/UNC 的完整 provider 调用序列并核对内容，而非只计 Python 系统调用。Linux 运行仅作为原生路径对照。没有固定耗时门槛，不能将搜索加速幅度套用到文件读写。证据与适用范围分别见 [第一阶段](docs/performance-phase1.md)、[常驻搜索](docs/performance-phase2.md)、[RPC 与统计](docs/performance-phase3.md)、[原生文件](docs/performance-phase4.md)。

## 兼容性

清单继承以下上游集成版本声明：

`0.1.0-rc.7` · `0.1.0-rc.8` · `0.1.1-rc.1` · `0.1.1-rc.2` · `0.1.2-rc.1` · `0.1.3-alpha.2` ·
`0.1.5-rc.1` · `0.1.5-rc.2` · `0.1.7-rc.1` · `0.1.7-rc.2` · `0.2.0-rc.2`

列表与 `package.json` 保持一致，历史验证见 [兼容性证据](docs/compatibility-evidence.md)。本轮原生文件使用 Node 24 与固定的 DSH `0.2.0-rc.2` 依赖，并在 Linux、Windows/WSL1、Windows/WSL2 上检查源码和构建包。[PR #5](https://github.com/yaelysia/dsh-wsl-workspace/pull/5) 记录具体提交和最新结果；历史版本的绿色声明不能当成本轮新后端的验证。未列出的宿主及用户实际安装的 Desktop 构建需要分别验证。

## 更新日志

[CHANGELOG.md](CHANGELOG.md) 和 [CHANGELOG.zh.md](CHANGELOG.zh.md) 保留上游发布历史；本 fork 尚未发布的增强改动由上述阶段文档与功能 PR 记录。

## 相关文档

[docs/README.md](docs/README.md) 是文档索引，[TESTING.md](TESTING.md) 说明构建与测试要求。中英文 README 描述当前 fork；其他译文已明确标为上游快照，不作为原生文件分支的安装依据：[日本語](README.ja.md)、[한국어](README.ko.md)、[Français](README.fr.md)、[Deutsch](README.de.md)、[Español](README.es.md)、[Português](README.pt.md)、[Русский](README.ru.md)。

## 许可与出处

MIT。再分发时保留 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。本 fork 基于 [dsh-wsl-workspace 上游](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace)，并适配 DeepSeek Harness 的文件系统与执行器契约。原生事务及复制/改编部分已在 NOTICE 标明，设计参考单独致谢；README 整理不改变这些许可。

## 致谢

感谢上游维护者与 NOTICE 中列出的参考项目。保留上游对 [dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale) UI 主题的致谢；该独立项目采用 CC BY-NC-SA 4.0，未包含在本插件内。
