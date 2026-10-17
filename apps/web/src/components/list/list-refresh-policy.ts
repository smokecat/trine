/**
 * 「该不该再发一次 `session.list.request`」的判据（评审 M1 / M5）。
 *
 * 抽成纯模块的两个理由：
 *
 * 1. **去重状态不能挂在组件里**。早先它是 `SessionListView` 里的一个
 *    `useRef(Set)`，随视图卸载而丢——列表 → 机器页 → 返回列表就是一次
 *    全量 `session.list`。agent 侧 `manager.list()` 每次都真跑 SDK
 *    `listSessions`（router 的 5s 缓存只服务 resume 路径），真机 339 个
 *    会话时是慢路径，还占 agent 的并发名额。
 * 2. **判据要能测**。「拉过就不再拉」「过了 TTL 再拉」「机器下线再上线要
 *    重拉」「换了连接代际要重拉」这几条靠点击 UI 验很贵。
 *
 * 状态是**模块级**的（跟着页面生命周期，不跟着任何组件），刷新页面自然清空。
 * 连接代际同理，见下面 `observeConnection()`（评审 N5）。
 */

/** 同一台机器两次自动拉取之间的最小间隔 */
export const LIST_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// 连接代际（评审 N5）
// ---------------------------------------------------------------------------

/**
 * 连接代际：WS 每从非 open 变成 open 记一代。断线期间 agent 可能建过新会话，
 * 重连后即便还在 TTL 内也该重拉一次。
 *
 * **必须是模块级单例**。早先它是 `useConnectionGeneration()` 里的一个
 * `useRef(0)` 且在 render 阶段自增——三个独立调用点（Layout / Sidebar /
 * ChatView）各有各的计数器，互不可比：Layout 开机即挂、经历一次重连后代际
 * 为 2，用户首次进聊天页时 ChatView 新挂载从 0 起跳为 1，判据不匹配 →
 * 多发一次全量 `listSessions`（真机 339 会话的慢路径），还把代际**倒着**
 * 盖回 1；下次 Layout 以 2 再判又不匹配，两边 ping-pong。加上 StrictMode
 * 的双渲染，render 阶段自增还会再多走一步。
 *
 * 现在由 `observeConnection()` 这一个订阅推进，组件只读。
 */
let generation = 0;
let wasOpen = false;

/**
 * 喂一次连接状态（由 runtime 的单一订阅调用）。
 * 非 open → open 记一代；其余状态只更新「上次是不是 open」。
 */
export function observeConnection(status: string): void {
  const open = status === 'open';
  if (open && !wasOpen) generation++;
  wasOpen = open;
}

/** 当前连接代际。组件只读，不自增。 */
export function connectionGeneration(): number {
  return generation;
}

interface Entry {
  at: number;
  /** 拉取时所属的连接代际：换连接就得重拉（断线期间 agent 可能建了新会话） */
  generation: number;
}

const lastFetched = new Map<string, Entry>();

/**
 * 从候选机器里挑出「现在该自动拉」的。
 *
 * @param online   当前在线的 machineId
 * @param now      当前时刻
 * @param generation 连接代际（每次 WS 重新 open 递增）
 * @param ttlMs    最小间隔
 * @param opts.prune 是否把不在 `online` 里的机器从记账中清掉（默认 true）。
 *   传全量在线清单时该清（下线过的机器要重拉）；只问单台机器时**必须关掉**，
 *   否则会把其它机器的记账误当「已下线」抹掉。
 */
export function pickMachinesToFetch(
  online: readonly string[],
  now: number,
  generation: number,
  ttlMs: number = LIST_TTL_MS,
  opts: { prune?: boolean } = {},
): string[] {
  // 已下线的机器忘掉：它再上线时 agent 可能已经重启过，必须重拉。
  //
  // 注意这条**不覆盖 agent 顶替式重连**（评审 N5 附带）：agent 重启时新连接
  // 常在旧连接 close 之前建立，服务端的 `isAgentOnline` 于是从未变 false，
  // 不广播 `online:false`，本地也就不会忘记它。那种情况下列表最多陈旧
  // LIST_TTL_MS（还有手动刷新兜底），可以接受。
  if (opts.prune !== false) {
    for (const id of [...lastFetched.keys()]) if (!online.includes(id)) lastFetched.delete(id);
  }

  const due: string[] = [];
  for (const id of online) {
    const last = lastFetched.get(id);
    if (last !== undefined && last.generation === generation && now - last.at < ttlMs) continue;
    due.push(id);
  }
  return due;
}

/** 标记这批机器刚拉过（发出请求时调，不等结果——失败由 TTL 自然重试） */
export function markFetched(ids: readonly string[], now: number, generation: number): void {
  for (const id of ids) lastFetched.set(id, { at: now, generation });
}

/** 手动刷新：清掉这些机器的记录，让下一次判定必然放行 */
export function invalidateFetched(ids: readonly string[]): void {
  for (const id of ids) lastFetched.delete(id);
}

/** 测试用：清空模块级状态（含连接代际） */
export function resetFetchedForTest(): void {
  lastFetched.clear();
  generation = 0;
  wasOpen = false;
}
