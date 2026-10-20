/**
 * 机器资源数据（machine-stats）的纯逻辑：能力探测、文案与色调、订阅协调。
 *
 * ## 订阅协调（`StatsWatchCoordinator`）
 *
 * agent 按设备记一份租约（core `machine.stats.request`），所以同一台机器在本设备上
 * 只该有一份订阅：列表顶部、机器卡、机器详情各自 `register(machineId, intervalMs)`，
 * 协调器取所有登记里最短的间隔发 watch，到期前（ttl 的一半）续租；间隔变了立即重发，
 * 没人要了（或页面隐藏）就发 `ttlMs: 0` 退订。机器离线 / agent 版本过旧时不发——
 * 离线时发的请求会被 relay 排队，等上线后一股脑送到。机器重新上线时重新订阅（agent
 * 可能重启过，租约已丢）。零 React，单测覆盖。
 */
import type { MachineInfo, MachineStats } from '@trine/core';
import { agentAtLeast } from '@/components/list/session-actions.ts';
import { formatBytes } from '@/lib/format.ts';

/** 首个支持 machine.stats.request 的 agent 版本 */
export const MACHINE_STATS_MIN_AGENT = '0.14.0';
/** 机器详情页打开时的刷新间隔 */
export const DETAIL_STATS_INTERVAL_MS = 5_000;

export function supportsMachineStats(info: Pick<MachineInfo, 'agentVersion'> | null | undefined): boolean {
  return agentAtLeast(info, MACHINE_STATS_MIN_AGENT);
}

/** 租约时长：至少 2 分钟，且不短于 3 个间隔（漏一两次推送也不断） */
export function leaseTtlMs(intervalMs: number): number {
  return Math.min(30 * 60_000, Math.max(120_000, intervalMs * 3));
}

export type StatsTone = 'normal' | 'warn' | 'danger';

/** ≥ 80% 提醒，≥ 90% 告警 */
export function percentTone(percent: number): StatsTone {
  if (percent >= 90) return 'danger';
  if (percent >= 80) return 'warn';
  return 'normal';
}

export function ratio(used: number, total: number): number {
  return total <= 0 ? 0 : Math.min(100, Math.max(0, (used / total) * 100));
}

export function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

/** 网速：`1.2 MB/s`；不到 1 KB/s 显示 `0 KB/s`，免得一直跳 B/s */
export function formatRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return '0 KB/s';
  return `${formatBytes(bytesPerSec)}/s`;
}

/** 运行时长：`3天4小时`、`5小时12分`、`8分` */
export function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3_600);
  const m = Math.floor((sec % 3_600) / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分`;
}

/** 内存：`4.1/7.7 GB`（单位按总量取，两侧同单位） */
export function formatMemoryPair(used: number, total: number): string {
  const gb = 1024 ** 3;
  if (total >= gb) return `${(used / gb).toFixed(1)}/${(total / gb).toFixed(1)} GB`;
  const mb = 1024 ** 2;
  return `${Math.round(used / mb)}/${Math.round(total / mb)} MB`;
}

/** 最满的那块盘（列表顶部只看它） */
export function fullestDisk(stats: MachineStats): { label: string; percent: number } | undefined {
  let best: { label: string; percent: number } | undefined;
  for (const d of stats.disks ?? []) {
    const percent = ratio(d.usedBytes, d.usedBytes + d.availBytes);
    if (best === undefined || percent > best.percent) best = { label: d.label, percent };
  }
  return best;
}

/**
 * 快照是否过时：机器离线，或比 3 个刷新间隔（至少 2 分钟）还旧。过时的照常显示，但调暗并注明时间。
 * `intervalMs` 为 null（只手动刷新）时只看离线。
 */
export function isStatsStale(stats: MachineStats, now: number, online: boolean | null, intervalMs: number | null): boolean {
  if (online === false) return true;
  if (intervalMs === null) return false;
  return now - stats.at > Math.max(120_000, intervalMs * 3);
}

/** 趋势线的 SVG polyline 点：x 均分，y 按 0–100 映射到 [height, 0] */
export function sparklinePoints(values: readonly number[], width: number, height: number): string {
  if (values.length === 0) return '';
  if (values.length === 1) return `0,${y(values[0]!, height)} ${width},${y(values[0]!, height)}`;
  const step = width / (values.length - 1);
  return values.map((v, i) => `${round(i * step)},${y(v, height)}`).join(' ');
}

function y(v: number, height: number): number {
  return round(height - (Math.min(100, Math.max(0, v)) / 100) * height);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// 订阅协调
// ---------------------------------------------------------------------------

export interface StatsWatchDeps {
  /** 发 machine.stats.request；失败吞掉（下次续租再试） */
  send: (machineId: string, watch: { intervalMs: number; ttlMs: number }) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

interface ActiveWatch {
  intervalMs: number;
  timer: unknown;
}

export class StatsWatchCoordinator {
  readonly #deps: StatsWatchDeps;
  /** machineId → 登记 token → 间隔 */
  readonly #consumers = new Map<string, Map<number, number>>();
  readonly #active = new Map<string, ActiveWatch>();
  /** 在线且 agent 支持的机器 */
  #eligible: ReadonlySet<string> = new Set();
  #visible = true;
  #nextToken = 1;

  constructor(deps: StatsWatchDeps) {
    this.#deps = deps;
  }

  /** 登记一份需求；返回注销函数 */
  register(machineId: string, intervalMs: number): () => void {
    const token = this.#nextToken++;
    let map = this.#consumers.get(machineId);
    if (map === undefined) {
      map = new Map();
      this.#consumers.set(machineId, map);
    }
    map.set(token, intervalMs);
    this.#evaluate(machineId);
    return () => {
      const current = this.#consumers.get(machineId);
      if (current === undefined || !current.delete(token)) return;
      if (current.size === 0) this.#consumers.delete(machineId);
      this.#evaluate(machineId);
    };
  }

  setVisible(visible: boolean): void {
    if (this.#visible === visible) return;
    this.#visible = visible;
    for (const id of this.#allIds()) this.#evaluate(id);
  }

  setEligible(ids: ReadonlySet<string>): void {
    const before = this.#eligible;
    if (before.size === ids.size && [...ids].every((id) => before.has(id))) return;
    this.#eligible = ids;
    for (const id of before) {
      // 离线 / 不再支持：租约随它去（发不出去，也不该排队），重新上线后重订
      if (!ids.has(id)) this.#drop(id);
    }
    for (const id of this.#allIds()) this.#evaluate(id);
  }

  /** 当前订阅的间隔（测试用） */
  activeInterval(machineId: string): number | undefined {
    return this.#active.get(machineId)?.intervalMs;
  }

  dispose(): void {
    for (const id of [...this.#active.keys()]) this.#drop(id);
  }

  #allIds(): Set<string> {
    return new Set([...this.#consumers.keys(), ...this.#active.keys()]);
  }

  #desired(machineId: string): number | null {
    if (!this.#visible || !this.#eligible.has(machineId)) return null;
    const map = this.#consumers.get(machineId);
    if (map === undefined || map.size === 0) return null;
    return Math.min(...map.values());
  }

  #evaluate(machineId: string): void {
    const desired = this.#desired(machineId);
    const active = this.#active.get(machineId);
    if (desired === null) {
      if (active === undefined) return;
      this.#drop(machineId);
      if (this.#eligible.has(machineId)) this.#deps.send(machineId, { intervalMs: active.intervalMs, ttlMs: 0 });
      return;
    }
    if (active?.intervalMs === desired) return;
    if (active !== undefined) this.#deps.clearTimer(active.timer);
    this.#subscribe(machineId, desired);
  }

  #subscribe(machineId: string, intervalMs: number): void {
    const ttlMs = leaseTtlMs(intervalMs);
    this.#deps.send(machineId, { intervalMs, ttlMs });
    const watch: ActiveWatch = { intervalMs, timer: undefined };
    watch.timer = this.#deps.setTimer(() => {
      if (this.#active.get(machineId) === watch) this.#subscribe(machineId, intervalMs);
    }, ttlMs / 2);
    this.#active.set(machineId, watch);
  }

  #drop(machineId: string): void {
    const active = this.#active.get(machineId);
    if (active === undefined) return;
    this.#deps.clearTimer(active.timer);
    this.#active.delete(machineId);
  }
}
