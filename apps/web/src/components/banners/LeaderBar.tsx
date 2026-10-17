/**
 * 标签页归属横幅。
 *
 * `leader.state === 'follower'` 在 Layout 里走**整页遮罩**（阶段 2a 定稿的
 * `LeaderOverlay`，共享文件不动）。遮罩在这里是对的：从页根本没有 client，
 * 侧栏与列表的数据源都不存在，渲染半个空壳只会让人以为应用坏了。
 *
 * 所以本条只负责剩下那个态——`idle`（锁还没定归属）。它通常几十毫秒就过去，
 * 停留超过 3 秒才出条，并给「在此接管」这条出路（Web Locks 不可用、退化成
 * 心跳选举时偶尔会卡在这个态）。
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { takeOver, useTrine } from '@/app/runtime.ts';
import { Bar } from './Bar.tsx';
import { leaderBannerVisible } from './conditions.ts';

const THRESHOLD_MS = 3_000;

export function LeaderBar(): React.JSX.Element | null {
  const leader = useTrine((s) => s.leader);
  const idleSince = useRef<number | null>(null);
  const [, bump] = useState(0);

  const isIdle = leader.state === 'idle';
  if (isIdle && idleSince.current === null) idleSince.current = Date.now();
  if (!isIdle) idleSince.current = null;

  // 到点后重渲染一次，把条亮出来
  useEffect(() => {
    if (!isIdle) return;
    const t = setTimeout(() => bump((n) => n + 1), THRESHOLD_MS + 100);
    return () => clearTimeout(t);
  }, [isIdle]);

  if (!leaderBannerVisible(leader, idleSince.current, Date.now(), THRESHOLD_MS)) return null;

  return (
    <Bar
      testId="banner-leader"
      actions={
        <Button size="xs" variant="outline" data-testid="leader-take-over" onClick={() => takeOver()}>
          在此接管
        </Button>
      }
    >
      正在确认标签页归属——本页暂未持有连接
    </Bar>
  );
}
