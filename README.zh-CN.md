# trine

个人自托管的 Claude Code 远程操作工具。用手机或浏览器查看电脑上的会话、继续对话、检查工具与子代理活动，并远程处理权限请求。

[English](README.md) · [部署指南](apps/server/deploy/README.md) · [安全说明](SECURITY.md) · [贡献指南](CONTRIBUTING.md)

## 能力与定位

- 流式消息、工具调用、子代理过程和历史回看。
- 回退到某条消息之前：可以还原代码、对话，或两者一起还原。
- 显示用量：会话的 context 占用，以及每台机器 5 小时 / 每周订阅限额的用量和重置时间（仅订阅账号）。限额在会话运行时自动更新，也可手动刷新。
- `/usage`、`/cost` 等本地命令的输出以卡片显示，保留终端排版；`/usage` 显示为各限额的进度条。
- 消息可以带图片和文件：点回形针选择、粘贴剪贴板里的图片或文件，或直接拖到页面上。附件在浏览器里加密后经 relay 中转；小图直接交给 Claude，其他文件存到 agent 所在机器上，以路径交给 Claude 读取。
- 常用 prompt 片段存在本设备：在设置里增删、编辑、复制；在输入区回形针旁的 prompt 按钮里点选插入光标处，或直接复制。手机上附件和片段收在「+」里，不挤占输入框宽度。
- 多台机器的会话列表、继续会话、重命名和归档；右键菜单、多选（Ctrl/Cmd/Shift 点击）批量归档，复制会话工作目录。
- 显示每台机器的 CPU、内存、磁盘、网络和 claude 子进程占用（列表顶部、机器卡、机器详情页），只在页面可见时刷新，间隔可在设置里调（默认 1 分钟），也可手动刷新。
- 会话和工作区可以置顶，最近置顶的在最上面；按工作区分组时，组的位置固定（新工作区在上），不随会话状态跳动。
- 扩展：agent 机器上的程序可以给会话页和输入框加面板、徽章和操作按钮（例如项目的任务列表，「在新会话里接续这个任务」），会话可以关联到它的条目；列表行上显示关联，工作区分组的菜单不进会话也能打开同一个面板。新建会话时可以从扩展的条目开始（预填首条消息并自动关联），关联变化和扩展的操作会在会话时间线留一条记录。浏览器不执行扩展的任何代码，只渲染 agent 返回的数据，操作在点击后由 agent 执行。用 `trine-agent ext add <目录>` 安装，见[扩展](docs/EXTENSIONS.md)。需要 agent 0.16.0 及以上（从条目开始、时间线记录需要 0.17.0）。
- 默认隐藏临时会话（工作目录在系统临时目录下，或 `claude -p` 等非交互运行），列表筛选里可以重新显示。
- 配对码/二维码与人工校验码确认，浏览器到 agent 的应用消息端到端加密。
- 可选 Bark 通知，仅包含通用事件类型和机器标识/别名。

当前是早期、单所有者自托管项目，界面为中文。主要使用场景是 macOS agent + Linux relay；Windows 尚未验证。没有多租户隔离、官方托管服务或预编译安装包。项目不隶属于 Anthropic。

## 本机启动

准备 Bun **1.3.11**、已安装并通过授权登录的 Claude Code、现代浏览器。模型费用及使用资格由你自己的账户/提供方决定。

```bash
git clone https://github.com/smokecat/trine.git
cd trine
bun install --frozen-lockfile
mkdir -p .dev
```

依次打开三个终端，均在仓库根运行：

```bash
# 终端 1：中转服务
TRINE_DB=.dev/relay.sqlite bun run dev:server
```

```bash
# 终端 2：Web 界面与同源代理
bun run dev:web
```

```bash
# 终端 3：签发一次性邀请，然后在 agent 的隐藏提示中粘贴
bun run agent:invite create --db .dev/relay.sqlite
# 选择你的账户可访问的模型
TRINE_DEFAULT_MODEL=sonnet bun run dev:agent --   --server http://localhost:5173 --home .dev/agent --enroll --pair
```

浏览器打开 <http://localhost:5173>，粘贴终端中的配对码，对比两端校验码；完全一致时才在 agent 的交互式终端确认。浏览器和 agent 必须使用相同主机名。

`.dev/agent` 只隔离 trine 的身份和状态；agent 仍能使用你的真实 Claude 工作空间、设置与权限。建议先在可丢弃的项目里体验。

## 公网使用

按[部署指南](apps/server/deploy/README.md)配置 HTTPS/WSS。首台与新增 agent 均由 relay 管理员签发短期、单次邀请，然后用 `--enroll` 启动并隐藏输入邀请；不需要注册窗口、重启 relay 或切换 SSH 隧道地址。空库也拒绝无邀请注册，旧的 `TRINE_OPEN_REGISTRATION` 开关不再生效。

以后保留同一 `--home`，启动时省略 `--enroll`；浏览器仍须单独配对并人工确认校验码。agent 已在运行（例如作为常驻服务）时，用 `bun run dev:agent -- pair --home <目录>` 增加浏览器，不要再起第二个 agent。邀请管理、失败恢复、升级兼容和安全边界见[中文注册指南](docs/AGENT-ENROLLMENT.zh-CN.md)。

不要把它作为多人共享的中转服务。Web 私钥保存在 localStorage，缓存聊天在 IndexedDB；端到端加密不能防止恶意前端脚本或受控终端读取它们。完整边界见 [SECURITY.md](SECURITY.md)。

## 配置、开发与文档

- agent：`--server` / `TRINE_SERVER` 必填；`--home` / `TRINE_HOME` 指定状态目录，默认 `~/.trine`；`--claude-bin` 选择 CLI；`TRINE_DEFAULT_MODEL` 指定兜底模型（默认 `opus[1m]`）。`TRINE_MAX_SESSIONS`（默认 10）与 `TRINE_IDLE_TIMEOUT_MS`（默认 15 分钟）控制活跃会话（有 Claude Code 子进程的会话）：名额满时先回收最久未活动的空闲会话的子进程（转录保留，下次发消息自动恢复），全都在忙才拒绝；归档会话也会顺带回收它的空闲子进程。Web 列表把这类会话标为「驻留」，并显示机器的「子进程 n/上限」。
- 模型：可以填 Claude Code 的家族别名（`fable`、`opus`、`sonnet`、`haiku`，以及 `opus[1m]` 这类带后缀的写法），由 Claude Code 解析到该家族最新版本；也可以填具体模型 ID。Web 端的预置模型只有别名。
- 新会话默认值：新建会话时预选的模型和权限模式在「设置 → 新会话默认值」里改，初值是 `opus[1m]` 和 `bypassPermissions`；会话建好后各自记住自己的模型和权限。不希望新会话跳过工具审批的话，请把默认权限改掉。
- 发送键：手机、平板等触屏设备上，键盘回车总是换行，点发送按钮发送；电脑键盘在「设置 → 发送键」里二选一：Enter 发送、Shift+Enter 换行（默认），或 Cmd/Ctrl+Enter 发送、Enter 换行。两种模式下 Cmd/Ctrl+Enter 都能发送。
- 排队消息：Claude 工作时发出的消息在输入框上方排队，当前任务结束后按顺序执行。排着的消息可以撤回，也可以撤回后放回输入框修改；输入框为空时按 ↑ 编辑最后一条。消息开始执行时才进入对话。停止任务时被丢下的排队消息留在排队区，可以重发、编辑或丢弃。机器离线时暂存在 relay 的消息只能撤回。撤回和这些回执需要 agent 0.15.0 及以上；旧 agent 上排队的消息会直接出现在对话里，不能撤回。升级时先更新 web，再重启 agent：旧版 web 不认识新的回执，停止任务时丢下的消息会一直显示为排队中。
- 回退：鼠标悬停（触屏上点一下）自己发的消息，选「回退到这里」（需要 agent 0.9.0 及以上，且会话空闲）。对话框先预览改动，再提供与 Claude Code `/rewind` 相同的三个选项：还原代码和对话、只回退对话、只还原代码。回退对话会在所有设备上撤掉这条消息及之后的内容，并把这条消息填回输入框。代码按 Claude Code 的文件快照还原，agent 现在为每个会话开启快照（由 Claude Code 存在它自己的配置目录里）。只能还原 Claude 用编辑工具做的改动，Bash 命令和手工改动无法还原；开启快照之前的轮次只能回退对话，会话的第一条消息只能还原代码。
- 附件：默认每条消息最多 10 个、合计 64MB，可在「设置 → 附件」里调整，但单个附件不能超过 relay 的上限（`TRINE_BLOB_MAX_BYTES`，默认 256MB）。图片默认原样上传，也可以在设置里给压缩阈值。relay 把加密后的附件存在 `TRINE_BLOB_DIR`（默认数据库旁边的 `blobs/`），保留 `TRINE_BLOB_TTL_MS`（默认 7 天）；过期后再点开，会请 agent 用它在 `<home>/uploads` 下的副本重新上传。约 3.75MB、2000px 以内的图片直接交给 Claude，更大的图片和其他文件以路径交给 Claude 读取。需要 agent 0.11.0 及以上。
- relay：[配置模板](apps/server/deploy/trine-server.env.example)，复制到仓库外再填写真实值。
- 验证：`bun run typecheck`、`bun test`、`bun run build`，或 `bun run check`。
- 架构：[STRUCTURE](docs/STRUCTURE.md)；决策：[DECISIONS](docs/DECISIONS.md)；协议：[PROTOCOL-REQUIREMENTS](docs/PROTOCOL-REQUIREMENTS.md)。

自有代码采用 [MIT](LICENSE)。Claude Code / Agent SDK 有独立条款；字体、UI 基件及依赖保留各自许可，见[第三方声明](THIRD_PARTY_NOTICES.md)。
