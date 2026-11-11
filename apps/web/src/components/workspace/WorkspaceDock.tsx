/**
 * 文件工作区的 dockview 外壳（懒加载 chunk 的主体，见 WorkspaceEntry.tsx）。
 *
 * - 渲染器用默认 `onlyWhenVisible`：dockview 只把隐藏 panel 的 DOM 摘下，React portal **不卸载**；
 *   所以每个 panel 自己订阅可见性，隐藏时卸掉重内容（FileDocView / Blob URL 消费者），只留元数据，
 *   切回时从缓存重读并按外部 view store 回填滚动。
 * - 滚动在 onScroll 时就记进 view store（FileDocView 的 useScrollMemory）：dockview 先摘 DOM 再发
 *   可见性事件，卸载时读到的 scrollTop 已经是 0。
 * - 自动保存挂 onDidLayoutChange（microtask 合并），恢复期间由 restorer 静音；防抖在控制器里。
 * - 免费 core 的键盘：tab 条 ←/→/Home/End、Enter、Delete 关闭；Backspace 关 tab 拦掉（容易误触）。
 *   分栏 / 移动 / 调整尺寸由每组右上角的「组菜单」提供（键盘可达）。
 * - 浮动组、popout 关闭；右键菜单不配置（8.x 默认为空）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewGroupPanel,
  type DockviewPanelApi,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from 'dockview-react';
import { EllipsisVerticalIcon, FileTextIcon, FolderIcon, PinIcon, XIcon } from 'lucide-react';
import { FileDirView } from '@/components/files/FileDirView.tsx';
import { FileDocView } from '@/components/files/FileDocView.tsx';
import type { FileOpenTarget } from '@/components/files/file-links.ts';
import { DEFAULT_DIR_MODEL, DEFAULT_DOC_MODEL, type FileDirModel, type FileDocModel } from '@/components/files/view-model.ts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { WORKSPACE_GROUP_MIN_HEIGHT, WORKSPACE_GROUP_MIN_WIDTH } from '@/lib/layout-prefs.ts';
import { cn } from '@/lib/utils.ts';
import {
  createCtx,
  createRestorer,
  keepOpen,
  navigateDir,
  openInWorkspace,
  paramsOf,
  snapshotOf,
  type DockHandle,
  type OpenRequest,
  type RestoreResult,
  type TabParams,
  type WorkspaceSnapshot,
} from './workspace-model.ts';
import type { MountRequest, WorkspaceViewStore } from './workspace-store.ts';
import { isInDirection, type Direction } from './dock-geometry.ts';

export const trineTheme: DockviewTheme = {
  name: 'trine',
  className: 'dockview-theme-trine',
  gap: 0,
  dndOverlayMounting: 'relative',
  dndPanelOverlay: 'content',
  dndTabIndicator: 'line',
};

interface Shared {
  machineId: string;
  sessionId: string;
  view: WorkspaceViewStore;
  open: (req: OpenRequest) => void;
  /** 工作区本身在显示（未收起、非窄屏）；收起时 dockview 仍认为 panel 可见，要另外判断 */
  visible: boolean;
}
const SharedContext = createContext<Shared | null>(null);
function useShared(): Shared {
  const s = useContext(SharedContext);
  if (s === null) throw new Error('WorkspaceDock 外使用');
  return s;
}

/** 订阅 panel 可见性（dockview 事件 → React） */
export function usePanelVisible(api: DockviewPanelApi): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const d = api.onDidVisibilityChange(cb);
      return () => d.dispose();
    },
    [api],
  );
  return useSyncExternalStore(subscribe, () => api.isVisible);
}

/** 订阅 tab 的内容状态（与窄屏抽屉共用同一份 view store） */
function useTabModel<T extends FileDocModel | FileDirModel>(view: WorkspaceViewStore, id: string, defaults: T): [T, (patch: Partial<T>) => void] {
  const stored = useSyncExternalStore(view.subscribe, () => view.get(id));
  const model = useMemo(() => ({ ...defaults, ...stored }) as T, [defaults, stored]);
  const onChange = useCallback((patch: Partial<T>) => view.patch(id, patch), [view, id]);
  return [model, onChange];
}

/** 正文是否该挂着：工作区在显示，且 dockview 认为 panel 可见 */
function useBodyVisible(api: DockviewPanelApi): boolean {
  const panelVisible = usePanelVisible(api);
  return useShared().visible && panelVisible;
}

function FileTabContent({ id, path, groupId }: { id: string; path: string; groupId: () => string }): React.JSX.Element {
  const { machineId, sessionId, view, open } = useShared();
  const request = useSyncExternalStore(view.subscribe, () => view.mount(id));
  return <FileTabDoc key={request?.nonce ?? 0} id={id} path={path} groupId={groupId} machineId={machineId} sessionId={sessionId} view={view} open={open} request={request} />;
}

function FileTabDoc({
  id,
  path,
  groupId,
  machineId,
  sessionId,
  view,
  open,
  request,
}: {
  id: string;
  path: string;
  groupId: () => string;
  machineId: string;
  sessionId: string;
  view: WorkspaceViewStore;
  open: (req: OpenRequest) => void;
  request: MountRequest | undefined;
}): React.JSX.Element {
  // 挂载时决定一次：没消费过的定位请求才带上（之后隐藏再显示按记下的滚动位置回来）
  const [fragment] = useState(() => view.consumeFragment(id, request));
  const [model, onModelChange] = useTabModel<FileDocModel>(view, id, DEFAULT_DOC_MODEL);
  return (
    <FileDocView
      machineId={machineId}
      sessionId={sessionId}
      path={path}
      {...(fragment === undefined ? {} : { fragment })}
      model={model}
      onModelChange={onModelChange}
      onBrowse={(dir) => open({ kind: 'dir', path: dir ?? '', placement: 'auto', fromGroupId: groupId(), fromKind: 'file' })}
    />
  );
}

function DirTabContent({ id, path, groupId, navigate }: { id: string; path: string; groupId: () => string; navigate: (dir: string) => void }): React.JSX.Element {
  const { machineId, sessionId, view, open } = useShared();
  const [model, onModelChange] = useTabModel<FileDirModel>(view, id, DEFAULT_DIR_MODEL);
  const browse = (dir: string | undefined, target?: FileOpenTarget): void => {
    if (target === 'side') open({ kind: 'dir', path: dir ?? '', placement: 'side', fromGroupId: groupId(), fromKind: 'dir' });
    else navigate(dir ?? '');
  };
  return (
    <FileDirView
      machineId={machineId}
      sessionId={sessionId}
      path={path === '' ? undefined : path}
      model={model}
      onModelChange={onModelChange}
      onBrowse={browse}
      onOpenFile={(file, target) => open({ kind: 'file', path: file, placement: target === 'side' ? 'side' : 'auto', fromGroupId: groupId(), fromKind: 'dir' })}
    />
  );
}

function FilePanelBody(props: IDockviewPanelProps<TabParams>): React.JSX.Element {
  const visible = useBodyVisible(props.api);
  const api = props.api;
  const groupId = useCallback(() => api.group.id, [api]);
  return (
    <div data-testid="ws-panel" data-panel={api.id} className="bg-surface flex h-full min-h-0 flex-col">
      {visible ? <FileTabContent id={api.id} path={props.params.path} groupId={groupId} /> : null}
    </div>
  );
}

function DirPanelBody(props: IDockviewPanelProps<TabParams>): React.JSX.Element {
  const visible = useBodyVisible(props.api);
  const { view } = useShared();
  const api = props.api;
  const containerApi = props.containerApi;
  const groupId = useCallback(() => api.group.id, [api]);
  const navigate = useCallback(
    (dir: string) => {
      const panel = containerApi.getPanel(api.id);
      if (panel === undefined) return;
      // 新目录从顶部开始
      view.set(api.id, { scrollTop: 0 });
      navigateDir(panel, dir);
    },
    [api, containerApi, view],
  );
  return (
    <div data-testid="ws-panel" data-panel={api.id} className="bg-surface flex h-full min-h-0 flex-col">
      {visible ? <DirTabContent key={props.params.path} id={api.id} path={props.params.path} groupId={groupId} navigate={navigate} /> : null}
    </div>
  );
}

/** 自定义 tab：预览斜体、「保留打开」、× 与中键关闭、双击保留 */
function TrineTab(props: IDockviewPanelHeaderProps<TabParams>): React.JSX.Element {
  const { preview, path, kind } = props.params;
  const keep = (): void => {
    const panel = props.containerApi.getPanel(props.api.id);
    if (panel !== undefined) keepOpen(panel);
  };
  // 按钮上的指针按下不能冒泡到 tab：否则会触发拖拽 / 激活
  const stop = (e: React.PointerEvent | React.MouseEvent): void => e.stopPropagation();
  const Icon = kind === 'dir' ? FolderIcon : FileTextIcon;
  return (
    <div
      className="group/tab flex h-full max-w-[16rem] items-center gap-1.5 pr-1 pl-2.5"
      data-testid="ws-tab"
      data-tab={props.api.id}
      data-preview={preview ? 'true' : 'false'}
      title={kind === 'dir' && path === '' ? '会话目录' : path}
      onDoubleClick={keep}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        props.api.close();
      }}
    >
      <Icon aria-hidden className={cn('size-3.5 shrink-0', kind === 'dir' ? 'text-brand' : 'text-text-3')} />
      <span className={cn('min-w-0 truncate', preview && 'italic')}>{props.api.title}</span>
      {preview && (
        <button
          type="button"
          data-testid="ws-tab-keep"
          aria-label="保留打开"
          title="保留打开（不被下一次预览替换）"
          tabIndex={-1}
          onPointerDown={stop}
          onClick={(e) => {
            e.stopPropagation();
            keep();
          }}
          className="text-text-3 hover:text-text hover:bg-surface-2 inline-flex size-5 shrink-0 items-center justify-center rounded opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          <PinIcon className="size-3" />
        </button>
      )}
      <button
        type="button"
        data-testid="ws-tab-close"
        aria-label={`关闭 ${props.api.title ?? ''}`}
        title="关闭"
        tabIndex={-1}
        onPointerDown={stop}
        onClick={(e) => {
          e.stopPropagation();
          props.api.close();
        }}
        className="text-text-3 hover:text-text hover:bg-surface-2 inline-flex size-5 shrink-0 items-center justify-center rounded"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

const RESIZE_STEP = 80;

/**
 * 某方向上真正相邻的组。dockview 的 adjacentGroupInDirection 在该方向没有组时也可能返回别的组
 * （实测只有左右两组时，「上方」返回左边那组），所以再按几何关系核对：目标必须整体落在该方向一侧，
 * 且在另一条轴上与本组有重叠。拿不到尺寸（测试环境）时信任 dockview 的结果。
 */
export function adjacentGroup(api: DockviewApi, group: DockviewGroupPanel, d: Direction): ReturnType<DockviewApi['adjacentGroupInDirection']> {
  let target: ReturnType<DockviewApi['adjacentGroupInDirection']>;
  try {
    target = api.adjacentGroupInDirection(group, d);
  } catch {
    return undefined;
  }
  if (target === undefined || target.id === group.id) return undefined;
  const a = group.element.getBoundingClientRect();
  const b = (target as DockviewGroupPanel).element.getBoundingClientRect();
  if (a.width === 0 || b.width === 0) return target;
  return isInDirection(a, b, d) ? target : undefined;
}

/** 每组 tab 条右侧的组菜单：分栏 / 移动 / 调整尺寸 / 关闭（拖拽之外的键盘可达入口） */
function GroupMenu(props: IDockviewHeaderActionsProps): React.JSX.Element {
  const { containerApi: api, group, activePanel } = props;
  const neighbor = (d: 'left' | 'right' | 'up' | 'down'): ReturnType<DockviewApi['adjacentGroupInDirection']> => adjacentGroup(api, group, d);
  const many = group.panels.length > 1;
  const split = (direction: 'right' | 'below'): void => {
    if (activePanel === undefined) return;
    activePanel.api.moveTo({ group, position: direction === 'right' ? 'right' : 'bottom' });
  };
  const moveTo = (d: 'left' | 'right' | 'up' | 'down'): void => {
    const target = neighbor(d);
    if (activePanel === undefined || target === undefined) return;
    activePanel.api.moveTo({ group: target as typeof group });
  };
  const resize = (dw: number, dh: number): void => {
    const g = group.api;
    if (dw !== 0) g.setSize({ width: Math.max(WORKSPACE_GROUP_MIN_WIDTH, g.width + dw) });
    if (dh !== 0) g.setSize({ height: Math.max(120, g.height + dh) });
  };
  const closeOthers = (): void => {
    for (const p of [...group.panels]) if (p.id !== activePanel?.id) p.api.close();
  };
  const preview = activePanel !== undefined && paramsOf(activePanel).preview;
  const manyGroups = api.groups.length > 1;
  return (
    <div className="flex h-full items-center pr-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="ws-group-menu"
            aria-label="组操作：分栏、移动、调整尺寸"
            title="组操作"
            className="text-text-3 hover:text-text hover:bg-surface-2 focus-visible:ring-ring inline-flex size-6 items-center justify-center rounded outline-none focus-visible:ring-2"
          >
            <EllipsisVerticalIcon className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {preview && <DropdownMenuItem onSelect={() => activePanel && keepOpen(activePanel)}>保留打开</DropdownMenuItem>}
          <DropdownMenuItem data-testid="ws-split-right" disabled={!many} onSelect={() => split('right')}>
            向右拆分
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="ws-split-down" disabled={!many} onSelect={() => split('below')}>
            向下拆分
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={neighbor('left') === undefined} onSelect={() => moveTo('left')}>
            移到左侧组
          </DropdownMenuItem>
          <DropdownMenuItem disabled={neighbor('right') === undefined} onSelect={() => moveTo('right')}>
            移到右侧组
          </DropdownMenuItem>
          <DropdownMenuItem disabled={neighbor('up') === undefined} onSelect={() => moveTo('up')}>
            移到上方组
          </DropdownMenuItem>
          <DropdownMenuItem disabled={neighbor('down') === undefined} onSelect={() => moveTo('down')}>
            移到下方组
          </DropdownMenuItem>
          {manyGroups && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => resize(RESIZE_STEP, 0)}>加宽本组</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => resize(-RESIZE_STEP, 0)}>减窄本组</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => resize(0, RESIZE_STEP)}>加高本组</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => resize(0, -RESIZE_STEP)}>减矮本组</DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!many} onSelect={closeOthers}>
            关闭其他 tab
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="ws-close-group" onSelect={() => group.api.close()}>
            关闭本组
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const components = { file: FilePanelBody, dir: DirPanelBody };
const tabComponents = { trine: TrineTab };

export interface WorkspaceDockProps {
  machineId: string;
  sessionId: string;
  /** 初始快照（已读过、可能布局为 null）；null = 空 */
  initial: WorkspaceSnapshot | null;
  view: WorkspaceViewStore;
  /** 恢复完成：交出句柄（控制器随后排空挂起的打开请求） */
  onReady: (handle: DockHandle, result: RestoreResult) => void;
  /** 布局 / tab 变化（恢复期间静音）：控制器防抖保存、更新计数 */
  onLayoutChange: () => void;
  /** 达到上限且没有可淘汰的 tab */
  onLimit: () => void;
  /**
   * 工作区在显示（未收起、非窄屏）。收起时 dockview 实例留在 <Activity> 里，但 Activity 只清 effect、
   * 保留 DOM 与组件状态，dockview 也仍认为 panel 可见——所以正文按「工作区显示 且 panel 可见」显式卸载
   */
  visible?: boolean;
}

export default function WorkspaceDock({ machineId, sessionId, initial, view, onReady, onLayoutChange, onLimit, visible = true }: WorkspaceDockProps): React.JSX.Element {
  const apiRef = useRef<DockviewApi | null>(null);
  const ctxRef = useRef(createCtx());
  const hostRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef({ initial, onReady, onLayoutChange, onLimit });
  propsRef.current = { initial, onReady, onLayoutChange, onLimit };

  const open = useCallback((req: OpenRequest) => {
    const api = apiRef.current;
    if (api === null) return { kind: 'limit' } as const;
    const result = openInWorkspace(api, ctxRef.current, req);
    if (result.kind === 'limit') propsRef.current.onLimit();
    return result;
  }, []);

  const shared = useMemo<Shared>(() => ({ machineId, sessionId, view, visible, open: (r) => void open(r) }), [machineId, sessionId, view, visible, open]);

  // Backspace 在 tab 上会被 dockview 当成关闭：拦掉（Delete 仍可关闭）。捕获阶段在 tab 元素之前处理
  useEffect(() => {
    const el = hostRef.current;
    if (el === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Backspace') return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('.dv-tab') != null) e.stopPropagation();
    };
    el.addEventListener('keydown', onKey, true);
    return () => el.removeEventListener('keydown', onKey, true);
  }, []);

  const handleReady = useCallback(
    (e: DockviewReadyEvent) => {
      const api = e.api;
      apiRef.current = api;
      const ctx = ctxRef.current;
      const restorer = createRestorer(api, ctx);
      // 最近活动的文件组 / 目录 tab：auto 打开与「所在目录」的落点
      api.onDidActivePanelChange((ev) => {
        const panel = ev.panel ?? api.activePanel;
        if (panel === undefined) return;
        if (paramsOf(panel).kind === 'file') ctx.lastFileGroupId = panel.group.id;
        else ctx.lastDirPanelId = panel.id;
      });
      // 拖出分栏 / 拖进别组的 tab 自动转保留
      api.onDidMovePanel((ev) => {
        const panel = api.getPanel(ev.panel.id);
        if (panel !== undefined) keepOpen(panel);
      });
      api.onDidRemovePanel((panel) => {
        if (restorer.restoring || api.getPanel(panel.id) !== undefined) return;
        view.delete(panel.id);
      });
      api.onDidAddPanel((panel) => view.revive(panel.id));
      // 组的最小宽度：新建的组、恢复出来的组都设上（外层 clamp / 自动收起用聚合后的最小宽度）
      const constrain = (g: DockviewGroupPanel): void => g.api.setConstraints({ minimumWidth: WORKSPACE_GROUP_MIN_WIDTH, minimumHeight: WORKSPACE_GROUP_MIN_HEIGHT });
      api.onDidAddGroup(constrain);
      api.onDidLayoutChange(() => {
        if (restorer.restoring) return;
        propsRef.current.onLayoutChange();
      });
      const result = restorer.restore(propsRef.current.initial);
      for (const g of api.groups) constrain(g);
      const handle: DockHandle = {
        api,
        ctx,
        open,
        snapshot: (collapsed) => snapshotOf(api, view.entries(), collapsed),
        resetLayout: () => {
          restorer.reset();
          // reset 期间静音，结束后保存一次
          queueMicrotask(() => queueMicrotask(() => propsRef.current.onLayoutChange()));
        },
        closeAll: () => {
          for (const p of [...api.panels]) p.api.close();
        },
        focus: () => {
          const el = hostRef.current?.querySelector<HTMLElement>('.dv-active-group .dv-tab.dv-active-tab') ?? hostRef.current?.querySelector<HTMLElement>('.dv-tab.dv-active-tab');
          if (el === null || el === undefined) return false;
          el.focus();
          return true;
        },
      };
      propsRef.current.onReady(handle, result);
    },
    [open, view],
  );

  return (
    <SharedContext.Provider value={shared}>
      <div ref={hostRef} data-testid="ws-dock" className="h-full min-h-0 w-full">
        <DockviewReact
          className="trine-workspace h-full"
          theme={trineTheme}
          components={components}
          tabComponents={tabComponents}
          defaultTabComponent={TrineTab}
          rightHeaderActionsComponent={GroupMenu}
          onReady={handleReady}
          disableFloatingGroups
          defaultRenderer="onlyWhenVisible"
          noPanelsOverlay="emptyGroup"
        />
      </div>
    </SharedContext.Provider>
  );
}
