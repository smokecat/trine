import { describe, expect, test } from 'bun:test';
import { splitCwd, tildify } from './cwd-display.ts';

describe('tildify', () => {
  test('home 前缀换成 ~，只认整段', () => {
    expect(tildify('/home/u/w/app', '/home/u')).toBe('~/w/app');
    expect(tildify('/home/u', '/home/u/')).toBe('~');
    expect(tildify('/home/user2/app', '/home/u')).toBe('/home/user2/app');
  });

  test('不知道 home 或 home 是根就原样', () => {
    expect(tildify('/home/u/app', undefined)).toBe('/home/u/app');
    expect(tildify('/srv/app', '/')).toBe('/srv/app');
  });
});

describe('splitCwd', () => {
  test('目录名 + 上级路径', () => {
    expect(splitCwd('/home/u/w/app', '/home/u')).toEqual({ name: 'app', parent: '~/w' });
    expect(splitCwd('/home/u/app', '/home/u')).toEqual({ name: 'app', parent: '~' });
    expect(splitCwd('/srv/app/', undefined)).toEqual({ name: 'app', parent: '/srv' });
    expect(splitCwd('/srv', undefined)).toEqual({ name: 'srv', parent: '/' });
  });

  test('根、home 本身、相对写法没有上级', () => {
    expect(splitCwd('/', undefined)).toEqual({ name: '/', parent: '' });
    expect(splitCwd('/home/u', '/home/u')).toEqual({ name: '~', parent: '' });
    expect(splitCwd('app', undefined)).toEqual({ name: 'app', parent: '' });
  });
});
