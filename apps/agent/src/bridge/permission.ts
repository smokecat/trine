/**
 * 权限桥：SDK `canUseTool` 回调 ↔ 远端异步应答。
 *
 * ## 语义（主会话拍板的决策 2）
 *
 * 1. **先匹配 remember 表**：client 应答带 `remember: { scope:'session', pattern }`
 *    时登记到 per-session 表；后续同 pattern 命中即直接 allow，**不挂起、不发帧**。
 *    作用域只有本会话（协议决策点 3：MVP 不做永久记忆）。
 * 2. **不设自超时定时器**：协议决策点 2 明确「超时只计时不自动拒绝」。挂起就一直挂着，
 *    等人；client 自己按 `requestedAt` 算等待时长并推送提醒。
 *    ——这是刻意的：自动拒绝会让人在手机上错过一次批准就得从头重跑任务。
 * 3. **AbortSignal abort 时**：清 pending 项 → 产出 `permission.invalidated` 事件
 *    → 向 SDK 返回 deny 结束该次挂起。abort 来源是 run 被 stop / 会话被回收 /
 *    进程要退出，此时这次请求已经没有意义，必须让 SDK 那侧的 await 解开，
 *    否则 query 迭代器永远不结束。
 *
 * ## 为什么 deny 而不是抛错
 *
 * `canUseTool` 抛错会被 SDK 当成回调故障，行为不确定；返回 deny 是协议内的
 * 正常路径，Claude 会得到「这次工具没批准」的明确结果并继续（或收尾）。
 */
import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode, WaitingFor } from '@trine/core';
import { isSafeRememberPattern, matchesPattern, waitingForTool } from '@trine/core/permission';
import type { EventBody } from './types.ts';

/** client 没给附言时 deny 送给 Claude 的默认文案 */
export const DEFAULT_DENY_MESSAGE = '用户拒绝了该工具调用';

/** 本会话记住的放行模式串上限（防会话内无界增长） */
const MAX_REMEMBERED = 200;

/** 一次挂起中的权限请求 */
interface PendingPermission {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  requestedAt: number;
  /** SDK 给的规则建议，原样进 permission.request（重发时也要带） */
  suggestions: unknown[] | undefined;
  /** 子 agent 发起的请求：父 Agent/Task 的 toolUseId（重发时也要带） */
  parentToolUseId: string | undefined;
  /** 兑现 SDK 那侧 await 的钩子 */
  resolve: (result: PermissionResult) => void;
  /** 解绑 abort 监听，避免会话长跑时监听器堆积 */
  detach: () => void;
}

/** `snapshot()` 的条目：重发 permission.request 所需的全部字段 */
export interface PendingPermissionSnapshot {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  requestedAt: number;
  suggestions?: unknown[];
  parentToolUseId?: string;
}

/** client 的应答（对应协议 permission.respond 帧） */
export interface PermissionVerdict {
  requestId: string;
  verdict: 'allow' | 'deny';
  updatedInput?: unknown;
  remember?: { scope: 'session'; pattern: string };
  /** 响应设备标识，进 permission.resolved 供多设备展示 */
  resolvedBy?: string;
  /** 拒绝附言：trim 后非空才代替默认拒绝文案（只在 deny 时生效） */
  message?: string;
  /** 批准同时切换会话权限模式（只在 allow 时生效，见 respond 的说明） */
  setMode?: PermissionMode;
}

export interface PermissionBridgeOptions {
  /** 事件出口（由会话层接到 emitter 上） */
  emit: (body: EventBody) => void;
  /** 时钟注入 */
  now?: () => number;
  /** requestId 生成器注入（测试要确定性） */
  newRequestId?: () => string;
  /** 每次新请求时回调，供会话层累加 permissionCount / 迁移 run.state */
  onPending?: (pending: { requestId: string; toolName: string }) => void;
  /** pending 数归零时回调，供会话层把 run.state 迁回 running */
  onDrained?: () => void;
  /**
   * 挂起项被移除（应答 / 作废）但**仍有剩余**时回调：最早一条可能换了人，
   * `waitingFor` 随之可能变，会话层据此重发 meta。归零走 onDrained，不走这里。
   */
  onPendingChanged?: () => void;
  /**
   * 子 agent 来源解析：canUseTool 的 `agentID`（= 子 agent 的 task_id，真 claude
   * 2.1.283 实测，不是 tool_use_id）→ 父 Agent/Task 工具的 toolUseId。映射由会话层
   * 按 task_started 维护；查不到返回 undefined，permission.request 就不带来源。
   */
  parentToolUseIdOf?: (agentId: string) => string | undefined;
  /**
   * 兜底来源：按 canUseTool 的 `toolUseID` 查翻译层记的在途工具的父 id。子工具的
   * tool_use 帧先于它的 canUseTool 到达（真 claude 实测），所以 task_started 映射缺失
   * （乱序 / 被过滤 / 被淘汰）时它仍查得到（评审 m6）。
   */
  parentToolUseIdOfToolUse?: (toolUseId: string) => string | undefined;
}

/**
 * 单会话的权限桥。会话层每会话建一个。
 */
export class PermissionBridge {
  readonly #emit: (body: EventBody) => void;
  readonly #now: () => number;
  readonly #newRequestId: () => string;
  readonly #onPending: ((p: { requestId: string; toolName: string }) => void) | undefined;
  readonly #onDrained: (() => void) | undefined;
  readonly #onPendingChanged: (() => void) | undefined;
  readonly #parentToolUseIdOf: ((agentId: string) => string | undefined) | undefined;
  readonly #parentToolUseIdOfToolUse: ((toolUseId: string) => string | undefined) | undefined;

  /** requestId → 挂起项（Map 保插入序 = 请求先后） */
  readonly #pending = new Map<string, PendingPermission>();
  /** 本会话已记住的放行模式串（决策 2 第 1 条） */
  readonly #remembered = new Set<string>();
  #counter = 0;

  constructor(options: PermissionBridgeOptions) {
    this.#emit = options.emit;
    this.#now = options.now ?? (() => Date.now());
    this.#newRequestId =
      options.newRequestId ?? (() => `perm-${++this.#counter}-${this.#now()}`);
    this.#onPending = options.onPending;
    this.#onDrained = options.onDrained;
    this.#onPendingChanged = options.onPendingChanged;
    this.#parentToolUseIdOf = options.parentToolUseIdOf;
    this.#parentToolUseIdOfToolUse = options.parentToolUseIdOfToolUse;
  }

  /** 当前挂起中的请求数（会话层判断是否 waiting_permission 用） */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * 最早一条挂起请求在等什么（SessionMeta.waitingFor 的来源）；无挂起项 undefined。
   * 「最早」= 插入序第一条：web 会话内的等待文案也取时间线上最早一条 pending，
   * 两处口径一致。
   */
  get waitingFor(): WaitingFor | undefined {
    const first = this.#pending.values().next();
    return first.done === true ? undefined : waitingForTool(first.value.toolName);
  }

  /** 本会话已记住的模式串（只读快照，调试/状态查询用） */
  get rememberedPatterns(): readonly string[] {
    return [...this.#remembered];
  }

  /**
   * 交给 SDK `Options.canUseTool` 的回调。
   */
  readonly canUseTool: CanUseTool = (toolName, input, options) => {
    // 1. remember 表命中即直接放行，不挂起、不打扰
    for (const pattern of this.#remembered) {
      if (matchesPattern(pattern, toolName, input)) {
        return Promise.resolve<PermissionResult>({ behavior: 'allow' });
      }
    }

    // 2. 挂起 + 转发
    const requestId = this.#newRequestId();
    const requestedAt = this.#now();

    return new Promise<PermissionResult>((resolve) => {
      const onAbort = (): void => {
        // 3. abort：清 pending、发 invalidated、以 deny 结束挂起（见文件头）
        const entry = this.#pending.get(requestId);
        if (entry === undefined) return;
        this.#pending.delete(requestId);
        entry.detach();
        this.#emit({
          type: 'permission.invalidated',
          requestId,
          reason: '运行已中止，该权限请求失效',
        });
        this.#afterRemoval();
        resolve({
          behavior: 'deny',
          message: '运行已中止，权限请求未获应答',
        });
      };

      options.signal.addEventListener('abort', onAbort, { once: true });
      const detach = (): void => {
        options.signal.removeEventListener('abort', onAbort);
      };

      const suggestions = options.suggestions as unknown[] | undefined;
      const parentToolUseId = this.#sourceOf(options.agentID, options.toolUseID);
      this.#pending.set(requestId, {
        requestId,
        toolName,
        input,
        requestedAt,
        suggestions,
        parentToolUseId,
        resolve,
        detach,
      });

      // signal 可能在注册前就已 abort
      if (options.signal.aborted) {
        onAbort();
        return;
      }

      this.#onPending?.({ requestId, toolName });
      this.#emit({
        type: 'permission.request',
        requestId,
        toolName,
        input,
        requestedAt,
        ...(suggestions === undefined ? {} : { suggestions }),
        ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
      });
    });
  };

  /**
   * 来源：先按 agentID（= task_id）查映射，查不到再按 toolUseID 查在途工具的父 id。
   * 主线程（无 agentID）、都查不到、解析器抛错都返回 undefined。
   */
  #sourceOf(agentId: unknown, toolUseId: unknown): string | undefined {
    if (typeof agentId !== 'string' || agentId === '') return undefined;
    const pick = (fn: ((key: string) => string | undefined) | undefined, key: unknown): string | undefined => {
      if (fn === undefined || typeof key !== 'string' || key === '') return undefined;
      try {
        const parent = fn(key);
        return typeof parent === 'string' && parent !== '' ? parent : undefined;
      } catch {
        return undefined;
      }
    };
    return pick(this.#parentToolUseIdOf, agentId) ?? pick(this.#parentToolUseIdOfToolUse, toolUseId);
  }

  /**
   * 收到 client 的 `permission.respond` 时调用。
   *
   * @returns 是否命中了一个挂起项（false = 重复应答或已失效，调用方可忽略）
   */
  respond(verdict: PermissionVerdict): boolean {
    const entry = this.#pending.get(verdict.requestId);
    if (entry === undefined) return false;

    this.#pending.delete(verdict.requestId);
    entry.detach();

    // remember 登记：只在 allow 时有意义（记住拒绝会让人无从补救），
    // 且 pattern 必须通过安全校验——client 发上来的 pattern 不可轻信，
    // 一个 `*` 就会让本会话后续所有工具调用静默放行
    if (
      verdict.verdict === 'allow' &&
      verdict.remember !== undefined &&
      isSafeRememberPattern(verdict.remember.pattern)
    ) {
      this.#remembered.add(verdict.remember.pattern);
      // 有界化：Set 保插入序，超限淘汰最早登记的
      while (this.#remembered.size > MAX_REMEMBERED) {
        const oldest = this.#remembered.values().next();
        if (oldest.done === true) break;
        this.#remembered.delete(oldest.value);
      }
    }

    // 「改参数后批准」：交给 SDK 的是改后的那份 input。
    // 判据（对象且非 null）与下面 resolved 事件里带不带 updatedInput 必须
    // **同一个**——只有真的换掉了入参才声称换过，否则各端会显示一份其实
    // 没生效的「已按修改后的参数批准」
    const updated = verdict.updatedInput;
    const usedUpdated =
      verdict.verdict === 'allow' && updated !== undefined && typeof updated === 'object' && updated !== null;

    // 批准时切模式（ExitPlanMode 的「批准并自动接受编辑」）：交给 CLI 的
    // updatedPermissions setMode，由 CLI 在批准这一刻原子地切——已用真 claude
    // 实测：模式直接停在 acceptEdits，不会先落到 default。不能改成「批准后再
    // setPermissionMode」：ExitPlanMode 批准后 CLI 自己切回 default，两者竞态。
    // 切换后 CLI 会发 system/status 回报新模式，会话层据此同步（session.ts）。
    const setMode = verdict.verdict === 'allow' ? verdict.setMode : undefined;
    // 拒绝附言：trim 后非空才用，否则默认文案；只有 client 给的附言才回报
    const message = verdict.verdict === 'deny' ? nonBlank(verdict.message) : undefined;

    if (verdict.verdict === 'allow') {
      entry.resolve({
        behavior: 'allow',
        ...(usedUpdated ? { updatedInput: updated as Record<string, unknown> } : {}),
        ...(setMode === undefined
          ? {}
          : { updatedPermissions: [{ type: 'setMode', mode: setMode, destination: 'session' }] }),
      });
    } else {
      entry.resolve({ behavior: 'deny', message: message ?? DEFAULT_DENY_MESSAGE });
    }

    // 多设备同步：其余设备把卡片置为已响应。带上**实际执行的**那份 input
    // ——否则各端只有最初的 request.input，改后的值仅存在于批准那台设备的
    // 组件 state 里，刷新即丢（验收 5）。附言 / 切模式同理：只回报实际生效的
    this.#emit({
      type: 'permission.resolved',
      requestId: verdict.requestId,
      verdict: verdict.verdict,
      ...(verdict.resolvedBy === undefined ? {} : { resolvedBy: verdict.resolvedBy }),
      ...(usedUpdated ? { updatedInput: updated } : {}),
      ...(message === undefined ? {} : { message }),
      ...(setMode === undefined ? {} : { setMode }),
    });
    this.#afterRemoval();
    return true;
  }

  /**
   * 作废全部挂起项（agent 重启、会话被回收、run 被 stop）。
   * 每项都发 `permission.invalidated` 并以 deny 解开 SDK 那侧的 await。
   */
  invalidateAll(reason: string): void {
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of entries) {
      entry.detach();
      this.#emit({
        type: 'permission.invalidated',
        requestId: entry.requestId,
        reason,
      });
      entry.resolve({ behavior: 'deny', message: reason });
    }
    if (entries.length > 0) this.#drainedIfEmpty();
  }

  /**
   * 挂起项的只读快照（状态查询 / 重连补发用）。
   *
   * 带完整 `input` 与 `suggestions`：重连后要按原样重发 `permission.request`
   * （同 requestId，client 按 requestId 幂等），少了 input 就拼不出合法帧。
   */
  snapshot(): ReadonlyArray<PendingPermissionSnapshot> {
    return [...this.#pending.values()].map((p) => ({
      requestId: p.requestId,
      toolName: p.toolName,
      input: p.input,
      requestedAt: p.requestedAt,
      ...(p.suggestions === undefined ? {} : { suggestions: p.suggestions }),
      ...(p.parentToolUseId === undefined ? {} : { parentToolUseId: p.parentToolUseId }),
    }));
  }

  #drainedIfEmpty(): void {
    if (this.#pending.size === 0) this.#onDrained?.();
  }

  /** 移除了一项之后：归零 → onDrained；还有剩余 → onPendingChanged */
  #afterRemoval(): void {
    if (this.#pending.size === 0) this.#onDrained?.();
    else this.#onPendingChanged?.();
  }
}

/** trim 后非空返回 trim 后的值，否则 undefined */
function nonBlank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  return t === '' ? undefined : t;
}

/** 给上层用的类型再导出，避免各处直接依赖 SDK 类型 */
export type { PermissionResult, PermissionUpdate };
