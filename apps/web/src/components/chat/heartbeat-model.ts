/**
 * 心跳 footer 的数值模型：把 2-5s 一发的 `run.heartbeat` 快照 + 本地 1s tick
 * 平滑成逐秒走动的计时器。
 *
 * ## 为什么要平滑
 *
 * agent 的心跳帧间隔是 2-5s，直接渲染快照里的 `runElapsedMs` 会看到秒数
 * 一跳三四秒——「长任务不焦虑」这个功能的全部价值就在于那个**在走**的秒数。
 * 做法：每个计时量 = 快照值 + (本地现在 − 快照到达时的本地时间)，收到新帧
 * 就重新对齐（快照是权威，本地累加只负责两帧之间的插值）。
 *
 * 注意用的是**快照到达时的本地时钟**而不是 `snapshot.at`（agent 的 ts）：
 * 两端时钟可以差出几十秒甚至几分钟，用 agent 的 ts 减本地 now 会让计时器
 * 直接飞掉或倒走。
 *
 * ## 静默阈值（方案 §0 行 j）
 *
 * 工具结束后 agent 侧静默可达 ~40s 属常态，所以 <60s 一律中性色，
 * ≥60s 才转 amber——否则这行字会长期报警，用户很快就不看它了。
 */
import type { WaitingFor } from '@trine/core';
import type { HeartbeatSnapshot } from '@/lib/reducer.ts';
import { waitingLabel } from '@/lib/waiting.ts';

/** 无输出多久才值得提醒（方案 §0 行 j） */
export const SILENT_WARN_MS = 60_000;

export interface HeartbeatView {
  runElapsedMs: number;
  currentTool: { name: string; elapsedMs: number } | null;
  silentMs: number;
  /** 静默是否已到提醒阈值 */
  silentWarn: boolean;
  /** 有 pending 权限时的本地等待时长；null = 无待批准 */
  waitingMs: number | null;
  /** 等待的文案（等待批准 / 等待回答 / 等待批准计划），按最早一条 pending 的工具区分 */
  waitingLabel: string;
  phase: HeartbeatSnapshot['phase'];
}

/**
 * @param snapshot     store 里的心跳快照
 * @param receivedAt   该快照到达时的**本地**时间戳
 * @param now          当前本地时间戳
 * @param pendingSince 最早一条 pending 权限的 requestedAt（本地按它计时）；无则 null
 * @param waitingFor   同一条 pending 在等什么（lib/waiting.ts）；缺省按普通权限
 */
export function heartbeatView(
  snapshot: HeartbeatSnapshot,
  receivedAt: number,
  now: number,
  pendingSince: number | null,
  waitingFor?: WaitingFor,
): HeartbeatView {
  // 时钟回拨或快照刚到都可能得到负数，夹到 0
  const drift = Math.max(0, now - receivedAt);
  const silentMs = snapshot.silentMs + drift;
  return {
    runElapsedMs: snapshot.runElapsedMs + drift,
    currentTool:
      snapshot.currentTool === undefined
        ? null
        : { name: snapshot.currentTool.name, elapsedMs: snapshot.currentTool.elapsedMs + drift },
    silentMs,
    silentWarn: silentMs >= SILENT_WARN_MS,
    // 等待批准用 requestedAt（本地已知的绝对时刻），不需要心跳帧参与
    waitingMs: pendingSince === null ? null : Math.max(0, now - pendingSince),
    waitingLabel: waitingLabel(waitingFor),
    phase: snapshot.phase,
  };
}
