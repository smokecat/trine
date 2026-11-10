/**
 * 会话级 rename / archive / delete / 复制工作目录动作的**唯一接线点**（session-list-v2 §4.1 / §4.4 / §4.6）。
 *
 * 列表页、PC 侧栏、归档视图、机器详情把它的返回值原样传给
 * `<SessionList actions>`；聊天页的 `/rename` 与头部菜单传 `machineId` 只看那一台。
 * 约定：**某个动作当前不可用（从标签页 / agent 版本过旧）就不给那个回调**，
 * 界面据此隐藏对应菜单项与斜杠命令，而不是给一个点了才报错的入口。
 *
 * 逻辑（能力探测、toast、错误文案）在 `session-actions.ts`，这里只做订阅与 memo。
 */
import { useMemo } from 'react';
import type { MachineInfo } from '@trine/core';
import { toast } from 'sonner';
import { useClient, useTrine } from '@/app/runtime.ts';
import { openLinkPicker, openWorkspacePanel } from '@/components/ext/use-ext.ts';
import { copyText } from '@/lib/clipboard.ts';
import { buildCopyCwd, buildSessionActions, supportedMachinesKey, supportsPin } from './session-actions.ts';
import type { SessionRowActions } from './SessionRowMenu.tsx';
import { supportsPinOrder } from './pin-order.ts';

export function useSessionActions(machineId?: string): SessionRowActions {
  const client = useClient();
  // 标量 selector：机器的 online / lastSeenAt 翻转不会让回调换引用
  const supportedKey = useTrine((s) => supportedMachinesKey(s.machines));
  const pinKey = useTrine((s) => supportedMachinesKey(s.machines, supportsPin));
  const pinOrderKey = useTrine((s) =>
    Object.keys(s.machines)
      .filter((id) => supportsPinOrder(s.machines[id]?.info))
      .sort()
      .join(','),
  );
  // 重排要与中继连着（不进离线队列），且这台机器没有在途的移动
  const relayOpen = useTrine((s) => s.connection.status === 'open');
  const pinMovingKey = useTrine((s) =>
    Object.keys(s.machines)
      .filter((id) => s.machines[id]?.pinMoving === true)
      .sort()
      .join(','),
  );
  // 有扩展的机器才给「关联…」（具体哪个扩展提供关联，选择器里再看）
  const linkKey = useTrine((s) =>
    Object.keys(s.machines)
      .filter((id) => (s.machines[id]?.info?.extensions?.count ?? 0) > 0)
      .sort()
      .join(','),
  );
  // 只取引擎的 id 与能力：限额变化不该让回调换引用
  const enginesKey = useTrine((s) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(s.machines).map(([id, m]) => [
          id,
          m.info?.engines?.map((e) => ({ id: e.id, displayName: e.displayName, available: e.available, capabilities: e.capabilities })),
        ]),
      ),
    ),
  );
  return useMemo(
    () => ({
      ...buildSessionActions({
        client,
        supportedMachineIds: new Set(supportedKey === '' ? [] : supportedKey.split(',')),
        pinMachineIds: new Set(pinKey === '' ? [] : pinKey.split(',')),
        onlyMachine: machineId,
        machineInfo: (target) => {
          const engines = (JSON.parse(enginesKey) as Record<string, MachineInfo['engines']>)[target];
          return engines === undefined ? undefined : { engines };
        },
        notify: toast,
      }),
      // 复制不经 agent：与能力探测无关，总是给
      onCopyCwd: buildCopyCwd(copyText, toast),
      onLink: (target: string, sessionIds: string[]) => openLinkPicker({ machineId: target, sessionIds }),
      onOpenWorkspace: (target: string, cwd: string) => openWorkspacePanel({ machineId: target, cwd }),
      supportsLinks: (target: string) => linkKey.split(',').includes(target),
      ...(client === null || pinOrderKey === ''
        ? {}
        : {
            supportsPinOrder: (target: string) => pinOrderKey.split(',').includes(target),
            pinMoveBlocked: (target: string) =>
              !relayOpen
                ? '与中继的连接已断开，暂不能调整顺序'
                : pinMovingKey.split(',').includes(target)
                  ? '正在调整顺序…'
                  : null,
            onMovePinnedWorkspace: (target: string, cwd: string, before: string | null) =>
              client.movePinnedWorkspace(target, cwd, before).catch((err: unknown) => {
                toast.error('调整置顶顺序失败', { description: err instanceof Error ? err.message : String(err) });
                throw err;
              }),
          }),
    }),
    [client, supportedKey, pinKey, pinOrderKey, relayOpen, pinMovingKey, linkKey, enginesKey, machineId],
  );
}
