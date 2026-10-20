/**
 * 机器资源数据的订阅 hook：把各处的需求交给模块级的 `StatsWatchCoordinator`（规则见
 * stats-model.ts），本文件只做 React / 浏览器胶水——client 引用、页面可见性、
 * 「哪些机器在线且支持」。
 */
import { useEffect } from 'react';
import type { TrineClient } from '@/lib/client.ts';
import { useClient, useTrine } from '@/app/runtime.ts';
import { StatsWatchCoordinator, supportsMachineStats } from './stats-model.ts';

let coordinator: { client: TrineClient; instance: StatsWatchCoordinator } | null = null;
let visibilityBound = false;

function coordinatorFor(client: TrineClient): StatsWatchCoordinator {
  if (coordinator?.client === client) return coordinator.instance;
  coordinator?.instance.dispose();
  const instance = new StatsWatchCoordinator({
    send: (machineId, watch) => void client.requestMachineStats(machineId, watch).catch(() => undefined),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  coordinator = { client, instance };
  if (!visibilityBound && typeof document !== 'undefined') {
    visibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      coordinator?.instance.setVisible(document.visibilityState === 'visible');
    });
  }
  if (typeof document !== 'undefined') instance.setVisible(document.visibilityState === 'visible');
  return instance;
}

/** 在线且 agent 支持资源数据的机器 id（排序后逗号拼接，给 selector 用的稳定标量） */
function useEligibleKey(): string {
  return useTrine((s) =>
    Object.values(s.machines)
      .filter((m) => m.online === true && supportsMachineStats(m.info))
      .map((m) => m.machineId)
      .sort()
      .join(','),
  );
}

/**
 * 在挂载期间订阅这些机器的资源数据（`intervalMs` 为 null = 不自动刷新）。数据落在
 * `machines[id].stats`，由调用方自己 select。
 */
export function useMachineStatsWatch(machineIds: readonly string[], intervalMs: number | null): void {
  const client = useClient();
  const eligibleKey = useEligibleKey();
  const idsKey = [...machineIds].sort().join(',');

  useEffect(() => {
    if (client === null) return;
    coordinatorFor(client).setEligible(new Set(eligibleKey === '' ? [] : eligibleKey.split(',')));
  }, [client, eligibleKey]);

  useEffect(() => {
    if (client === null || intervalMs === null || idsKey === '') return;
    const c = coordinatorFor(client);
    const offs = idsKey.split(',').map((id) => c.register(id, intervalMs));
    return () => {
      for (const off of offs) off();
    };
  }, [client, idsKey, intervalMs]);
}

/** 列表顶部 / 机器卡用的间隔（prefs；0 = 关闭 → null） */
export function useListStatsInterval(): number | null {
  const ms = useTrine((s) => s.prefs.machineStatsIntervalMs);
  return ms === 0 ? null : ms;
}
