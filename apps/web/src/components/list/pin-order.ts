/**
 * 置顶工作区的手动顺序（plan §1）在 web 侧的纯函数：从机器的 cwd 快照得到「有效顺序」、
 * 把菜单动作（上移 / 下移 / 移到本机最前）翻译成 `cwd.pin.move` 的 before、判断能不能重排。
 *
 * 有效顺序用**规范化 cwd**（去尾 `/`）表示，与分组 key 一致；agent 按字面或去尾 `/` 都能匹配。
 */
import { normalizePinOrder, type MachineInfo } from '@trine/core';
import { normalizeCwd } from './filtering.ts';

/** cwd 快照 → 规范化 cwd 的置顶顺序（没有 pinOrder = 置顶时间倒序；去重） */
export function effectivePinOrder(cwd: { pinned?: Record<string, number>; pinOrder?: string[] } | null | undefined): string[] {
  if (cwd?.pinned === undefined) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of normalizePinOrder(cwd.pinOrder, cwd.pinned)) {
    const p = normalizeCwd(raw);
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export type PinMoveAction = 'up' | 'down' | 'top';

/**
 * 菜单动作 → `cwd.pin.move` 的 before。`undefined` = 已经在那个位置（不用发）。
 * 下移到最后一位时 before 为 null（移到末尾）。
 */
export function pinMoveTarget(order: readonly string[], cwd: string, action: PinMoveAction): string | null | undefined {
  const idx = order.indexOf(cwd);
  if (idx < 0) return undefined;
  switch (action) {
    case 'up':
      return idx === 0 ? undefined : order[idx - 1];
    case 'top':
      return idx === 0 ? undefined : order[0];
    case 'down':
      if (idx === order.length - 1) return undefined;
      return order[idx + 2] ?? null;
  }
}

/** 拖放：把 cwd 放到 overCwd 的位置（dnd-kit sortable 语义：往下拖落在它之后，往上拖落在它之前） */
export function pinDropTarget(order: readonly string[], cwd: string, overCwd: string): string | null | undefined {
  const from = order.indexOf(cwd);
  const to = order.indexOf(overCwd);
  if (from < 0 || to < 0 || from === to) return undefined;
  if (to < from) return overCwd;
  return order[to + 1] ?? null;
}

/** agent 认识 cwd.pin.move（能力位，不看版本号） */
export function supportsPinOrder(info: MachineInfo | null | undefined): boolean {
  return info?.cwd?.pinOrder === true;
}
