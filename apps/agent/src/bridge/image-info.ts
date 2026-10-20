/**
 * 从文件头识别图片类型和尺寸（png / jpeg / gif / webp）。
 *
 * 内联给模型的 image 块，`media_type` 必须和真实格式一致（API 会拒绝不符的），
 * 尺寸决定能不能内联（见 attachments.ts 的内联条件）——浏览器给的 mime 和扩展名
 * 都不可信，这里只看字节。不依赖图像库：只解析头部，不解码像素。
 */

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ImageInfo {
  mediaType: ImageMediaType;
  width: number;
  height: number;
}

/** 识别不了（不是这四种 / 头部残缺）返回 undefined */
export function sniffImage(bytes: Uint8Array): ImageInfo | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const has = (n: number) => bytes.length >= n;

  // PNG：8 字节签名，紧跟 IHDR（宽高各 4 字节大端）
  if (has(24) && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return dims('image/png', view.getUint32(16), view.getUint32(20));
  }

  // GIF：GIF87a / GIF89a，逻辑屏幕宽高各 2 字节小端
  if (has(10) && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return dims('image/gif', view.getUint16(6, true), view.getUint16(8, true));
  }

  // WebP：RIFF....WEBP + VP8 / VP8L / VP8X 子块
  if (has(30) && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === 'VP8 ') {
      return dims('image/webp', view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    }
    if (chunk === 'VP8L') {
      const b = view.getUint32(21, true);
      return dims('image/webp', (b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1);
    }
    if (chunk === 'VP8X') {
      const w = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
      const h = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
      return dims('image/webp', w, h);
    }
    return undefined;
  }

  // JPEG：FFD8 起，逐段找 SOFn（C0–CF，除去 C4 DHT / C8 / CC DAC）
  if (has(4) && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let off = 2;
    while (off + 9 < bytes.length) {
      if (bytes[off] !== 0xff) return undefined;
      const marker = bytes[off + 1]!;
      // 填充字节
      if (marker === 0xff) {
        off += 1;
        continue;
      }
      // 无长度的独立标记
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      const len = view.getUint16(off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return dims('image/jpeg', view.getUint16(off + 7), view.getUint16(off + 5));
      }
      off += 2 + len;
    }
    return undefined;
  }

  return undefined;
}

function dims(mediaType: ImageMediaType, width: number, height: number): ImageInfo | undefined {
  return width > 0 && height > 0 ? { mediaType, width, height } : undefined;
}

function ascii(bytes: Uint8Array, start: number, len: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + len));
}
