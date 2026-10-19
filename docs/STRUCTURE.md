# 架构与目录

trine 是单所有者自托管工具，使用 Bun workspaces 管理 TypeScript monorepo。

```text
apps/
  agent/       Claude Code 代理端，主动连接 relay
  server/      Hono + SQLite 中转与设备认证；deploy/ 为通用部署模板
  web/         React + Vite 浏览器界面
packages/
  core/        协议、类型、crypto、权限匹配和认证客户端
patches/       上游依赖修补
LICENSES/      第三方许可正文
docs/          功能范围、架构决策与协议说明
.github/       CI、问题与 PR 模板
```

## 数据流

1. 浏览器和 agent 分别创建 Ed25519 身份密钥与 X25519 加密密钥。
2. 首台和新增 agent 经管理员签发的短期一次性邀请注册到 relay；浏览器通过配对码和人工 SAS 确认加入。
3. 用户命令在浏览器加密，经 relay 转给 agent；agent 验证并调用 Claude Agent SDK。
4. SDK 输出转换成共享事件，agent 加密发送，浏览器解密并合并到时间线。
5. relay 用 SQLite 保存设备信息、认证 token 摘要、路由元数据与有限期密文。
6. 可选 Bark 推送仅传事件类型及机器标识/别名。

## 代码边界

- `core/protocol`：Zod 消息 schema 与版本；修改需要考虑三端兼容性。
- `core/crypto`：crypto_box、Ed25519、配对材料与 SAS；不依赖 UI。
- `agent/app`：配置、生命周期、命令路由、状态、回退编排与 CLI 更新。
- `agent/bridge`：SDK 会话、工具权限、事件翻译、历史与子代理历史。
- `agent/net`：设备身份、收件人列表、加密信封、配对与 WS 客户端。
- `agent/control`：本机控制通道（`<home>/control.sock`）与 `pair`/`devices`/`status` 子命令。
- `server/auth`、`store`、`ws`：设备认证、存储、连接路由及离线补发。
- `web/lib`：浏览器传输、身份、缓存与 reducer；`components`/`views` 负责展示。

## 持久化与信任

agent 默认状态目录为 `~/.trine`，内含单实例锁 `agent.lock`（同一目录只许一个进程）；Claude 的会话目录独立于 trine。Web 使用
localStorage/IndexedDB。生产数据库应放仓库外。开发实例可用忽略的 `.dev/`。

加密保护浏览器到 agent 的消息链路，但前端脚本、浏览器和 agent 仍是信任根。
浏览器存储不由 trine 加密；同源部署不能防止被攻陷服务器替换前端代码。
详细边界见 [SECURITY.md](../SECURITY.md)。

## 验证

在根目录安装并运行 `bun run check`。测试使用临时数据和注入式 SDK 替身，不访问
真实用户账户或发起付费模型请求。受版本控制的转录样本使用合成标识与路径。
