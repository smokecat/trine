/**
 * 终端二维码渲染。
 *
 * 配对材料的带外通道是 QR：用户拿手机扫 agent 终端里的码。渲染失败
 * （不是 TTY、终端不支持 Unicode 半块字符、库本身出问题）**绝不能让配对
 * 走不下去**——纯文本 payload 手工复制粘贴同样能完成配对，只是麻烦些。
 * 所以这里的契约是：永远返回可展示的东西，QR 只是「有就更好」。
 */
import QRCode from 'qrcode';

export interface RenderedPairing {
  /** 终端可直接打印的 QR 图形；渲染不出来时为 null */
  qr: string | null;
  /** 原始 payload 文本，任何情况下都有——这是 fallback 的兜底 */
  text: string;
  /** QR 渲染失败的原因（仅供日志） */
  qrError?: string;
}

/**
 * 渲染配对 payload。
 *
 * `small: true` 用半块字符把码压到一半高度——完整尺寸的 QR 在 80x24 的
 * 终端里根本放不下，滚动出去一半的码是扫不了的。
 */
export async function renderPairingPayload(
  payload: string,
): Promise<RenderedPairing> {
  try {
    const qr = await QRCode.toString(payload, {
      type: 'terminal',
      small: true,
      // 配对码里已有 128-bit 的 qrSecret，纠错级别取低档换更小的图形；
      // 屏幕上的码不存在污损，M 以上纯属浪费面积
      errorCorrectionLevel: 'L',
    });
    return { qr, text: payload };
  } catch (err) {
    return { qr: null, text: payload, qrError: (err as Error).message };
  }
}

/**
 * 组装终端上给用户看的完整配对提示。
 *
 * 明确要求「两端 SAS 一致才确认」是有必要的：SAS 比对是整套配对里唯一
 * 挡得住中间人的环节（服务端不可信、pair 帧明文广播），用户随手点确认
 * 等于把它废掉。
 */
export function formatPairingPrompt(rendered: RenderedPairing): string {
  const lines = ['', '用手机扫描下面的二维码完成配对：', ''];
  if (rendered.qr) {
    lines.push(rendered.qr);
  } else {
    lines.push(
      `（二维码渲染失败${rendered.qrError ? `：${rendered.qrError}` : ''}，`,
      '请手工复制下面这行配对码到客户端）',
      '',
    );
  }
  lines.push('配对码（复制粘贴同样可用）：', rendered.text, '');
  lines.push(
    '扫码后两端会各自显示一组校验码（SAS）。',
    '**两端完全一致才可确认**——不一致意味着中间有人在替换密钥，请中止并重新配对。',
    '',
  );
  return lines.join('\n');
}
