import { describe, expect, test } from 'bun:test';
import {
  isUnder,
  normalizeDirInput,
  pathCrumbs,
  trustRisk,
  detectPath,
  displayPath,
  fenceCode,
  isLocalHref,
  languageOf,
  parentDir,
  resolveRelative,
  visibleEntries,
} from './file-model.ts';
import { searchForView, viewFromSearch } from './use-file-panel.ts';

describe('detectPath', () => {
  test('像路径的', () => {
    expect(detectPath('docs/plan.md')).toEqual({ path: 'docs/plan.md', dir: false });
    expect(detectPath('./src/a.ts')).toEqual({ path: './src/a.ts', dir: false });
    expect(detectPath('/w/repo/README.md')).toEqual({ path: '/w/repo/README.md', dir: false });
    expect(detectPath('~/notes/todo.txt')).toEqual({ path: '~/notes/todo.txt', dir: false });
    expect(detectPath('README.md')).toEqual({ path: 'README.md', dir: false });
    expect(detectPath('package.json')).toEqual({ path: 'package.json', dir: false });
    expect(detectPath('apps/web/.gitignore')).toEqual({ path: 'apps/web/.gitignore', dir: false });
    expect(detectPath('docs/设计.md')).toEqual({ path: 'docs/设计.md', dir: false });
    expect(detectPath('src/')).toEqual({ path: 'src/', dir: true });
  });

  test('去掉行号后缀', () => {
    expect(detectPath('src/a.ts:12')?.path).toBe('src/a.ts');
    expect(detectPath('src/a.ts:12:3')?.path).toBe('src/a.ts');
    expect(detectPath('src/a.ts#L5-L9')?.path).toBe('src/a.ts');
  });

  test('不像路径的', () => {
    for (const s of [
      '0.20.0',
      'v1.2.3',
      'e.g.',
      'example.com',
      'and/or',
      'TCP/IP',
      '@trine/core',
      '@/lib/utils.ts',
      'https://example.com/a.md',
      'mailto:x@y.z',
      'npm i',
      'foo()',
      'a.b.c()',
      '/',
      './',
      'Array<string>',
      'x'.repeat(2000) + '.md',
      '.gitignore',
    ]) {
      expect(detectPath(s)).toBeUndefined();
    }
  });
});

describe('链接与路径', () => {
  test('isLocalHref', () => {
    expect(isLocalHref('docs/a.md')).toBe(true);
    expect(isLocalHref('../a.md')).toBe(true);
    expect(isLocalHref('/abs/a.md')).toBe(true);
    for (const h of ['', '#top', '//evil/x', '/\\evil/x', 'https://x', ' javascript:alert(1)', 'data:text/html,x']) {
      expect(isLocalHref(h)).toBe(false);
    }
  });

  test('resolveRelative：相对文件所在目录，去锚点', () => {
    expect(resolveRelative('/w/repo/docs/a.md', 'b.md')).toBe('/w/repo/docs/b.md');
    expect(resolveRelative('/w/repo/docs/a.md', './img/x.png')).toBe('/w/repo/docs/img/x.png');
    expect(resolveRelative('/w/repo/docs/a.md', '../README.md#usage')).toBe('/w/repo/README.md');
    expect(resolveRelative('/w/a.md', '../../../x.md')).toBe('/x.md');
    expect(resolveRelative('/w/repo/docs/a.md', '/etc/x.md')).toBe('/etc/x.md');
    expect(resolveRelative('/w/repo/docs/a.md', '~/x.md')).toBe('~/x.md');
  });

  test('displayPath / pathCrumbs / parentDir', () => {
    expect(displayPath('/w/repo/docs/a.md', '/w/repo')).toBe('docs/a.md');
    expect(displayPath('/w/repo', '/w/repo')).toBe('.');
    expect(displayPath('/w/repo2/a', '/w/repo')).toBe('/w/repo2/a');
    expect(pathCrumbs('/w/repo/docs', '/w/repo')).toEqual([
      { label: '/', path: '/', inScope: false },
      { label: 'w', path: '/w', inScope: false },
      { label: 'repo', path: '/w/repo', inScope: true },
      { label: 'docs', path: '/w/repo/docs', inScope: true },
    ]);
    expect(pathCrumbs('/w/x')).toEqual([
      { label: '/', path: '/', inScope: false },
      { label: 'w', path: '/w', inScope: false },
      { label: 'x', path: '/w/x', inScope: false },
    ]);
    expect(pathCrumbs('/', '/')).toEqual([{ label: '/', path: '/', inScope: true }]);
    expect(parentDir('/w/repo/a.md')).toBe('/w/repo');
    expect(parentDir('/a')).toBe('/');
  });

  test('normalizeDirInput', () => {
    expect(normalizeDirInput('~', '/home/u')).toBe('/home/u');
    expect(normalizeDirInput('~/..', '/home/u')).toBe('/home');
    expect(normalizeDirInput('/home/u/./w//', '/home/u')).toBe('/home/u/w');
    expect(normalizeDirInput('/..', undefined)).toBe('/');
    expect(normalizeDirInput('~/x', undefined)).toBeUndefined();
    expect(normalizeDirInput('rel', '/home/u')).toBeUndefined();
  });

  test('isUnder 按路径段；trustRisk', () => {
    expect(isUnder('/a/b', '/a')).toBe(true);
    expect(isUnder('/a/bc', '/a/b')).toBe(false);
    expect(isUnder('/a', '/')).toBe(true);
    expect(trustRisk('/home/u', '/home/u')).toBe('home');
    expect(trustRisk('/home', '/home/u')).toBe('above-home');
    expect(trustRisk('/home/u/w', '/home/u')).toBeUndefined();
    expect(trustRisk('/home/u', undefined)).toBeUndefined();
  });

  test('visibleEntries 默认藏点开头的', () => {
    const entries = [
      { name: '.env', type: 'file' as const, denied: true },
      { name: 'a.md', type: 'file' as const },
    ];
    expect(visibleEntries(entries, false).map((e) => e.name)).toEqual(['a.md']);
    expect(visibleEntries(entries, true)).toHaveLength(2);
  });
});

describe('高亮', () => {
  test('languageOf', () => {
    expect(languageOf('a.ts')).toBe('typescript');
    expect(languageOf('Dockerfile')).toBe('dockerfile');
    expect(languageOf('notes.txt')).toBeUndefined();
  });

  test('fenceCode：围栏比内容里最长的反引号串更长', () => {
    expect(fenceCode('x', 'ts')).toBe('```ts\nx\n```\n');
    expect(fenceCode('a ```` b\n', undefined)).toBe('`````\na ```` b\n`````\n');
  });
});

describe('面板 URL', () => {
  test('viewFromSearch / searchForView 往返，保留其他参数', () => {
    expect(viewFromSearch('')).toBeNull();
    expect(viewFromSearch('?dir=')).toEqual({ kind: 'dir' });
    expect(viewFromSearch('?dir=%2Fw%2Frepo')).toEqual({ kind: 'dir', path: '/w/repo' });
    expect(viewFromSearch('?file=docs%2Fa.md')).toEqual({ kind: 'file', path: 'docs/a.md' });
    const s = searchForView('?x=1&dir=', { kind: 'file', path: '/w/a b.md' });
    expect(viewFromSearch(s)).toEqual({ kind: 'file', path: '/w/a b.md' });
    expect(new URLSearchParams(s).get('x')).toBe('1');
    expect(searchForView(s, null)).toBe('?x=1');
  });
});
