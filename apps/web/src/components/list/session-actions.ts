/**
 * 会话 rename / archive / delete 动作的纯逻辑（session-list-v2 §4.1，评审 B1 / S2）：
 * agent 版本能力探测 + 把 client 的三条命令包成 `SessionRowActions` 回调（含
 * toast）。React 胶水在 `use-session-actions.ts`，这里零 React 依赖、可直接单测。
 *
 * ## 能力探测
 *
 * 旧 agent 对不认识的 c2a type 在 schema 层**静默丢弃**，web 只能等超时——
 * 所以按 `machine.info.agentVersion` 先判：`>= 0.2.0`（这批命令随 agent 0.2.0
 * 发布）才给入口。版本号解析不了、或还没收到 `machine.info` 的机器一律当不支持
 * ——宁可暂时藏起入口，也不给一个点了等 10 秒才报错的按钮。万一探测误判（agent
 * 自报版本号却不认帧），`request()` 的超时文案兜底提示「agent 版本过旧或离线」。
 */
import type { MachineInfo } from '@trine/core';
import type { SessionRowActions } from './SessionRowMenu.tsx';

/** 首个支持 session.rename / archive / delete 的 agent 版本 */
export const SESSION_MUTATIONS_MIN_AGENT = '0.2.0';

interface ParsedVersion {
  core: [number, number, number];
  pre: string[];
}

/** 宽松 semver：可带前缀 v、可省略 minor/patch，`+build` 忽略；不合法 → null */
function parseVersion(raw: string): ParsedVersion | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim());
  if (m === null) return null;
  return {
    core: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)],
    pre: m[4] === undefined ? [] : m[4].split('.'),
  };
}

/**
 * semver 优先级比较：a < b → 负，= → 0，> → 正；任一方不合法 → null。
 * 预发布版低于同号正式版（`0.2.0-rc.1 < 0.2.0`），预发布段逐段比，数字段按数值。
 */
export function compareVersions(a: string, b: string): number | null {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (va === null || vb === null) return null;
  for (let i = 0; i < 3; i++) {
    const d = va.core[i]! - vb.core[i]!;
    if (d !== 0) return d;
  }
  if (va.pre.length === 0 || vb.pre.length === 0) return vb.pre.length - va.pre.length;
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i];
    const y = vb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx) return -1; // 数字段低于字母段
    if (ny) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** 这台机器的 agent 是否认识 rename / archive / delete */
export function supportsSessionMutations(info: Pick<MachineInfo, 'agentVersion'> | null | undefined): boolean {
  if (info === null || info === undefined) return false;
  const cmp = compareVersions(info.agentVersion, SESSION_MUTATIONS_MIN_AGENT);
  return cmp !== null && cmp >= 0;
}

/** 支持的机器 id，排序后逗号拼接——给 React selector 用的稳定标量 */
export function supportedMachinesKey(machines: Record<string, { info: Pick<MachineInfo, 'agentVersion'> | null }>): string {
  return Object.keys(machines)
    .filter((id) => supportsSessionMutations(machines[id]?.info))
    .sort()
    .join(',');
}

export interface SessionMutationClient {
  renameSession(machineId: string, sessionId: string, title: string): Promise<void>;
  archiveSession(machineId: string, sessionId: string, archived: boolean): Promise<void>;
  deleteSession(machineId: string, sessionId: string): Promise<void>;
}

export interface Notifier {
  success(message: string, options?: { action?: { label: string; onClick: () => void } }): void;
  error(message: string, options: { description: string }): void;
}

const NONE: SessionRowActions = Object.freeze({});

/**
 * 组装回调。
 *
 * - `client === null`（从标签页）或没有任何支持的机器 → 一个回调都不给，入口全藏；
 * - `onlyMachine` 给了（聊天页）→ 只看那一台；
 * - 否则回调照给，另带 `supports` 让列表逐行判（「全部机器」视图里新旧 agent 混排）。
 *
 * 回调返回的 Promise 在失败时**先 toast 再 reject**：对话框据 reject 保持打开，
 * 错误文案只出一次（这里）。成功时列表的变化由 agent 广播的 session.updated /
 * session.removed 带来（应答之前就已落地），这里只给一条轻提示。
 */
export function buildSessionActions(args: {
  client: SessionMutationClient | null;
  supportedMachineIds: ReadonlySet<string>;
  onlyMachine?: string | undefined;
  notify: Notifier;
}): SessionRowActions {
  const { client, supportedMachineIds, onlyMachine, notify } = args;
  if (client === null || supportedMachineIds.size === 0) return NONE;
  if (onlyMachine !== undefined && !supportedMachineIds.has(onlyMachine)) return NONE;

  const run = async (failTitle: string, op: () => Promise<void>, onOk: () => void): Promise<void> => {
    try {
      await op();
    } catch (err) {
      notify.error(failTitle, { description: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    onOk();
  };

  const onArchive = (machineId: string, sessionId: string, archived: boolean): Promise<void> =>
    run(
      archived ? '归档失败' : '取消归档失败',
      () => client.archiveSession(machineId, sessionId, archived),
      () =>
        archived
          ? notify.success('已归档', {
              action: { label: '撤销', onClick: () => void onArchive(machineId, sessionId, false).catch(() => {}) },
            })
          : notify.success('已取消归档'),
    );

  return {
    supports: (machineId) => supportedMachineIds.has(machineId),
    onRename: (machineId, sessionId, title) =>
      run('重命名失败', () => client.renameSession(machineId, sessionId, title), () => notify.success('已重命名')),
    onArchive,
    onDelete: (machineId, sessionId) =>
      run('永久删除失败', () => client.deleteSession(machineId, sessionId), () => notify.success('已永久删除')),
  };
}
