# trine 协议事件与字段需求清单

> 协议与界面行为参考；以 packages/core 的 schema 和三端实现为准。
> 由 Web 客户端界面原型逐屏推导：界面要显示什么 → 协议要携带什么。是 scaffold-core
> 设计 `packages/core` 消息帧 schema 的输入——本清单描述需求语义，不约束帧的最终命名与编码。
> 约定：以下均为 E2E 密文信封内的明文 payload（client ↔ agent），另标注 † 的是服务端可见的路由/元数据字段（零知识边界）。

## 0. 信封与通用字段

每帧通用：

- `type` — 事件类型（下文各节）
- `sessionId`† — 路由用（服务端需要按会话路由/补发，不可加密）
- `machineId`† — 路由用
- `seq`† — 单调序号，断线补发与去重的依据（服务端存密文 + seq）
- `ts` — 事件时间戳（心跳/耗时计算的基准）

> 开放：seq 由谁分配（agent 发出方分配，服务端只校验单调）；client→agent 上行同样带 seq。

## 1. 聊天视图

### 1.1 流式回复

- `assistant.delta` — 文本增量：`{ text }`（token 级，SDK includePartialMessages）
- `assistant.done` — 一条 assistant 消息完成：`{ messageId, text }`（终态覆盖，防乱序）
- `thinking.start` / `thinking.delta`? — 原型只显示「思考中…」占位，MVP 可只要 start 信号，不传 thinking 正文
- `user.message` 回显 — 多客户端设备时，别的设备发的消息本设备也要看到

### 1.2 工具调用卡（原地更新）

- `tool.start` — `{ toolUseId, toolName, argSummary }`
  - argSummary：单行摘要（Bash→命令、Edit→文件路径），由 agent 端生成，避免 client 理解每种工具的参数结构
- `tool.end` — `{ toolUseId, status: ok|warn|error, durationMs, resultSummary, outputPreview }`
  - resultSummary：单行（`✓ +9 −2` / `⚠ 1 failed · 3.5s` 的数据源：exit code、diff stat、耗时）
  - outputPreview：尾部截断的输出文本（阈值待定，~2KB），展开查看用

### 1.3 心跳 footer

- `run.heartbeat` — 周期（1s？运行中才发）：`{ runElapsedMs, currentTool?: { toolUseId, name, elapsedMs }, silentMs, phase: run|tool|wait }`
  - 备选：不发心跳帧，client 本地根据最近事件时间自行计时（省流量，但「无输出秒数」在断连时会失真）→ **倾向 agent 发**，频率可降到 2-5s
- `run.state` — 会话运行状态迁移：`{ state: idle|running|waiting_permission|error|stopped, … }`（列表页状态 pill 同源）

### 1.4 权限卡

- `permission.request` — `{ requestId, toolName, input（完整参数，Bash 即完整命令）, suggestions?（SDK canUseTool 提供的建议）, requestedAt }`
- `permission.respond`（client→agent）— `{ requestId, verdict: allow|deny, updatedInput?（改参数后批准）, remember?: { scope: session, pattern } }`
- `permission.resolved` — 多设备同步：谁批的、结果（别的设备把卡片置为已响应）
- `permission.invalidated` — agent 重启/run 中止导致 pending 请求失效：`{ requestId, reason }`
- 派生需求：等待时长 = now − requestedAt，client 本地算，无需专门字段

### 1.5 输入与排队

- `input.send`（client→agent）— `{ clientMsgId（幂等去重）, text }`
- 排队语义：**会话运行中**由 agent 端排队（回执 `input.queued`）；**agent 离线**由 server 排队†（server 只见密文帧 + 目标，回执由 server 发 `input.parked`？）
  - 开放：两级排队的回执如何区分显示（原型统一显示「已排队」+ 不同副文案）
- `input.recall`（client→server/agent）— 撤回排队消息：`{ clientMsgId }`
- `run.stop`（client→agent）— 停止当前任务；agent 回 `run.state: stopped` + 已产出内容保留

### 1.6 完成卡

- `run.done` — `{ durationMs, costUsd, toolCount, permissionCount, turns? }`
  - costUsd 来源：SDK result message 的 total_cost_usd

### 1.7 历史回看（agent 读本机转录，按需拉取）

决策 D8 的落地：会话时间线默认只来自服务端中转帧（7 天 TTL、且只有经 trine 跑过的 run 才有帧），
本机终端创建的、配对前的、超 TTL 的会话打开是空的。补法是 client 在会话 sync 结束后按需向 agent 要历史：

- `session.history.request`（client→agent，会话级）— `{ reqId, before?, limit?(1..500) }`；
  `before` 是上一页响应给的不透明游标，省略即最新一页。agent **不为它拉起会话进程**
  （读的是 `~/.claude/projects` 转录，SDK `getSessionMessages`）
- `session.history.response`（agent→client，**只发给请求方设备**）— `{ reqId, items[], hasMore, nextBefore? }`；
  items 旧→新，三种：`user{id,text,ts}` / `assistant{id=SDK message.id,text,ts}` /
  `tool{id=toolUseId,toolName,argSummary,status?,durationMs?,resultSummary?,outputPreview?,ts}`，
  id 与实时流同源以便去重。单条文本截断（~8KB），整帧体积封顶（~512KB，超了少给并 hasMore）——
  它会进服务端离线补发存储。会话找不到 → 空 items，不报错
- client 合并：只收早于时间线里「agent 产生的条目（seq>0）」最早 ts 的历史项，按 id 去重，
  以 seq 0 前插到时间线开头；`hasMore` 时时间线顶部给「加载更早」

## 2. 会话列表

- `session.list`（client→agent 请求 / agent 推增量）— 每条：
  `{ sessionId, title, state, lastEvent（单行摘要）, lastActivityAt, cwd, model, permissionMode, costUsd }`
- `session.created` / `session.updated` — 列表增量更新（标题生成、状态迁移、成本累计）
- `session.create`（client→agent）— `{ cwd, model, permissionMode }`（新建表单字段；cwd 默认值 = 该机器 defaultCwd，见 §6；model / permissionMode 默认值取 client 设置「新会话默认值」，初值 opus[1m] / bypassPermissions；model 可为家族别名如 opus、opus[1m]；permissionMode 含 bypassPermissions 档，UI 改选时两击确认）
- 标题：MVP = 首条用户消息截断；`session.title` 字段留好，后续 agent 生成摘要

### 2.1 会话元数据字段扩展（session-list-v2，2026-09-25）

SessionMeta 新增**可选**字段（旧 agent 不发、旧 client 收到会被 schema strip，双向兼容）：

- `archived?: boolean`、`archivedAt?: Timestamp` — 归档标记，来源是 agent 的 `~/.trine/sessions.json`（见 DECISIONS D12），省略 = 未归档
- `createdAt?: Timestamp` / `gitBranch?: string` / `firstPrompt?: string` — 来自 SDK 会话信息（创建时间、会话结束时的分支、首条有意义的输入），供搜索与分组
- `lastEvent` 语义不变

- `headless?: boolean`（session-ux，2026-10-20）— 非交互会话：转录里第一条带 `entrypoint` 的行是 `sdk-cli`（`claude -p`）或 `sdk-py`（Python SDK）。终端交互（`cli`）与 trine 自己开的会话（TS SDK，`sdk-ts`）都不算。agent 读转录开头判定、按 sessionId 缓存；省略 = 不是 / 不知道 / 旧 agent。client 把它与「cwd 在系统临时目录下」一起归为临时会话，列表默认隐藏

agent 侧所有产出 SessionMeta 的出口（list、session.created、session.updated、各命令成功后的广播）都经同一处合并归档标记与 `headless`，活跃会话的状态迁移不会冲掉 title / firstPrompt / archived 等非运行时字段。

### 2.2 重命名 / 归档 / 永久删除

三条 c2a 都是**会话级**帧（带 `sessionId`、`reqId`），在 agent 上与同会话的 `input.send` 串行执行，但 agent **不会**因此把会话 resume 起来（不占并发名额）：

- `session.rename { sessionId, reqId, title }` — 写转录的 custom-title 记录，与 CLI `/rename` 同格式、互通。agent 写入前按 CLI 显示标题时的同款规则规范化：trim → 控制/格式字符换空格 → 去 `\x00-\x1f\x7f-\x9f` → 按码点截 200 → trim；结果为空 → `invalid`。SDK 的 `listSessions` / `getSessionInfo` 读取时**不**规范化、原样返回；在写入端先对齐，是为了与 CLI 的显示一致，并让广播出去的标题与之后读回的逐字相等（列表不闪）。client 不必自己截断（按 UTF-16 码元截会把 emoji 提前截掉），交给 agent。从未发过消息的会话还没有转录，标题先记在 agent 本地，首条消息落盘后补写。改名会刷新转录 mtime，会话会跳到列表顶部（接受）
- `session.archive { sessionId, reqId, archived: boolean }` — 归档 / 取消归档。运行中、等待批准、有排队消息 → `busy`（与改工作目录同口径）。**自动取消归档**：已归档会话进入 running（本机远端任一设备发消息、`run.resumeAt` 续跑等）时 agent 自动清标记，随同一次 `session.updated` 广播。本机终端 `claude --resume` 继续已归档会话**不会**自动取消归档（agent 看不到），非目标
- `session.delete { sessionId, reqId }` — 永久删除本机转录，不可逆。只能删**已归档**的（否则 `not_archived`，协议层兜底）；忙 → `busy`；转录 60 秒内被 trine 以外的进程写过 → `busy`（本机终端可能正开着它；trine 自己刚做的改名不算）。删除成功约 8 秒后 agent 会复查一次：CLI 子进程退出时会补写元数据（SDK 关闭子进程是先等 2 秒再 SIGTERM），可能重建一个只含元数据的转录，查到且其修改时间落在删除时刻后 15 秒内就再删一次；启动与每日清理时也对仍在期内的墓碑复查。修改时间更晚的转录视为用户删除后在本机终端又用了这个会话：不删，并撤掉墓碑，它重新作为合法会话出现在 agent 的列表里

应答统一走**机器级** `session.mutate.response { reqId, targetSessionId, ok, error?: { code, message } }`，`code ∈ busy | not_found | not_archived | invalid | io | deleted`。业务拒绝一律在这里表达，不用 `error.fatal`（那会进聊天时间线且关联不到请求）。目标会话字段叫 `targetSessionId` 而不是 `sessionId`：密文里的 `sessionId` 是信封绑定字段，带上它这帧就成了会话级帧。

成功时另有机器级广播给所有设备：rename / archive → `session.updated`（整份快照，含 `archived`/`archivedAt`）；delete → `session.removed { targetSessionId }`。client 收到 `session.removed` 应清掉该会话的列表条目、时间线、游标、能力缓存、待发帧与 parked 条目，当前正打开它则跳回列表。

**墓碑**：删除后 agent 保留墓碑 8 天（= 服务端默认 parked 24h + relay 留存 7 天：一帧指向已删会话的旧命令最晚在这个窗口内到达）。命中墓碑的**任何**会话级帧都不会让会话复活：带 `reqId` 的（含 `session.status.request` 等）回 `session.mutate.response{ok:false, code:'deleted'}`；不带的（`input.send`、park 队列或断线补发回来的旧帧）agent 丢弃，并对该会话广播 `session.removed`（按会话限频，60 秒至多一次），让还缓存着它的设备自清。client 侧也记住已删会话 8 天：此后指向它的会话级帧（断线补发回放、迟到帧）直接丢弃，不再对它发 sync，也不能再打开（深链 / 后退回来时提示并跳回列表）。删除后 seq 计数不重置（D10 保守取向）。

**互操作**：

- 新 client + 旧 agent：旧 agent 不认识这三个 type，schema 层静默丢弃 → client 的请求只能等超时，应提示「agent 版本过旧或离线」。client 应按 `machine.info.agentVersion`（semver，**≥ 0.2.0** 支持）做能力探测，版本不够时隐藏菜单项
- 旧 client + 新 agent：旧 client 丢弃不认识的 `session.mutate.response` / `session.removed`；被删的会话在它的列表里保留到下次刷新（`session.list.request` 的结果里已经没有它）

## 3. 机器管理

- `machine.status`† — 服务端可见（在线状态本身就是服务端知道的）：`{ machineId, online, lastSeenAt }`
- `machine.info` — E2E 内容：`{ name, platform, osVersion, agentVersion, claudeVersion, activeSessionCount }`（常用目录另见 §6）
- `machine.rename` / `machine.unpair`（client→…）— 原型未画界面但 MVP 需要
- 离线排队计数：server 按 machineId 报排队帧数†（`{ machineId, parkedCount }`，不泄露内容）

## 4. 配对

- 带外（QR/配对码）内容：`{ serverUrl, agentPubKey, pairingToken（一次性）}`
- `pair.begin`（client→server→agent）— client 用 token 提交自己的公钥
- 双端 SAS 短认证串：由双方公钥派生（协议细节 scaffold-core 定），UI 需要 emoji/短码渲染约定
- `pair.confirm` / `pair.abort` — 人工比对结果
- 完成后 server 登记：设备指纹†、machineId†——不含任何密钥私有部分

## 5. 连接与异常

- client↔server WS：断线重连（指数退避），重连后按 `seq` 请求补发：`sync.request { sessionId, sinceSeq }`†
- `error.transient` — 瞬时错误 + 自动 resume 中：`{ attempt, reason }`（一行痕迹）
- `error.fatal` — `{ kind: quota|auth|config|…, message, retryAt?（额度重置时间）}`
  - `retryAt` 支撑「14:30 后自动续跑」按钮 → 对应指令 `run.resumeAt`（client→agent）
- 消息/事件全链路幂等：三段 WS 都可能复推，按 `seq`/`clientMsgId`/`requestId` 去重

## 6. 命令面板与工作目录管理

### 6.1 「/」命令菜单的三组来源

1. **会话控制命令（协议级，不走文本）**——UI 上以 `/model` `/cwd` `/permission` `/status` `/mcp` 呈现，但实现为独立协议消息，本地即时响应、不往返 Claude、零成本：
   - `session.setModel`（client→agent）— `{ model }`，下一轮生效（SDK streaming input 的 setModel / 下一次 query options）
   - `session.setPermissionMode` — `{ mode: default|acceptEdits|plan|bypassPermissions }`（对应 SDK setPermissionMode / CLI --permission-mode；bypass 已拍板保留，client UI 强制两击确认）
   - `session.setCwd` — `{ cwd }`，下一轮 query 生效
   - `session.status`（req/resp）— resp：`{ model, cwd, permissionMode, costUsd, contextUsedTokens, contextLimitTokens, agentVersion, claudeVersion }`
   - `mcp.status`（req/resp 或并入 session.status）— `[{ name, state: connected|failed|needs_auth, toolCount }]`（源：SDK system/init 的 mcp_servers）
2. **项目 slash commands / skills（agent 下发）**：
   - `session.capabilities`（agent→client，会话就绪时推）— `{ slashCommands: [{ name, description, source: project|user|skill|plugin }], models[]（如 fable/opus/sonnet/haiku，以 agent 上报为准）, mcpServers[] }`（源：SDK system/init 的 slash_commands + capabilities 特性检测）
   - 选中后作为普通文本透传：`input.send` 的 text 以 `/` 开头即原样进 SDK query，agent 不解析
3. **常用 prompt 片段**：client 本地存储（个人输入习惯，跨机器通用），不进协议；未来多设备同步再议

### 6.2 工作目录管理（agent 端持久化，每机器一份）

- `cwd.list`（req/resp）— `{ favorites: [path], defaultCwd }`；机器详情/新建会话/会话设置三处共用
- `cwd.add` / `cwd.remove` — `{ path }`
- `cwd.setDefault` — `{ path }`；新建会话表单以 defaultCwd 预选
- 变更广播 `cwd.updated` — 多客户端设备保持一致
- 会话内当前 cwd 的展示：会话头部元信息行（低优先级折叠态），点开会话设置 sheet 查看/切换——数据即 `session.status.cwd`，无需独立事件

## 7. 推送（服务端触发，脱敏）†

服务端无法读密文，推送触发依赖 agent 发的**明文事件类型标记**（信封外元数据，仅事件类型 + 会话名 hash/别名，不含正文）：

- `push_hint: permission_pending` → Bark「[trine] mbp-m3 · 会话等待权限确认」
- `push_hint: run_done | run_error` → 同理
- 开放：会话名要进推送就得让 server 知道明文名 → 折衷：client 配对时给每个会话生成推送别名？或推送只报机器名（原型文案按机器名 + 事件类型即可成立）

## 协议约定汇总

1. ✅ **离线态**：方案 A（排队发送 + 可撤回 + 默认 24h TTL 可配置）
2. ✅ **权限超时**：不自动拒绝，只计时 + 推送；超时策略留 agent 配置项
3. ✅ **记住批准作用域**：MVP 只做「本会话 + 该工具/模式串」，不做永久
4. ✅ **心跳**：agent 周期发 heartbeat 帧（2-5s），而非 client 本地推算
5. ✅ **成本展示**：会话级累计（列表 + 完成卡），机器/日汇总不进 MVP
6. ✅ **推送文案**：只含机器名 + 事件类型（不含会话名，避免明文泄露给 server）

7. ✅ **常用目录/默认目录存 agent 端**（每机器一份，跨客户端设备一致）——目录是机器属性，client 只缓存
8. ✅ **常用 prompt 片段存 client 本地**（个人输入习惯，跨机器通用），不进协议
9. ✅ **bypass 档保留**（会话设置与新建会话均可选，等同 `claude --permission-mode bypassPermissions`），client UI 强制两击确认
