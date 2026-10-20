/**
 * 机器列表（原型「机器」屏 `#scr-machines`）。
 *
 * 卡片在 `components/machines/MachineCard`；本视图只管排序（在线优先）、
 * 空态与「+ 添加机器」入口。
 */
import { useMemo } from 'react';
import { NavLink } from 'react-router';
import { PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { AppHead } from '@/components/shell/AppHead.tsx';
import { MachineCard } from '@/components/machines/MachineCard.tsx';
import { countActiveSessions, countLiveSessions } from '@/components/list/sorting.ts';
import { useNow } from '@/components/list/use-session-refresh.ts';
import { useTrine } from '@/app/runtime.ts';

export function MachinesView(): React.JSX.Element {
  const machines = useTrine((s) => s.machines);
  const sessions = useTrine((s) => s.sessions);
  const now = useNow();

  const list = useMemo(
    () =>
      Object.values(machines).sort(
        (a, b) =>
          Number(b.online === true) - Number(a.online === true) ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      ),
    [machines],
  );

  return (
    <>
      <AppHead
        back="/"
        title="机器"
        right={
          <Button size="sm" variant="outline" asChild data-testid="add-machine">
            <NavLink to="/pair">
              <PlusIcon />
              添加机器
            </NavLink>
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-3">
        {list.length === 0 && (
          <div className="text-text-3 flex flex-col items-center gap-3 px-4 py-10 text-center text-sm">
            还没有配对任何机器。
            <Button size="sm" asChild>
              <NavLink to="/pair">配对第一台机器</NavLink>
            </Button>
          </div>
        )}
        {list.map((m) => (
          <MachineCard
            key={m.machineId}
            machine={m}
            activeCount={countActiveSessions(sessions[m.machineId])}
            liveCount={countLiveSessions(sessions[m.machineId])}
            now={now}
          />
        ))}
      </div>
    </>
  );
}
