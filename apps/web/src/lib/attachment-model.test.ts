import { describe, expect, test } from 'bun:test';
import {
  attachmentKind,
  attachmentRefs,
  checkAdd,
  draftRefs,
  draftsReady,
  effectiveLimits,
  hasFiles,
  isCompressibleImage,
  type DraftAttachment,
} from './attachment-model.ts';

const MB = 1024 * 1024;
const ref = { name: 'a.png', mime: 'image/png', size: 3, kind: 'image' as const, blobId: 'b'.repeat(22), key: 'k'.repeat(43) };

describe('attachment-model', () => {
  test('类型判定：只有四种格式按图片发，参数与大小写不影响', () => {
    expect(attachmentKind('image/png')).toBe('image');
    expect(attachmentKind('IMAGE/JPEG; charset=binary')).toBe('image');
    expect(attachmentKind('image/heic')).toBe('file');
    expect(attachmentKind('')).toBe('file');
    expect(isCompressibleImage('image/webp')).toBe(true);
    expect(isCompressibleImage('image/gif')).toBe(false);
  });

  test('effectiveLimits：个数夹到协议上限，单个上限取 relay 的 99%', () => {
    expect(effectiveLimits({ attachMaxCount: 99, attachMaxTotalMb: 64 })).toEqual({
      maxCount: 32,
      maxTotalBytes: 64 * MB,
      maxFileBytes: undefined,
    });
    expect(effectiveLimits({ attachMaxCount: 10, attachMaxTotalMb: 64 }, 100 * MB).maxFileBytes).toBe(Math.floor(99 * MB));
  });

  test('checkAdd：按顺序收，超个数 / 超合计 / 超单个的拒掉并说明', () => {
    const limits = { maxCount: 3, maxTotalBytes: 10 * MB, maxFileBytes: 6 * MB };
    const files = [
      { name: 'a', size: 4 * MB },
      { name: 'big', size: 7 * MB },
      { name: 'b', size: 6 * MB },
      { name: 'c', size: 5 * MB },
      { name: 'd', size: 1 },
    ];
    // 已有 1MB：a → 5MB；big 超单个；b → 11MB 超合计；c → 10MB 正好；d 超个数
    const { accepted, errors } = checkAdd([{ size: 1 * MB }], files, limits);
    expect(accepted.map((f) => f.name)).toEqual(['a', 'c']);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('big');
    expect(errors[1]).toContain('合计');
    expect(errors[2]).toContain('最多 3 个');
  });

  test('草稿：全部 done 才能发，只取完成的引用', () => {
    const draft = (status: DraftAttachment['status']): DraftAttachment => ({
      id: status,
      file: new File([], 'x'),
      name: 'x',
      size: 0,
      kind: 'file',
      status,
      progress: 0,
      ...(status === 'done' ? { ref } : {}),
    });
    expect(draftsReady([])).toBe(true);
    expect(draftsReady([draft('done'), draft('uploading')])).toBe(false);
    expect(draftsReady([draft('error')])).toBe(false);
    expect(draftRefs([draft('done'), draft('error')])).toEqual([ref]);
  });

  test('attachmentRefs：只要带完整引用的', () => {
    expect(attachmentRefs({ attachments: [ref, { name: 'h.png', mime: 'image/png', size: 1, kind: 'image' }] })).toEqual([ref]);
    expect(attachmentRefs({})).toEqual([]);
  });

  test('hasFiles：只认带文件的拖拽', () => {
    expect(hasFiles(['text/plain', 'Files'])).toBe(true);
    expect(hasFiles(['text/plain'])).toBe(false);
    expect(hasFiles(undefined)).toBe(false);
  });
});
