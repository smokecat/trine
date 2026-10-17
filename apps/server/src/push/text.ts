/**
 * 推送文案渲染：机器标识 + 事件类型 → 固定中文文案。
 *
 * 这是脱敏的**唯一出口**——渠道拿到的 `PushMessage` 只可能由本文件产出，
 * 而本文件的输入只有 machineId 与 PushHint 两样东西。想往推送里塞正文，
 * 得先改这里的函数签名，改动会足够显眼。
 */
import type { PushHint } from '@trine/core/types';
import type { PushEvent, PushMessage } from './types.ts';

/** 事件类型 → 固定文案。穷举 PushHint，新增事件类型时这里会编译报错 */
const HINT_TEXT: Record<PushHint, string> = {
  permission_pending: '等待权限确认',
  question_pending: 'Claude 在提问',
  plan_pending: '等待批准计划',
  run_done: '任务完成',
  run_error: '任务出错',
};

/** machineId 短前缀长度：够区分个位数台机器，又不泄露完整标识 */
export const MACHINE_LABEL_LENGTH = 8;

/**
 * 机器标识的显示名。
 *
 * 默认取 machineId 的短前缀——machineId 是服务端路由字段，本就在明文里，
 * 截断只是为了文案短。用户可在服务端配置明文别名（`TRINE_PUSH_ALIAS`），
 * 那是**用户知情的主动选择**，不改变零知识默认值。
 */
export function machineLabel(
  machineId: string,
  aliases: Readonly<Record<string, string>> = {},
): string {
  const alias = aliases[machineId];
  if (alias) return alias;
  return machineId.slice(0, MACHINE_LABEL_LENGTH);
}

/**
 * 渲染最终推送内容。
 *
 * 标题 = 机器标识，正文 = 事件类型固定文案。两者都不含任何 E2E 内容。
 */
export function renderPushMessage(
  event: PushEvent,
  aliases: Readonly<Record<string, string>> = {},
): PushMessage {
  const label = machineLabel(event.machineId, aliases);
  return {
    title: label,
    body: HINT_TEXT[event.hint],
    // 分组用机器标识：同一台机器的通知在 Bark 里折叠成一组
    group: label,
  };
}

/**
 * 解析别名映射配置。
 *
 * 格式：`machineId=别名` 逗号分隔，例如 `abc123def=mbp,ff00aa11=vps`。
 * 选逗号分隔而非 JSON，是因为它写在 systemd EnvironmentFile 里更省心
 * （不用跟引号和转义较劲）。非法条目静默跳过——一个写错的别名不该让
 * 服务端拒绝启动，退化成短前缀即可。
 */
export function parseAliases(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!raw) return map;
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key && value) map[key] = value;
  }
  return map;
}
