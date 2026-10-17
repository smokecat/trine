/**
 * 入站 relay 帧处理（方案 §4.3 前半）：解密 → schema → 信封绑定 → 游标。
 *
 * ## 补发期暂存（评审 B1）
 *
 * 重连后对每条流发 sync.request，服务端把积压帧补发回来并以 `sync.done`
 * 收尾。但连接是同一条，agent 新产生的 live 帧也在往这里发，且 seq 更大——
 * 若 live 帧先到并推进游标，随后的补发帧全被当重放丢。所以 `beginSync`
 * 到 `onSyncDone` 之间，该 scope 的**所有** relay 帧一律进暂存区，`sync.done`
 * 到达后按 seq 排序去重再放行。暂存不推进游标：连接中途断了暂存直接丢，
 * 下次重连按原游标再补，不丢不重。
 *
 * ## 回填模式
 *
 * 空时间线但游标 > 0 的会话（本地时间线丢了、或重置过）以 `sinceSeq:0`
 * 同步：这段窗口里放行 `seq <= 游标` 的帧（按 seq 去重），sync.done 后
 * 恢复单调。判据只有 sync.done，没有定时器。
 *
 * ## 游标倒退探测（评审 B6）
 *
 * 服务端库被删 / agent state 归零后，a2c 从 seq 1 重来，而本地游标停在几千
 * ——全部帧被静默丢弃、界面纹丝不动。同一 scope 在同一条连接上连续 ≥20 帧
 * 被丢且 `seq < 游标 − 1000` 即判定为服务端序号重置，回调让 UI 出横幅并
 * 提供「该 scope 游标置 0 重新同步」。
 */
import { openJson } from '@trine/core/crypto';
import {
  AgentToClientEventSchema,
  assertEnvelopeBinding,
  type AgentToClientEvent,
  type TransportFrame,
} from '@trine/core';

export type RelayFrame = Extract<TransportFrame, { type: 'relay' }>;
export type SyncDoneFrame = Extract<TransportFrame, { type: 'sync.done' }>;

export type DropReason = 'unknown_machine' | 'decrypt' | 'schema' | 'binding' | 'replay';

export interface DroppedInfo {
  reason: DropReason;
  machineId: string;
  scope: string;
  seq: number;
  detail: string;
}

export type SyncMode = 'normal' | 'backfill';

export interface InboundOptions {
  /** 本设备 X25519 私钥 */
  boxSecretKey: string;
  /** 已配对机器的 agent 公钥；未配对返回 undefined → 帧被丢 */
  agentKeyFor: (machineId: string) => string | undefined;
  cursor: {
    get(machineId: string, scope: string): number;
    /** 调用方负责「落盘取 max」 */
    set(machineId: string, scope: string, seq: number): void;
  };
  apply: (machineId: string, event: AgentToClientEvent) => void;
  onDropped?: (info: DroppedInfo) => void;
  onCursorRegression?: (machineId: string, scope: string) => void;
  /** 探测阈值（测试可调小） */
  regression?: { minDrops: number; minGap: number };
  log?: (line: string) => void;
}

export const DEFAULT_REGRESSION = { minDrops: 20, minGap: 1_000 };

interface SyncState {
  mode: SyncMode;
  stash: { seq: number; event: AgentToClientEvent }[];
}

/** 机器 + scope 的复合键（sessionId 是 UUID，不含 `|`） */
export function scopeKey(machineId: string, sessionId: string | undefined): string {
  return `${machineId}|${sessionId ?? ''}`;
}

export class Inbound {
  readonly #syncing = new Map<string, SyncState>();
  /** 连接内的倒退计数：key → 连续被丢帧数 */
  readonly #regressionDrops = new Map<string, number>();
  readonly #regressionReported = new Set<string>();
  readonly #regression: { minDrops: number; minGap: number };
  readonly #log: (line: string) => void;

  constructor(private readonly options: InboundOptions) {
    this.#regression = options.regression ?? DEFAULT_REGRESSION;
    this.#log = options.log ?? (() => {});
  }

  /** 发出 sync.request 的同时调用：该 scope 进入暂存 */
  beginSync(machineId: string, scope: string, mode: SyncMode): void {
    this.#syncing.set(scopeKey(machineId, scope || undefined), { mode, stash: [] });
  }

  isSyncing(machineId: string, scope: string): boolean {
    return this.#syncing.has(scopeKey(machineId, scope || undefined));
  }

  get syncingCount(): number {
    return this.#syncing.size;
  }

  /** 新连接建立前：清暂存、清同步标记、清倒退计数 */
  onConnectionReset(): void {
    this.#syncing.clear();
    this.#regressionDrops.clear();
    this.#regressionReported.clear();
  }

  onRelay(frame: RelayFrame): void {
    const scope = frame.sessionId ?? '';
    const agentKey = this.options.agentKeyFor(frame.machineId);
    if (agentKey === undefined) {
      this.#drop({ reason: 'unknown_machine', machineId: frame.machineId, scope, seq: frame.seq, detail: '未配对的机器' });
      return;
    }
    let value: unknown;
    try {
      value = openJson({ nonce: frame.nonce, ciphertext: frame.ciphertext }, agentKey, this.options.boxSecretKey);
    } catch (err) {
      this.#drop({ reason: 'decrypt', machineId: frame.machineId, scope, seq: frame.seq, detail: String(err) });
      return;
    }
    const parsed = AgentToClientEventSchema.safeParse(value);
    if (!parsed.success) {
      this.#drop({ reason: 'schema', machineId: frame.machineId, scope, seq: frame.seq, detail: parsed.error.message });
      return;
    }
    const event = parsed.data;
    try {
      assertEnvelopeBinding(event, { sessionId: frame.sessionId, seq: frame.seq }, 'a2c');
    } catch (err) {
      this.#drop({ reason: 'binding', machineId: frame.machineId, scope, seq: frame.seq, detail: String(err) });
      return;
    }

    const key = scopeKey(frame.machineId, frame.sessionId);
    const sync = this.#syncing.get(key);
    if (sync !== undefined) {
      sync.stash.push({ seq: frame.seq, event });
      return;
    }
    this.#deliver(frame.machineId, scope, frame.seq, event, false);
  }

  onSyncDone(frame: SyncDoneFrame): void {
    const key = scopeKey(frame.machineId, frame.sessionId);
    const sync = this.#syncing.get(key);
    if (sync === undefined) return;
    this.#syncing.delete(key);
    const scope = frame.sessionId ?? '';
    const sorted = sync.stash.sort((a, b) => a.seq - b.seq);
    let lastSeq = -1;
    for (const item of sorted) {
      if (item.seq === lastSeq) continue; // 同 seq 去重（补发与 live 可能各一份）
      lastSeq = item.seq;
      this.#deliver(frame.machineId, scope, item.seq, item.event, sync.mode === 'backfill');
    }
  }

  #deliver(machineId: string, scope: string, seq: number, event: AgentToClientEvent, allowBelowCursor: boolean): void {
    const key = scopeKey(machineId, scope || undefined);
    const cursor = this.options.cursor.get(machineId, scope);
    if (seq <= cursor && !allowBelowCursor) {
      this.#drop({ reason: 'replay', machineId, scope, seq, detail: `seq ${seq} <= 游标 ${cursor}` });
      this.#noteRegression(key, machineId, scope, seq, cursor);
      return;
    }
    this.#regressionDrops.delete(key);
    if (seq > cursor) this.options.cursor.set(machineId, scope, seq);
    this.options.apply(machineId, event);
  }

  #noteRegression(key: string, machineId: string, scope: string, seq: number, cursor: number): void {
    if (seq >= cursor - this.#regression.minGap) {
      this.#regressionDrops.delete(key);
      return;
    }
    const count = (this.#regressionDrops.get(key) ?? 0) + 1;
    this.#regressionDrops.set(key, count);
    if (count >= this.#regression.minDrops && !this.#regressionReported.has(key)) {
      this.#regressionReported.add(key);
      this.#log(`[inbound] 疑似服务端序号重置 machine=${machineId} scope=${scope || '(machine)'} seq=${seq} 游标=${cursor}`);
      this.options.onCursorRegression?.(machineId, scope);
    }
  }

  #drop(info: DroppedInfo): void {
    this.#log(`[inbound] 丢弃 ${info.reason} machine=${info.machineId} scope=${info.scope || '(machine)'} seq=${info.seq}：${info.detail}`);
    this.options.onDropped?.(info);
  }
}
