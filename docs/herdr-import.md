# Herdr 配置导入（0.2.0）

导入的是 **机器连接配置 + 项目路径**，不是正在运行的 Agent、会话、布局或聊天记录。Herdr 不需要运行；整个导入流程不执行 Herdr/SSH/tmux，也不修改源文件。导入后的 Agent 仍通过本插件独立 tmux 后端启动。

## GUI

1. 在 DSH 的「Agent 工作台」选择「导入 Herdr」。
2. 选择机器目录 `endpoints.json` 和/或项目快照 `session.json`，每份文件最多 1 MiB，UTF-8 JSON。
3. 导入项目时，**明确选择项目实际所在的机器**。目标机必须已存在；若是新远端机器，先仅导入机器，再导入其项目快照。
4. 点击「生成导入预览」，核对机器地址（含用户/端口）、项目路径、重复项和全部警告。
5. 勾选确认，再点击「确认导入配置」。文件或目标改变会立即使预览失效；源内容/已有机器项目发生变化时后端也会拒绝旧 digest。
6. 导入的项目即使没有 Agent 也会显示，可点击快捷启动预填机器与 cwd；导入动作本身不启动进程。

文件只暂存在当前组件内存中，不保存到 localStorage。只将白名单解析结果显示为预览；密码、环境、启动命令、原生会话引用、终端历史均不导入。所有 RPC 仍要求 DSH owner。

## Herdr 文件在哪里

已根据官方 **v0.9.5** 源码核对：

| 数据 | Linux/macOS 默认位置 | 支持的结构 |
| --- | --- | --- |
| 机器 | `$HOME/.local/state/herdr/client/endpoints.json` | `version: 1`，`ssh` 数组 |
| 默认会话项目 | `$HOME/.config/herdr/session.json` | `version: 3`，`workspaces` 数组 |
| 命名会话项目 | `$HOME/.config/herdr/sessions/<name>/session.json` | 同上 |

XDG_STATE_HOME / XDG_CONFIG_HOME 覆盖相应根目录。Windows 配置位置采用 LOCALAPPDATA / APPDATA；但当前运行后端仍针对 macOS/Linux，Windows 风格 cwd 不会导入。Herdr 的 `config.toml` 是设置文件，不是机器或项目目录。`session-history.json` 是私有终端历史，**不要选择它**。

远端快照必须由用户明确提供文件副本。导入器不扫描远端、不建立 SSH 连接，不从 session 名称、Herdr pane ID 或当前 UI 选择推断机器归属。路径只保存，不验证其当前存在与否。

机器只支持安全的 SSH alias、主机名、IPv6，以及 `user@host`、`ssh://user@host:port` 等可明确解析的目标。用户名和端口作为独立字段/SSH argv 保存；含密码、参数、shell 语句或不支持 URI 内容的目标跳过并警告。禁用的 Herdr profile 不导入。

不同 Herdr profile 若连接到同一 host/user/port，会合并为同一机器；Herdr remote session 选择不迁移。SSH config 里两个不同 alias 即使实际指向同一主机，也不会执行网络解析去合并。

项目优先取 `identity_cwd`，缺失时只尝试该 workspace 直属 tab/pane 的 cwd 并警告。不递归搜集任意 `cwd`，不读路径指向的其他文件。仅支持版本 3；旧版或未来版本明确报错。

## 离线 CLI / Skill

插件包内含 CLI 和 [herdr-import Skill](<../skills/herdr-import/SKILL.md>)。插件加载时向现有 skills 服务注册 Skill provider；在支持 skills 服务的 DSH 中，启用插件后 Skill 会进入目录，不需要向用户 home 隐式复制文件。

源码仓库先 `npm run build`；安装包的 CLI 位于包根目录的 [import-cli.js](<../lib/import-cli.js>)。普通 npm 安装也会提供 `dsh-remote-agents-import` 命令。以下例子在插件根目录执行：

```sh
# 只打印候选文件位置，不读取它们
node lib/import-cli.js paths
# 只读列出现有机器 ID / 项目，便于确定项目归属
node lib/import-cli.js list --state /absolute/path/fleet.json
# 预览，不写 fleet 文件或目录
node lib/import-cli.js preview --machines /absolute/path/endpoints.json --state /absolute/path/fleet.json
# 明确确认预览后才导入；使用刚返回的 digest
node lib/import-cli.js import --machines /absolute/path/endpoints.json --state /absolute/path/fleet.json --confirm "替换为预览返回的digest"
# 项目独立导入；local 仅在确认这些路径确实属于本机时使用
node lib/import-cli.js preview --session /absolute/path/session.json --project-machine local --state /absolute/path/fleet.json
```

也可在用户允许读取默认机器目录后使用 `--machines auto`。项目文件始终明确给路径，不会自动读取默认活动快照。

`--state` 必须与 GUI 宿主的状态文件一致。默认遵循 `DSH_REMOTE_AGENTS_STATE`、`DSH_HOME`；如果宿主插件 config 另设了 `statePath`，CLI 不会自动得知，需明确传入。`paths` 输出最终默认目标路径，便于确认。Skill 要求展示预览后再次询问用户，不能把“请实现导入”当作实际导入授权。

导入返回新增机器/项目数量与 `importedMachineIds` / `importedProjectIds`，ID 顺序对应预览中的新增项。再次预览可核对幂等结果。已导入项目引用的机器暂不允许移除；本版尚无项目删除界面，避免静默丢失项目归属。

## 验证和限制

- 测试覆盖只读预览、显式确认、内容/配置变化使 digest 过期、并发提交、原子写、去重、SSH argv、源文件保持不变、敏感字段过滤，以及 GUI 预览失效/确认门控。
- 使用合成 v1/v3 fixtures；不会读取开发机器上的真实 Herdr 私有目录或会话。
- 尚未在用户实际 Herdr 文件、真实 SSH 服务器或已安装到当前 GUI 的环境中联调。不将 mock/DOM 测试描述为真实服务器验证。

## 格式依据

- [机器目录结构](https://github.com/herdrdev/herdr/blob/v0.9.5/src/client/endpoint/catalog.rs)
- [状态与配置目录规则](https://github.com/herdrdev/herdr/blob/v0.9.5/src/config/io.rs)
- [Session 快照结构](https://github.com/herdrdev/herdr/blob/v0.9.5/src/persist/snapshot.rs)
- [官方多机说明](https://herdr.dev/tui/docs/connecting-machines/)
- [快照与历史区别](https://herdr.dev/tui/docs/session-state/)
