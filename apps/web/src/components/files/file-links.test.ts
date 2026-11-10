/**
 * 文件打开 intent 的路由：没有工作区时三种 target 都进抽屉；接上工作区后 auto 看展开状态、
 * side 直接进工作区、drawer 永远抽屉。抽屉视图的换算（锚点单独带、目录省略路径 = 会话 cwd）。
 */
import { describe, expect, test } from 'bun:test';
import { createFileLinks, resolveFileOpenTarget, targetForClick, type FileOpenIntent, type FileWorkspaceRoute } from './file-links.ts';
import { viewForIntent } from './use-file-panel.ts';

function workspace(expanded: boolean, log: FileOpenIntent[]): FileWorkspaceRoute {
  return { expanded: () => expanded, open: (i) => void log.push(i) };
}

describe('resolveFileOpenTarget', () => {
  test('没有工作区：都去抽屉', () => {
    for (const t of ['auto', 'side', 'drawer'] as const) expect(resolveFileOpenTarget(t, null)).toBe('drawer');
  });

  test('有工作区：auto 看展开，side 进工作区，drawer 去抽屉', () => {
    expect(resolveFileOpenTarget('auto', workspace(true, []))).toBe('workspace');
    expect(resolveFileOpenTarget('auto', workspace(false, []))).toBe('drawer');
    expect(resolveFileOpenTarget('side', workspace(false, []))).toBe('workspace');
    expect(resolveFileOpenTarget('drawer', workspace(true, []))).toBe('drawer');
  });
});

describe('createFileLinks', () => {
  test('按路由把 intent 原样交给抽屉或工作区', () => {
    const drawer: FileOpenIntent[] = [];
    const side: FileOpenIntent[] = [];
    const links = createFileLinks({ drawer: (i) => void drawer.push(i), workspace: workspace(false, side) });
    links.open({ path: 'a.md', target: 'auto', fragment: '安装' });
    links.open({ path: 'b.md', target: 'side', keep: true });
    links.open({ dir: true, target: 'drawer' });
    expect(drawer).toEqual([
      { path: 'a.md', target: 'auto', fragment: '安装' },
      { dir: true, target: 'drawer' },
    ]);
    expect(side).toEqual([{ path: 'b.md', target: 'side', keep: true }]);
  });

  test('只有抽屉：side 也落到抽屉', () => {
    const drawer: FileOpenIntent[] = [];
    createFileLinks({ drawer: (i) => void drawer.push(i) }).open({ path: 'x.md', target: 'side' });
    expect(drawer).toHaveLength(1);
  });

  test('Alt 才是 side', () => {
    expect(targetForClick({ altKey: true })).toBe('side');
    expect(targetForClick({ altKey: false })).toBe('auto');
  });
});

describe('viewForIntent', () => {
  test('文件带锚点、目录省略路径', () => {
    expect(viewForIntent({ path: '/w/a.md', target: 'auto', fragment: 'x' })).toEqual({ kind: 'file', path: '/w/a.md', fragment: 'x' });
    expect(viewForIntent({ path: '/w/a.md', target: 'auto', fragment: '' })).toEqual({ kind: 'file', path: '/w/a.md' });
    expect(viewForIntent({ dir: true, target: 'auto' })).toEqual({ kind: 'dir' });
    expect(viewForIntent({ dir: true, path: '/w', target: 'side', keep: true })).toEqual({ kind: 'dir', path: '/w' });
  });
});
