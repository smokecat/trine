/**
 * 工作区快照的读取 / 校验（纯函数，不起 dockview）与持久化存储（schema 版本、隔离、上限、内存回退）。
 */
import { describe, expect, test } from 'bun:test';
import { gridMinWidth, normalizePreview, readSnapshot, salvageTabs, validateLayout, type WorkspaceSnapshot } from './workspace-model.ts';
import { isInDirection } from './dock-geometry.ts';
import { workspaceKey, WorkspaceStore, WorkspaceViewStore, type KvLike } from './workspace-store.ts';

function layout(): Record<string, unknown> {
  return {
    grid: {
      root: {
        type: 'branch',
        data: [
          { type: 'leaf', data: { id: '1', views: ['dir:1'], activeView: 'dir:1' }, size: 300 },
          { type: 'leaf', data: { id: '2', views: ['file:/w/a.md', 'file:/w/b.md'], activeView: 'file:/w/b.md' }, size: 700 },
        ],
        size: 600,
      },
      width: 1000,
      height: 600,
      orientation: 'HORIZONTAL',
    },
    panels: {
      'dir:1': { id: 'dir:1', contentComponent: 'dir', tabComponent: 'trine', params: { kind: 'dir', path: '', preview: false }, title: '会话目录' },
      'file:/w/a.md': { id: 'file:/w/a.md', contentComponent: 'file', params: { kind: 'file', path: '/w/a.md', preview: false }, title: 'a.md' },
      'file:/w/b.md': { id: 'file:/w/b.md', contentComponent: 'file', params: { kind: 'file', path: '/w/b.md', preview: true }, title: 'b.md' },
    },
    activeGroup: '2',
  };
}

function snapshot(): Record<string, unknown> {
  return {
    v: 1,
    layout: layout(),
    tabs: [
      { id: 'dir:1', kind: 'dir', path: '', preview: false, group: '1' },
      { id: 'file:/w/a.md', kind: 'file', path: '/w/a.md', preview: false, group: '2' },
      { id: 'file:/w/b.md', kind: 'file', path: '/w/b.md', preview: true, group: '2' },
    ],
    view: { 'file:/w/a.md': { mode: 'source', wrap: true, scrollTop: 120, anchor: { line: 4, offset: -3 } }, 'file:/ghost': { scrollTop: 1 } },
    active: 'file:/w/b.md',
    collapsed: false,
  };
}

describe('validateLayout', () => {
  test('合法布局通过', () => {
    expect(validateLayout(layout())).not.toBeNull();
  });

  test('含浮动组 / popout / 边缘组：拒绝', () => {
    for (const k of ['floatingGroups', 'popoutGroups', 'edgeGroups']) {
      expect(validateLayout({ ...layout(), [k]: [] })).toBeNull();
    }
  });

  test('panel 级问题都在 fromJSON 之前拦下：未知组件、id 与路径不符、叶子引用缺失 / 重复、activeView 不在组里', () => {
    const cases: ((l: Record<string, any>) => void)[] = [
      (l) => (l.panels['file:/w/a.md'].contentComponent = 'evil'),
      (l) => (l.panels['file:/w/a.md'].params.path = '/w/other.md'),
      (l) => (l.panels['dir:1'].params.kind = 'file'),
      (l) => l.grid.root.data[1].data.views.push('file:/ghost'),
      (l) => l.grid.root.data[0].data.views.push('file:/w/a.md'),
      (l) => (l.grid.root.data[0].data.activeView = 'file:/w/a.md'),
      (l) => (l.grid.root.data[1].data.id = '1'),
      (l) => (l.grid.root = { type: 'leaf', data: {} }),
      (l) => (l.panels['file:/w/a.md'].params.path = '/w/a\0.md'),
    ];
    for (const mutate of cases) {
      const l = layout() as Record<string, any>;
      mutate(l);
      expect(validateLayout(l)).toBeNull();
    }
  });

  test('超过 20 个 panel：拒绝', () => {
    const l = layout() as Record<string, any>;
    const views: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      const id = `file:/w/${i}.md`;
      l.panels[id] = { id, contentComponent: 'file', params: { kind: 'file', path: `/w/${i}.md`, preview: false } };
      views.push(id);
    }
    l.grid.root.data[1].data.views.push(...views);
    expect(validateLayout(l)).toBeNull();
  });
});

describe('readSnapshot', () => {
  test('完整快照：保留布局、元数据、合法的内容状态（丢掉不存在 tab 的）', () => {
    const s = readSnapshot(snapshot())!;
    expect(s.layout).not.toBeNull();
    expect(s.tabs.map((t) => t.id)).toEqual(['dir:1', 'file:/w/a.md', 'file:/w/b.md']);
    expect(s.view).toEqual({ 'file:/w/a.md': { mode: 'source', wrap: true, scrollTop: 120, anchor: { line: 4, offset: -3 } } });
    expect(s.active).toBe('file:/w/b.md');
  });

  test('布局坏了但元数据在：layout 置 null（恢复时按单组重建），tab 不丢', () => {
    const raw = snapshot();
    (raw.layout as Record<string, any>).grid.root.data[1].data.views.push('file:/ghost');
    const s = readSnapshot(raw)!;
    expect(s.layout).toBeNull();
    expect(s.tabs.length).toBe(3);
  });

  test('布局与元数据对不上：以元数据为准', () => {
    const raw = snapshot();
    (raw.tabs as unknown[]).pop();
    expect(readSnapshot(raw)!.layout).toBeNull();
  });

  test('版本不对 / 没有任何 tab / 垃圾：null', () => {
    expect(readSnapshot({ ...snapshot(), v: 2 })).toBeNull();
    expect(readSnapshot({ v: 1, tabs: [], layout: null })).toBeNull();
    expect(readSnapshot('x')).toBeNull();
  });

  test('salvageTabs：只要身份合法的，去重、限 20；目录 tab 永不为预览', () => {
    const tabs = salvageTabs({
      tabs: [
        { id: 'file:/w/a.md', kind: 'file', path: '/w/a.md', preview: true },
        { id: 'file:/w/a.md', kind: 'file', path: '/w/a.md', preview: false },
        { id: 'file:/w/x.md', kind: 'file', path: '/w/y.md', preview: true },
        { id: 'dir:7', kind: 'dir', path: '/w', preview: true },
        { id: 'weird', kind: 'dir', path: '/w' },
      ],
    });
    expect(tabs).toEqual([
      { id: 'file:/w/a.md', kind: 'file', path: '/w/a.md', preview: true },
      { id: 'dir:7', kind: 'dir', path: '/w', preview: false },
    ]);
  });
});

function memoryKv(): KvLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('WorkspaceStore', () => {
  const snap = (): WorkspaceSnapshot => readSnapshot(snapshot())!;

  test('按「机器 + cwd」隔离，存取往返', () => {
    const kv = memoryKv();
    const store = new WorkspaceStore(kv);
    const a = workspaceKey('m1', '/w');
    const b = workspaceKey('m2', '/w');
    store.save(a, snap());
    expect(store.load(a)?.tabs.length).toBe(3);
    expect(store.load(b)).toBeNull();
    // 不存内容与 Blob URL：只有元数据与布局
    expect([...kv.data.values()].join('')).not.toContain('blob:');
  });

  test('超过上限：删最久没写的', () => {
    const kv = memoryKv();
    const store = new WorkspaceStore(kv, 2);
    store.save('k1', snap());
    store.save('k2', snap());
    store.save('k1', snap());
    store.save('k3', snap());
    expect(store.load('k2')).toBeNull();
    expect(store.load('k1')).not.toBeNull();
    expect(store.load('k3')).not.toBeNull();
  });

  test('没有 tab 即删除', () => {
    const store = new WorkspaceStore(memoryKv());
    store.save('k', snap());
    store.save('k', { ...snap(), tabs: [] });
    expect(store.load('k')).toBeNull();
  });

  test('localStorage 写不进（满额 / 不可用）：退回内存', () => {
    const kv = memoryKv();
    kv.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    const store = new WorkspaceStore(kv);
    store.save('k', snap());
    expect(store.load('k')?.tabs.length).toBe(3);
    const none = new WorkspaceStore(null);
    none.save('k', snap());
    expect(none.load('k')?.tabs.length).toBe(3);
  });

  test('存档损坏（非 JSON）：当作没有', () => {
    const kv = memoryKv();
    kv.setItem('trine.workspace.v1:k', '{oops');
    expect(new WorkspaceStore(kv).load('k')).toBeNull();
  });
});

describe('评审修复（纯逻辑）', () => {
  test('锚点消费记录不跨工作区：A 消费了某路径的第一次定位，B 同路径的第一次定位照常生效', () => {
    const a = new WorkspaceViewStore();
    const b = new WorkspaceViewStore();
    a.requestMount('file:/w/a.md', '安装');
    expect(a.consumeFragment('file:/w/a.md', a.mount('file:/w/a.md'))).toBe('安装');
    expect(a.consumeFragment('file:/w/a.md', a.mount('file:/w/a.md'))).toBeUndefined();
    b.requestMount('file:/w/a.md', '用法');
    expect(b.consumeFragment('file:/w/a.md', b.mount('file:/w/a.md'))).toBe('用法');
  });

  test('localStorage 不可用时内存回退同样按条数上限淘汰', () => {
    const none = new WorkspaceStore(null, 2);
    const s = readSnapshot(snapshot())!;
    none.save('k1', s);
    none.save('k2', s);
    none.save('k3', s);
    expect(none.load('k1')).toBeNull();
    expect(none.load('k2')).not.toBeNull();
    expect(none.load('k3')).not.toBeNull();
  });

  test('一组里两个预览位：布局校验拒绝（走重建），重建时归一', () => {
    const l = layout() as Record<string, any>;
    l.panels['file:/w/a.md'].params.preview = true;
    expect(validateLayout(l)).toBeNull();
    expect(normalizePreview([{ id: 'a', preview: true }, { id: 'b', preview: true }, { id: 'c', preview: false }], 'a')).toEqual([
      { id: 'a', preview: true },
      { id: 'b', preview: false },
      { id: 'c', preview: false },
    ]);
  });

  test('聚合最小宽度：左右相加、上下取大', () => {
    expect(gridMinWidth(layout() as never, 220)).toBe(440);
    const l = layout() as Record<string, any>;
    l.grid.orientation = 'VERTICAL';
    expect(gridMinWidth(l as never, 220)).toBe(220);
    expect(gridMinWidth(null, 220)).toBe(220);
  });

  test('邻组的几何核对：只有左右两组时，「上方」不算邻组', () => {
    const left = { left: 0, right: 300, top: 0, bottom: 600 };
    const right = { left: 300, right: 600, top: 0, bottom: 600 };
    expect(isInDirection(right, left, 'left')).toBe(true);
    expect(isInDirection(right, left, 'up')).toBe(false);
    expect(isInDirection(right, left, 'down')).toBe(false);
    const below = { left: 300, right: 600, top: 300, bottom: 600 };
    const above = { left: 300, right: 600, top: 0, bottom: 300 };
    expect(isInDirection(below, above, 'up')).toBe(true);
  });
});

describe('WorkspaceViewStore', () => {
  test('patch 合并并通知保存；定位请求每次换 nonce', () => {
    const v = new WorkspaceViewStore();
    let changes = 0;
    v.onChange = () => (changes += 1);
    v.patch('file:/a', { scrollTop: 10 });
    v.patch('file:/a', { mode: 'source' });
    expect(v.get('file:/a')).toEqual({ scrollTop: 10, mode: 'source' });
    expect(changes).toBe(2);
    let notified = 0;
    const off = v.subscribe(() => (notified += 1));
    v.requestFragment('file:/a', '安装');
    const first = v.fragment('file:/a')!.nonce;
    v.requestFragment('file:/a', '安装');
    expect(v.fragment('file:/a')!.nonce).toBeGreaterThan(first);
    expect(notified).toBe(2);
    off();
  });
});
