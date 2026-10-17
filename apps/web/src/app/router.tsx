/**
 * 路由（react-router 7 data router）。
 *
 *   /                          会话列表（移动端完整列表；PC 上主区空态，列表在侧栏）
 *   /archived                  已归档会话（移动端整页；PC 渲染在主区，侧栏仍是未归档列表）
 *   /s/:machineId/:sessionId   聊天
 *   /machines                  机器卡片列表
 *   /machines/:machineId       机器详情（改名 / 从本设备移除 / 重置游标）
 *   /pair                      配对
 *   /settings                  设置
 *
 * 视图文件的 2b 分工见 apps/web/README.md「阶段 2b 分工」。
 *
 * ## 为什么聊天页与配对页走 `lazy`
 *
 * 这两条路由各自独占一坨大依赖，而首屏（会话列表）一个都用不上：
 * - 聊天页 → streamdown + `@streamdown/code`（shiki 的 JS 引擎）；
 * - 配对页 → jsqr。
 *
 * 全静态引入时它们会跟首屏代码打进同一个 entry chunk，手机上首次打开要先
 * 下完几百 KB 才看得到列表。`lazy` 把它们切成按需加载的独立 chunk——真正
 * 进到那条路由才拉，且浏览器会缓存。
 *
 * 其余视图（列表/归档/机器/设置）都很小，切分的收益抵不过多一次请求，保持静态。
 */
import { createBrowserRouter } from 'react-router';
import { Layout } from './Layout.tsx';
import { ArchivedView } from '../views/ArchivedView.tsx';
import { MachineDetailView } from '../views/MachineDetailView.tsx';
import { MachinesView } from '../views/MachinesView.tsx';
import { SessionListView } from '../views/SessionListView.tsx';
import { SettingsView } from '../views/SettingsView.tsx';

export const router = createBrowserRouter([
  {
    path: '/',
    Component: Layout,
    children: [
      { index: true, Component: SessionListView },
      { path: 'archived', Component: ArchivedView },
      {
        path: 's/:machineId/:sessionId',
        lazy: async () => ({ Component: (await import('../views/ChatView.tsx')).ChatView }),
      },
      { path: 'machines', Component: MachinesView },
      { path: 'machines/:machineId', Component: MachineDetailView },
      {
        path: 'pair',
        lazy: async () => ({ Component: (await import('../views/PairView.tsx')).PairView }),
      },
      { path: 'settings', Component: SettingsView },
    ],
  },
]);
