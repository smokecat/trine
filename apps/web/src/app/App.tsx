/**
 * 根组件：启动运行时并挂路由。阶段 0 的 libsodium 自检已由 TrineClient.create
 * 内部的 sodiumReady() 取代——真链路里第一帧密文解不开会直接体现为配对失败。
 */
import { useEffect } from 'react';
import { RouterProvider } from 'react-router';
import { router } from './router.tsx';
import { boot } from './runtime.ts';

export function App(): React.JSX.Element {
  useEffect(() => {
    void boot();
  }, []);
  return <RouterProvider router={router} />;
}
