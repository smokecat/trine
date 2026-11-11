/**
 * 工作区懒加载入口：dockview 运行时与它的 CSS 只在这里 import，Vite 拆成独立 chunk（JS + CSS），
 * 首次展开工作区（或桌面空闲预取）时才下载，主包不变。
 */
import 'dockview-react/dist/styles/dockview.css';
import './dockview-theme.css';

export { default } from './WorkspaceDock.tsx';
