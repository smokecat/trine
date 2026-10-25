/**
 * 组 `MachineInfo`（协议 §3，E2E 密文内的机器信息）。
 *
 * claude 版本在启动时探测一次（claude-cli.ts `detectClaudeVersion`，探测的是会话
 * 实际使用的那个可执行文件，尽力而为，拿不到给 'unknown'），远程 `claude update`
 * 跑完后再探测一次：它只用于展示，探测失败不该影响启动；每次广播都去 spawn 一遍也没必要。
 */
import { release } from 'node:os';
import type {
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
export const AGENT_VERSION = '0.20.0';

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
  };
}
