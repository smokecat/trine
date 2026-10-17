import { describe, expect, test } from 'bun:test';
import { isSessionNotFound, normalizeSessionTitle, SESSION_TITLE_MAX } from './session-mutations.ts';

describe('normalizeSessionTitle（与 SDK W4 逐字对齐）', () => {
  test('trim；连续控制 / 格式字符换成一个空格', () => {
    expect(normalizeSessionTitle('  部署脚本  ')).toBe('部署脚本');
    expect(normalizeSessionTitle('a\n\r\tb')).toBe('a b');
    expect(normalizeSessionTitle('a\u0000b\u007fc\u0085d')).toBe('a b c d');
    // \p{Cf}：零宽空格 / BOM；U+2028/2029 行分隔
    expect(normalizeSessionTitle('x\u200by\ufeffz\u2028w\u2029v')).toBe('x y z w v');
  });

  test('只剩控制字符 / 空白 → 空串（调用方据此回 invalid）', () => {
    expect(normalizeSessionTitle('')).toBe('');
    expect(normalizeSessionTitle(' \u0001\u007f\n ')).toBe('');
  });

  test('按码点截到 200（不劈开代理对），截完再 trim', () => {
    const emoji = '😀'.repeat(250);
    const out = normalizeSessionTitle(emoji);
    expect([...out]).toHaveLength(SESSION_TITLE_MAX);
    expect(out).toBe('😀'.repeat(200));
    expect(normalizeSessionTitle(`${'a'.repeat(199)} tail`)).toBe('a'.repeat(199));
  });
});

describe('isSessionNotFound', () => {
  test('认 SDK 的 not found 消息，其余不认', () => {
    expect(isSessionNotFound(new Error('Session x not found in any project directory'))).toBe(true);
    expect(isSessionNotFound(new Error('Session x not found in project directory for /p'))).toBe(true);
    expect(isSessionNotFound(new Error('EACCES: permission denied'))).toBe(false);
    expect(isSessionNotFound('not found')).toBe(false);
  });
});
