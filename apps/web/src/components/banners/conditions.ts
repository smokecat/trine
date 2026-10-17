/**
 * 横幅的显示条件与文案，从 store 状态纯函数推导（`bun test` 覆盖）。
 *
 * 为什么值得抽出来：横幅是「用户唯一能看到出了什么事」的地方，漏显示比多
 * 显示危险得多，而条件本身分散在 connection / leader / machines / notices
 * 四个切片里。把判断写成纯函数，组件只负责画。
 */
import type { ConnectionSnapshot, LeaderSnapshot, Notice } from '@/store/types.ts';

// ---------------------------------------------------------------------------
// 断连 / 升级
// ---------------------------------------------------------------------------

export type ConnectionBanner =
  | { kind: 'none' }
  | { kind: 'upgrade' }
  /** 连接中/认证中：告知 + 「重试」（这两态可以卡住，评审 N3） */
  | { kind: 'connecting'; text: string }
  /** 退避等待：有倒计时与「立即重连」 */
  | { kind: 'reconnect'; attempt: number; secondsLeft: number }
  /** 停在未连接（stopped/idle）：只告知——此时本页没有 client 可供重启 */
  | { kind: 'stopped'; text: string };

/**
 * 断连横幅。**未配对时不显示**——配对页自己会讲状态，此时「没连接」是正常的。
 * `status === 'open'` 也不显示（一切正常）。
 */
export function connectionBanner(
  connection: ConnectionSnapshot,
  paired: boolean,
  now: number,
): ConnectionBanner {
  if (!paired) return { kind: 'none' };
  switch (connection.status) {
    case 'open':
      return { kind: 'none' };
    case 'needs_upgrade':
      return { kind: 'upgrade' };
    case 'authenticating':
      return { kind: 'connecting', text: '正在认证…' };
    case 'connecting':
      return { kind: 'connecting', text: '连接中…' };
    case 'backoff':
      return {
        kind: 'reconnect',
        attempt: connection.attempt,
        // nextRetryAt 缺失当作「马上」；负数夹到 0，免得显示「-2s 后」
        secondsLeft: Math.max(0, Math.ceil(((connection.nextRetryAt ?? now) - now) / 1000)),
      };
    case 'stopped':
    case 'idle':
      // 这个态实际只在「主标签让位」时出现，而那时本页的 client 已被
      // ClientLifecycle.dispose() 置空——没有任何按钮能在这里重启它。
      // 所以文案直接指向真正的恢复路径（评审复核项 13）。
      return { kind: 'stopped', text: '未连接——连接由另一个标签页持有，可在上方「在此接管」或刷新本页' };
  }
}

/**
 * 会话页 composer 上方的离线提示（评审 m6）。
 *
 * 它贴着「按下发送会发生什么」，是离线这件事在会话页的**唯一**提示——
 * 顶部曾经还有一条同义的 `OfflineBanner`，同屏两遍是噪音，去重后它在任何
 * 路由都不再渲染（成了死代码），已连同槽位一并删掉（评审 C-3）。
 * 排队数当时并到了这里，信息量没丢。
 */
export function composerOfflineHint(machine: { name: string; parkedCount: number } | undefined): string {
  const name = machine?.name ?? '机器';
  const parked = machine?.parkedCount ?? 0;
  const base = `${name} 离线，发出的消息会排队，等它上线后送达`;
  return parked > 0 ? `${base} · 已排队 ${parked} 条` : base;
}

/** 重连条正文（原型 `.reconnect-bar`：「⟳ 连接中断 · 3s 后重连（第 2 次）」） */
export function reconnectText(attempt: number, secondsLeft: number): string {
  return `连接中断 · ${secondsLeft}s 后重连（第 ${attempt} 次）`;
}

// ---------------------------------------------------------------------------
// 主从标签
// ---------------------------------------------------------------------------

/**
 * 从页横幅。`follower` 在 Layout 里走整页遮罩（阶段 2a 定稿），所以这里只
 * 负责 `idle`——归属还没定下来的过渡态。它通常只闪一下；**停留超过 3 秒**
 * 才值得出条，否则每次刷新都闪一条横幅。
 */
export function leaderBannerVisible(
  leader: LeaderSnapshot,
  idleSinceMs: number | null,
  now: number,
  thresholdMs = 3_000,
): boolean {
  if (leader.state !== 'idle') return false;
  if (idleSinceMs === null) return false;
  return now - idleSinceMs >= thresholdMs;
}

// ---------------------------------------------------------------------------
// notices（游标倒退 / scope fatal / 自愈放弃 / 机器级错误）
// ---------------------------------------------------------------------------

export interface NoticeView {
  id: string;
  text: string;
  /** 一键恢复动作的标签；null = 只能关掉 */
  actionLabel: string | null;
  /** 常驻横幅还是一闪而过的 toast */
  placement: 'bar' | 'toast';
}

/**
 * notice → 展示形态。
 *
 * **要用户点一下才能恢复的（游标倒退、scope fatal）走常驻横幅**，纯告知的
 * （自愈放弃、机器级错误）走 toast——toast 消失后用户再也找不到的信息不能
 * 是「唯一的恢复入口」。
 */
export function noticeView(notice: Notice, machineName: (machineId: string) => string): NoticeView {
  const n = notice.notice;
  switch (n.kind) {
    case 'cursor_regression':
      return {
        id: notice.id,
        text: `服务端序号已重置（${machineName(n.machineId)}${n.scope === '' ? '' : ` · 会话 ${n.scope.slice(0, 8)}`}）：后续消息会被当作重放丢弃。`,
        actionLabel: '重置游标并重新同步',
        placement: 'bar',
      };
    case 'scope_fatal':
      return {
        id: notice.id,
        text: n.detail,
        actionLabel: '重置出站计数器',
        placement: 'bar',
      };
    case 'outbox_gave_up':
      return {
        id: notice.id,
        text: `出站自愈放弃（${machineName(n.machineId)}）：${n.detail}`,
        actionLabel: null,
        placement: 'toast',
      };
    case 'machine_error':
      return {
        id: notice.id,
        text: `${machineName(n.machineId)} 报告错误（${n.error.kind}）：${n.error.message}`,
        actionLabel: null,
        placement: 'toast',
      };
  }
}
