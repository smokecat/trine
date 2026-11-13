/**
 * 组 `MachineInfo`（协议 §3，E2E 密文内的机器信息）。
 *
 * claude 版本在启动时探测一次（claude-cli.ts `detectClaudeVersion`，探测的是会话
 * 实际使用的那个可执行文件，尽力而为，拿不到给 'unknown'），远程 `claude update`
 * 跑完后再探测一次：它只用于展示，探测失败不该影响启动；每次广播都去 spawn 一遍也没必要。
 */
import { release } from 'node:os';
import type {
  EngineSummary,
  MachineClaudeLatest,
  MachineExtensionsSummary,
  MachineFilesInfo,
  MachineInfo,
  MachineRestartInfo,
  RateLimits,
} from '@trine/core';

/**
 * 与 apps/agent/package.json 的 version 对齐（手工同步；没有构建步骤可注入）。
 * client 按它做能力探测（semver 比较）：
 * - 0.2.0 起支持 session.rename / session.archive / session.delete
 * - 0.3.0 起支持 session.history.request
 * - 0.4.0 起支持 machine.claude.update.request；会话改用本机全局 claude
 * - 0.5.0 起支持 session.commands.request（不拉起会话取斜杠命令清单）
 * - 0.6.0 起 permission.respond 的 message（拒绝附言）/ setMode（批准时切模式）
 *   生效；同步 CLI 自行切换的权限模式；SessionMeta 带 waitingFor。旧 agent 收到
 *   这两个字段会被 zod strip（不拒帧），只是不生效——web 据版本决定显不显示
 */
// - 0.7.0 起支持后台任务：bgtask.snapshot / bgtask.stop、SessionMeta.bgRunning、
//   run.state running+detail 标记自发轮；会话泵改为长驻读取循环（自发轮不再错位）
// - 0.8.0 起支持子 agent 过程：子 agent 的 tool.start/end 与 permission.request 带
//   parentToolUseId（旧 web 会把子工具卡平铺——先部署 web 再重启 agent）、
//   subagent.history.request；Agent/Task 结果摘要改为「N 次工具调用 · 耗时」
// - 0.9.0 起支持回退：session.rewind.preview / session.rewind / session.rewound，
//   user.message 带转录 uuid；会话开启文件快照（enableFileCheckpointing）
// - 0.10.0 起 SessionMeta 带 live（有子进程）、MachineInfo 带 maxSessions；名额满时
//   先回收最久未活动的空闲会话，全都在忙才拒绝；默认上限 5 → 10
// - 0.11.0 起支持附件：input.send / user.message 带 attachments（relay blob 引用），
//   history user 条目带附件元数据，attachment.fetch.request 按需重新上传
// - 0.12.0 起 SessionMeta 带 context（context 用量）、MachineInfo 带 rateLimits（5 小时 /
//   7 天订阅限额用量），支持 machine.usage.request 手动刷新；本地斜杠命令的输出在
//   assistant.done 上带 command（web 按命令卡渲染）
// - 0.13.0 起支持 session.context.request（手动刷新会话 context 用量）；
//   session.status.response 的 context 字段填最近一次已知值（此前恒为 0/0）
// - 0.14.0 起支持置顶：session.pin（SessionMeta 带 pinnedAt）、cwd.pin（cwd.updated /
//   cwd.list.response 带 pinned）；归档会清掉会话置顶；支持 machine.stats.request（机器资源数据，
//   按设备订阅定时推送）
// - 0.15.0 起排队中的消息出队开始执行时才回显 user.message（此前入队即回显）；撤回成功、
//   停止任务或会话关闭丢弃排队消息时发 input.cancelled（旧 web 会丢掉这帧——先部署 web 再重启 agent）
// - 0.16.0 起支持扩展：ext.* 帧、session.links.update、MachineInfo 带 extensions、
//   SessionMeta 带 links（web 按 machine.info.extensions 有无判断，不按版本号）
// - 0.17.0 起扩展贡献点 newSession（新建会话「从任务开始」）、时间线记录卡（ext.record 广播、
//   ext.records.request；web 按 machine.info.extensions.records 判断）
// - 0.18.0 起支持自重启：machine.agent.restart.request、MachineInfo 带 restart（运行版本 /
//   工作区版本 / 进行中的重启；web 按 machine.info.restart 有无判断）；`restart` / `selfcheck`
//   子命令；会话子进程带 TRINE_HOME / TRINE_SESSION_ID
// - 0.19.0 起 MachineInfo 带 claudeLatest（发布源上的 claude 最新版本，启动后与每 6 小时自动查），
//   支持 machine.claude.check.request 立即检查（web 按 machine.info.claudeLatest 有无判断）
// - 0.20.0 起支持文件查看：fs.list.request / fs.read.request（会话 cwd + TRINE_FILES_ALLOW 范围内只读），
//   MachineInfo 带 files（web 按有无判断）；tool.start / history tool 条目带 filePath
// - 0.21.0 起 MachineInfo 带 engines（机器上的引擎与能力，web 按有无判断）；session.create /
//   session.setPermissionMode 可带 engine / engineMode，SessionMeta 可带 engine / engineMode
// - 0.22.0 起引擎能力多了 effort / update，Codex 支持回退对话、推理强度（session.create 的 effort、
//   session.setEffort，SessionMeta 带 effort）、压缩和 skills（session.commands.response）；
//   支持 machine.engine.update.request / machine.engine.check.request
// - 0.23.0 起引擎由 Homebrew、apt 安装时更新和版本检查走包管理器；MachineInfo.claudeLatest、
//   EngineSummary 带 install（实际的更新命令）
// - 0.24.0 起支持信任目录（files.trust.add / remove，`~/.trine/files.json`）：MachineInfo.files 带
//   roots / home（web 按 roots 有无判断）；fs.* 的 denied 带 reason；/proc /sys /dev 一律拒绝
// - 0.25.0 起 tool.start / history tool 条目带 argDetail（长命令原文）；MachineInfo.rateLimits 带
//   models（按模型计的周限额，如 Fable）。都是可选字段，web 按有无判断
// - 0.26.0 起置顶工作区可调顺序（cwd.json pinOrder、cwd.pin.move，MachineInfo.cwd.pinOrder 能力位）；
//   tool.start / tool.end / history tool 条目带 subagent（子 agent 类型、前后台、状态），permission.request
//   可带 subagentId，Codex 子 agent 的审批路由到父会话；扩展特性协商（ext.read / ext.action.prepare 的
//   features、client，MachineInfo.extensions.features）与本地效果 files.open。web 都按字段 / 能力位判断
// - 0.27.0 起支持新建会话前检查 / 创建工作目录（cwd.prepare.request，MachineInfo.cwd.create 能力位）
// - 0.28.0 起支持重启引擎的后台进程（machine.engine.restart.request，EngineCapabilities.restart；
//   Codex：换掉 trine 的 app-server、常驻 daemon 在跑时一并重启，换账号后重新读登录）
export const AGENT_VERSION = '0.28.0';

export function buildMachineInfo(input: {
  name: string;
  claudeVersion: string;
  activeSessionCount: number;
  maxSessions: number;
  rateLimits?: RateLimits | undefined;
  extensions?: MachineExtensionsSummary | undefined;
  restart?: MachineRestartInfo | undefined;
  claudeLatest?: MachineClaudeLatest | undefined;
  files?: MachineFilesInfo | undefined;
  engines?: EngineSummary[] | undefined;
}): MachineInfo {
  return {
    name: input.name,
    platform: process.platform,
    osVersion: release(),
    agentVersion: AGENT_VERSION,
    claudeVersion: input.claudeVersion,
    activeSessionCount: input.activeSessionCount,
    maxSessions: input.maxSessions,
    ...(input.rateLimits === undefined ? {} : { rateLimits: input.rateLimits }),
    ...(input.extensions === undefined ? {} : { extensions: input.extensions }),
    ...(input.restart === undefined ? {} : { restart: input.restart }),
    ...(input.claudeLatest === undefined ? {} : { claudeLatest: input.claudeLatest }),
    ...(input.files === undefined ? {} : { files: input.files }),
    ...(input.engines === undefined ? {} : { engines: input.engines }),
    // 置顶工作区的手动顺序（cwd.pin.move、cwd 快照带 pinOrder）；web 按这一位判断，不按版本号
    // create：认识 cwd.prepare.request（新建会话前检查 / 创建工作目录）
    cwd: { pinOrder: true, create: true },
  };
}
