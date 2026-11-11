/**
 * Markdown 文件预览的浮动目录（方案 §6）与锚点定位。
 *
 * - 标题列表在渲染提交后从**预览根节点**读（`[data-heading-slug]`），内容变化（刷新、源码/渲染切换、
 *   异步解码）由 MutationObserver 触发重读；不从 rehype 插件往外回调。
 * - 只在本预览的滚动容器内定位：按 id / slug 找元素、算相对容器的位置后 scrollTo，不用 location.hash；
 *   用户主动跳转后焦点移到目标标题（tabIndex=-1，preventScroll）。
 * - 当前节：以阅读线为准，scroll 事件 rAF 合并计算，尺寸变化重算，IntersectionObserver 补充。
 * - 平滑滚动尊重 prefers-reduced-motion。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TableOfContentsIcon } from 'lucide-react';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { targetForClick, type FileOpenTarget } from './file-links.ts';
import { activeIndex, resolveAnchor, tocItems, type AnchorTarget, type TocItem } from './toc-model.ts';

/** 点了目录项：`target` 按修饰键给（Alt = side）；返回 true 表示焦点已移到目标 */
export type TocJump = (slug: string, target: FileOpenTarget) => boolean | void;

/** 预览根节点的标记（FileViewer 渲染 markdown 时加在外层） */
export const PREVIEW_ROOT_ATTR = 'data-file-preview';
/** 容器至少这么宽才用右侧 sticky 栏，否则右上角按钮 + 弹层 */
export const TOC_RAIL_MIN_WIDTH = 860;
/** 阅读线：容器顶部往下这么多像素以内算「已经读到」 */
const READING_LINE = 96;

function previewRoot(container: HTMLElement | null): HTMLElement | null {
  return container?.querySelector<HTMLElement>(`[${PREVIEW_ROOT_ATTR}]`) ?? null;
}

function headingElements(root: HTMLElement | null): HTMLElement[] {
  return root === null ? [] : [...root.querySelectorAll<HTMLElement>('[data-heading-slug]')];
}

function readHeadings(root: HTMLElement | null): TocItem[] {
  return headingElements(root).map((el) => ({
    slug: el.dataset['headingSlug'] ?? '',
    text: (el.textContent ?? '').trim(),
    level: Number(el.tagName.slice(1)) || 6,
  }));
}

function prefersReducedMotion(): boolean {
  return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 把 target 滚到容器顶部（相对容器算，不用 scrollIntoView：它会连带滚动外层页面） */
export function scrollWithin(container: HTMLElement, target: HTMLElement, smooth: boolean): void {
  const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 8;
  const behavior: ScrollBehavior = smooth && !prefersReducedMotion() ? 'smooth' : 'auto';
  if (typeof container.scrollTo === 'function') container.scrollTo({ top: Math.max(0, top), behavior });
  else container.scrollTop = Math.max(0, top);
}

/**
 * 在**当前预览**里找锚点的目标。候选（文档顺序）：标题（slug + raw HTML 写的显式 id 别名
 * `data-anchor-id`）与其他带 id 的元素（raw HTML、脚注）；标题自己的 DOM id 是实例前缀 + slug，
 * 不参与匹配。匹配顺序见 resolveAnchor：精确 id / 别名 → 精确 slug → 大小写、slugify、前缀兼容。
 */
export function findAnchor(container: HTMLElement | null, fragment: string): HTMLElement | undefined {
  const root = previewRoot(container);
  if (root === null) return undefined;
  const els = [...root.querySelectorAll<HTMLElement>('[data-heading-slug], [id]')];
  const targets: AnchorTarget[] = els.map((el) =>
    el.dataset['headingSlug'] !== undefined ? { slug: el.dataset['headingSlug'], id: el.dataset['anchorId'] } : { id: el.id },
  );
  const i = resolveAnchor(fragment, targets);
  return i === undefined ? undefined : els[i];
}

/** 预览里的标题（提交后读，内容变了重读）；`version` 每次内容变化加一，供定位待定锚点用 */
export function useDocHeadings(container: HTMLElement | null): { headings: TocItem[]; version: number; hasPreview: boolean } {
  const [state, setState] = useState<{ headings: TocItem[]; key: string; version: number; hasPreview: boolean }>({
    headings: [],
    key: '',
    version: 0,
    hasPreview: false,
  });
  const lastKey = useRef('');
  useLayoutEffect(() => {
    if (container === null) return;
    const read = (): void => {
      const root = previewRoot(container);
      const headings = readHeadings(root);
      const key = `${root === null ? 0 : 1}|${headings.map((h) => `${h.level}:${h.slug}:${h.text}`).join('\n')}`;
      // 无关的 DOM 变化（提示条、代码高亮）不触发更新
      if (key === lastKey.current) return;
      lastKey.current = key;
      setState((s) => ({ headings, key, version: s.version + 1, hasPreview: root !== null }));
    };
    read();
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(read);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [container]);
  return { headings: state.headings, version: state.version, hasPreview: state.hasPreview };
}

/**
 * 当前节（scrollspy）：以阅读线为准按几何位置算——容器的 scroll 事件经 requestAnimationFrame
 * 合并（每帧最多算一次）；容器尺寸变化（ResizeObserver）重算；IntersectionObserver
 * （root = 预览滚动容器）只作补充触发（例如内容高度变化让标题移动但没有滚动）。
 */
export function useActiveHeading(
  container: HTMLElement | null,
  items: readonly TocItem[],
): [string | undefined, (slug: string) => void] {
  const [active, setActive] = useState<string | undefined>(undefined);
  const key = items.map((i) => i.slug).join('\n');
  useEffect(() => {
    if (container === null || key === '') return;
    const compute = (): void => {
      const els = headingElements(previewRoot(container)).filter((el) => Number(el.tagName.slice(1)) <= 4);
      if (els.length === 0) return;
      const top = container.getBoundingClientRect().top;
      const tops = els.map((el) => el.getBoundingClientRect().top - top);
      const i = activeIndex(tops, Math.min(READING_LINE, container.clientHeight * 0.3));
      setActive(els[i]?.dataset['headingSlug']);
    };
    let frame: number | null = null;
    const schedule = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        compute();
      });
    };
    compute();
    container.addEventListener('scroll', schedule, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    ro?.observe(container);
    const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(schedule, { root: container, threshold: [0, 1] });
    for (const el of headingElements(previewRoot(container))) io?.observe(el);
    return () => {
      container.removeEventListener('scroll', schedule);
      ro?.disconnect();
      io?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [container, key]);
  return [active, setActive];
}

/** 容器宽度（ResizeObserver；没有时读一次） */
export function useContainerWidth(container: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (container === null) return;
    setWidth(container.clientWidth);
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => setWidth(container.clientWidth));
    ro.observe(container);
    return () => ro.disconnect();
  }, [container]);
  return width;
}

function TocList({ items, active, onJump }: { items: readonly TocItem[]; active: string | undefined; onJump: TocJump }): React.JSX.Element {
  const top = Math.min(...items.map((i) => i.level));
  return (
    <nav aria-label="目录" data-testid="file-toc">
      <ul className="flex flex-col gap-px text-[12.5px]">
        {items.map((item) => {
          const current = item.slug === active;
          return (
            <li key={item.slug}>
              <button
                type="button"
                data-testid="toc-item"
                data-slug={item.slug}
                aria-current={current ? 'location' : undefined}
                onClick={(e) => onJump(item.slug, targetForClick(e))}
                style={{ paddingLeft: `${0.5 + (item.level - top) * 0.75}rem` }}
                className={cn(
                  'w-full truncate rounded border-l-2 py-1 pr-2 text-left pointer-coarse:min-h-10',
                  current ? 'border-brand text-text bg-surface-2 font-medium' : 'text-text-2 hover:text-text border-transparent',
                )}
                title={item.text}
              >
                {item.text}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** 宽容器：右侧 sticky 栏（放在滚动容器里，跟着内容区一起滚但钉在顶部） */
export function TocRail({
  items,
  active,
  onJump,
  maxHeight,
}: {
  items: readonly TocItem[];
  active: string | undefined;
  onJump: TocJump;
  maxHeight: number;
}): React.JSX.Element {
  return (
    <aside
      data-testid="file-toc-rail"
      className="border-border sticky top-0 w-56 shrink-0 self-start overflow-y-auto border-l px-2 py-3"
      style={maxHeight > 0 ? { maxHeight } : undefined}
    >
      <div className="text-text-3 mb-1 px-2 text-[11px] font-medium">目录</div>
      <TocList items={items} active={active} onJump={onJump} />
    </aside>
  );
}

/** 窄容器（含手机抽屉）：右上角浮动按钮 + 弹层 */
export function TocPopover({
  items,
  active,
  onJump,
}: {
  items: readonly TocItem[];
  active: string | undefined;
  onJump: TocJump;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  // 选了目录项：焦点已经移到目标标题，弹层关闭时不要再把焦点还给按钮
  const jumped = useRef(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon-sm"
          variant="outline"
          data-testid="file-toc-button"
          aria-label="目录"
          title="目录"
          className="bg-surface/90 absolute top-2 right-4 z-10 shadow-sm backdrop-blur"
        >
          <TableOfContentsIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[min(70dvh,32rem)] w-72 overflow-y-auto p-2"
        onCloseAutoFocus={(e) => {
          if (!jumped.current) return;
          jumped.current = false;
          // Radix 非模态弹层看到焦点移出（focusin）通常也不会还焦点；这里显式拦住，不依赖事件顺序
          e.preventDefault();
        }}
      >
        <TocList
          items={items}
          active={active}
          onJump={(slug, target) => {
            // 返回 true = 焦点已移到目标；否则（找不到、交给 intent）照常还给按钮
            jumped.current = onJump(slug, target) === true;
            setOpen(false);
            return jumped.current;
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export interface JumpOptions {
  /** 平滑滚动（默认是；加载 / 刷新后的定位用瞬时） */
  smooth?: boolean;
  /** 把焦点移到目标（用户主动跳转时） */
  focus?: boolean;
}

/** 目录项（≥3 个 h1–h4 才有）+ 定位：给 FileDocView 用 */
export function useDocToc(container: HTMLElement | null): {
  items: TocItem[];
  active: string | undefined;
  version: number;
  hasPreview: boolean;
  /** 定位锚点（原文 / 编码都行）；找不到返回 false */
  jump: (fragment: string, options?: JumpOptions) => boolean;
} {
  const { headings, version, hasPreview } = useDocHeadings(container);
  const items = tocItems(headings);
  const [active, setActive] = useActiveHeading(container, items);
  const jump = useCallback(
    (fragment: string, { smooth = true, focus = false }: JumpOptions = {}): boolean => {
      const target = findAnchor(container, fragment);
      if (container === null || target === undefined) return false;
      scrollWithin(container, target, smooth);
      const slug = target.dataset['headingSlug'];
      if (slug !== undefined) setActive(slug);
      if (focus) {
        // 标题自带 tabIndex=-1；raw HTML 的锚点元素临时补上，才能接住焦点
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
      return true;
    },
    [container, setActive],
  );
  return { items, active, version, hasPreview, jump };
}
