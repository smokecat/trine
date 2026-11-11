/**
 * 文件工作区的控制器（主包里；dockview 本身懒加载）。按「机器 + 会话工作目录」一份：
 * 同目录的会话共享 tab，换到别的目录时先保存、卸载，再在新 key 下恢复。
 *
 * 状态：
 * - absent：没有 tab（关掉最后一个即回到这里）；
 * - expanded：聊天 | 工作区两栏；
 * - collapsed：保留全部 tab 与布局（dockview 实例用 <Activity mode="hidden"> 留着），右侧边缘
 *   「文件（N）」一键恢复；
 * - maximized（expanded 的子状态，不持久化）：工作区临时盖住聊天，不卸载聊天。
 * 另有 narrow：主区放不下两栏时自动收起（不改 collapsed），宽度恢复后还原。
 *
 * 保存：每次布局变化立刻算出快照（toJSON 很便宜）记在内存，写 localStorage 防抖；
 * 换 key、卸载、页面隐藏时同步落盘。不依赖卸载时 dockview 还活着。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { FileOpenIntent, FileWorkspaceRoute } from '@/components/files/file-links.ts';
import { WORKSPACE_GROUP_MIN_WIDTH, workspaceFits, workspaceMinWidth } from '@/lib/layout-prefs.ts';
import { gridMinWidth, TAB_LIMIT, type DockHandle, type OpenRequest, type RestoreResult, type TabMeta, type TabViewState, type WorkspaceSnapshot } from './workspace-model.ts';
import { workspaceKey, WorkspaceStore, WorkspaceViewStore } from './workspace-store.ts';

export type WorkspaceStatus = 'absent' | 'expanded' | 'collapsed';

/** 写 localStorage 的防抖（拖分隔条时布局事件很密） */
export const SAVE_DEBOUNCE_MS = 300;

let sharedStore: WorkspaceStore | null = null;
function defaultStore(): WorkspaceStore {
  sharedStore ??= new WorkspaceStore();
  return sharedStore;
}

/** 测试用：换掉默认存储（null = 下次按 localStorage 重建） */
export function setWorkspaceStoreForTest(store: WorkspaceStore | null): void {
  sharedStore = store;
}

/** 一个「机器 + cwd」的运行时记录：所有可变状态都挂在这里，换 key 即换一份，旧的照常落盘 */
interface KeyRecord {
  key: string;
  snap: WorkspaceSnapshot | null;
  collapsed: boolean;
  handle: DockHandle | null;
  pending: ((h: DockHandle) => void)[];
  timer: ReturnType<typeof setTimeout> | undefined;
  view: WorkspaceViewStore;
}

interface UiState {
  rec: KeyRecord | null;
  collapsed: boolean;
  tabs: TabMeta[];
  active: string | undefined;
  /** dockview 是否该挂着（展开过一次就挂着，收起只是隐藏） */
  mounted: boolean;
  maximized: boolean;
  /** 「重置布局」/ 出错后重挂 dockview 的计数 */
  generation: number;
  /** 当前分栏布局的聚合最小宽度 */
  layoutMin: number;
}

function uiFor(rec: KeyRecord | null): UiState {
  const tabs = rec?.snap?.tabs ?? [];
  const collapsed = rec?.collapsed === true;
  return {
    rec,
    collapsed,
    tabs,
    active: rec?.snap?.active,
    mounted: tabs.length > 0 && !collapsed,
    maximized: false,
    generation: 0,
    layoutMin: gridMinWidth(rec?.snap?.layout, WORKSPACE_GROUP_MIN_WIDTH),
  };
}

/** 单组的最小宽度（没有布局 / 布局被丢弃时） */
const SINGLE_GROUP_MIN = gridMinWidth(null, WORKSPACE_GROUP_MIN_WIDTH);

/** 工作区清空（关掉最后一个 tab）：连同分栏布局的最小宽度一起复位，否则旧的多组约束会让窄屏判断出错 */
const EMPTY_UI = { tabs: [] as TabMeta[], active: undefined, mounted: false, maximized: false, collapsed: false, layoutMin: SINGLE_GROUP_MIN };

function sameTabs(a: readonly TabMeta[], b: readonly TabMeta[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => {
    const u = b[i]!;
    return t.id === u.id && t.path === u.path && t.preview === u.preview && t.kind === u.kind && t.group === u.group;
  });
}

function flushRecord(store: WorkspaceStore, rec: KeyRecord): void {
  clearTimeout(rec.timer);
  rec.timer = undefined;
  if (rec.snap === null || rec.snap.tabs.length === 0) store.remove(rec.key);
  else store.save(rec.key, rec.snap);
}

/** intent → 工作区的打开请求 */
export function requestForIntent(intent: FileOpenIntent, placement: 'auto' | 'side'): OpenRequest {
  if (intent.dir === true) return { kind: 'dir', path: intent.path ?? '', placement };
  return { kind: 'file', path: intent.path, placement, ...(intent.keep === true ? { keep: true } : {}) };
}

export interface WorkspaceDockBinding {
  machineId: string;
  sessionId: string;
  initial: WorkspaceSnapshot | null;
  view: WorkspaceViewStore;
  onReady: (handle: DockHandle, result: RestoreResult) => void;
  onLayoutChange: () => void;
  onLimit: () => void;
  onResetLayout: () => void;
}

export interface WorkspaceController {
  /** 可用（桌面 + agent 支持文件 + 知道会话 cwd） */
  enabled: boolean;
  key: string | null;
  status: WorkspaceStatus;
  /** 主区太窄，自动收起中 */
  narrow: boolean;
  /** 主区宽度已经测量过（之前不判断窄屏、也不做深链交接） */
  measured: boolean;
  /** 工作区最小宽度（含分栏布局的聚合最小宽度） */
  minWidth: number;
  /** 两栏实际显示着工作区 */
  shown: boolean;
  maximized: boolean;
  count: number;
  tabs: readonly TabMeta[];
  active: string | undefined;
  /** dockview 该不该挂着（collapsed / narrow 时挂着但隐藏） */
  mounted: boolean;
  generation: number;
  view: WorkspaceViewStore;
  dock: WorkspaceDockBinding | null;
  /** 给 createFileLinks 的工作区路由；不可用 / 窄屏时为 null（全部走抽屉） */
  route: FileWorkspaceRoute | null;
  /** 抽屉交接：带着内容状态开成保留 tab */
  openWithState: (intent: FileOpenIntent, state: TabViewState) => void;
  expand: () => void;
  collapse: () => void;
  setMaximized: (on: boolean) => void;
  closeAll: () => void;
  resetLayout: () => void;
  /** 主区（聊天 + 工作区）实测宽度 */
  setMainWidth: (width: number) => void;
}

const EMPTY_VIEW = new WorkspaceViewStore();

export function useWorkspace({
  machineId,
  sessionId,
  cwd,
  enabled: enabledIn,
  store = defaultStore(),
}: {
  machineId: string;
  sessionId: string;
  cwd: string | undefined;
  enabled: boolean;
  store?: WorkspaceStore;
}): WorkspaceController {
  const key = enabledIn && cwd !== undefined && cwd !== '' && machineId !== '' ? workspaceKey(machineId, cwd) : null;
  const rec = useMemo<KeyRecord | null>(() => {
    if (key === null) return null;
    const snap = store.load(key);
    const view = new WorkspaceViewStore();
    if (snap !== null) view.replaceAll(snap.view);
    return { key, snap, collapsed: snap?.collapsed === true, handle: null, pending: [], timer: undefined, view };
  }, [key, store]);

  const [state, setState] = useState<UiState>(() => uiFor(rec));
  // 换了 key：按新 key 的存档重置（渲染期派生，不用旧 key 的状态渲染一帧）
  let ui = state;
  if (state.rec !== rec) {
    ui = uiFor(rec);
    setState(ui);
  }
  /** 只改当前 rec 的 UI 状态（迟到的旧 rec 回调不影响新 key） */
  const update = useCallback(
    (fn: (s: UiState) => UiState) => setState((s) => (s.rec === rec ? fn(s) : s)),
    [rec],
  );

  // 0 = 还没测量：此时不能当成「够宽」（否则窄窗口首次进入会把深链交接给一个随即自动收起的工作区）
  const [mainWidth, setMainWidth] = useState(0);
  const measured = mainWidth > 0;
  const minWidth = workspaceMinWidth(ui.layoutMin);
  const narrow = measured && !workspaceFits(mainWidth, minWidth);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const scheduleSave = useCallback(() => {
    if (rec === null) return;
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => flushRecord(store, rec), SAVE_DEBOUNCE_MS);
  }, [rec, store]);

  // 换 key / 卸载 / 页面隐藏：落盘
  useEffect(() => {
    if (rec === null) return;
    const onHide = (): void => flushRecord(store, rec);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      // 只落盘、不清 handle：StrictMode 会模拟一次卸载再挂载，而 dockview 的 onReady 不会再调
      flushRecord(store, rec);
    };
  }, [rec, store]);

  // 内容状态（滚动、模式）变化：并进内存快照并安排保存
  useEffect(() => {
    if (rec === null) return;
    const view = rec.view;
    view.onChange = () => {
      const snap = rec.snap;
      if (snap === null) return;
      const ids = new Set(snap.tabs.map((t) => t.id));
      const v: Record<string, TabViewState> = {};
      for (const [id, s] of view.entries()) if (ids.has(id)) v[id] = s;
      rec.snap = { ...snap, view: v };
      scheduleSave();
    };
    return () => {
      view.onChange = null;
    };
  }, [rec, scheduleSave]);

  /** 从 dockview 同步：计数、tab 列表、内存快照 */
  const sync = useCallback(() => {
    if (rec === null || rec.handle === null) return;
    const snap = rec.handle.snapshot(rec.collapsed);
    if (snap.tabs.length === 0) {
      // 最后一个 tab 关了：工作区消失
      rec.snap = null;
      rec.handle = null;
      rec.collapsed = false;
      flushRecord(store, rec);
      update((s) => ({ ...s, ...EMPTY_UI }));
      return;
    }
    rec.snap = snap;
    scheduleSave();
    const layoutMin = gridMinWidth(snap.layout, WORKSPACE_GROUP_MIN_WIDTH);
    update((s) =>
      sameTabs(s.tabs, snap.tabs) && s.active === snap.active && s.layoutMin === layoutMin ? s : { ...s, tabs: snap.tabs, active: snap.active, layoutMin },
    );
  }, [rec, store, scheduleSave, update]);

  const onReady = useCallback(
    (handle: DockHandle, result: RestoreResult) => {
      if (rec === null) return;
      rec.handle = handle;
      if (result === 'rebuilt') toast.info('工作区布局无法恢复，已按单组重新排列');
      const pending = rec.pending;
      rec.pending = [];
      for (const run of pending) run(handle);
      // 恢复期间（含随后那个 microtask）自动保存是静音的：这里主动同步一次
      sync();
    },
    [rec, sync],
  );

  const onLimit = useCallback(() => {
    toast.info(`工作区最多 ${TAB_LIMIT} 个 tab，请先关掉一些`);
  }, []);

  const onResetLayout = useCallback(() => {
    if (rec === null) return;
    if (rec.snap !== null) {
      rec.snap = { ...rec.snap, layout: null };
      flushRecord(store, rec);
    }
    rec.handle = null;
    // 布局丢弃后按单组重建：最小宽度回到单组
    update((s) => ({ ...s, generation: s.generation + 1, layoutMin: SINGLE_GROUP_MIN }));
  }, [rec, store, update]);

  const expand = useCallback(() => {
    if (rec === null) return;
    rec.collapsed = false;
    if (rec.snap !== null && rec.snap.collapsed) {
      rec.snap = { ...rec.snap, collapsed: false };
      scheduleSave();
    }
    update((s) => ({ ...s, collapsed: false, mounted: true }));
  }, [rec, scheduleSave, update]);

  const collapse = useCallback(() => {
    if (rec === null) return;
    rec.collapsed = true;
    if (rec.snap !== null) {
      rec.snap = { ...rec.snap, collapsed: true };
      scheduleSave();
    }
    update((s) => ({ ...s, collapsed: true, maximized: false }));
  }, [rec, scheduleSave, update]);

  const openRequest = useCallback(
    (req: OpenRequest, extra: { state?: TabViewState | undefined; fragment?: string | undefined }) => {
      if (rec === null) return;
      expand();
      const run = (h: DockHandle): void => {
        const result = h.open(req);
        if (result.kind === 'limit') return;
        const fragment = extra.fragment !== undefined && extra.fragment !== '' && req.kind === 'file' ? extra.fragment : undefined;
        // 交接来的状态：新 tab 直接用；已有 tab 也要应用，并让正文按新状态重挂（滚动只在挂载时恢复）
        // set 会作废现有正文实例的代次，所以带状态时总是请求重挂（新实例按新状态定位、取得新代次）
        if (extra.state !== undefined) rec.view.set(result.id, extra.state);
        if (fragment !== undefined || extra.state !== undefined) rec.view.requestMount(result.id, fragment);
      };
      // dockview 未就绪（首次展开、懒加载中）：排队，就绪后按序执行
      if (rec.handle !== null) run(rec.handle);
      else rec.pending.push(run);
    },
    [rec, expand],
  );

  const present = ui.tabs.length > 0 || ui.mounted;
  const shown = rec !== null && measured && present && !ui.collapsed && !narrow;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const route = useMemo<FileWorkspaceRoute | null>(() => {
    if (rec === null || narrow) return null;
    return {
      // 「刚展开、还在加载」也算展开：auto 打开进工作区（排队）
      expanded: () => shownRef.current,
      open: (intent) => {
        const placement = intent.target === 'side' ? 'side' : 'auto';
        openRequest(requestForIntent(intent, placement), { fragment: intent.dir === true ? undefined : intent.fragment });
      },
    };
  }, [rec, narrow, openRequest]);

  const openWithState = useCallback(
    (intent: FileOpenIntent, s: TabViewState) => {
      openRequest({ ...requestForIntent(intent, 'auto'), keep: true }, { state: s, fragment: intent.dir === true ? undefined : intent.fragment });
    },
    [openRequest],
  );

  const setMaximized = useCallback(
    (on: boolean) => {
      if (on) {
        const el = document.activeElement;
        restoreFocusRef.current = el instanceof HTMLElement && el !== document.body ? el : null;
      }
      update((s) => (s.maximized === on ? s : { ...s, maximized: on }));
      if (!on) {
        const el = restoreFocusRef.current;
        restoreFocusRef.current = null;
        // 还原后焦点回到最大化前的位置（等布局恢复后）
        if (el !== null) requestAnimationFrame(() => el.isConnected && el.focus({ preventScroll: true }));
      }
    },
    [update],
  );

  const closeAll = useCallback(() => {
    if (rec === null) return;
    if (rec.handle !== null) {
      rec.handle.closeAll();
      return;
    }
    rec.snap = null;
    rec.collapsed = false;
    flushRecord(store, rec);
    update((s) => ({ ...s, ...EMPTY_UI }));
  }, [rec, store, update]);

  const resetLayout = useCallback(() => {
    if (rec?.handle != null) rec.handle.resetLayout();
    else onResetLayout();
  }, [rec, onResetLayout]);

  const dock = useMemo<WorkspaceDockBinding | null>(() => {
    if (rec === null) return null;
    return {
      machineId,
      sessionId,
      // 每次（重新）挂载时取最新的内存快照
      get initial() {
        return rec.snap;
      },
      view: rec.view,
      onReady,
      onLayoutChange: sync,
      onLimit,
      onResetLayout,
    };
  }, [rec, machineId, sessionId, onReady, sync, onLimit, onResetLayout]);

  const count = ui.tabs.length;
  const status: WorkspaceStatus = rec === null || !present ? 'absent' : ui.collapsed ? 'collapsed' : 'expanded';
  return {
    enabled: rec !== null,
    key,
    status,
    narrow,
    measured,
    minWidth,
    shown,
    maximized: shown && ui.maximized,
    count,
    tabs: ui.tabs,
    active: ui.active,
    mounted: rec !== null && ui.mounted,
    generation: ui.generation,
    view: rec?.view ?? EMPTY_VIEW,
    dock,
    route,
    openWithState,
    expand,
    collapse,
    setMaximized,
    closeAll,
    resetLayout,
    setMainWidth,
  };
}
