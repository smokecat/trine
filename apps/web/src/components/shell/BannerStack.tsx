/**
 * 全局横幅区：顶部细条堆叠，所有路由共享（挂在 Layout 顶部）。
 *
 * 本文件只负责**堆叠与顺序**，条目本身在 `components/banners/**`（2b shell
 * 组）。顺序（上 → 下）按「用户必须先处理哪个」排：
 *   1. 存储不可用——隐私模式下刷新即失忆，最该先知道
 *   2. 需升级（4006）——不处理什么都用不了
 *   3. 标签页归属未定——同上，但有一键出路
 *   4. 断连重连——自动恢复中，告知即可
 *   5. 服务端序号重置 / scope fatal——要用户点一下才能恢复
 *
 * **机器离线不在这里**（评审 C-3）：m6 把它从会话页去重掉之后，剩下的路由
 * 里 machineId 恒为空串，`OfflineBanner` 在全应用不再渲染，成了死代码，
 * 而文件头注释还写着「它仍是全应用横幅的挂点」。离线这件事已经有三处在说
 * ——会话页 composer 上方的 `composerOfflineHint`（贴着「按下发送会发生
 * 什么」，排队数也并了进去）、机器卡的「离线 · 最后在线 …」、列表 chip 的
 * 排队数——所以直接删掉组件与槽位，而不是再给它编一个路由来源。
 *
 * 纯 toast 的通知（机器级 error.fatal、outbox 放弃自愈）由 `NoticeToasts`
 * 承接，它不渲染任何 DOM，挂在这里只是图个统一的生命周期。
 */
import { AlertTriangleIcon } from 'lucide-react';
import { Bar } from '@/components/banners/Bar.tsx';
import { ReconnectBar, UpgradeBar } from '@/components/banners/ConnectionBanners.tsx';
import { LeaderBar } from '@/components/banners/LeaderBar.tsx';
import { CursorResetBar, NoticeToasts } from '@/components/banners/NoticeBanners.tsx';

/** 存储不可用（隐私模式）——不是协议问题，但后果严重，值一条常驻细条 */
export function StorageBar({ persistent }: { persistent: boolean }): React.JSX.Element | null {
  if (persistent) return null;
  return (
    <Bar testId="banner-storage" icon={<AlertTriangleIcon className="size-3.5 shrink-0" />}>
      浏览器存储不可用（隐私模式？）：本次会话的身份与历史刷新后即丢失
    </Bar>
  );
}

export function BannerStack({ persistent }: { persistent: boolean }): React.JSX.Element {
  return (
    <div className="shrink-0">
      <StorageBar persistent={persistent} />
      <UpgradeBar />
      <LeaderBar />
      <ReconnectBar />
      <CursorResetBar />
      <NoticeToasts />
    </div>
  );
}
