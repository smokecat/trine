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
- `assistant.done` — 一条 assistant 消息完成：`{ messageId, text, command? }`（终态覆盖，防乱序）
  - `command?: string`（agent ≥ 0.12.0）— 本条是本地斜杠命令（`/usage`、`/cost` 等，CLI 直接输出、不调模型）的输出：值是命令名（不带 `/`，不知道时为空串），text 是去掉 ANSI 的纯文本。来源：SDK 合成的 assistant 消息带 `local_command_source`（类型定义里没有的字段）；命令名取本轮推送的用户消息。client 按命令卡渲染（等宽原样，`/usage` 解析成用量进度条），不当 Markdown；紧跟的 0 轮、0 工具的 `run.done` 不出完成卡。历史回看里没有这类输出：SDK 的 `getSessionMessages` 不返回转录里的 `system/local_command` 行
- `thinking.start` / `thinking.delta`? — 原型只显示「思考中…」占位，MVP 可只要 start 信号，不传 thinking 正文
- `user.message` 回显 — 多客户端设备时，别的设备发的消息本设备也要看到；带附件时附 `attachments`（引用，见 §1.9）

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

- `input.send`（client→agent）— `{ clientMsgId（幂等去重）, text, attachments? }`；带附件时 text 可以为空（见 §1.9）
- 排队语义：**会话运行中**由 agent 端排队（回执 `input.queued`）；**agent 离线**由 server 排队†（server 只见密文帧 + 目标，回执由 server 发 `input.parked`？）
  - 开放：两级排队的回执如何区分显示（原型统一显示「已排队」+ 不同副文案）
- `input.recall`（client→server/agent）— 撤回排队消息：`{ clientMsgId }`
- 回显时机（agent ≥ 0.15.0）：排队中的消息在**出队开始执行**时才回显 `user.message`（此前入队即回显，client 收到回显就当已确认，撤回入口永远不出现）
- `input.cancelled`（agent→client，agent ≥ 0.15.0）— 排队消息没执行就离开了队列：`{ clientMsgId, reason: recalled | stopped | closed }`。撤回成功、停止任务清队、会话关闭时发；撤回没赶上不发（回显已先到）
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
  items 旧→新，三种：`user{id,text,attachments?,ts}` / `assistant{id=SDK message.id,text,ts}` /
  `tool{id=toolUseId,toolName,argSummary,status?,durationMs?,resultSummary?,outputPreview?,ts}`，
  id 与实时流同源以便去重。单条文本截断（~8KB），整帧体积封顶（~512KB，超了少给并 hasMore）——
  它会进服务端离线补发存储。会话找不到 → 空 items，不报错
- client 合并：只收早于时间线里「agent 产生的条目（seq>0）」最早 ts 的历史项，按 id 去重，
  以 seq 0 前插到时间线开头；`hasMore` 时时间线顶部给「加载更早」

### 1.8 回退（rewind，agent ≥ 0.9.0）

对应 Claude Code `/rewind`：回到某条用户消息发出之前，可选「代码 + 对话」「只回退对话」「只还原代码」。

- `user.message` 增加可选 `uuid` — 这条消息在本机转录里的 uuid（与历史回看 user 条目的 id 同源），
  回退以它指认目标；client 也用它与历史页去重。旧 agent 不带，client 退回用 messageId
- `session.rewind.preview`（client→agent，会话级）— `{ reqId, targetMessageId }`，不改任何东西
- `session.rewind.preview.response`（agent→client，**只发给请求方设备**）—
  `{ reqId, ok, error?, text?, conversation?: { available, reason? }, files?: { available, reason?, filesChanged?, insertions?, deletions? } }`；
  `text` 是目标消息原文。目标是第一条消息时对话不可回退；没有文件快照时代码不可还原
- `session.rewind`（client→agent，会话级）— `{ reqId, targetMessageId, mode: both|conversation|code }`
- `session.rewind.response`（agent→client，只发给请求方设备）— `{ reqId, ok, error?, text?, files?: { filesChanged, insertions, deletions, skippedLinks? } }`
- `session.rewound`（agent→client，会话级广播）— `{ targetMessageIds[], mode, filesChanged? }`；
  `mode` 不是 `code` 时 client 把时间线从目标消息起（含）截掉，`targetMessageIds` 里任一 id
  （转录 uuid / clientMsgId）能对上本地条目即可；都对不上就清空时间线重拉历史。成功的回退先广播再应答
- 失败码 `busy | not_found | invalid | unavailable | io`：运行中、等待批准、有排队消息或有后台任务 → `busy`；
  目标不在当前对话主链上 → `not_found`；不是用户消息、或回退对话到第一条消息之前 → `invalid`；没有文件快照 → `unavailable`
- `targetMessageId` 可以是转录 uuid，也可以是实时回显的 messageId（agent 进程内能映射回 uuid）
- agent 实现：所有会话开启 SDK `enableFileCheckpointing`，代码经 `Query.rewindFiles()` 还原（会话没有子进程时
  临时起一个不发消息的 query）；对话经下次起 query 时的 `resumeSessionAt` 截断。截断点存在 `~/.trine/state.json`，
  直到新分支上收到第一条回复才清除，期间历史回看按它截掉被撤的尾巴。`both` 先还原文件，失败则对话不动
- 互操作：旧 agent 不认识这些 type，client 按 `agentVersion ≥ 0.9.0` 决定显不显示入口；旧 client 丢弃
  `session.rewound`，时间线保留已回退的消息，刷新历史后恢复正确

### 1.9 附件（agent ≥ 0.11.0）

- 字节不走 E2E 帧。发送端为每个附件生成随机 key，用 libsodium secretstream（XChaCha20-Poly1305，
  64KB 分块，最后一块 FINAL）加密成 `header(24B) ‖ chunks…`，经 HTTP 上传到 relay：
  - `POST /blobs`（bearer token，请求体为密文）→ `{ blobId, size }`；超过 `TRINE_BLOB_MAX_BYTES` 回 413
  - `GET /blobs/:id` → 密文；不存在或已过期回 404
  - `GET /blobs/config` → `{ maxBytes, ttlMs }`
  任一已认证设备都能读写任一 blob（relay 单一所有者；blobId 为 128 位随机数，内容只有持 key 的一方能解）
- 引用 `AttachmentRef = { name, mime, size, kind: image|file, blobId, key }`，放在 `input.send.attachments`
  与 `user.message.attachments`（每条至多 32 个；默认上限 10 个 / 64MB 由 client 设置）。
  历史 user 条目的 `attachments` 可能不带 `blobId/key`（CLI 里直接粘贴的图片只在转录里）
- agent 收到 `input.send` 后先下载、解密、落盘（`<home>/uploads/<会话>/<消息>/`），再入队；这一步在命令链外、
  按会话保序。失败回 `input.rejected { clientMsgId, reason }`（没进队列也没进去重表，client 标失败、可原样重试）
- 交给 SDK：png/jpeg/gif/webp、原始 ≤ 3.75MB、长边 ≤ 2000px 的图片作为 image 内容块（类型以文件头为准）；
  其余在文字末尾附 `<attached-files>` 路径清单，由 Claude 用 Read 读取（会话的上传目录在 `additionalDirectories` 里）。
  历史回看时按 manifest 还原附件列表并去掉路径清单
- `attachment.fetch.request`（client→agent，会话级，不拉起会话进程）— `{ reqId, messageId（转录 uuid）, index }`；
  `attachment.fetch.response`（只发给请求方）— `{ reqId, ok, attachment?, error?: { code: not_found|io|unavailable, message } }`。
  agent 从本机副本（有 manifest）或转录里的图片块重新加密上传，返回新引用。client 在 blob 404 或没有引用时使用
- 互操作：旧 agent 丢弃 `attachments` 字段、拒收空 text 的 `input.send`，client 按 `agentVersion ≥ 0.11.0` 决定给不给附件入口

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
- `live?: boolean`（live-sessions，agent ≥ 0.10.0）— 会话当前在 agent 上有子进程，占一个活跃名额（上限见 `machine.info.maxSessions`）。子进程拉起（新建 / resume）与关闭（空闲回收、满额腾位、归档、切目录）后都会广播一次 `session.updated`；归档会话时若它不忙且没有后台任务，顺带回收子进程；省略 = 没有 / 旧 agent。名额满时 agent 先回收最久未活动且不忙（不在跑、不等批准、无排队输入、无后台任务）的会话，全都在忙才回 `error.fatal(config)`
- `context?: { usedTokens, maxTokens, percent, at }`（usage-display，agent ≥ 0.12.0）— 最近一次已知的 context 用量。agent 在主 agent 每轮结束（result）后，在同一个 SDK query 上调 `getContextUsage()` 取值（不消耗模型 token），也可由 client 发 `session.context.request { reqId }`（会话级，agent ≥ 0.13.0）手动刷新：有子进程就直接查，没有就临时起一个 resume 该会话、不发消息的 claude 查完即关（约 2 秒，不写转录；有待生效的截断点时从截断点 resume）。新值随 `session.updated` 广播，应答 `session.context.response { reqId, ok, context?, error?: { code: not_found|failed, message } }` 只发给请求方（会话打不开时为机器级 `not_found`）。`session.status.response` 的 `contextUsedTokens / contextLimitTokens` 填这个最近值（0.13.0 之前恒为 0/0）；`maxTokens` 是自动压缩窗口，`percent` 超窗时可 > 100。子进程回收后保留最后一次的值（agent 重启后清空，等下一轮再取）；省略 = 还没取到 / 旧 agent

- `pinnedAt?: Timestamp`（sidebar-pin，agent ≥ 0.14.0）— 置顶时间，与归档标记存在同一个 `~/.trine/sessions.json`（`pinned: {sid: ts}`）；省略 = 未置顶。见 §2.3

agent 侧所有产出 SessionMeta 的出口（list、session.created、session.updated、各命令成功后的广播）都经同一处合并归档 / 置顶标记、`headless` 与 `live`，活跃会话的状态迁移不会冲掉 title / firstPrompt / archived 等非运行时字段。

### 2.2 重命名 / 归档 / 永久删除

三条 c2a 都是**会话级**帧（带 `sessionId`、`reqId`），在 agent 上与同会话的 `input.send` 串行执行，但 agent **不会**因此把会话 resume 起来（不占并发名额）：

- `session.rename { sessionId, reqId, title }` — 写转录的 custom-title 记录，与 CLI `/rename` 同格式、互通。agent 写入前按 CLI 显示标题时的同款规则规范化：trim → 控制/格式字符换空格 → 去 `\x00-\x1f\x7f-\x9f` → 按码点截 200 → trim；结果为空 → `invalid`。SDK 的 `listSessions` / `getSessionInfo` 读取时**不**规范化、原样返回；在写入端先对齐，是为了与 CLI 的显示一致，并让广播出去的标题与之后读回的逐字相等（列表不闪）。client 不必自己截断（按 UTF-16 码元截会把 emoji 提前截掉），交给 agent。从未发过消息的会话还没有转录，标题先记在 agent 本地，首条消息落盘后补写。改名会刷新转录 mtime，会话会跳到列表顶部（接受）
- `session.archive { sessionId, reqId, archived: boolean }` — 归档 / 取消归档。运行中、等待批准、有排队消息 → `busy`（与改工作目录同口径）。**自动取消归档**：已归档会话进入 running（本机远端任一设备发消息、`run.resumeAt` 续跑等）时 agent 自动清标记，随同一次 `session.updated` 广播。本机终端 `claude --resume` 继续已归档会话**不会**自动取消归档（agent 看不到），非目标
- `session.delete { sessionId, reqId }` — 永久删除本机转录，不可逆。只能删**已归档**的（否则 `not_archived`，协议层兜底）；忙 → `busy`；转录 60 秒内被 trine 以外的进程写过 → `busy`（本机终端可能正开着它；trine 自己刚做的改名不算）。删除成功约 8 秒后 agent 会复查一次：CLI 子进程退出时会补写元数据（SDK 关闭子进程是先等 2 秒再 SIGTERM），可能重建一个只含元数据的转录，查到且其修改时间落在删除时刻后 15 秒内就再删一次；启动与每日清理时也对仍在期内的墓碑复查。修改时间更晚的转录视为用户删除后在本机终端又用了这个会话：不删，并撤掉墓碑，它重新作为合法会话出现在 agent 的列表里

应答统一走**机器级** `session.mutate.response { reqId, targetSessionId, ok, error?: { code, message } }`，`code ∈ busy | not_found | not_archived | invalid | io | deleted`。业务拒绝一律在这里表达，不用 `error.fatal`（那会进聊天时间线且关联不到请求）。目标会话字段叫 `targetSessionId` 而不是 `sessionId`：密文里的 `sessionId` 是信封绑定字段，带上它这帧就成了会话级帧。

成功时另有机器级广播给所有设备：rename / archive → `session.updated`（整份快照，含 `archived`/`archivedAt`）；delete → `session.removed { targetSessionId }`。client 收到 `session.removed` 应清掉该会话的列表条目、时间线、游标、能力缓存、待发帧与 parked 条目，当前正打开它则跳回列表。

### 2.3 置顶（sidebar-pin，agent ≥ 0.14.0）

- `session.pin { sessionId, reqId, pinned: boolean }` — 会话置顶 / 取消置顶。会话级帧，与 §2.2 同一套处理：不 resume、应答走 `session.mutate.response`（未知会话 → `not_found`），成功广播 `session.updated`（带或不带 `pinnedAt`）。不看会话忙不忙；重复置顶保留原时间。**归档会清掉置顶**，取消归档不恢复；删除一并清掉
- `cwd.pin { path, pinned: boolean }` — 工作区置顶 / 取消置顶（机器级，fire-and-forget，同 `cwd.add`）。工作区不是实体，是 client 按（机器, 去尾 `/` 的 cwd）分出来的组；path 按这个规范化 cwd 发，agent 按字面存进 `~/.trine/cwd.json` 的 `pinned: {cwd: ts}`（最多 100 条，超出丢最早置顶的），随 `cwd.updated` / `cwd.list.response` 的 `pinned` 下发
- 排序（client）：分组时组序 = 置顶组（越晚置顶越靠上）→ 工作区创建时间倒序（该机器该 cwd 下**全部**会话含已归档的最早 `createdAt`，缺省退回 `lastActivityAt`）；不再看组内状态与最后活动，组不随会话状态跳动。组内 / 平铺时：置顶会话（越晚置顶越靠上）→ 等待批准 → 运行中 → 其余按最后活动时间
- client 拉会话列表时顺带发一次 `cwd.list.request`，拿到置顶工作区
- 互操作：按 `machine.info.agentVersion` ≥ 0.14.0 探测，版本不够时隐藏置顶菜单；旧 client 丢弃不认识的 `pinnedAt` / `pinned`

**墓碑**：删除后 agent 保留墓碑 8 天（= 服务端默认 parked 24h + relay 留存 7 天：一帧指向已删会话的旧命令最晚在这个窗口内到达）。命中墓碑的**任何**会话级帧都不会让会话复活：带 `reqId` 的（含 `session.status.request` 等）回 `session.mutate.response{ok:false, code:'deleted'}`；不带的（`input.send`、park 队列或断线补发回来的旧帧）agent 丢弃，并对该会话广播 `session.removed`（按会话限频，60 秒至多一次），让还缓存着它的设备自清。client 侧也记住已删会话 8 天：此后指向它的会话级帧（断线补发回放、迟到帧）直接丢弃，不再对它发 sync，也不能再打开（深链 / 后退回来时提示并跳回列表）。删除后 seq 计数不重置（D10 保守取向）。

**互操作**：

- 新 client + 旧 agent：旧 agent 不认识这三个 type，schema 层静默丢弃 → client 的请求只能等超时，应提示「agent 版本过旧或离线」。client 应按 `machine.info.agentVersion`（semver，**≥ 0.2.0** 支持）做能力探测，版本不够时隐藏菜单项
- 旧 client + 新 agent：旧 client 丢弃不认识的 `session.mutate.response` / `session.removed`；被删的会话在它的列表里保留到下次刷新（`session.list.request` 的结果里已经没有它）

## 3. 机器管理

- `machine.status`† — 服务端可见（在线状态本身就是服务端知道的）：`{ machineId, online, lastSeenAt }`
- `machine.info` — E2E 内容：`{ name, platform, osVersion, agentVersion, claudeVersion, activeSessionCount, maxSessions?, rateLimits? }`（maxSessions 自 0.10.0，rateLimits 自 0.12.0）（常用目录另见 §6）
- `rateLimits?: { fiveHour?, sevenDay?: { percent(0–100), resetsAt? }, updatedAt }`（usage-display）— 机器上登录账号的订阅限额用量，账号级、同机所有会话共用。来源：会话活动时 CLI 每次 API 请求发的 `rate_limit_event`（取其 `unifiedWindows`，类型定义里没有的字段；没有时退回顶层的单个窗口），值变了（或值不变但距上次广播超过 5 分钟）就广播一次 `machine.info`。API key / Bedrock / Vertex 等没有订阅限额的账号不带。agent 不落盘，重启后等下一次会话活动或手动刷新
- `machine.usage.request { reqId }`（client→agent，机器级，agent ≥ 0.12.0）— 手动刷新限额用量：agent 借一个活跃会话的 query 调 SDK 的实验性 usage 接口；没有活跃子进程就临时起一个不发消息、不落转录的 claude（不占会话名额，30 秒超时），用完即关。只给手动刷新用，client 不要定时发。拿到后先广播 `machine.info`，再回 `machine.usage.response { reqId, ok, error?: { code: unavailable|failed, message } }`（`unavailable` = 账号没有订阅限额，agent 同时清掉已有的 rateLimits）。旧 agent 静默丢弃，client 按 agentVersion 探测
- `machine.stats.request { reqId, watch?: { intervalMs, ttlMs } }`（client→agent，机器级，agent ≥ 0.14.0）— 机器资源数据。agent 立刻采样一次，以带 reqId 的 `machine.stats { reqId, stats }` **只回给请求设备**；带 `watch` 时再按 `intervalMs`（2 秒–10 分钟）给该设备定时推 `machine.stats { stats }`（不带 reqId），直到 `ttlMs`（≤ 30 分钟）到期。同一设备的新 watch 覆盖旧的，`ttlMs: 0` 立即退订。不做常驻广播：机器级流还承载 `session.updated` 等，relay 每条子流只留存有限帧，定时广播会挤掉断线补发窗口、给离线设备堆积无用帧。首次采样要两次读数算 CPU 与网速，多等约 1 秒；结果在 1.5 秒内复用
  - `stats: { at, cpu?: { percent, cores, load? }, memory?: { totalBytes, usedBytes, swapTotalBytes?, swapUsedBytes? }, disks?: [{ label, totalBytes, usedBytes, availBytes }], network?: { rxBytesPerSec, txBytesPerSec }, uptimeSec?, claude?: { processes, rssBytes } }`，各块采不到就省略。CPU 用 `os.cpus()` 计数差；内存 Linux 用 MemAvailable、macOS 用 `vm_stat`（free + inactive + speculative）；磁盘是 `/` 与 home 所在文件系统（同一个只报一次，标签只给 `/`、`~`）；网速只算物理网卡（Linux 排除回环、容器、VPN 网卡，macOS 只算 `en*`）；`claude` 是 agent 全部子孙进程的个数与 RSS
  - client：资源数据可见且页面可见时订阅（取本设备各处需求里最短的间隔），在 ttl 一半时续租，不再需要时退订；机器离线不发。列表顶部 / 机器卡的间隔来自设置（5 秒 / 10 秒 / 30 秒 / 1 分钟 / 关闭，默认 1 分钟），机器详情页打开时 5 秒（设置为关闭时只在打开时取一次）。快照只在内存，不落盘
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

- `cwd.list`（req/resp）— `{ favorites: [path], defaultCwd, pinned? }`；机器详情/新建会话/会话设置三处共用；`pinned` 是置顶工作区（§2.3）
- `cwd.add` / `cwd.remove` — `{ path }`
- `cwd.setDefault` — `{ path }`；新建会话表单以 defaultCwd 预选
- `cwd.pin` — `{ path, pinned }`；置顶工作区（§2.3）
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
