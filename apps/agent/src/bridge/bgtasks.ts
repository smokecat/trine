/**
 * 每会话的后台任务表：由 SDK 的五种 task 类 system 消息驱动，产出协议的
 * `bgtask.snapshot`（全量快照）。纯逻辑、无 I/O、时钟注入，可脱离 SDK 单测。
 *
 * ## 数据来源（真 claude 2.1.282 + SDK 0.3.251 实测形状）
 *
 * - `background_tasks_changed`：当前在跑的完整列表快照（REPLACE 语义），每次成员
 *   变化都发；**没有** owned_by_subagent 信息。实测它先于同一变化的 bookend 到达。
 * - `task_started`：`is_backgrounded` / `owned_by_subagent` / `tool_use_id` /
 *   `task_type` / `description`。子 agent 内部**同步**跑的 Bash 也会发（
 *   `is_backgrounded:false, owned_by_subagent:true`）——那不是后台任务，要过滤。
 * - `task_progress`（仅 local_agent）：`usage{tool_uses,duration_ms}`、`last_tool_name`。
 * - `task_updated`：`patch{status: completed|failed|killed|…, end_time, is_backgrounded}`。
 * - `task_notification`：`status: completed|failed|stopped`、`summary`、`usage?`。
 *   它也是自发轮的前奏：CLI 收到通知后会自己开一轮，`lastNotification` 供会话层
 *   给自发轮的 run.state 带触发说明。
 *
 * ## 收录规则
 *
 * 只收 `is_backgrounded:true` 且非 `owned_by_subagent` 且非 `ambient` 的任务。
 * 前台起的任务（`is_backgrounded:false`）先记在候选表里：之后 `task_updated`
 * 的 `patch.is_backgrounded:true`（用户按 Ctrl+B / 宿主 backgroundTasks）会把它
 * 转成后台任务。level 信号（`background_tasks_changed`）里出现而表里没有的任务
 * 直接收（漏了 bookend 也不至于少显示）；表里 running 而 level 里没有的标记结束
 * （默认 completed，随后的 task_updated / notification 会改成准确状态）。
 *
 * 已结束的任务只保留最近 `MAX_ENDED` 条，更早的丢掉；快照按开始时间排序。
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { BG_TASK_SUMMARY_MAX, type BgTask } from '@trine/core';
import { toSingleLine } from './summarize.ts';

/** 快照里保留的已结束任务条数 */
export const MAX_ENDED = 10;
/** 前台任务候选表上限（等 is_backgrounded 补丁的；超出淘汰最旧，防长会话泄漏） */
const MAX_FOREGROUND = 50;

/** 最近一次任务结束通知（自发轮的触发说明来源） */
export interface BgTaskNotification {
  taskId: string;
  description: string;
  status: BgTask['status'];
  at: number;
}

/** 从 unknown 对象里安全取字段 */
function field(obj: unknown, key: string): unknown {
  if (typeof obj !== 'object' || obj === null) return undefined;
  return (obj as Record<string, unknown>)[key];
}

function numberField(obj: unknown, key: string): number | undefined {
  const v = field(obj, key);
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : undefined;
}

/** SDK 的 task_type → 协议 kind */
export function kindOf(taskType: unknown): BgTask['kind'] {
  if (taskType === 'local_bash') return 'bash';
  if (taskType === 'local_agent') return 'agent';
  return 'other';
}

/** task_updated.patch.status / task_notification.status → 协议 status；不认识的返回 undefined */
function statusOf(raw: unknown): BgTask['status'] | undefined {
  switch (raw) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'killed':
    case 'stopped':
      return 'stopped';
    case 'running':
    case 'pending':
      return 'running';
    default:
      return undefined;
  }
}

/** 前台起的任务候选（等 is_backgrounded 补丁把它转成后台任务） */
interface ForegroundCandidate {
  kind: BgTask['kind'];
  description: string;
  toolUseId: string | undefined;
  startedAt: number;
}

export class BgTaskTracker {
  readonly #now: () => number;
  /** taskId → 任务（Map 保插入序） */
  readonly #tasks = new Map<string, BgTask>();
  readonly #foreground = new Map<string, ForegroundCandidate>();
  #lastNotification: BgTaskNotification | undefined = undefined;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  /** 正在运行的后台任务数（空闲回收判断 / SessionMeta.bgRunning） */
  get runningCount(): number {
    let n = 0;
    for (const t of this.#tasks.values()) if (t.status === 'running') n += 1;
    return n;
  }

  /** 最近一次结束通知；`consume` 为 true 时取走（自发轮只用一次） */
  lastNotification(consume = false): BgTaskNotification | undefined {
    const n = this.#lastNotification;
    if (consume) this.#lastNotification = undefined;
    return n;
  }

  /** 当前快照（按开始时间排序，已结束的最多 MAX_ENDED 条） */
  snapshot(): BgTask[] {
    return [...this.#tasks.values()]
      .map((t) => ({ ...t }))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * 喂一条 SDK 消息。
   *
   * @returns 快照是否变了（变了会话层就发 bgtask.snapshot）
   */
  observe(message: SDKMessage): boolean {
    if (message.type !== 'system') return false;
    // 字段按 unknown 对待：CLI 随全局 claude 自动更新，消息形状随时可能变；缺字段
    // 只该让这一帧不生效，不该抛到读取循环（评审 B2 / 探针 L）
    switch (message.subtype) {
      case 'background_tasks_changed':
        return Array.isArray(message.tasks) ? this.#onLevel(message.tasks) : false;
      case 'task_started':
        return typeof message.task_id === 'string' ? this.#onStarted(message) : false;
      case 'task_progress':
        return typeof message.task_id === 'string' ? this.#onProgress(message) : false;
      case 'task_updated':
        return typeof message.task_id === 'string' && typeof message.patch === 'object' && message.patch !== null
          ? this.#onUpdated(message)
          : false;
      case 'task_notification':
        return typeof message.task_id === 'string' ? this.#onNotification(message) : false;
      default:
        return false;
    }
  }

  /**
   * 子进程没了（stop / 续跑拆 query / 崩溃 / 关闭）：在跑的任务随之死亡，
   * 标成 stopped。返回是否有任务被标掉。
   */
  markAllStopped(): boolean {
    let changed = false;
    for (const t of this.#tasks.values()) {
      if (t.status !== 'running') continue;
      this.#end(t, 'stopped');
      changed = true;
    }
    this.#foreground.clear();
    if (changed) this.#prune();
    return changed;
  }

  #onLevel(tasks: readonly { task_id: string; task_type: string; description: string; ambient?: boolean }[]): boolean {
    let changed = false;
    const live = new Set<string>();
    for (const t of tasks) {
      if (typeof t !== 'object' || t === null || typeof t.task_id !== 'string') continue;
      if (t.ambient === true) continue;
      live.add(t.task_id);
      const existing = this.#tasks.get(t.task_id);
      if (existing === undefined) {
        // 先于 task_started 到达（实测顺序）：先收进来，bookend 再补 toolUseId
        const candidate = this.#foreground.get(t.task_id);
        this.#foreground.delete(t.task_id);
        this.#tasks.set(t.task_id, {
          taskId: t.task_id,
          kind: kindOf(t.task_type),
          description: t.description,
          status: 'running',
          startedAt: candidate?.startedAt ?? this.#now(),
          ...(candidate?.toolUseId === undefined ? {} : { toolUseId: candidate.toolUseId }),
        });
        changed = true;
      } else if (existing.status !== 'running') {
        // 结束后又出现在 level 里（如 resume 的子 agent）：重新视为在跑
        existing.status = 'running';
        delete existing.endedAt;
        changed = true;
      }
    }
    for (const t of this.#tasks.values()) {
      if (t.status === 'running' && !live.has(t.taskId)) {
        this.#end(t, 'completed');
        changed = true;
      }
    }
    if (changed) this.#prune();
    return changed;
  }

  #onStarted(message: Extract<SDKMessage, { type: 'system'; subtype: 'task_started' }>): boolean {
    if (message.ambient === true || message.skip_transcript === true) return false;
    if (field(message, 'owned_by_subagent') === true) {
      // 子 agent 自己起的后台任务：level 信号先到、不带 owned_by_subagent，已经把它
      // 收进表了（评审 m1 / 探针 J）——bookend 一到就撤掉，不算本会话的后台任务
      const leaked = this.#tasks.delete(message.task_id);
      this.#foreground.delete(message.task_id);
      return leaked;
    }
    const kind = kindOf(message.task_type);
    if (message.is_backgrounded !== true) {
      // 前台任务：记候选，等 is_backgrounded 补丁
      this.#foreground.set(message.task_id, {
        kind,
        description: message.description,
        toolUseId: message.tool_use_id,
        startedAt: this.#now(),
      });
      while (this.#foreground.size > MAX_FOREGROUND) {
        const oldest = this.#foreground.keys().next();
        if (oldest.done === true) break;
        this.#foreground.delete(oldest.value);
      }
      return false;
    }
    const existing = this.#tasks.get(message.task_id);
    if (existing !== undefined) {
      let changed = false;
      if (existing.toolUseId === undefined && message.tool_use_id !== undefined) {
        existing.toolUseId = message.tool_use_id;
        changed = true;
      }
      if (existing.description !== message.description && message.description !== '') {
        existing.description = message.description;
        changed = true;
      }
      return changed;
    }
    this.#tasks.set(message.task_id, {
      taskId: message.task_id,
      kind,
      description: message.description,
      status: 'running',
      startedAt: this.#now(),
      ...(message.tool_use_id === undefined ? {} : { toolUseId: message.tool_use_id }),
    });
    this.#prune();
    return true;
  }

  #onProgress(message: Extract<SDKMessage, { type: 'system'; subtype: 'task_progress' }>): boolean {
    const task = this.#tasks.get(message.task_id);
    if (task === undefined) return false;
    let changed = false;
    const toolUses = numberField(message.usage, 'tool_uses');
    const durationMs = numberField(message.usage, 'duration_ms');
    if (toolUses !== undefined && task.toolUses !== toolUses) {
      task.toolUses = toolUses;
      changed = true;
    }
    // durationMs 每条进度都变，但 client 显示的已运行时长是按 startedAt 本地走秒的
    // ——只静默记着（结束时随快照一起出），不为它单独发一帧（评审 m3 / 探针 K：
    // 子 agent 跑几十分钟会产生成百上千帧只差 durationMs 的快照）
    if (durationMs !== undefined) task.durationMs = durationMs;
    if (message.last_tool_name !== undefined && task.lastToolName !== message.last_tool_name) {
      task.lastToolName = message.last_tool_name;
      changed = true;
    }
    return changed;
  }

  #onUpdated(message: Extract<SDKMessage, { type: 'system'; subtype: 'task_updated' }>): boolean {
    const patch = message.patch;
    let task = this.#tasks.get(message.task_id);
    let changed = false;
    if (task === undefined) {
      const candidate = this.#foreground.get(message.task_id);
      if (candidate === undefined) return false;
      // 前台任务结束了：候选作废，之后迟到 / 错序的 is_backgrounded 补丁不能把它
      // 复活成 running（评审 m2 / 探针 I）
      const ended = statusOf(patch.status);
      if (ended !== undefined && ended !== 'running') {
        this.#foreground.delete(message.task_id);
        return false;
      }
      // 前台任务被转到后台（Ctrl+B / backgroundTasks）
      if (patch.is_backgrounded !== true) return false;
      this.#foreground.delete(message.task_id);
      task = {
        taskId: message.task_id,
        kind: candidate.kind,
        description: candidate.description,
        status: 'running',
        startedAt: candidate.startedAt,
        ...(candidate.toolUseId === undefined ? {} : { toolUseId: candidate.toolUseId }),
      };
      this.#tasks.set(message.task_id, task);
      changed = true;
    }
    if (patch.description !== undefined && patch.description !== task.description) {
      task.description = patch.description;
      changed = true;
    }
    const status = statusOf(patch.status);
    if (status !== undefined && status !== 'running' && task.status !== status) {
      this.#end(task, status, patch.end_time);
      changed = true;
    }
    if (changed) this.#prune();
    return changed;
  }

  #onNotification(message: Extract<SDKMessage, { type: 'system'; subtype: 'task_notification' }>): boolean {
    const task = this.#tasks.get(message.task_id);
    if (task === undefined) {
      // 前台任务的结束通知：候选作废（同 #onUpdated）
      this.#foreground.delete(message.task_id);
      return false;
    }
    const raw = statusOf(message.status);
    // 通知只会是 completed / failed / stopped；不认识的按 completed
    const status: Exclude<BgTask['status'], 'running'> = raw === undefined || raw === 'running' ? 'completed' : raw;
    let changed = false;
    // 通知的状态比 level 信号默认的 completed 更准（如 stopped），以它为准
    if (task.status !== status) {
      this.#end(task, status);
      changed = true;
    }
    const summary = toSingleLine(message.summary, BG_TASK_SUMMARY_MAX);
    if (summary !== '' && task.summary !== summary) {
      task.summary = summary;
      changed = true;
    }
    const toolUses = numberField(message.usage, 'tool_uses');
    const durationMs = numberField(message.usage, 'duration_ms');
    if (toolUses !== undefined) task.toolUses = toolUses;
    if (durationMs !== undefined) task.durationMs = durationMs;
    this.#lastNotification = { taskId: task.taskId, description: task.description, status: task.status, at: this.#now() };
    if (changed) this.#prune();
    return changed;
  }

  #end(task: BgTask, status: Exclude<BgTask['status'], 'running'>, endTime?: number): void {
    task.status = status;
    if (task.endedAt === undefined) {
      task.endedAt = typeof endTime === 'number' && Number.isFinite(endTime) && endTime > 0 ? Math.round(endTime) : this.#now();
    }
  }

  /** 已结束的只留最近 MAX_ENDED 条（按结束时间） */
  #prune(): void {
    const ended = [...this.#tasks.values()].filter((t) => t.status !== 'running');
    if (ended.length <= MAX_ENDED) return;
    ended.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const t of ended.slice(0, ended.length - MAX_ENDED)) this.#tasks.delete(t.taskId);
  }
}

/** 自发轮的触发说明文案（run.state.detail） */
export function spontaneousDetailOf(notification: BgTaskNotification | undefined): string {
  if (notification === undefined) return '后台任务完成';
  const name = toSingleLine(notification.description, 60);
  const what = name === '' ? '后台任务' : `后台任务“${name}”`;
  switch (notification.status) {
    case 'failed':
      return `${what}失败`;
    case 'stopped':
      return `${what}已停止`;
    default:
      return `${what}已完成`;
  }
}
