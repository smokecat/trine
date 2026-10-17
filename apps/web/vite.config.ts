import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * Vite 配置。
 *
 * ## libsodium 与裸 `import "libsodium"`（任务 R1 的结论）
 *
 * 仓库对 `libsodium-wrappers` 打了补丁（patches/），把它 ESM 入口里的
 * `import e from "./libsodium.mjs"` 改成裸包名 `import e from "libsodium"`
 * ——为的是让 Bun 能解析。担心的是 Vite 解析不了这个裸名，需要 alias 兜底。
 *
 * **实测不需要任何额外配置**：`libsodium` 是 npm 上真实存在的包
 * （libsodium-wrappers 的 dependency），bun 把它装成 libsodium-wrappers
 * 旁边的兄弟目录，Vite 按 Node 解析规则原样找得到。dev 与 build 都通过。
 *
 * 唯一需要显式写的是 `optimizeDeps.exclude`：libsodium 的 .mjs 是一个
 * 单文件 asm.js/wasm 混合产物（数 MB），把它交给 esbuild 预打包除了拖慢
 * 冷启动没有别的作用，而且预打包过程曾是这类巨型单文件最容易出问题的
 * 一环。排除后 dev 直接按源文件走原生 ESM，反而更稳。
 */
/**
 * 开发期反代目标。默认本机服务端 8787；同机已有别的 trine 服务端占着 8787 时
 * （如主检出在跑），用 `TRINE_DEV_PROXY=http://127.0.0.1:8797 bun run dev:web`
 * 配合 `TRINE_PORT=8797 bun run dev:server` 起第二套。
 */
const proxyTarget = process.env['TRINE_DEV_PROXY'] ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // shadcn 约定的 `@/` 别名（与 tsconfig.json paths 对齐）
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    // 不设 host：默认只听 localhost。手机实测要走 TLS 端点（Tailscale/VPS），
    // 而不是把 dev server 裸暴露到局域网——摄像头 API 也要求安全上下文。
    strictPort: true,
    /**
     * 把服务端的四个入口反代到本机 trine 服务端，让**开发期也是同源**。
     *
     * 这样一来：页面、API、WS 全在 http://localhost:5173 这一个源上，
     * 开发不需要配 TRINE_CORS_ORIGINS，也不会踩 WS 的跨源检查——本地跑的
     * 形态与生产的 TRINE_WEB_DIST 同源托管一致，少一类「只在开发出现」
     * 的问题。
     *
     * agent 那侧对应地用 `--server http://localhost:5173`：
     * core 的 pairing.ts 对回环地址豁免 TLS 要求，`localhost` 在豁免名单里，
     * 所以配对码能正常生成。
     *
     * 完整开发闭环见 README.md。
     */
    proxy: {
      '/ws': { target: proxyTarget, ws: true },
      '/auth': { target: proxyTarget },
      '/healthz': { target: proxyTarget },
      '/devices': { target: proxyTarget },
    },
  },
  preview: {
    port: 5173,
    strictPort: true,
    // preview 不读 server.proxy，得单独给一份同样的反代（本机自测用）
    proxy: {
      '/ws': { target: proxyTarget, ws: true },
      '/auth': { target: proxyTarget },
      '/healthz': { target: proxyTarget },
      '/devices': { target: proxyTarget },
    },
  },
  optimizeDeps: {
    // 见上：巨型单文件 wasm 产物不值得预打包
    exclude: ['libsodium', 'libsodium-wrappers'],
  },
  build: {
    /**
     * 500KB 是给「首屏必下」定的线，而这里超线的几块**全部是按需加载**的：
     * libsodium（client 起来时才拉）、streamdown 核心、以及 shiki 的单个
     * 语言定义（`emacs-lisp` / `cpp` / `wasm` 这些）。首屏实际必下的 JS
     * 是 ~258KB gzip，见下方 codeSplitting 的说明；实际体积以当前构建报告为准。
     *
     * 提到 800KB 而不是关掉：真有东西掉进首屏并超过这个数时，仍然要报。
     */
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      output: {
        /**
         * 手工分组，目的只有一个：**别让 libsodium 压在首屏的关键路径上**。
         *
         * libsodium 的 ESM 产物是个 1MB 的 asm.js/wasm 混合单文件（gzip 后
         * 仍有 330KB+）。它被 `@trine/core/crypto` 静态引入，不分组时会和
         * 随便哪个共享模块打成一个 chunk（实测跟 `textarea` 打在一起），
         * 名字既看不出内容，又被 `modulepreload` 拉进首屏必下集合。
         *
         * 单独成组之后它仍然会被加载（`sodiumReady()` 在启动就要 await），
         * 但至少是一个名副其实、可独立缓存、不跟业务代码一起失效的 chunk
         * ——业务代码每次发版都变，libsodium 几乎不变。
         *
         * **不给 react 单独分组**：实测按路径分组会让 react-dom 落到
         * development 构建（`captureOwnerStack` 出现在产物里，431KB 未压），
         * 分组规则绕过了 Vite 对 `process.env.NODE_ENV` 的条件解析。
         * 交给默认分块即可。
         *
         * shiki 的语言定义不在这里管：`@streamdown/code` 通过
         * `bundledLanguages` 的动态 import 按需加载，每种语言天然就是一个
         * 独立 chunk（构建产物里那几百个 `cpp-*.js` / `emacs-lisp-*.js`），
         * **不进首屏**——它们只在真的渲染到该语言的代码块时才拉。
         */
        codeSplitting: {
          groups: [
            /**
             * Vite 的 `__vite_preload` 助手先单独占一组。
             *
             * 它是个虚拟模块，每个动态 import 都要用，因而**被 entry 静态依赖**。
             * 不显式分出来的话它会被并进碰巧第一个需要它的分组——实测并进了
             * libsodium 那组，于是 entry 为了拿这个几百字节的助手，把整块
             * 730KB 一起钉进了必下集合，分组白做。
             */
            { name: 'vite-preload', test: /preload[-_]?helper|vite[\\/]preload/ },
            // 只匹配包目录本身（`node_modules/**/libsodium*/`）
            { name: 'libsodium', test: /[\\/]node_modules[\\/][^\\/]*libsodium[^\\/]*[\\/]/ },
          ],
        },
      },
    },
  },
});
