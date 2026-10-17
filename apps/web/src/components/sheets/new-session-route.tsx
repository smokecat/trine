/**
 * 新建会话 sheet 的「URL 开关」：`?new=1` 打开。
 *
 * 为什么挂 URL 而不是组件 state：这个 sheet 有两个入口，而它们在两套布局里
 * 分属不同的组件树——移动端是列表页的 FAB，PC 是常驻侧栏底部的「+ 新建」
 * （侧栏在 `/machines`、`/settings` 等路由下也在，而列表页此时根本没挂载）。
 * 用 search param 当开关，两个入口都只是 `navigate('/?new=1')` 或 setParams，
 * 不需要跨树传 state，返回键也能关掉 sheet。
 *
 * 同一时刻只会有一处挂载 `<NewSessionSheetRoute>`：移动端在列表页，PC 在侧栏
 * （移动端不渲染侧栏；PC 的 `/` 主区是空态而不是列表页）。
 */
import { useSearchParams } from 'react-router';
import { NewSessionSheet } from './NewSessionSheet.tsx';

export const NEW_SESSION_PARAM = 'new';

export function useNewSessionSheet(): [boolean, (open: boolean) => void] {
  const [params, setParams] = useSearchParams();
  const open = params.get(NEW_SESSION_PARAM) === '1';
  const setOpen = (next: boolean): void => {
    setParams(
      (prev) => {
        const search = new URLSearchParams(prev);
        if (next) search.set(NEW_SESSION_PARAM, '1');
        else search.delete(NEW_SESSION_PARAM);
        return search;
      },
      { replace: true },
    );
  };
  return [open, setOpen];
}

export function NewSessionSheetRoute(): React.JSX.Element {
  const [open, setOpen] = useNewSessionSheet();
  return <NewSessionSheet open={open} onOpenChange={setOpen} />;
}
