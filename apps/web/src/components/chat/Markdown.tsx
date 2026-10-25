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
import { memo, useContext } from 'react';
import { defaultRehypePlugins, Streamdown, type StreamdownProps } from 'streamdown';
import { code } from '@streamdown/code';
import { ImageIcon } from 'lucide-react';
import { decodeHref, detectPath, isLocalHref, resolveRelative } from '@/components/files/file-model.ts';
import { FileBaseContext, useFileLinks } from '@/components/files/file-links.ts';
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

/**
 * 本地路径可点（聊天页提供了 FileLinksContext 时）：
 * - 行内代码里像路径的（`docs/plan.md`、`src/a.ts:12`）→ 打开文件预览，以 `/` 结尾的打开目录；
 * - 没有协议的链接（`[方案](docs/plan.md)`）→ 同上。预览 markdown 文件时（FileBaseContext）
 *   相对链接按**该文件所在目录**解析，否则相对会话 cwd。
 * 其余链接照常（新标签打开）。
 */
function FileAwareInlineCode({ children, className, node: _node, ...props }: React.ComponentProps<'code'> & { node?: unknown }): React.JSX.Element {
  const links = useFileLinks();
  const text = typeof children === 'string' ? children : Array.isArray(children) && children.every((c) => typeof c === 'string') ? children.join('') : undefined;
  const detected = links === null || text === undefined ? undefined : detectPath(text);
  const codeEl = (
    <code {...props} data-streamdown="inline-code" className={cn('rounded bg-muted px-1.5 py-0.5 font-mono text-sm', className)}>
      {children}
    </code>
  );
  if (links === null || detected === undefined) return codeEl;
  return (
    <button
      type="button"
      data-testid="file-link"
      data-path={detected.path}
      title={detected.dir ? `浏览目录 ${detected.path}` : `预览 ${detected.path}`}
      onClick={() => (detected.dir ? links.browse(detected.path) : links.open(detected.path))}
      className="cursor-pointer align-baseline decoration-dotted underline-offset-2 hover:underline"
    >
      {codeEl}
    </button>
  );
}

function FileAwareLink({
  href,
  children,
  className,
  node: _node,
  'data-file-href': fileHref,
  ...props
}: React.ComponentProps<'a'> & { node?: unknown; 'data-file-href'?: string }): React.JSX.Element {
  const links = useFileLinks();
  const base = useContext(FileBaseContext);
  if (links !== null && typeof fileHref === 'string') {
    // 先去掉 ?query / #锚点 再解码（文件名里的 %23 解码后是 #，不能再被当锚点切掉）
    const href = decodeHref(fileHref.replace(/[?#].*$/, ''));
    const target = base === undefined ? href : resolveRelative(base, href);
    // 聊天里只认像路径的（`[x](foo)` 这种裸词不算）；文件里的相对链接都当文件
    const detected = base === undefined ? detectPath(target) : { path: target, dir: target.endsWith('/') };
    if (detected !== undefined) {
      return (
        <button
          type="button"
          data-testid="file-link"
          data-path={detected.path}
          title={detected.path}
          onClick={() => (detected.dir ? links.browse(detected.path) : links.open(detected.path))}
          className={cn('text-brand-ink cursor-pointer text-left underline', className)}
        >
          {children}
        </button>
      );
    }
    return <span className={className}>{children}</span>;
  }
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer" className={cn('wrap-anywhere font-medium underline', className)}>
      {children}
    </a>
  );
}

/** 预览 markdown 文件时的图片：不加载（同源相对路径会打到 web 服务），给一个打开该图片的按钮 */
function FileDocImage({
  alt,
  'data-file-href': fileHref,
}: React.ComponentProps<'img'> & { node?: unknown; 'data-file-href'?: string }): React.JSX.Element | null {
  const links = useFileLinks();
  const base = useContext(FileBaseContext);
  // 外部图片一律不显示（零远端资源）；本地图片只给按钮
  if (links === null || base === undefined || typeof fileHref !== 'string') return null;
  const target = resolveRelative(base, decodeHref(fileHref.replace(/[?#].*$/, '')));
  return (
    <button
      type="button"
      data-testid="file-doc-image"
      data-path={target}
      onClick={() => links.open(target)}
      className="border-border bg-surface-2 text-text-2 hover:text-text inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[12px]"
    >
      <ImageIcon className="size-3.5" />
      {alt !== undefined && alt !== '' ? alt : target.slice(target.lastIndexOf('/') + 1)}
    </button>
  );
}

const fileComponents = { source: (): null => null, inlineCode: FileAwareInlineCode, a: FileAwareLink };
const fileDocComponents = { ...fileComponents, img: FileDocImage };

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * 在 harden 之前把本地链接（以及文件预览里的本地图片）的**原始**地址存进 `data-file-href`，
 * 地址本身换成占位 `/`：harden 会把 `../x.md` 归一成 `/x.md`、把 `docs/a.md` 这种裸相对路径
 * 直接拦成 [blocked]，组件拿不到原文就没法按文件目录解析。放在 sanitize 之后，自定义属性不会被剥。
 */
function stashLocalUrls(tree: HastNode, images: boolean): void {
  const props = tree.properties;
  if (tree.type === 'element' && props !== undefined) {
    if (tree.tagName === 'a' && typeof props['href'] === 'string' && isLocalHref(props['href'])) {
      props['dataFileHref'] = props['href'];
      props['href'] = '/'; // harden 认得的同源路径（`#`、裸相对路径会被它拦掉）；组件不用它
    } else if (images && tree.tagName === 'img' && typeof props['src'] === 'string' && isLocalHref(props['src'])) {
      props['dataFileHref'] = props['src'];
      props['src'] = '/';
    }
  }
  for (const child of tree.children ?? []) stashLocalUrls(child, images);
}

// 两个插件必须是**不同名**的具名函数：streamdown 按插件函数名缓存 unified 处理器，
// 同名（或都是匿名箭头函数）会让聊天与文件预览共用同一个处理器
function rehypeStashFileLinks() {
  return (tree: HastNode): void => stashLocalUrls(tree, false);
}
function rehypeStashFileLinksAndImages() {
  return (tree: HastNode): void => stashLocalUrls(tree, true);
}

type Pluggable = NonNullable<StreamdownProps['rehypePlugins']>[number];
const { raw, sanitize, harden } = defaultRehypePlugins as Record<'raw' | 'sanitize' | 'harden', Pluggable>;
const fileRehypePlugins: Pluggable[] = [raw, sanitize, rehypeStashFileLinks, harden];
const fileDocRehypePlugins: Pluggable[] = [raw, sanitize, rehypeStashFileLinksAndImages, harden];

/**
 * 扩展给的详情文本（`restricted`）更严：图片一律不渲染（同源相对图片也会把文本带进请求 URL、
 * 暴露给 relay），链接只留 https。
 */
const restrictedComponents = { source: (): null => null, img: (): null => null };

export function restrictedUrlTransform(url: string, key: string): string | null {
  if (key === 'src') return null;
  if (key === 'href') return /^https:\/\//i.test(url) ? url : null;
  return url;
}

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
  restricted = false,
  fileBase,
  fullHeightCode = false,
}: {
  text: string;
  /** 还在流式接收：开 streaming 模式（增量解析 + 未闭合语法修补） */
  streaming: boolean;
  className?: string;
  /** 扩展输出：禁图、链接只留 https（见 restrictedComponents） */
  restricted?: boolean;
  /** 预览中的 markdown 文件路径：相对链接与图片相对它解析（见 FileBaseContext） */
  fileBase?: string;
  /** 代码块不限高（文件预览整页看源码）；默认 400px 内滚动 */
  fullHeightCode?: boolean;
}): React.JSX.Element {
  const links = useFileLinks();
  const mode = restricted || links === null ? 'plain' : fileBase === undefined ? 'chat' : 'doc';
  const chosen = restricted ? restrictedComponents : mode === 'chat' ? fileComponents : mode === 'doc' ? fileDocComponents : components;
  const body = (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      parseIncompleteMarkdown={streaming}
      plugins={plugins}
      // 零远端资源：外域图片一律不请求（streamdown 默认放行 '*'，见文件头 M4）
      urlTransform={restricted ? restrictedUrlTransform : safeUrlTransform}
      // `<source srcset>` 绕过 urlTransform（见文件头 N1）：整个不渲染
      components={chosen}
      {...(mode === 'chat' ? { rehypePlugins: fileRehypePlugins } : mode === 'doc' ? { rehypePlugins: fileDocRehypePlugins } : {})}
      shikiTheme={['github-light', 'github-dark']}
      {...(fullHeightCode ? { codeBlockMaxHeight: 0 } : {})}
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
  return fileBase === undefined ? body : <FileBaseContext.Provider value={fileBase}>{body}</FileBaseContext.Provider>;
});
