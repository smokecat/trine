import { describe, expect, test } from 'bun:test';
import { sniffImage } from './image-info.ts';

/** 3×2 的合成小图（Pillow 生成），覆盖各格式的头部变体 */
const FIXTURES: Record<string, string> = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR4nGM8wcXFwMDAwMDAxAADABByAOAp6i43AAAAAElFTkSuQmCC',
  jpeg:
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDy6iiivmj9tP/Z',
  gif: 'R0lGODdhAwACAIEAAMgKCgAAAAAAAAAAACwAAAAAAwACAAAIBgABCBwYEAA7',
  webpLossy: 'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoDAAIAAUAmJaACdLoB+AADsAD+9hNf/izkYjs83/4E78Cd+BO/8AAAAAA=',
  webpLossless: 'UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAAAdQhSJXof+BiOh/AAA=',
  webpExtended: 'UklGRkYAAABXRUJQVlA4WAoAAAAQAAAAAgAAAQAAQUxQSAcAAAAAAAAAAAAAAFZQOCAYAAAAMAEAnQEqAwACAAFAJiWkAANwAP79NmgA',
};

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

describe('sniffImage', () => {
  test.each([
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webpLossy', 'image/webp'],
    ['webpLossless', 'image/webp'],
    ['webpExtended', 'image/webp'],
  ])('%s → %s 3×2', (name, mediaType) => {
    expect(sniffImage(bytes(FIXTURES[name]!))).toEqual({ mediaType: mediaType as never, width: 3, height: 2 });
  });

  test('不认识的内容和截断的头部返回 undefined', () => {
    expect(sniffImage(new TextEncoder().encode('%PDF-1.7 not an image'))).toBeUndefined();
    expect(sniffImage(new Uint8Array(0))).toBeUndefined();
    expect(sniffImage(bytes(FIXTURES['png']!).subarray(0, 12))).toBeUndefined();
    // JPEG 在 SOF 之前就断了
    expect(sniffImage(bytes(FIXTURES['jpeg']!).subarray(0, 100))).toBeUndefined();
  });
});
