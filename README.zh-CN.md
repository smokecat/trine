# trine

个人自托管的 Claude Code 远程操作工具。用手机或浏览器查看电脑上的会话、继续对话、检查工具与子代理活动，并远程处理权限请求。

[English](README.md) · [部署指南](apps/server/deploy/README.md) · [安全说明](SECURITY.md) · [贡献指南](CONTRIBUTING.md)

## 能力与定位

- 流式消息、工具调用、子代理过程和历史回看。
- 多台机器的会话列表、继续会话、重命名和归档。
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
# 终端 3：agent，选择你的账户可访问的模型
TRINE_DEFAULT_MODEL=sonnet bun run dev:agent --   --server http://localhost:5173 --home .dev/agent --pair
```

浏览器打开 <http://localhost:5173>，粘贴终端中的配对码，对比两端校验码；完全一致时才在 agent 的交互式终端确认。浏览器和 agent 必须使用相同主机名。

`.dev/agent` 只隔离 trine 的身份和状态；agent 仍能使用你的真实 Claude 工作空间、设置与权限。建议先在可丢弃的项目里体验。

## 公网使用

按[部署指南](apps/server/deploy/README.md)配置 HTTPS/WSS。**在开放公网前，先用 SSH 隧道完成首台 agent 注册**。当前代码在设备库为空时允许首设备注册，关闭开放注册开关也不能替代这一步。

不要把它作为多人共享的中转服务。Web 私钥保存在 localStorage，缓存聊天在 IndexedDB；端到端加密不能防止恶意前端脚本或受控终端读取它们。完整边界见 [SECURITY.md](SECURITY.md)。

## 配置、开发与文档

- agent：`--server` / `TRINE_SERVER` 必填；`--home` / `TRINE_HOME` 指定状态目录，默认 `~/.trine`；`--claude-bin` 选择 CLI；`TRINE_DEFAULT_MODEL` 指定兜底模型。
- relay：[配置模板](apps/server/deploy/trine-server.env.example)，复制到仓库外再填写真实值。
- 验证：`bun run typecheck`、`bun test`、`bun run build`，或 `bun run check`。
- 架构：[STRUCTURE](docs/STRUCTURE.md)；决策：[DECISIONS](docs/DECISIONS.md)；协议：[PROTOCOL-REQUIREMENTS](docs/PROTOCOL-REQUIREMENTS.md)。

自有代码采用 [MIT](LICENSE)。Claude Code / Agent SDK 有独立条款；字体、UI 基件及依赖保留各自许可，见[第三方声明](THIRD_PARTY_NOTICES.md)。
