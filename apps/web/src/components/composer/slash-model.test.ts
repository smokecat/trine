/**
 * 「/」菜单的分组、过滤与键盘导航的单测。
 */
import { describe, expect, test } from 'bun:test';
import type { SlashCommand } from '@trine/core';
import {
  buildSlashMenu,
  flattenSlashGroups,
  moveSlashIndex,
  parseSlashInput,
  sessionCommandAction,
} from './slash-model.ts';

const commands: SlashCommand[] = [
  { name: 'ws:task', description: '私有任务管理', source: 'project' },
  { name: 'code-review', description: '代码审查', source: 'skill' },
  { name: 'commit', description: '规范化提交', source: 'user' },
];
const snippets = ['继续', '跑测试，修掉失败的用例', 'model 相关的备忘'];
const sources = { slashCommands: commands, promptSnippets: snippets };

describe('parseSlashInput', () => {
  test('非 / 开头返回 null', () => {
    expect(parseSlashInput('hello')).toBeNull();
    expect(parseSlashInput(' /model')).toBeNull();
  });

  test('拆命令与参数，命令大小写归一', () => {
    expect(parseSlashInput('/')).toEqual({ name: '', arg: '' });
    expect(parseSlashInput('/Model')).toEqual({ name: 'model', arg: '' });
    expect(parseSlashInput('/model  claude-opus-5 ')).toEqual({ name: 'model', arg: 'claude-opus-5' });
    expect(parseSlashInput('/cwd ~/a b/c')).toEqual({ name: 'cwd', arg: '~/a b/c' });
  });
});

describe('sessionCommandAction', () => {
  test('无参数弹 sheet，有参数直接设值', () => {
    expect(sessionCommandAction('model', '')).toEqual({ kind: 'sheet', section: 'model' });
    expect(sessionCommandAction('model', 'opus')).toEqual({ kind: 'apply', command: 'model', arg: 'opus' });
    expect(sessionCommandAction('permission', 'plan')).toEqual({
      kind: 'apply',
      command: 'permission',
      arg: 'plan',
    });
  });

  test('/rename：无参数开对话框，有参数直接改（大小写原样）', () => {
    expect(sessionCommandAction('rename', '')).toEqual({ kind: 'rename', title: '' });
    expect(sessionCommandAction('rename', 'Fix Login')).toEqual({ kind: 'rename', title: 'Fix Login' });
    expect(buildSlashMenu('/rename 修 登录 bug', sources)[0]?.items[0]?.action).toEqual({
      kind: 'rename',
      title: '修 登录 bug',
    });
  });

  test('/status 与 /mcp 是按需请求，不带参数语义', () => {
    expect(sessionCommandAction('status', '')).toEqual({ kind: 'status' });
    expect(sessionCommandAction('mcp', 'whatever')).toEqual({ kind: 'mcp' });
  });
});

describe('buildSlashMenu', () => {
  test('裸 / 出全部三组', () => {
    const groups = buildSlashMenu('/', sources);
    expect(groups.map((g) => g.title)).toEqual([
      '会话控制 · 协议级',
      '项目命令 · agent 下发',
      '常用 prompt · 本设备',
    ]);
    expect(groups[0]?.items.map((i) => i.label)).toEqual([
      '/model',
      '/cwd',
      '/permission',
      '/status',
      '/mcp',
      '/rename',
    ]);
    expect(groups[1]?.items[0]).toMatchObject({ label: '/ws:task', source: 'project' });
    expect(groups[2]?.items[0]?.action).toEqual({ kind: 'fill', text: '继续' });
  });

  test('前缀过滤：/mo 只留 /model；片段按包含匹配', () => {
    const groups = buildSlashMenu('/mo', sources);
    expect(groups.map((g) => g.title)).toEqual(['会话控制 · 协议级', '常用 prompt · 本设备']);
    expect(groups[0]?.items.map((i) => i.label)).toEqual(['/model']);
    // 片段没有 `/` 前缀可言，按包含匹配
    expect(groups[1]?.items.map((i) => i.label)).toEqual(['model 相关的备忘']);
  });

  test('项目命令选中后填入命令名（带尾随空格），不直接发送', () => {
    const groups = buildSlashMenu('/co', sources);
    const project = groups.find((g) => g.title.startsWith('项目命令'));
    expect(project?.items.map((i) => i.label)).toEqual(['/code-review', '/commit']);
    // 回归：早先这里发的是字面 `/co`，Claude 收到一条不存在的命令
    // 回归：点选即发，用户没机会补参数
    expect(project?.items[0]?.action).toEqual({ kind: 'fill', text: '/code-review ' });
    expect(project?.items[1]?.action).toEqual({ kind: 'fill', text: '/commit ' });
  });

  test('命令名完整打出但未带参数：仍是填入', () => {
    const groups = buildSlashMenu('/commit', sources);
    expect(groups.find((g) => g.title.startsWith('项目命令'))?.items[0]?.action).toEqual({
      kind: 'fill',
      text: '/commit ',
    });
  });

  test('命令名完整 + 已带参数：直接发送', () => {
    const withArg = buildSlashMenu('/commit 只提交 web', sources);
    expect(withArg.find((g) => g.title.startsWith('项目命令'))?.items[0]?.action).toEqual({
      kind: 'send',
      text: '/commit 只提交 web',
    });
  });

  test('前缀 + 参数：补全命令名后填入，不发送', () => {
    const groups = buildSlashMenu('/co 只提交 web', sources);
    const project = groups.find((g) => g.title.startsWith('项目命令'));
    expect(project?.items[0]?.action).toEqual({ kind: 'fill', text: '/code-review 只提交 web' });
  });

  test('大小写前缀也填规范的命令名', () => {
    const groups = buildSlashMenu('/CO', sources);
    const project = groups.find((g) => g.title.startsWith('项目命令'));
    expect(project?.items[0]?.action).toEqual({ kind: 'fill', text: '/code-review ' });
  });

  test('已经打出参数后不再推荐 prompt 片段', () => {
    expect(buildSlashMenu('/model opus', sources).map((g) => g.title)).toEqual(['会话控制 · 协议级']);
  });

  test('无候选返回空数组（菜单整体隐藏）', () => {
    expect(buildSlashMenu('/zzz', sources)).toEqual([]);
    expect(buildSlashMenu('不是命令', sources)).toEqual([]);
  });

  test('agent 下发的与会话控制同名的命令被过滤（不出现两个 /rename）', () => {
    const withDupes = {
      slashCommands: [
        ...commands,
        { name: 'rename', description: 'CLI 自带', source: 'user' },
        { name: 'Model', source: 'user' },
      ] as SlashCommand[],
      promptSnippets: [],
    };
    const labels = flattenSlashGroups(buildSlashMenu('/', withDupes)).map((i) => i.label);
    expect(labels.filter((l) => l === '/rename')).toHaveLength(1);
    expect(labels.filter((l) => l.toLowerCase() === '/model')).toHaveLength(1);
    expect(buildSlashMenu('/ren', withDupes).map((g) => g.title)).toEqual(['会话控制 · 协议级']);
  });

  test('不可用的会话控制命令不出现，同名 agent 命令也不回填', () => {
    const src = {
      slashCommands: [{ name: 'rename', source: 'user' }] as SlashCommand[],
      promptSnippets: [],
      unavailable: ['rename'] as const,
    };
    expect(buildSlashMenu('/ren', src)).toEqual([]);
    expect(flattenSlashGroups(buildSlashMenu('/', src)).map((i) => i.label)).not.toContain('/rename');
  });

  test('capabilities 与片段为空时只剩会话控制组', () => {
    expect(buildSlashMenu('/', { slashCommands: [], promptSnippets: [] }).map((g) => g.title)).toEqual([
      '会话控制 · 协议级',
    ]);
  });
});

describe('键盘导航', () => {
  test('扁平化跳过分组标题', () => {
    expect(flattenSlashGroups(buildSlashMenu('/', sources))).toHaveLength(6 + 3 + 3);
  });

  test('上下键两端循环，空列表恒 0', () => {
    expect(moveSlashIndex(0, 1, 3)).toBe(1);
    expect(moveSlashIndex(2, 1, 3)).toBe(0);
    expect(moveSlashIndex(0, -1, 3)).toBe(2);
    expect(moveSlashIndex(0, 1, 0)).toBe(0);
    expect(moveSlashIndex(5, 1, 3)).toBe(0);
  });
});
