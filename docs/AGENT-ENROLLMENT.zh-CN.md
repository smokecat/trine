# Agent 注册、部署与恢复

[English deployment guide](../apps/server/deploy/README.md) · [安全说明](../SECURITY.md)

首台与新增 agent 现在都只需要两项注册操作：管理员签发邀请，新机器启动后输入邀请。
不再需要关闭公网入口、临时开放注册、两次重启 relay，或通过隧道注册后切换 URL。
已注册机器保留原身份即可重连；浏览器仍须配对并人工确认校验码。

## 本机开发

先按 [README](../README.zh-CN.md)启动 relay 和 Web 开发服务，再在仓库根目录运行：

```bash
bun run agent:invite create --db .dev/relay.sqlite
TRINE_DEFAULT_MODEL=sonnet bun run dev:agent -- --server http://localhost:5173 --home .dev/agent --enroll --pair
```

第一条命令输出一次邀请；第二条命令仅在身份尚未注册时要求隐藏输入。粘贴邀请本身并按 Enter。
然后浏览器打开相同 origin，扫码或粘贴配对载荷，比对两端校验码，完全一致才确认。

## 公网部署：首次和新增机器相同

先按[部署指南](../apps/server/deploy/README.md)启动新版 relay、配置 Caddy 和 HTTPS。
relay 保持只监听回环。新版空库也拒绝无邀请注册，因此可以先配置 HTTPS，再登记首台 agent。
如果当前运行的是旧版空库，升级完成前仍须阻断公网注册入口。

以下路径和域名均为部署模板示例。必须使用实际运行服务的数据库和对应版本源码。
在可信、私密的 relay SSH 终端运行：

```bash
cd /opt/trine
sudo -u trine /usr/local/bin/bun run agent:invite create --db /var/lib/trine/trine.sqlite
```

在新机器的交互式终端运行：

```bash
TRINE_DEFAULT_MODEL=sonnet bun run dev:agent -- --server https://trine.example.com --home ~/.trine --enroll --pair
```

输入邀请，完成浏览器配对。下一台机器重复这两步即可，无需改环境变量或重启 relay。
后续启动保留同一 `--home`，省略 `--enroll`。即使保留 `--enroll`，已注册身份也不会请求或消耗邀请。
同一 `--home` 只能运行一个 agent：第二个进程会因 `<home>/agent.lock` 直接报错退出，
否则两边会在 relay 上互相顶替（日志里表现为 `code=4005` 和反复重连）。

`--enroll` 也支持从私密 stdin 管道读取一行，便于 SSH 管道交付。不要把凭据作为参数、环境变量、
URL 或持久配置传递。非交互管道无法人工确认浏览器配对；之后用下面的 `pair` 子命令配对即可。

## 给运行中的 agent 增加浏览器（无需停机）

agent 作为常驻服务（systemd、launchd 等）运行时，不要停服务，也不要用同一 `--home` 再起一个 `--pair`。
在该机器的交互式终端里运行：

```bash
bun run dev:agent -- pair --home ~/.trine
```

命令通过 `<home>/control.sock` 连接运行中的 agent 并打出二维码和配对码。浏览器扫码后，终端显示本端校验码；
**与浏览器上显示的完全一致才输入 `y`**。配对码 5 分钟内有效，到期前 1 分钟提醒，过期或中止后按 Enter 可生成新码；
Ctrl-C 退出会同时作废未完成的配对。比对期间若又收到新的配对请求，旧的作废，须按最新显示的校验码重新比对。

控制通道是只对本机同一用户开放的 Unix socket（文件 0600，位于 0700 的 home 目录下），不监听网络端口。
能访问它的人可以发起配对和移除设备，权限与能读取 `identity.json` 私钥相同。
只用 `--pair` 前台启动 agent 的旧方式仍然可用。

## 管理已配对浏览器

```bash
bun run dev:agent -- status --home ~/.trine           # 运行状态、连接状态、已配对数量
bun run dev:agent -- devices --home ~/.trine          # 列出已配对浏览器
bun run dev:agent -- devices revoke web-1a2b --home ~/.trine   # 完整 deviceId 或唯一前缀
```

`devices revoke` 从 agent 的名册（`recipients.json`）移除该设备：agent 在运行时立即生效，不在运行时直接修改文件。
之后 agent 不再为它加密事件，它发来的消息也会被丢弃。relay 上的设备登记不变；设备丢失或疑似受控时，
仍按[设备恢复说明](../SECURITY.md#lost-devices-and-recovery)评估是否需要整体重置。要恢复使用须重新配对。

## 邀请有效期与撤销

默认 10 分钟，可用 `--ttl 300` 改为 5 分钟；范围 1–3600 秒。每份邀请只允许新增一个 agent，
不能直接注册浏览器。最多保留 100 份有效待使用邀请。签发命令将凭据写到 stdout，非秘密 ID 和
过期时间写到 stderr；请保护终端滚动记录、剪贴板历史和终端录制，不要截图分享。

```bash
sudo -u trine /usr/local/bin/bun run agent:invite list --db /var/lib/trine/trine.sqlite
sudo -u trine /usr/local/bin/bun run agent:invite revoke INVITATION_ID --db /var/lib/trine/trine.sqlite
```

列表仅包含 ID 和到期时间。`INVITATION_ID` 来自签发提示或列表，不是邀请凭据。
撤销只影响尚未使用的邀请，不能撤销已经注册的设备。设备丢失或受控请按
[设备恢复说明](../SECURITY.md#lost-devices-and-recovery)处理；从单台 agent 移除某个浏览器见上文「管理已配对浏览器」。

## 失败恢复

| 情况 | 操作 |
| --- | --- |
| 尚未注册，提示 `--enroll` | 核对 `--server`、`--home`；确为新机器时签发邀请并重跑。 |
| `invalid_invitation` | 邀请已过期、撤销、被另一身份使用，或发自另一 relay；签发新邀请，保留原身份重试。 |
| 注册时断网或响应丢失 | 保留原 `--home` 重试。若服务端已登记，直接用私钥认证；尚未登记且邀请未过期时可重用原邀请。 |
| `registration_closed` | 新设备没有有效注册授权；升级 relay 和 agent 后使用邀请，不能通过旧开关绕过。 |
| `rate_limited` | 等至少一分钟再试；持续出现时核对可信代理与异常流量。 |
| 身份、公钥或角色冲突 | 检查正确的身份备份和 relay；不要覆盖私钥强行注册。 |
| `device_revoked` | 邀请不能恢复已撤销身份，按设备恢复流程处理。 |
| 签发命令失败 | 核对数据库是否已由匹配版本 relay 初始化、文件权限、TTL 和待使用邀请上限。 |
| 启动报「已有 agent 在使用这个身份目录」 | 已有同身份进程在运行；配对用 `pair` 子命令。确认锁文件中的 PID 不是 agent 后才可删除该锁。 |
| `pair` 提示 agent 在运行但连不上控制通道 | 运行中的是不带控制通道的旧版本；升级后重启该服务再试。 |
| 日志出现 `code=4005` 被顶替 | 另一个进程或另一台机器在用同一份身份；只保留一个。被顶替的一方每 30 秒重试一次。 |

身份文件在注册之前生成并保留。网络失败后不要删除它或改用新的 `--home`，否则会变成另一台设备，
无法利用已提交注册的幂等恢复。邀请过期或撤销不会影响已注册设备的日常认证。

## 安全与信任边界

- 初始信任来自 relay 主机的 OS/SSH 权限。没有公网签发接口，也没有新增常驻管理员密码。
  SSH 主机身份和 HTTPS 证书必须可信。持有未使用邀请的人可注册 agent，邀请应仅交给自己控制的机器。
- 邀请使用 256 位随机值；SQLite 仅保存 SHA-256 摘要、撤销 ID 和到期时间，不保存原文。
  核销与设备插入通过 IMMEDIATE 事务原子提交；多个进程竞争时只允许一个身份成功，写入失败会回滚邀请。
- 同一设备 ID、公钥和角色的重试返回成功但不签发认证 token，也不再消耗邀请。
  真正连接仍需要 Ed25519 私钥挑战应答；换公钥、换角色或已撤销身份均不能通过。
- agent 隐藏输入、不落盘，仅通过 HTTPS（本机开发可回环 HTTP）POST body 传递邀请，拒绝重定向。
  不要开启会记录认证请求体的反代追踪。保护数据库、备份和系统时钟。
- 注册请求最大 4 KiB；每来源每分钟 20 次、全局每分钟 200 次。伪造 deviceId 不能绕过。
  无可信反代时 HTTP 来源共用保守配额。限流可能暂时影响新注册，但不会降低授权要求。
  新版已注册 agent 直接挑战认证，不占注册配额。
- 浏览器人工配对、client-to-agent 加密、设备角色校验、权限检查和防重放仍有效。
  relay 仍是单所有者服务，邀请不提供多租户隔离；恶意前端和受控终端仍在既有威胁边界内。

## 升级与回退

先备份，再升级 relay。schema v4 只增加邀请表，保留设备公钥、认证 token、密文与配对记录。
旧 agent 若已经注册，可继续用原身份连接；尚未注册的旧 agent 必须升级才能输入邀请。
`TRINE_OPEN_REGISTRATION` 保留配置兼容但已失效，设为 `1` 也不能开放注册；启动时会提示废弃。

旧 relay 拒绝较新的 schema，回退需要匹配版本的升级前备份，会丢失备份后的新状态。
恢复备份也可能恢复仍未到期的旧邀请：在重新开放公网入口前，列出并撤销所有待使用邀请，再重新签发。
本功能不自动修改运行中的部署，也不提供数据库降级。
