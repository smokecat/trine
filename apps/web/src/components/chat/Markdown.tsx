/**
 * assistant 文本的 markdown 渲染：streamdown（流式安全的增量 markdown）。
 *
 * ## 为什么是 streamdown 而不是 react-markdown
 *
 * 流式文本天然会在半个语法结构上停住——`**加粗` 只到一半、代码围栏只开了
 * 没关。普通 markdown 渲染器会把这些原样吐出来，于是回复过程中满屏的
 * 星号与反引号在闪。streamdown 的 `parseIncompleteMarkdown` 专治这个。
 *
 * ## 零远端资源（方案 §4.1）
 *
 * - 核心包不拉网；代码高亮用 `@streamdown/code` 的 shiki **JS 引擎**，
 *   语法与主题都打进 bundle，不走 CDN、不 fetch wasm；
 * - `@streamdown/math` / mermaid **不装**——MVP 用不上，且它们会引入远端
 *   资源与大体积依赖；
 * - `linkSafety` 不开（它要外部检查）；
 * - **图片一律不外连**（见下）。
 * 构建后 `dist/` 的外链 grep 是这条约束在构建产物上的守门测。
 *
 * ## 为什么必须自己挡图片（M4）
 *
 * streamdown 2.6.0 的 harden 默认是 `allowedImagePrefixes:['*']`——assistant
 * 文本里一个 `![x](http://evil.example/x.png)` 就会让**用户的浏览器**去请求
 * 攻击者的域名，泄露手机 IP、在线时刻与会话活跃信号。而 assistant 文本并不
 * 可信：agent 的工具输出（WebFetch 到一个恶意页面）经提示注入就能把它写进来。
 *
 * 同源托管时服务端的 CSP `img-src 'self' data: blob:` 会挡住，但 dev、
 * `vite preview`、以及 D11 的分离部署都没有那层；零知识的姿态下不该只靠
 * 一道 CSP。所以在渲染层直接用 `urlTransform` 掐断：
 * - `img`：只放行 `data:` 与同源相对路径，其余一律丢（返回 null → 不设 src）；
 * - `a`：http(s) 保留（用户主动点击才会离开，且 target/rel 由 streamdown 处理），
 *   其余协议交给 streamdown 原有的 sanitize（`javascript:` 已被它替换成 [blocked]）。
 *
 * ## `urlTransform` 不够（N1）：`<source>` 整个不渲染
 *
 * `urlTransform` 只作用于 `html-url-attributes` 的 `urlAttributes` 表，那张表
 * **不含 `srcset`**。于是 raw HTML 里的
 * `<picture><source srcset="http://evil.example/x.png"><img></picture>`
 * 原样渲染，浏览器按 picture 选源规则**真的去请求**它——评审用 Playwright
 * 量到了实际 GET，而且 `<img>` 被挡掉时 `<source>` 依然供图，观感上「图片
 * 正常显示」反而更不容易被发现。
 *
 * 修法取最彻底的一条：`components={{ source: () => null }}`——`<source>` 只在
 * `<picture>` / `<video>` / `<audio>` 里有意义，这三者 MVP 都用不上（响应式
 * 图片没有需求，媒体标签本就被 sanitize 清空），整个不渲染零代价。
 * 守门测是 `markdown-render.test.tsx`：25 条载荷过**真实渲染**，断言输出
 * 不含攻击者域名——纯函数测试测不出「管线里还有别的属性能带 URL 出去」。
 *
 * ## 主题
 *
 * shiki 双主题 `[github-light, github-dark]` 由 streamdown 按 CSS 变量切，
 * 与 app/theme.ts 的三态主题自洽（跟随 `prefers-color-scheme` 与 `.dark`）。
 */
import { memo } from 'react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { cn } from '@/lib/utils.ts';

/** 插件实例提到模块级：每次渲染新建会丢掉 shiki 已加载的语言缓存 */
const plugins = { code };

/**
 * `<source>` 一律不渲染（N1）。
 *
 * `srcset` 不在 `urlTransform` 能管到的属性表里，`<picture><source srcset=…>`
 * 会绕过图片拦截真的外连。MVP 不需要响应式图片，整个节点丢掉最彻底。
 * 同样提到模块级：内联箭头函数每次渲染都是新 type，会让整棵子树重挂。
 */
const components = { source: (): null => null };

/** 图片允许的来源：内联数据，以及同源相对路径（`/x.png`、`./x.png`） */
function isAllowedImageUrl(url: string): boolean {
  if (url.startsWith('data:image/')) return true;
  // 相对路径（不含协议、不是协议相对 `//host/x`）
  return !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//');
}

/**
 * 掐断外连：`img` 的 src 只放行 data: 与同源相对路径。
 *
 * 返回 `null` 让 react-markdown 不设该属性——图片渲染成空 `<img>`，
 * 浏览器不会发出任何请求。
 */
export function safeUrlTransform(url: string, key: string): string | null {
  if (key === 'src') return isAllowedImageUrl(url) ? url : null;
  return url;
}

export const Markdown = memo(function Markdown({
  text,
  streaming,
  className,
}: {
  text: string;
  /** 还在流式接收：开 streaming 模式（增量解析 + 未闭合语法修补） */
  streaming: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      parseIncompleteMarkdown={streaming}
      plugins={plugins}
      // 零远端资源：外域图片一律不请求（streamdown 默认放行 '*'，见文件头 M4）
      urlTransform={safeUrlTransform}
      // `<source srcset>` 绕过 urlTransform（见文件头 N1）：整个不渲染
      components={components}
      shikiTheme={['github-light', 'github-dark']}
      // 代码块只留复制（下载会触发浏览器下载，远程场景意义不大）
      controls={{ code: { copy: true, download: false }, table: { copy: true, download: false } }}
      lineNumbers={false}
      // 动画交给流式本身：逐词淡入在长回复里会拖慢观感
      animated={false}
      className={cn(
        'max-w-full text-[14px] leading-[1.55] break-words',
        '[&_p]:my-0 [&_p+p]:mt-2',
        '[&_pre]:bg-code-bg [&_pre]:border-border [&_pre]:rounded-lg [&_pre]:border',
        '[&_code]:font-mono [&_code]:text-[12.5px]',
        '[&_:not(pre)>code]:bg-code-bg [&_:not(pre)>code]:rounded [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5',
        '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_li]:my-0.5',
        '[&_h1]:mt-3 [&_h1]:mb-1.5 [&_h1]:text-[16px] [&_h1]:font-semibold',
        '[&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-[15px] [&_h2]:font-semibold',
        '[&_h3]:mt-2.5 [&_h3]:mb-1 [&_h3]:text-[14px] [&_h3]:font-semibold',
        '[&_a]:text-brand-ink [&_a]:underline',
        '[&_blockquote]:border-border-strong [&_blockquote]:text-text-2 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-3',
        '[&_table]:text-[12.5px] [&_th]:border-border [&_td]:border-border [&_th]:border [&_td]:border [&_th]:px-2 [&_td]:px-2 [&_th]:py-1 [&_td]:py-1',
        '[&_hr]:border-border [&_hr]:my-3',
        className,
      )}
    >
      {text}
    </Streamdown>
  );
});
