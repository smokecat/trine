/**
 * 机器卡的文案口径（原型 `.mach .meta` / `.warnline`）。纯函数，`bun test` 覆盖。
 *
 * 三条判断值得钉住：
 * - **在线用「心跳 Ns 前」、离线用「离线 · 最后在线 …」**：同一个 lastSeenAt
 *   在两种状态下是完全不同的信息（前者是「活着」的证据，后者是「死了多久」）。
 * - **`online === null` 是「状态未知」而不是离线**：连接刚建立还没收到
 *   `machine.status` 时把机器显示成离线，会让用户以为 agent 挂了。
 * - **版本缺失显示「未知」**：新配对设备在 agent 补发 machine.info 之前
 *   `info` 为 null（评审 B5），此时空着比写「未知」更像 UI 坏了。
 */
import { formatRelativeTime } from '@/lib/format.ts';

export type MachineOnline = boolean | null;

/** 状态点的色调 */
export function machineTone(online: MachineOnline): 'on' | 'off' {
  return online === true ? 'on' : 'off';
}

/** 在线/离线/未知的主状态词 */
export function machineStatusLabel(online: MachineOnline): string {
  if (online === true) return '在线';
  if (online === false) return '离线';
  return '状态未知';
}

/**
 * 状态 + 心跳的完整一行：
 *   在线 → 「在线 · 心跳 3 分钟前」（lastSeenAt 缺失时只有「在线」）
 *   离线 → 「离线 · 最后在线 2 小时前」
 *   未知 → 「状态未知」
 */
export function machineHeartbeatLine(
  online: MachineOnline,
  lastSeenAt: number | null,
  now?: number,
): string {
  const label = machineStatusLabel(online);
  if (lastSeenAt === null || online === null) return label;
  const rel = formatRelativeTime(lastSeenAt, now);
  return online ? `${label} · 心跳 ${rel}` : `${label} · 最后在线 ${rel}`;
}

/** 版本行：缺 machine.info 时给「未知」而不是空白 */
export function machineVersionLine(
  info: { agentVersion: string; claudeVersion: string } | null,
): string {
  const agent = info?.agentVersion.trim() ?? '';
  const claude = info?.claudeVersion.trim() ?? '';
  return `agent ${agent === '' ? '未知' : agent} · claude ${claude === '' ? '未知' : claude}`;
}

/** 平台行：「macOS 15.6」；缺 info 时为空串（调用方不渲染） */
export function machinePlatformLine(info: { platform: string; osVersion: string } | null): string {
  if (info === null) return '';
  const parts = [info.platform, info.osVersion].map((p) => p.trim()).filter((p) => p !== '');
  return parts.join(' ');
}

/** 排队告警行（原型 `.warnline`）；0 条时为空串 */
export function parkedWarnLine(parkedCount: number): string {
  return parkedCount > 0 ? `${parkedCount} 条消息排队中，上线后自动发送` : '';
}
