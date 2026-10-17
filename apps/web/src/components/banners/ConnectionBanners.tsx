/**
 * 连接相关的横幅：重连倒计时（原型 `.reconnect-bar`）与 4006 需升级。
 *
 * 倒计时每 500ms 重算一次；不在 backoff 时不起定时器（避免整页每半秒重渲染）。
 */
import { useEffect, useState } from 'react';
import { AlertTriangleIcon, RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { useClient, useTrine } from '@/app/runtime.ts';
import { Bar } from './Bar.tsx';
import { connectionBanner, reconnectText } from './conditions.ts';

/** 只在需要倒计时的时候起定时器 */
function useTicker(active: boolean, intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
}

/**
 * 断连细条。
 *
 * - `backoff` 给倒计时 + 「立即重连」→ `wake()`（把已安排的那次重连提前）；
 * - `connecting` / `authenticating` 给「重试」→ 同样走 `wake()`。这两态原本
 *   **一个按钮都没有**，而它们可以永久卡住（半开连接），用户只能刷新页面
 *   （评审 N3）。现在 25s 有看门狗兜底，按钮则让用户不必干等：`wake()` 对
 *   超过 `STALE_CONNECTING_MS` 的中间态会掐断重来（没到点就什么都不做，
 *   免得打断一次正常的认证往返）；
 * - `stopped`：**不给按钮**。这个态只在「主标签让位」时出现，而那时
 *   `ClientLifecycle.dispose()` 已经把 client 置空（`useClient()` 返回 null），
 *   早先这里的 `client?.start()` 是个永远点不动的死按钮。真正的恢复路径是
 *   LeaderBar 的「在此接管」或刷新页面，文案直接指过去（评审复核项 13）。
 */
export function ReconnectBar(): React.JSX.Element | null {
  const connection = useTrine((s) => s.connection);
  const paired = useTrine((s) => s.paired);
  const queued = useTrine((s) => s.queuedCount);
  const client = useClient();
  const counting = connection.status === 'backoff';
  const now = useTicker(counting);

  const banner = connectionBanner(connection, paired, now);
  if (banner.kind === 'none' || banner.kind === 'upgrade') return null;

  const queueSuffix = queued > 0 ? ` · 待发 ${queued} 条` : '';

  if (banner.kind === 'reconnect') {
    return (
      <Bar
        testId="banner-reconnect"
        icon={<RefreshCwIcon className="size-3.5 shrink-0 motion-safe:animate-spin" />}
        actions={
          <Button size="xs" variant="outline" data-testid="reconnect-now" onClick={() => client?.wake()}>
            立即重连
          </Button>
        }
      >
        {reconnectText(banner.attempt, banner.secondsLeft)}
        {queueSuffix}
      </Bar>
    );
  }

  if (banner.kind === 'connecting') {
    return (
      <Bar
        testId="banner-connecting"
        icon={<RefreshCwIcon className="size-3.5 shrink-0 motion-safe:animate-spin" />}
        actions={
          <Button size="xs" variant="outline" data-testid="connecting-retry" onClick={() => client?.wake()}>
            重试
          </Button>
        }
      >
        {banner.text}
        {queueSuffix}
      </Bar>
    );
  }

  return (
    <Bar testId="banner-stopped">
      {banner.text}
      {queueSuffix}
    </Bar>
  );
}

/**
 * 4006（协议版本不符）。服务端明确拒绝了这个客户端版本，重连只会再被拒，
 * 所以文案写「已停止重连」并要求刷新——刷新会拉到新版静态资源。
 */
export function UpgradeBar(): React.JSX.Element | null {
  const connection = useTrine((s) => s.connection);
  const paired = useTrine((s) => s.paired);
  if (connectionBanner(connection, paired, Date.now()).kind !== 'upgrade') return null;
  return (
    <Bar
      tone="red"
      testId="banner-upgrade"
      icon={<AlertTriangleIcon className="size-3.5 shrink-0" />}
      actions={
        <Button size="xs" variant="outline" onClick={() => window.location.reload()}>
          刷新页面
        </Button>
      }
    >
      服务端协议版本不符，需要升级客户端（已停止重连）
    </Bar>
  );
}
