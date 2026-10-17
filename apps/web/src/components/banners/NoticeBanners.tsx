/**
 * notice 承接：需要一键恢复的走常驻横幅，纯告知的走 toast。
 *
 * - `CursorResetBar`：游标倒退探测（方案 §4.3 / 评审 B6）与 scope fatal
 *   （`seq_too_far_ahead`）。这两条的共同点是**只有用户点一下才能恢复**，
 *   所以必须常驻——toast 飘走之后用户就再也找不到恢复入口了。
 * - `NoticeToasts`：机器级 `error.fatal`、outbox 放弃自愈。它们是「已经发生
 *   且没有一键解法」的事实通报，toast 合适；同一条 notice 只弹一次
 *   （store 的 notices 是累积列表，重渲染不该重复弹）。
 */
import { useEffect, useRef } from 'react';
import { AlertTriangleIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { useClient, useTrine } from '@/app/runtime.ts';
import { Bar } from './Bar.tsx';
import { noticeView } from './conditions.ts';

function useMachineName(): (machineId: string) => string {
  const machines = useTrine((s) => s.machines);
  return (machineId: string) => machines[machineId]?.name ?? machineId;
}

export function CursorResetBar(): React.JSX.Element | null {
  const notices = useTrine((s) => s.notices);
  const dismiss = useTrine((s) => s.dismissNotice);
  const client = useClient();
  const machineName = useMachineName();

  const bars = notices.filter((n) => noticeView(n, machineName).placement === 'bar');
  if (bars.length === 0) return null;

  return (
    <>
      {bars.map((entry) => {
        const view = noticeView(entry, machineName);
        const n = entry.notice;
        const run = (): void => {
          if (n.kind === 'cursor_regression') client?.resetScopeCursor(n.machineId, n.scope);
          else if (n.kind === 'scope_fatal') client?.resetOutSeq(n.machineId, n.scope);
          dismiss(entry.id);
        };
        return (
          <Bar
            key={entry.id}
            tone="red"
            testId="banner-cursor-reset"
            icon={<AlertTriangleIcon className="size-3.5 shrink-0" />}
            actions={
              <>
                {view.actionLabel !== null && (
                  <Button size="xs" variant="outline" data-testid="cursor-reset-action" onClick={run}>
                    {view.actionLabel}
                  </Button>
                )}
                <Button size="xs" variant="ghost" onClick={() => dismiss(entry.id)}>
                  关闭
                </Button>
              </>
            }
          >
            {view.text}
          </Bar>
        );
      })}
    </>
  );
}

export function NoticeToasts(): null {
  const notices = useTrine((s) => s.notices);
  const machineName = useMachineName();
  const shown = useRef(new Set<string>());

  useEffect(() => {
    for (const entry of notices) {
      const view = noticeView(entry, machineName);
      if (view.placement !== 'toast' || shown.current.has(entry.id)) continue;
      shown.current.add(entry.id);
      toast.error(view.text, { duration: 8_000 });
    }
    // machineName 每次渲染都是新函数，故意不进依赖：notices 变了才需要重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notices]);

  return null;
}
