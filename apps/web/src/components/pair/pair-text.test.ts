import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { decodePairingPayload, sodiumReady } from '@trine/core/crypto';
import {
  activeStep,
  agentCommand,
  cameraFailureText,
  canRetry,
  classifyCameraError,
  pairingCodeError,
  qrScanSize,
  QR_SCAN_INTERVAL_MS,
  phaseText,
  phaseTone,
} from './pair-text.ts';

await sodiumReady();

/** 造一段 trine1: 配对码（内容可畸形，用来驱动解码失败路径） */
function encode(payload: Record<string, unknown>): string {
  return `trine1:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

const GOOD = {
  v: 1,
  serverUrl: 'https://trine.example.com',
  agentPubKey: Buffer.alloc(32, 7).toString('base64url'),
  pairingToken: 'tok',
  qrSecret: Buffer.alloc(16, 3).toString('base64url'),
};

function decodeError(code: string): string {
  try {
    decodePairingPayload(code);
    throw new Error('期望解码失败，但成功了');
  } catch (err) {
    return pairingCodeError(err);
  }
}

describe('配对码错误 → 可读原因', () => {
  test('对照组：合法配对码能解开', () => {
    expect(decodePairingPayload(encode(GOOD)).serverUrl).toBe(GOOD.serverUrl);
  });

  test('非 trine 配对码', () => {
    expect(decodeError('hello world')).toContain('trine1:');
  });

  test('serverUrl 非 TLS 且非回环 → 指出必须 https/wss 或回环', () => {
    const text = decodeError(encode({ ...GOOD, serverUrl: 'http://example.com' }));
    expect(text).toContain('服务端地址');
    expect(text).toMatch(/https|wss|回环/);
  });

  test('回环地址豁免 TLS（本机开发）', () => {
    expect(decodePairingPayload(encode({ ...GOOD, serverUrl: 'http://localhost:5173' })).serverUrl).toBe(
      'http://localhost:5173',
    );
  });

  test('公钥长度不对 → 说公钥损坏', () => {
    expect(decodeError(encode({ ...GOOD, agentPubKey: 'AAAA' }))).toContain('公钥');
  });

  test('截断的配对码 → 提示重新复制整段（lib 已在源头映射，无需 UI 补丁）', () => {
    const text = decodeError('trine1:!!!!');
    expect(text).toContain('重新复制');
    expect(text).not.toMatch(/incomplete input/i);
  });

  test('实际路径：prepare() 已映射过的中文文案原样透传', () => {
    // PairView 拿到的是 snapshot.error（字符串），不是原始异常；
    // lib 修好后 prepare() 再也产不出 `配对码无法解析：incomplete input` 这种，
    // 这里只需保证已可读的文案不被再套一层前缀
    const single = 'MVP 只支持一个服务端：本设备已配对 A，这个配对码指向 B。';
    expect(pairingCodeError(single)).toBe(single);
    expect(pairingCodeError('配对码内容损坏或不完整，请重新复制')).toBe('配对码内容损坏或不完整，请重新复制');
  });

  test('不认识的错误也带上原文，不是空白', () => {
    expect(pairingCodeError(new Error('boom'))).toContain('boom');
  });
});

describe('摄像头失败归类与文案', () => {
  test('DOMException name → 归类', () => {
    expect(classifyCameraError({ name: 'NotAllowedError' })).toBe('denied');
    expect(classifyCameraError({ name: 'SecurityError' })).toBe('denied');
    expect(classifyCameraError({ name: 'NotFoundError' })).toBe('not-found');
    expect(classifyCameraError({ name: 'NotReadableError' })).toBe('in-use');
    expect(classifyCameraError(new Error('???'))).toBe('unknown');
    expect(classifyCameraError(null)).toBe('unknown');
  });

  test('每种原因都指向粘贴框这条兜底路径', () => {
    for (const f of ['insecure-context', 'unsupported', 'denied', 'not-found', 'in-use', 'unknown'] as const) {
      expect(cameraFailureText(f)).toContain('粘贴框');
    }
    expect(cameraFailureText('insecure-context')).toContain('localhost');
    expect(cameraFailureText('denied')).toContain('权限');
  });
});

describe('phase → 状态行 / 步骤 / 重试', () => {
  test('逐 phase 文案', () => {
    expect(phaseText('ready')).toContain('比对');
    expect(phaseText('waiting')).toBe('等待 agent 确认…');
    expect(phaseText('verifying')).toBe('正在验证登记…');
    expect(phaseText('done')).toBe('完成');
    expect(phaseText('aborted')).toBe('已中止');
    expect(phaseText('failed')).toBe('配对失败');
    expect(phaseText('idle')).toBe('');
    expect(phaseText('disposed')).toBe('');
  });

  test('等待/验证是 wait，完成是 ok，中止/失败是 err', () => {
    expect(phaseTone('waiting')).toBe('wait');
    expect(phaseTone('verifying')).toBe('wait');
    expect(phaseTone('done')).toBe('ok');
    expect(phaseTone('aborted')).toBe('err');
    expect(phaseTone('failed')).toBe('err');
    expect(phaseTone('idle')).toBe('neutral');
  });

  test('解码成功后步骤推进到 3，失败态退回 2', () => {
    expect(activeStep('idle')).toBe(2);
    expect(activeStep('ready')).toBe(3);
    expect(activeStep('waiting')).toBe(3);
    expect(activeStep('done')).toBe(3);
    expect(activeStep('failed')).toBe(2);
    expect(activeStep('aborted')).toBe(2);
  });

  test('只有失败/中止能重试', () => {
    expect(canRetry('failed')).toBe(true);
    expect(canRetry('aborted')).toBe(true);
    expect(canRetry('waiting')).toBe(false);
    expect(canRetry('done')).toBe(false);
  });
});

describe('第 1 步命令行', () => {
  test('已知服务端就填进去，未知给占位符', () => {
    expect(agentCommand('http://localhost:5173')).toContain('--server http://localhost:5173');
    expect(agentCommand(null)).toContain('<服务端地址>');
    expect(agentCommand(null)).toContain('--pair');
  });
});

describe('jsQR 解码降采样（m1）', () => {
  test('超过上限等比缩到最长边 640', () => {
    expect(qrScanSize(1920, 1080)).toEqual({ width: 640, height: 360 });
    expect(qrScanSize(1080, 1920)).toEqual({ width: 360, height: 640 });
    expect(qrScanSize(1280, 1280)).toEqual({ width: 640, height: 640 });
  });

  test('已经够小就不动（放大反而丢信息又更慢）', () => {
    expect(qrScanSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(qrScanSize(320, 240)).toEqual({ width: 320, height: 240 });
  });

  test('退化输入不产生 0 宽 canvas（getImageData 会抛）', () => {
    expect(qrScanSize(0, 0)).toEqual({ width: 0, height: 0 });
    expect(qrScanSize(4000, 1)).toEqual({ width: 640, height: 1 });
  });

  test('节流间隔约 10fps', () => {
    expect(QR_SCAN_INTERVAL_MS).toBeGreaterThanOrEqual(80);
    expect(QR_SCAN_INTERVAL_MS).toBeLessThanOrEqual(150);
  });

  test('CameraScanner 用了重入守卫与限频（m1/m2）', () => {
    const src = readFileSync(new URL('./CameraScanner.tsx', import.meta.url), 'utf8');
    expect(src).toContain('startingRef');
    expect(src).toContain('qrScanSize');
    expect(src).toContain('QR_SCAN_INTERVAL_MS');
  });
});
