/**
 * @trine/web 入口：挂 React，其余交给 app/App.tsx（运行时启动 + 路由）。
 * 协议层在 src/lib/，状态镜像在 src/store/，页面在 src/views/。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { initTheme } from './app/theme.ts';
import './styles.css';

// 在 render 之前贴主题，避免首屏从浅色闪到深色（见 app/theme.ts）
initTheme();

const root = document.getElementById('root');
if (!root) throw new Error('#root 不存在：index.html 被改坏了');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
