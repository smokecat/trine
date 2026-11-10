/**
 * 新建会话 sheet 的「URL 开关」：`?new=1` 打开。
 *
 * 为什么挂 URL 而不是组件 state：这个 sheet 有两个入口，而它们在两套布局里
 * 分属不同的组件树——移动端是列表页的 FAB，PC 是常驻侧栏顶部的「+ 新建」
 * （侧栏在 `/machines`、`/settings` 等路由下也在，而列表页此时根本没挂载）。
 * 用 search param 当开关，侧栏与列表入口都通过 setParams 保留当前路由，
 * 不需要跨树传 state，返回键也能关掉 sheet。
 *
 * 预选（plan §3）：`?new=1&nm=<machineId>&ncwd=<path>` 是一次性 intent——sheet 每次
 * 打开时消费它并覆盖上次的选择；关闭（成功或取消）时连同 `new` 一起清掉，保留其他
 * 查询参数与 location.state（文件面板等靠 state 记录历史深度）。
 *
 * 同一时刻只会有一处挂载 `<NewSessionSheetRoute>`：移动端在列表页 / 机器详情页，
 * PC 在侧栏（移动端不渲染侧栏；PC 的 `/` 主区是空态而不是列表页）。
 */
import { useCallback } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { NewSessionSheet } from './NewSessionSheet.tsx';

export const NEW_SESSION_PARAM = 'new';
export const NEW_SESSION_MACHINE_PARAM = 'nm';
export const NEW_SESSION_CWD_PARAM = 'ncwd';

/** 预选的机器 + 目录 */
export interface NewSessionIntent {
  machineId: string;
  cwd: string;
}

/** 从查询参数读 intent；没有 / 不完整 = null */
export function readNewSessionIntent(params: URLSearchParams): NewSessionIntent | null {
  if (params.get(NEW_SESSION_PARAM) !== '1') return null;
  const machineId = params.get(NEW_SESSION_MACHINE_PARAM) ?? '';
  const cwd = params.get(NEW_SESSION_CWD_PARAM) ?? '';
  return machineId === '' ? null : { machineId, cwd };
}

/** 打开 / 关闭后的查询参数：开时写入（或清掉旧的）intent，关时一并清掉；其他参数不动 */
export function nextNewSessionParams(
  prev: URLSearchParams,
  open: boolean,
  intent?: NewSessionIntent,
): URLSearchParams {
  const search = new URLSearchParams(prev);
  search.delete(NEW_SESSION_MACHINE_PARAM);
  search.delete(NEW_SESSION_CWD_PARAM);
  if (!open) {
    search.delete(NEW_SESSION_PARAM);
    return search;
  }
  search.set(NEW_SESSION_PARAM, '1');
  if (intent !== undefined) {
    search.set(NEW_SESSION_MACHINE_PARAM, intent.machineId);
    search.set(NEW_SESSION_CWD_PARAM, intent.cwd);
  }
  return search;
}

/**
 * `[open, setOpen, openIn, intent]`。`setOpen(true)` 是不带预选的打开；`openIn(m, cwd)` 带预选。
 */
export function useNewSessionSheet(): [
  boolean,
  (open: boolean) => void,
  (machineId: string, cwd: string) => void,
  NewSessionIntent | null,
] {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const state: unknown = location.state;
  const open = params.get(NEW_SESSION_PARAM) === '1';
  const intent = readNewSessionIntent(params);
  const setOpen = useCallback(
    (next: boolean): void => {
      setParams((prev) => nextNewSessionParams(prev, next), { replace: true, state });
    },
    [setParams, state],
  );
  const openIn = useCallback(
    (machineId: string, cwd: string): void => {
      setParams((prev) => nextNewSessionParams(prev, true, { machineId, cwd }), { replace: true, state });
    },
    [setParams, state],
  );
  return [open, setOpen, openIn, intent];
}

export function NewSessionSheetRoute(): React.JSX.Element {
  const [open, setOpen, , intent] = useNewSessionSheet();
  return <NewSessionSheet open={open} onOpenChange={setOpen} intent={intent} />;
}
