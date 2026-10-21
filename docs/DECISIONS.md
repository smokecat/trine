# 架构决策

本文记录当前实现的选择与边界；协议细节见 [PROTOCOL-REQUIREMENTS.md](PROTOCOL-REQUIREMENTS.md)。

## D1 · 应用消息端到端加密

客户端 ↔ agent 使用 libsodium crypto_box（X25519 + XSalsa20-Poly1305）。服务端
中转密文，不实现消息内容搜索。设备认证使用独立的 Ed25519 密钥。
TLS 仍是必要条件，尤其用于配对期间的传输。Web 前端代码分发仍需要信任托管方，
见 D11；不能把此设计解释为服务器被攻陷后仍绝对安全。

## D2 · WebSocket 与有限期中转存储

浏览器与 agent 均主动连接 relay，不要求 agent 开放监听端口。心跳、重连、序号与
SQLite 留存支持离线补发。单进程实现避免额外消息队列，但不提供集群高可用。

## D3 · Claude Agent SDK

Agent 通过 TypeScript SDK 管理流式 query、权限转发和会话历史。配置显式使用
`systemPrompt: { type: 'preset', preset: 'claude_code' }` 和
`settingSources: ['user', 'project', 'local']`，对齐本机工作空间设置。
SDK 锁定版本；CLI 优先从 PATH 查找，支持显式路径。认证资格与使用条款由
Anthropic/用户配置的提供方决定，trine 不提供或绕过授权。
同一会话应只有一个活跃控制进程。

## D4 · Bun、Hono 与 SQLite

轻量单进程 relay，便于共享 TypeScript 协议。运行时依赖 bun:sqlite，不能在没有
适配的情况下直接切到 Node。生产由 systemd 管理、Caddy 提供 HTTPS/WSS。

## D5 · React SPA

React + Vite + Tailwind + shadcn/ui，使用 Streamdown 展示消息。无需 SSR。
Manifest 与图标提供轻量安装外观；没有 service worker 离线聊天承诺。

## D6 · Bark 通知

推送通过适配器与主链路解耦。仅发送事件类型与机器短 ID/别名，不发送会话名或
正文。Bark 可见这些元数据。失败重试有限，在线抑制与去抖减少重复通知。

## D7 · Bun workspaces

使用一套包管理器和锁文件。四个工作包不需要额外构建任务编排系统。

## D8 · 独立配对与 agent 背书

每台浏览器拥有独立身份与加密密钥；每台 agent 保存已配对收件人列表。client
登记由已认证 agent 在确认 SAS 后背书，不接受客户端自行宣称配对成功。
新增浏览器的历史由 agent 从本机读取，再加密给新收件人。不共享根私钥。
当前缺少完整的终端用户撤销工作流，恢复边界见 SECURITY.md。

## D9 · 使用现有认证信封

crypto_box 提供消息认证，配合 sessionId、seq 和 requestId 处理重复与重放，
不再叠加独立 HMAC。若新增外部 Webhook，应单独设计认证、TTL 和幂等机制。

## D10 · 序号恢复

relay 保存持久高水位，seq 冲突通过 relay.reject 的 expectedAfter 回传；发送端
对可恢复的 seq_not_monotonic 重新编号重发。seq_too_far_ahead 不能靠继续前移修复，
应显式报错。高水位采用独立 TTL（默认 90 天），大于密文留存（默认 7 天）。
已认证恶意设备仍可制造资源压力；TTL 不等同于严格的总存储配额。

## D11 · 前端托管的信任边界

默认部署指南采用同源托管，减少跨域配置；独立前端可用明确的 CORS 允许清单。
浏览器私钥在 localStorage，缓存消息在 IndexedDB，均无额外应用层静态加密。
控制前端 JS 的一方可读取密钥和明文。CSP、本地打包资源与可信构建可减少攻击面，
但不能消除恶意前端主机这一信任根。详细威胁模型见 SECURITY.md。

## D12 · 模型、配额与成本展示

能力探测、模型选择与成本信息依赖 SDK/CLI 实际返回。不能把缺失信息填成肯定值，
也不能把 trine 的展示当作提供方的最终账单。用环境变量配置可访问的默认模型。

## D13 · 短期单次 agent 邀请

首台与新增机器统一使用本地管理员签发的 256 位随机邀请（默认 10 分钟，最长 1 小时）。
签发权限来自 relay 主机/数据库的 OS 权限，不新增公网管理 API、常驻管理员密钥或多租户模型。
SQLite 只保存摘要、撤销 ID 和过期时间；IMMEDIATE 事务将核销与设备插入一起提交。
同身份重试幂等但仍须私钥认证；旧身份重连不再注册。空库与开放开关均无旁路。

相较于远程管理界面，这个方案复用自托管者已有的 SSH 信任，维护面更小；相较于开放注册窗口，
不需要停服务或反复改配置。代价是签发仍需要主机访问，邀请作为短期 bearer 必须私密交付。
隐藏输入/单行 stdin、不落盘、禁止远程明文与重定向、请求限流与数量限制共同收紧暴露面。
浏览器配对、SAS 人工确认、身份角色校验、权限、防重放与 E2E 均保持原有边界。
详见[注册、恢复和迁移说明](AGENT-ENROLLMENT.zh-CN.md)。

## D14 · 消息附件：先上传、消息里只带引用

附件不进 E2E 帧：单帧整体 crypto_box 再两次 base64，体积约 1.78 倍，几 MB 就会碰到 WS
帧上限，还会放大离线补发存储和每台设备各一份的扇出。改为浏览器用每个附件独立的随机
key（libsodium secretstream，64KB 分块、带截断检测）加密后经 HTTP 上传到 relay 的 blob
目录，`input.send` / `user.message` 只带 `{blobId, key}`——key 在 E2E 密文里。relay 只存
密文，按 TTL 清理，不进 SQLite。

交给 Claude 的方式对齐 Claude Code CLI：满足 API 限制的小图作为 image 内容块内联，其余
（大图、普通文件）由 agent 落盘到 `<home>/uploads/<会话>/`，在消息末尾列路径，SDK
`additionalDirectories` 让 Read 读它们不弹权限。默认不压缩图片，大图交给 Read 缩放。
blob 过期或从没上传过（CLI 里粘贴的图片只在转录里）时，`attachment.fetch` 请 agent
从本机副本或转录重新上传。代价：relay 能看到附件大小与时间；agent 磁盘上留有明文副本。

## D15 · 用量展示：会话活动时顺带刷新，手动刷新才临时起进程

context 用量是会话级的，在每轮结束后借同一个 SDK query 调 `getContextUsage()`，不额外起进程、
不消耗 token；子进程回收后保留最后一次的值，不从转录估算（转录里的模型名不带窗口大小，算不准）。

5 小时 / 7 天限额是账号级的，挂在 `machine.info` 上。CLI 每次 API 请求都会发 `rate_limit_event`，
实测带一个类型定义里没有的 `unifiedWindows`，一次给齐两个窗口——会话活动时零成本刷新。
没有会话活动时数据会变旧，但不定时轮询：SDK 的 usage 接口需要一个 claude 进程，没有活跃会话就得
专门起一个（几秒、上百 MB），只在用户手动刷新时这么做。代价：依赖两个不稳定的 SDK 面（未公开
字段和标注为实验性的接口），所以解析都做形状校验，认不出就不显示，不影响会话本身。

## D16 · 会话列表：组位置固定，置顶存在 agent

按工作区分组时，组序只看置顶与工作区创建时间（新的在上），不看组内状态与最后活动：
组随会话开始运行、等待批准而跳位置，比「急的排上面」更打扰；待批准靠组头角标、组强制展开与推送提示。
组内仍按状态排。工作区不是实体，创建时间从该目录下全部会话（含已归档）推出，筛选不改变组位置。
不做手动拖拽排序。

置顶与归档一样是用户意图，存在 agent（会话：`sessions.json`；工作区：`cwd.json`），各设备一致；
不放 web 的本设备偏好。归档清掉会话置顶，免得取消归档后它突然出现在最上面。

## D17 · 机器资源数据：按需订阅，只推给在看的设备

资源数据变化快但只有人看的时候才有用，所以不挂在 `machine.info` 上常驻广播，而是由 client 在数据可见、
页面可见时订阅（租约，到期即停），agent 只把快照定向推给订阅的设备。这样离线设备不会积压帧，
relay 的机器级补发窗口也不会被资源快照挤占。默认 1 分钟、详情页 5 秒，是「看得出趋势」与
「帧数、采样进程开销」之间的折中；采样在 macOS 上要起几个系统命令，没有订阅时完全不采。
历史趋势只保留在页面内存里，不在 agent 或 relay 落盘。

## D18 · 扩展：agent 侧外部命令 + 固定视图词汇

想让 trine 显示别的工具（例如任务管理）的数据、提供操作按钮，又不让 trine 依赖它们。扩展做成 agent 机器上的
外部命令：stdin 一个 JSON、stdout 一个 JSON（与 Claude Code 的 statusLine 同一种形态），用什么语言写都行，
由 agent 执行、校验并经 E2E 通道转给浏览器。浏览器只用自己的组件渲染一组固定词汇（分组、条目、徽章、按钮、
受限 Markdown），不加载任何扩展代码：浏览器私钥在 localStorage，同源执行的第三方 JS 能读到私钥、伪造权限批准，
等于废掉 D1 与 D8。需要更丰富的界面时再考虑 MCP Apps 式的跨源沙箱 iframe，不自己造插件运行时。

动作的底线是「读取 / 刷新 / 推送永远不执行效果」。需要 agent 执行的动作（发消息、开会话、改关联、回调扩展）在视图里
只是一次性令牌：只对签发设备有效、10 分钟过期、扩展变更或 agent 重启即作废。relay 会留存 c2a 帧，断线时点下的动作
可能在重连后才送达，过期令牌保证它不会在用户离开后突然执行。需要确认时，确认的是 agent 固定好的执行计划，commit 时不重新
运行扩展，执行前复查会话的目录与权限模式。权限按扩展、按能力设置，存在 agent；全托管下不弹任何确认（用户的选择）。

会话关联是 trine 自己的通用机制（`{ext, ref, label}`），trine 不理解 ref 的含义；存在单独的 `session-links.json`，
旧版 agent 全量重写 sessions.json 时不会把它剥掉。能力判断看 `machine.info.extensions` 有无，不按版本号；完整目录按 rev
另拉，避免频繁广播的 machine.info 变大。

多 agent（Codex、Gemini 等）不走这套机制：那是替换会话引擎，需要后端抽象层，与「给会话加功能」不是一回事；
目前仍是非目标（REQUIREMENTS）。契约见 [EXTENSIONS.md](EXTENSIONS.md)。

## 开放问题

- 可操作的设备撤销与恢复界面。
- 已认证恶意客户端的总体流量/存储配额（附件 blob 只有单个大小上限和 TTL，没有总量配额）。
- 更多平台与浏览器的持续集成覆盖。
