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

## 开放问题

- 可操作的设备撤销与恢复界面。
- 已认证恶意客户端的总体流量/存储配额。
- 更多平台与浏览器的持续集成覆盖。
