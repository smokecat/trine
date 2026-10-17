/**
 * shadcn 约定的 `cn` 出口（components.json 的 aliases.utils 指向这里）。
 *
 * shadcn 4.x 的 radix-nova 组件直接 `import { cn } from "cn"`——`cn` 是独立
 * 的 npm 包（clsx + tailwind-merge 的编译期优化版）。本文件保留是为了让
 * 业务代码有一个稳定的、走 `@/` 别名的入口，不必记住包名。
 *
 * 注意：本文件与 `src/lib/` 下的协议层（client / outbox / reducer …）无关，
 * 只是 shadcn 的约定位置。
 */
export { cn } from 'cn';
