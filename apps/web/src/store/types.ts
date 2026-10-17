/**
 * zustand store 的公开契约（阶段 1.5 评审冻结；阶段 2 两路 UI 并行依赖）。
 *
 * store 是 `TrineClient`（lib/client.ts）状态的**镜像**：所有协议层字段都由
 * client 的事件写入，UI 不直接改它们；store 自己只拥有纯 UI 态（草稿、已关闭
 * 的横幅）。每个字段的注释写明它来自哪个事件/帧。
 *
 * key 约定：`timelineKey(machineId, sessionId)` = `${machineId}/${sessionId}`。
 */
import type { SessionMeta } from '@trine/core';
import type { ClientNotice } from '../lib/client.ts';
import type { ConnectionSnapshot } from '../lib/connection.ts';
import type { LeaderSnapshot } from '../lib/leader.ts';
import type { Capabilities, MachineState, Timeline } from '../lib/reducer.ts';
import type { Prefs } from '../lib/storage.ts';

export type { ConnectionSnapshot, ConnectionStatus } from '../lib/connection.ts';
export type { LeaderSnapshot, LeaderState } from '../lib/leader.ts';
export type {
  AssistantEntry,
  Capabilities,
  HeartbeatSnapshot,
  LocalStatus,
  MachineState,
  PermissionEntry,
  Timeline,
  TimelineEntry,
  ToolEntry,
  UserEntry,
} from '../lib/reducer.ts';
export type { PeerState, Prefs } from '../lib/storage.ts';
export type { ClientNotice } from '../lib/client.ts';
export type { PairingPhase, PairingSnapshot } from '../lib/pairing.ts';
export { timelineKey } from '../lib/storage.ts';

// ---------------------------------------------------------------------------
// 切片
// ---------------------------------------------------------------------------

export interface ConnectionSlice {
  /**
   * 连接状态机快照。来源：Connection.onStatus（lib/connection.ts）。
   * `status: 'needs_upgrade'` = 服务端 4006，UI 提示升级且不再重连；
   * `nextRetryAt` 用于断连细条的倒计时。
   */
  connection: ConnectionSnapshot;
  /** 待发队列长度（连接不在时积压的 c2a 帧）。来源：client 'queue' 事件（每次入队/冲刷/丢弃后触发） */
  queuedCount: number;
}

export interface LeaderSlice {
  /**
   * 单主标签选举结果。来源：LeaderElector.onChange（lib/leader.ts）。
   * `state: 'follower'` 时本页不持有连接，UI 显示「已在另一标签页运行 / 在此接管」。
   */
  leader: LeaderSnapshot;
}

export interface MachinesSlice {
  /**
   * machineId → 机器状态。来源：
   * - `online / lastSeenAt`：transport `machine.status`（连接建立与 sync 后服务端推）；
   * - `info / name`：E2E `machine.info`；
   * - `parkedCount`：transport `parked.count`；
   * - `cwd`：E2E `cwd.list.response / cwd.updated`；
   * - `lastError`：机器级 `error.fatal`（无 sessionId）。
   * 只含已配对机器（PeerState.machines）。
   */
  machines: Record<string, MachineState>;
  /** 是否至少配对了一台机器。来源：client 'peer' 事件 */
  paired: boolean;
  /** 当前服务端（MVP 单服务端）。来源：PeerState.serverUrl */
  serverUrl: string | null;
}

export interface SessionsSlice {
  /**
   * machineId → sessionId → SessionMeta。来源：`session.list.response`（全量覆盖）、
   * `session.created / session.updated / session.create.response`（按 sessionId 合并）、
   * `run.state`（更新 state 与 lastActivityAt）。刷新后为空，由列表页发 session.list.request 重建。
   */
  sessions: Record<string, Record<string, SessionMeta>>;
  /** timelineKey → 会话能力。来源：`session.capabilities` */
  capabilities: Record<string, Capabilities>;
}

export interface TimelinesSlice {
  /**
   * 同步/回填进行中的 scope：key = 会话 `timelineKey` / 机器级 `machineId`，值为模式。
   * 来源：client 'sync' 事件（发出 sync.request 时置，收到该 scope 的 sync.done 或断连时清）。
   * UI 据此显示「正在同步历史…」占位。
   */
  syncing: Record<string, 'normal' | 'backfill'>;
  /**
   * timelineKey → 时间线。来源：reducer.applyEvent 对全部会话级 a2c 事件的折叠 +
   * 本地条目操作（sendInput / input.parked / park.expired / 本地过期）。
   * `entries` 不可变更新，可直接做 React 依赖。
   */
  timelines: Record<string, Timeline>;
}

export interface DraftsSlice {
  /** timelineKey → 输入框草稿。纯 UI 态，不落盘（阶段 2 可改为落盘） */
  drafts: Record<string, string>;
  setDraft: (key: string, text: string) => void;
}

export interface PrefsSlice {
  /** 偏好（主题 / prompt 片段 / knownModels）。来源：client 'prefs' 事件；knownModels 随 session.capabilities 并集 */
  prefs: Prefs;
}

/** 需要用户看见/处理的横幅（cursor 倒退、scope fatal、自愈放弃、机器级错误） */
export interface Notice {
  /** `${kind}:${machineId}:${scope}` 去重键 */
  id: string;
  notice: Exclude<ClientNotice, { kind: 'dropped' }>;
  at: number;
}

export interface NoticesSlice {
  /** 来源：client 'notice' 事件（不含 dropped——那只计数） */
  notices: Notice[];
  /** 被丢弃的入站帧计数（调试用，不告警） */
  droppedCount: number;
  dismissNotice: (id: string) => void;
}

export interface IdentitySlice {
  /**
   * 本设备 id（`web-<uuid>`）。来源：TrineClient.deviceId（identity 只生成一次）。
   * 权限卡「已允许（本设备）」与 `PermissionEntry.resolvedBy` 比对用。
   * 私钥不进 store，UI 也拿不到（client 只暴露 deviceId 与公钥）。
   */
  deviceId: string | null;
}

export type TrineState = IdentitySlice &
  ConnectionSlice &
  LeaderSlice &
  MachinesSlice &
  SessionsSlice &
  TimelinesSlice &
  DraftsSlice &
  PrefsSlice &
  NoticesSlice;
