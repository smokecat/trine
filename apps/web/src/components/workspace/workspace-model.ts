/**
 * 文件工作区（方案 §5）的 tab 模型：打开规则、预览位、上限、快照校验与恢复。
 *
 * 只 `import type` dockview：本文件在主包里（控制器、窄屏抽屉、测试都用它），dockview 运行时
 * 在懒加载 chunk 里。
 *
 * 分工：
 * - dockview `params` 只放**身份** `{kind, path, preview}`，随 toJSON 序列化，tab 组件直接读；
 *   一律用 `panel.params`（`api.getParameters()` 拿不到 addPanel 的初始值）。
 * - 易变的内容状态（模式、换行、滚动）放外部 `WorkspaceViewStore`，不进 params（滚动不触发 tab 重渲染）。
 * - 持久化 = `{v, layout: api.toJSON(), tabs, view, active, collapsed}`；恢复前先校验，
 *   dockview 的 fromJSON 在 panel 级出错时会先清空布局再抛。
 */
import type { DockviewApi, DockviewGroupPanel, IDockviewGroupPanel, IDockviewPanel, SerializedDockview } from 'dockview-react';
import type { ScrollAnchor } from '@/components/files/scroll-anchor.ts';

export type TabKind = 'file' | 'dir';

/** dockview panel 的 params：tab 身份。目录 tab 的 `path === ''` 表示会话目录 */
export interface TabParams {
  kind: TabKind;
  path: string;
  /** 预览 tab（斜体）：会被同组下一次 auto 打开替换。目录 tab 恒为 false */
  preview: boolean;
}

/** tab 的内容状态（FileDocModel / FileDirModel 的并集，字段都可缺） */
export interface TabViewState {
  mode?: 'rendered' | 'source';
  wrap?: boolean;
  scrollTop?: number;
  anchor?: ScrollAnchor | undefined;
}

export const TAB_LIMIT = 20;
export const COMPONENTS = ['file', 'dir'] as const;
const PATH_MAX = 4096;
const GRID_DEPTH_MAX = 16;

/** 文件 tab 的 id 由路径决定：同一路径只有一个 tab（重复打开 = 激活） */
export function fileTabId(path: string): string {
  return `file:${path}`;
}

/** 目录 tab 在 tab 内就地导航（路径会变），id 用序号 */
export function dirTabId(seq: number): string {
  return `dir:${seq}`;
}

const DIR_ID = /^dir:(\d{1,9})$/;

export function paramsOf(panel: IDockviewPanel): TabParams {
  return (panel.params ?? {}) as unknown as TabParams;
}

export function basename(path: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  return parts[parts.length - 1] ?? path;
}

export function tabTitle(t: Pick<TabParams, 'kind' | 'path'>): string {
  if (t.kind === 'dir' && t.path === '') return '会话目录';
  return basename(t.path) || '/';
}

export interface OpenRequest {
  kind: TabKind;
  /** 目录：'' = 会话目录 */
  path: string;
  /** auto：最近活动的文件组（预览位）；side：活动组右侧（保留） */
  placement: 'auto' | 'side';
  keep?: boolean;
  /** 发起者所在组（tab 里点的），目录 tab 里点文件时据此找「右侧的文件组」 */
  fromGroupId?: string | undefined;
  /**
   * 发起者是哪种 tab。目录 tab 里点文件 → 在其右侧的文件组打开；按发起 tab 判断，
   * 不看整组（用户把文件拖进目录组后，组就不再「全是目录」）
   */
  fromKind?: TabKind | undefined;
}

/** 工作区运行时上下文：React 外维护的少量状态 */
export interface WorkspaceCtx {
  /** 最近活动的「文件组」：auto 打开的落点 */
  lastFileGroupId: string | null;
  /** 最近活动的目录 tab：在文件里点「所在目录」时就地导航它 */
  lastDirPanelId: string | null;
  /** 组 → 它右侧的组（getBoundingClientRect 不可用时的回退，如测试环境） */
  sideOf: Map<string, string>;
  /** 下一个目录 tab 的序号 */
  dirSeq: number;
}

export function createCtx(): WorkspaceCtx {
  return { lastFileGroupId: null, lastDirPanelId: null, sideOf: new Map(), dirSeq: 1 };
}

/** 恢复后接上目录序号（避免与已有 id 冲突） */
export function syncDirSeq(ctx: WorkspaceCtx, ids: Iterable<string>): void {
  for (const id of ids) {
    const m = DIR_ID.exec(id);
    if (m !== null) ctx.dirSeq = Math.max(ctx.dirSeq, Number(m[1]) + 1);
  }
}

function isDirGroup(group: IDockviewGroupPanel): boolean {
  return group.panels.length > 0 && group.panels.every((p) => paramsOf(p).kind === 'dir');
}

function groupById(api: DockviewApi, id: string | null | undefined): DockviewGroupPanel | undefined {
  if (id === null || id === undefined) return undefined;
  return api.getGroup(id) as DockviewGroupPanel | undefined;
}

/** `group` 右侧的组：先用 dockview 的空间查询（靠布局尺寸），再用记录的关系 */
function rightGroup(api: DockviewApi, ctx: WorkspaceCtx, group: DockviewGroupPanel, filesOnly: boolean): DockviewGroupPanel | undefined {
  let spatial: IDockviewGroupPanel | undefined;
  try {
    spatial = api.adjacentGroupInDirection(group, 'right');
  } catch {
    spatial = undefined;
  }
  if (spatial !== undefined && !(filesOnly && isDirGroup(spatial))) return spatial as DockviewGroupPanel;
  const recorded = groupById(api, ctx.sideOf.get(group.id));
  if (recorded !== undefined && !(filesOnly && isDirGroup(recorded))) return recorded;
  return undefined;
}

export type OpenResult =
  | { kind: 'activated'; id: string }
  | { kind: 'opened'; id: string; replaced?: string; evicted?: string }
  | { kind: 'limit' };

export function findDirTab(api: DockviewApi, path: string): IDockviewPanel | undefined {
  return api.panels.find((p) => {
    const pp = paramsOf(p);
    return pp.kind === 'dir' && pp.path === path;
  });
}

/** 目录 tab 就地导航（面包屑、子目录、「所在目录」） */
export function navigateDir(panel: IDockviewPanel, path: string): void {
  const p = paramsOf(panel);
  if (p.kind !== 'dir' || p.path === path) return;
  panel.api.updateParameters({ ...p, path });
  panel.api.setTitle(tabTitle({ kind: 'dir', path }));
}

export function keepOpen(panel: IDockviewPanel): void {
  const p = paramsOf(panel);
  if (!p.preview) return;
  panel.api.updateParameters({ ...p, preview: false });
}

/**
 * 打开到工作区（只覆盖工作区分支；`auto` 在工作区不存在 / 收起时走抽屉由外层决定）。
 *
 * - 同一路径已开：激活（side / keep 顺便转保留）；
 * - 目录 tab 里点文件：在它右侧的文件组打开，没有就新建；
 * - side：活动组（或发起组）右侧的组，没有就新建；保留；
 * - auto 文件：最近活动的文件组，替换该组的预览 tab（位置不变）；
 * - 目录：已有目录 tab 时就地导航最近的那个；没有就在左侧新建一组；
 * - 上限 20：只淘汰隐藏且未保留的，否则返回 limit。
 */
export function openInWorkspace(api: DockviewApi, ctx: WorkspaceCtx, req: OpenRequest): OpenResult {
  const { kind, path } = req;
  const keep = kind === 'dir' || req.keep === true || req.placement === 'side';
  const from = groupById(api, req.fromGroupId);

  // 1. 已有同一路径：激活
  const existing = kind === 'file' ? api.getPanel(fileTabId(path)) : findDirTab(api, path);
  if (existing !== undefined) {
    if (keep) keepOpen(existing);
    existing.api.setActive();
    return { kind: 'activated', id: existing.id };
  }

  // 目录（非 side）：就地导航已有的目录 tab
  if (kind === 'dir' && req.placement === 'auto') {
    const dirPanel = api.getPanel(ctx.lastDirPanelId ?? '') ?? api.panels.find((p) => paramsOf(p).kind === 'dir');
    if (dirPanel !== undefined) {
      navigateDir(dirPanel, path);
      dirPanel.api.setActive();
      ctx.lastDirPanelId = dirPanel.id;
      return { kind: 'activated', id: dirPanel.id };
    }
  }

  // 2. 选落点：要么已有组（group），要么在某组某侧新建（newBeside）
  let group: DockviewGroupPanel | undefined;
  let newBeside: { ref: DockviewGroupPanel; direction: 'right' | 'left' } | undefined;
  const active = api.activeGroup;
  if (api.totalPanels === 0) {
    group = undefined;
  } else if (kind === 'dir') {
    const ref = from ?? active ?? api.groups[0];
    if (ref !== undefined) newBeside = { ref, direction: req.placement === 'side' ? 'right' : 'left' };
  } else if (from !== undefined && (req.fromKind === 'dir' || (req.fromKind === undefined && isDirGroup(from)))) {
    group = rightGroup(api, ctx, from, true);
    if (group === undefined || group.id === from.id) {
      group = undefined;
      newBeside = { ref: from, direction: 'right' };
    }
  } else if (req.placement === 'side') {
    const ref = from ?? active ?? api.groups[0];
    if (ref !== undefined) {
      group = rightGroup(api, ctx, ref, true);
      if (group === undefined) newBeside = { ref, direction: 'right' };
    }
  } else {
    const last = groupById(api, ctx.lastFileGroupId);
    const ref = last ?? active ?? api.groups[0];
    if (ref !== undefined && isDirGroup(ref)) {
      group = rightGroup(api, ctx, ref, true);
      if (group === undefined) newBeside = { ref, direction: 'right' };
    } else {
      group = ref;
    }
  }

  // 3. 预览位：同组里未保留的文件 tab（目录 tab 不会被文件替换）
  let replace: IDockviewPanel | undefined;
  if (!keep && group !== undefined) {
    replace = group.panels.find((p) => {
      const pp = paramsOf(p);
      return pp.preview && pp.kind === kind;
    });
  }

  // 4. 上限：只淘汰隐藏且未保留的
  let evicted: string | undefined;
  if (replace === undefined && api.totalPanels >= TAB_LIMIT) {
    const victim = api.panels.find((p) => !p.api.isVisible && paramsOf(p).preview);
    if (victim === undefined) return { kind: 'limit' };
    evicted = victim.id;
    api.removePanel(victim);
    if (group !== undefined && api.getGroup(group.id) === undefined) group = undefined;
  }

  const id = kind === 'file' ? fileTabId(path) : dirTabId(ctx.dirSeq++);
  const params: TabParams = { kind, path, preview: !keep };
  const base = { id, component: kind, params, title: tabTitle(params) } as const;
  let panel: IDockviewPanel;
  if (newBeside !== undefined) {
    panel = api.addPanel({ ...base, position: { referenceGroup: newBeside.ref, direction: newBeside.direction } });
    if (newBeside.direction === 'right') ctx.sideOf.set(newBeside.ref.id, panel.group.id);
    else ctx.sideOf.set(panel.group.id, newBeside.ref.id);
  } else if (group !== undefined) {
    const index = replace === undefined ? undefined : group.panels.indexOf(replace);
    panel = api.addPanel({ ...base, position: { referenceGroup: group, ...(index === undefined ? {} : { index }) } });
  } else {
    panel = api.addPanel(base);
  }
  if (replace !== undefined) api.removePanel(replace);
  if (kind === 'file') ctx.lastFileGroupId = panel.group.id;
  else ctx.lastDirPanelId = panel.id;
  return {
    kind: 'opened',
    id,
    ...(replace === undefined ? {} : { replaced: replace.id }),
    ...(evicted === undefined ? {} : { evicted }),
  };
}

// ---------------------------------------------------------------- 快照

export const SNAPSHOT_VERSION = 1;

/** tab 元数据（布局损坏时据此重建单组；窄屏抽屉、「文件（N）」也读它） */
export interface TabMeta extends TabParams {
  id: string;
  /** 所属组 id（只作参考；重建时都放进一组） */
  group?: string | undefined;
}

export interface WorkspaceSnapshot {
  v: typeof SNAPSHOT_VERSION;
  /** dockview toJSON；null = 只有元数据（如布局被重置） */
  layout: SerializedDockview | null;
  tabs: TabMeta[];
  view: Record<string, TabViewState>;
  /** 活动 tab */
  active?: string | undefined;
  collapsed: boolean;
}

export function tabsOf(api: DockviewApi): TabMeta[] {
  return api.panels.map((p) => ({ ...paramsOf(p), id: p.id, group: p.group.id }));
}

export function snapshotOf(api: DockviewApi, view: ReadonlyMap<string, TabViewState>, collapsed: boolean): WorkspaceSnapshot {
  const layout = api.toJSON();
  const tabs = tabsOf(api);
  const ids = new Set(tabs.map((t) => t.id));
  const v: Record<string, TabViewState> = {};
  for (const [id, s] of view) if (ids.has(id)) v[id] = s;
  return { v: SNAPSHOT_VERSION, layout, tabs, view: v, active: api.activePanel?.id, collapsed };
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function validPath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= PATH_MAX && !path.includes('\0');
}

/** id 与 params 是否一致（文件 id 由路径决定，目录 id 是序号） */
function validIdentity(id: string, kind: unknown, path: unknown): boolean {
  if (!validPath(path)) return false;
  if (kind === 'file') return path !== '' && id === fileTabId(path);
  if (kind === 'dir') return DIR_ID.test(id);
  return false;
}

/**
 * fromJSON 前的布局校验。dockview 自己只查「root 是 branch」，其后先 clear() 再逐个反序列化，
 * 中途失败会把布局清空再抛——所以能查的都在外面先查掉：拒绝浮动组 / popout / 边缘组；
 * panel 数 1..20；组件名、id、params 一致；网格叶子引用的 panel 都存在且各出现一次；深度有限。
 */
export function validateLayout(layout: unknown): SerializedDockview | null {
  if (!isObj(layout) || !isObj(layout.grid) || !isObj(layout.panels)) return null;
  if (layout.floatingGroups !== undefined || layout.popoutGroups !== undefined || layout.edgeGroups !== undefined) return null;
  const grid = layout.grid;
  const root = grid.root;
  if (!isObj(root) || root.type !== 'branch' || !Array.isArray(root.data)) return null;
  if (typeof grid.width !== 'number' || typeof grid.height !== 'number') return null;
  const panels = layout.panels;
  const ids = Object.keys(panels);
  if (ids.length === 0 || ids.length > TAB_LIMIT) return null;
  for (const id of ids) {
    const p = panels[id];
    if (!isObj(p) || p.id !== id) return null;
    const component = p.contentComponent;
    if (typeof component !== 'string' || !(COMPONENTS as readonly string[]).includes(component)) return null;
    // 默认 tab 组件序列化成 'props.defaultTabComponent'
    if (p.tabComponent !== undefined && p.tabComponent !== 'trine' && p.tabComponent !== 'props.defaultTabComponent') return null;
    const params = p.params;
    if (!isObj(params) || params.kind !== component || typeof params.preview !== 'boolean') return null;
    if (!validIdentity(id, params.kind, params.path)) return null;
  }
  const seen = new Set<string>();
  const groupIds = new Set<string>();
  const walk = (node: unknown, depth: number): boolean => {
    if (!isObj(node) || depth > GRID_DEPTH_MAX) return false;
    if (node.type === 'branch') return Array.isArray(node.data) && node.data.length > 0 && node.data.every((c) => walk(c, depth + 1));
    if (node.type !== 'leaf' || !isObj(node.data)) return false;
    const views = node.data.views;
    const gid = node.data.id;
    if (typeof gid !== 'string' || groupIds.has(gid) || !Array.isArray(views)) return false;
    groupIds.add(gid);
    let previews = 0;
    for (const v of views) {
      if (typeof v !== 'string' || !(v in panels) || seen.has(v)) return false;
      seen.add(v);
      const params = (panels[v] as { params: { preview: boolean } }).params;
      if (params.preview) previews += 1;
    }
    // 每组至多一个预览位
    if (previews > 1) return false;
    const activeView = node.data.activeView;
    return activeView === undefined || (typeof activeView === 'string' && views.includes(activeView));
  };
  if (!walk(root, 0) || seen.size !== ids.length) return null;
  return layout as unknown as SerializedDockview;
}

function sanitizeView(raw: unknown): TabViewState | null {
  if (!isObj(raw)) return null;
  const out: TabViewState = {};
  if (raw.mode === 'rendered' || raw.mode === 'source') out.mode = raw.mode;
  if (typeof raw.wrap === 'boolean') out.wrap = raw.wrap;
  if (typeof raw.scrollTop === 'number' && Number.isFinite(raw.scrollTop) && raw.scrollTop >= 0) out.scrollTop = raw.scrollTop;
  const a = raw.anchor;
  if (isObj(a) && Number.isInteger(a.line) && (a.line as number) > 0 && typeof a.offset === 'number' && Number.isFinite(a.offset)) {
    out.anchor = { line: a.line as number, offset: a.offset };
  }
  return out;
}

/** 从任意（可能损坏的）快照里尽量抠出 tab 元数据：有 tabs 用 tabs，否则看 layout.panels；去重、限量 */
export function salvageTabs(raw: unknown): TabMeta[] {
  if (!isObj(raw)) return [];
  const out: TabMeta[] = [];
  const seen = new Set<string>();
  const push = (id: unknown, kind: unknown, path: unknown, preview: unknown, group: unknown): void => {
    if (typeof id !== 'string' || seen.has(id) || out.length >= TAB_LIMIT) return;
    if (!validIdentity(id, kind, path)) return;
    seen.add(id);
    out.push({
      id,
      kind: kind as TabKind,
      path: path as string,
      preview: kind === 'file' && preview !== false,
      ...(typeof group === 'string' ? { group } : {}),
    });
  };
  // 元数据为准；没有元数据（旧格式 / 损坏）才从布局里抠
  if (Array.isArray(raw.tabs)) {
    for (const t of raw.tabs) if (isObj(t)) push(t.id, t.kind, t.path, t.preview, t.group);
  } else if (isObj(raw.layout) && isObj(raw.layout.panels)) {
    for (const p of Object.values(raw.layout.panels)) {
      if (isObj(p) && isObj(p.params)) push(p.id, p.params.kind, p.params.path, p.params.preview, undefined);
    }
  }
  return out;
}

/** 读快照：结构不对的部分丢掉，能用的都留下（layout 不合法则置 null，交给恢复时重建） */
export function readSnapshot(raw: unknown): WorkspaceSnapshot | null {
  if (!isObj(raw) || raw.v !== SNAPSHOT_VERSION) return null;
  const tabs = salvageTabs(raw);
  if (tabs.length === 0) return null;
  const layout = validateLayout(raw.layout);
  // 布局里的 tab 必须与元数据一致，否则以元数据为准（重建）
  const layoutOk = layout !== null && Object.keys(layout.panels).length === tabs.length && tabs.every((t) => t.id in layout.panels);
  const view: Record<string, TabViewState> = {};
  if (isObj(raw.view)) {
    for (const t of tabs) {
      const v = sanitizeView(raw.view[t.id]);
      if (v !== null) view[t.id] = v;
    }
  }
  const active = typeof raw.active === 'string' && tabs.some((t) => t.id === raw.active) ? raw.active : undefined;
  return { v: SNAPSHOT_VERSION, layout: layoutOk ? layout : null, tabs, view, active, collapsed: raw.collapsed === true };
}

/**
 * 合并成一组后预览位要归一：至多留一个预览 tab（优先活动的那个，否则最后一个），其余转为保留——
 * 原来各组各有一个预览位，合并后若都留着，下一次 auto 只会替换其中一个。
 */
export function normalizePreview<T extends Pick<TabMeta, 'id' | 'preview'>>(tabs: readonly T[], active?: string): T[] {
  const previews = tabs.filter((t) => t.preview);
  if (previews.length <= 1) return [...tabs];
  const keepId = previews.find((t) => t.id === active)?.id ?? previews.at(-1)!.id;
  return tabs.map((t) => (t.preview && t.id !== keepId ? { ...t, preview: false } : t));
}

/** 用 tab 元数据重建单组布局（校验失败 / fromJSON 抛错 / 「重置布局」） */
export function rebuildSingleGroup(api: DockviewApi, tabs: readonly TabMeta[], active?: string): void {
  api.clear();
  for (const t of normalizePreview(tabs.slice(0, TAB_LIMIT), active)) {
    api.addPanel({ id: t.id, component: t.kind, params: { kind: t.kind, path: t.path, preview: t.preview }, title: tabTitle(t) });
  }
  const a = active === undefined ? undefined : api.getPanel(active);
  a?.api.setActive();
}

/**
 * 分栏布局的聚合最小宽度：左右并排的组相加，上下叠放的取最大（每组至少 `groupMin`）。
 * 布局缺失 / 不可识别时按单组算。外层用它夹工作区宽度、判断窄屏自动收起、给分隔条 aria 范围。
 */
export function gridMinWidth(layout: SerializedDockview | null | undefined, groupMin: number): number {
  const grid = (layout as { grid?: { root?: unknown; orientation?: unknown } } | null | undefined)?.grid;
  if (grid === undefined || !isObj(grid.root)) return groupMin;
  const walk = (node: unknown, horizontal: boolean, depth: number): number => {
    if (!isObj(node) || depth > GRID_DEPTH_MAX) return groupMin;
    if (node.type !== 'branch' || !Array.isArray(node.data) || node.data.length === 0) return groupMin;
    const children = node.data.map((c) => walk(c, !horizontal, depth + 1));
    return horizontal ? children.reduce((a, b) => a + b, 0) : Math.max(...children);
  };
  return walk(grid.root, grid.orientation !== 'VERTICAL', 0);
}

export type RestoreResult = 'restored' | 'rebuilt' | 'empty';

/** 懒加载的 dockview 外壳交给控制器的句柄 */
export interface DockHandle {
  readonly api: DockviewApi;
  readonly ctx: WorkspaceCtx;
  open(req: OpenRequest): OpenResult;
  snapshot(collapsed: boolean): WorkspaceSnapshot;
  /** 按当前 tab 重建单组布局 */
  resetLayout(): void;
  /** 关闭所有 tab（工作区随之消失） */
  closeAll(): void;
  /** 焦点移到活动 tab（tab 条上），没有返回 false */
  focus(): boolean;
}

export interface Restorer {
  /** 恢复期间（含随后那个 microtask）为 true：自动保存应跳过 */
  readonly restoring: boolean;
  restore(snapshot: WorkspaceSnapshot | null): RestoreResult;
  /** 「重置布局」：按当前 tab 重建单组（同样静音自动保存的中间态，结束后由调用方保存一次） */
  reset(): void;
}

export function createRestorer(api: DockviewApi, ctx: WorkspaceCtx): Restorer {
  let restoring = false;
  const settle = (): void => {
    // onDidLayoutChange 是 microtask 合并发出的：同步复位 flag 会让那次合并事件漏网；
    // 排在 dockview 的 microtask 之后再复位（FIFO）
    queueMicrotask(() => {
      restoring = false;
    });
  };
  return {
    get restoring() {
      return restoring;
    },
    restore(snap) {
      restoring = true;
      try {
        if (snap === null || snap.tabs.length === 0) {
          api.clear();
          return 'empty';
        }
        let result: RestoreResult = 'rebuilt';
        if (snap.layout !== null) {
          try {
            api.fromJSON(snap.layout);
            result = 'restored';
          } catch {
            // dockview 已把布局清空并重抛；落到下面重建
          }
        }
        if (result === 'rebuilt') rebuildSingleGroup(api, snap.tabs, snap.active);
        else if (snap.active !== undefined) api.getPanel(snap.active)?.api.setActive();
        syncDirSeq(ctx, api.panels.map((p) => p.id));
        return result;
      } finally {
        settle();
      }
    },
    reset() {
      restoring = true;
      try {
        const tabs = tabsOf(api);
        const active = api.activePanel?.id;
        ctx.sideOf.clear();
        rebuildSingleGroup(api, tabs, active);
      } finally {
        settle();
      }
    },
  };
}
