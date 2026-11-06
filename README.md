# DSH Remote Agents

在 DeepSeek Harness 内管理 **本机 + SSH 远程 CLI Agent** 的工作台。借鉴 Herdr 的机器/终端组织方式与 T3 Code 的项目工作区体验，不依赖 Herdr，不接管已有 Agent。

## 当前能力（0.2.0）

新增 **Herdr 机器与项目配置导入**：工作台内选择文件 → 预览 → 明确确认；配套离线 CLI 和自动注册的 `herdr-import` Skill。详见[导入指南](<docs/herdr-import.md>)与 [Skill](<skills/herdr-import/SKILL.md>)。不接管 Herdr 活动会话，也不修改源配置。

- DSH 侧栏「Agent 工作台」，按机器筛选、按项目目录组织 Agent。
- 本机、SSH alias 配置与连接检查；Codex、Claude Code、DSH TUI、Shell 启动。
- 有界终端输出快照、刷新、输入发送、Ctrl+C 中断、确认后停止。
- tmux 会话跨 SSH 断连和 DSH 重启保留；重新打开工作台可以继续查看。
- 复用 DSH Connection 的登录/来源检查，并额外限制为 owner。

**这是 MVP，不是完整 Herdr/T3 Code 克隆。** 暂不提供终端仿真器/鼠标透传、Git diff/worktree 操作、多机任务编排、已有终端发现、Agent 语义状态识别。`running` 仅说明终端进程存活，`unknown` 表示连接或所有权无法确认；机器在线与任务完成不是同一件事。快照里的状态是上次观察值，查看输出会更新它。

## 要求

- 已核对插件 API 的 DSH **0.2.2-rc.1**，以 Web GUI 运行；其他版本需重新验证，未设置版本豁免。
- 插件运行主机：Node.js 22+、tmux、OpenSSH 客户端；目标主机：macOS/Linux、tmux、对应 Agent CLI。
- CLI 已完成登录，位于目标交互 shell 的 PATH 中；远端 `tmux` 需在 SSH 非交互 PATH 中。
- 本机与远端 cwd 均使用各自主机的**绝对路径**。
- 当前插件使用 Web Connection 自定义 RPC 通道；不声称支持没有 WebServer 的纯 Electron IPC 模式。

## 构建与安装

```sh
npm ci --ignore-scripts
npm test
npm run build
npm pack
```

从 [GitHub Release](https://github.com/FrankieeW/dsh-remote-agents/releases/tag/v0.2.0) 下载[插件安装包](https://github.com/FrankieeW/dsh-remote-agents/releases/download/v0.2.0/dsh-remote-agents-0.2.0.tgz)，或按上面的命令本地构建。在 DSH 插件管理页面选择安装包安装（若该版本界面不支持本地文件，使用 CLI 管理 **web** profile）：

```sh
dsh plugin --profile web add /absolute/path/dsh-remote-agents-0.2.0.tgz
```

安装目标必须与正在使用的 GUI profile 一致。桌面应用的专用 profile 请通过该应用插件管理入口安装，不要用 `web` profile 安装命令冒充修改桌面 profile。安装后按 DSH 提示重新加载插件/重启宿主并刷新原 GUI；本项目不会另起一个替代 GUI，也不自动改动你的 profile。

构建产物包含 Host ESM 与 DSH `__ModuleLoader__` 懒加载客户端工厂。React 使用宿主共享实例。没有启动 `dev:web` watcher 时，不能依赖 HMR。

## SSH 配置

手动添加机器仍可使用 alias/主机名；Herdr 导入支持安全解析 `user@host`、`ssh://user@host:port` 等目标并保留独立用户名/端口。不接受任意 SSH 参数、密码或私钥内容。跳板机和密钥位置继续由现有 OpenSSH 配置处理。例如：

```sshconfig
Host dev-box
  HostName 192.0.2.10
  User developer
  Port 22
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
```

先在自己的终端确认主机指纹并完成认证：

```sh
ssh dev-box
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes dev-box 'tmux -V'
```

然后在工作台添加名字和 `dev-box`，点击连接检查，再选择远端绝对项目路径启动 Agent。插件不自动接受未知主机指纹，不自动安装远端软件，也不持有 SSH 密码；它使用 `BatchMode=yes`、`StrictHostKeyChecking=yes`，需密钥/ssh-agent 等非交互认证。

## 安全边界与持久化

- 只操作专用 tmux socket、随机 session ID、匹配记录和 ownership marker 的会话；不会枚举或关闭用户默认 tmux 会话。
- 命令使用 argv 调用，SSH 端参数逐一 shell quoting；主机 alias、输入长度、cwd、种类和参数均校验。
- **所有者可启动 shell 并发送命令，等价于相应本机/SSH 账号的终端权限，不是沙箱。** 不要将 DSH 所有者会话分享给不可信的人。
- 文本输入按单行发送；不要把输入框当安全的“仅聊天”接口。Shell Agent 的输入会执行命令，CLI 的授权提示需要你自己判断。
- 默认状态位于 `~/.dsh/remote-agents/fleet.json`，遵循 `DSH_HOME`；文件权限 0600，目录初建 0700，原子写和跨实例锁。可用 `DSH_REMOTE_AGENTS_STATE` 或插件配置 `statePath` 指定其他路径。
- 同一状态文件表示同一 fleet；不同 profile 如需隔离，请配置不同状态文件。
- 状态保存机器、目录、启动参数与会话标识，不保存密码/终端 transcript。**不要把 token 或密码放进启动参数**，它们会出现在状态文件和进程列表。
- 不会在卸载、HMR 或关闭 GUI 时杀掉 Agent。停止按钮是破坏性操作；关闭浏览器不等于停止。
- 网络失败时不自动重试启动/输入，避免重复执行。启动失败可能已创建会话，请先查看错误和已有记录，不要盲目重复启动。
- 操作串行并有超时；首版没有后台跨机器并行健康检查。进程被强制杀死可能留下 `.lock`，确认没有其他插件实例写入后才可手动处理，切勿并发删除锁。

## 验证

```sh
npm test
npm run build
# 可选：需要本机 tmux；只创建独立测试会话，结束时停止
DSH_FLEET_SMOKE=1 node --test test/local-smoke.test.js
```

单元测试覆盖 SSH quoting、校验、所有权、锁、输出上限及 RPC 鉴权。真实 SSH 集成需要你提供可访问的 alias，mock 测试不代表已经连接过你的服务器。

## 目录

- [核心 API](<src/core/API.md>)：独立 Node ESM fleet 服务。
- [Host 插件](<src/index.js>)、[RPC](<src/rpc.js>)：DSH 生命周期与 owner-only RPC。
- [工作台](<src/client/FleetPage.jsx>)、[客户端入口](<src/client-entry.jsx>)：界面与 DSH slots 接入。
- [构建脚本](<scripts/build.mjs>)：可发布插件构建。
