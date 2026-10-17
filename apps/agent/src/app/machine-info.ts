/**
 * 组 `MachineInfo`（协议 §3，E2E 密文内的机器信息）。
 *
 * claude 版本在启动时探测一次（claude-cli.ts `detectClaudeVersion`，探测的是会话
 * 实际使用的那个可执行文件，尽力而为，拿不到给 'unknown'），远程 `claude update`
 * 跑完后再探测一次：它只用于展示，探测失败不该影响启动；每次广播都去 spawn 一遍也没必要。
 */
import { release } from 'node:os';
import type { MachineInfo } from '@trine/core';

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
export const AGENT_VERSION = '0.8.0';

export function buildMachineInfo(input: {
  name: string;
  claudeVersion: string;
  activeSessionCount: number;
}): MachineInfo {
  return {
    name: input.name,
    platform: process.platform,
    osVersion: release(),
    agentVersion: AGENT_VERSION,
    claudeVersion: input.claudeVersion,
    activeSessionCount: input.activeSessionCount,
  };
}
