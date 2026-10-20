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
import { toast } from 'sonner';
import { useClient, useTrine } from '@/app/runtime.ts';
import { copyText } from '@/lib/clipboard.ts';
import { buildCopyCwd, buildSessionActions, supportedMachinesKey, supportsPin } from './session-actions.ts';
import type { SessionRowActions } from './SessionRowMenu.tsx';

export function useSessionActions(machineId?: string): SessionRowActions {
  const client = useClient();
  // 标量 selector：机器的 online / lastSeenAt 翻转不会让回调换引用
  const supportedKey = useTrine((s) => supportedMachinesKey(s.machines));
  const pinKey = useTrine((s) => supportedMachinesKey(s.machines, supportsPin));
  return useMemo(
    () => ({
      ...buildSessionActions({
        client,
        supportedMachineIds: new Set(supportedKey === '' ? [] : supportedKey.split(',')),
        pinMachineIds: new Set(pinKey === '' ? [] : pinKey.split(',')),
        onlyMachine: machineId,
        notify: toast,
      }),
      // 复制不经 agent：与能力探测无关，总是给
      onCopyCwd: buildCopyCwd(copyText, toast),
    }),
    [client, supportedKey, pinKey, machineId],
  );
}
