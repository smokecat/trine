/**
 * 配对页的文案映射：配对码错误、扫码降级原因、逐 phase 的状态行。纯函数 + 单测。
 *
 * 解码失败的映射**全部在** `lib/pairing.ts` 的 `describePairingCodeError`
 * ——它按异常的真实形状（libsodium 的 `incomplete input`、zod 的 issue 结构）
 * 判定。这里早先有一层 UI 补丁补 lib 漏判的 `incomplete input`，lib 修好后
 * 补丁就是第二份真相了，已删；本文件对配对码错误只剩「已映射文案原样透传」
 * 这一件事。
 */
import { describePairingCodeError } from '@/lib/pairing.ts';
import type { PairingPhase } from '@/store/types.ts';

/**
 * 配对码错误 → 用户能读的原因。
 *
 * 实际路径上拿到的是 `PairingFlow.prepare()` **已经映射过**的
 * `snapshot.error` 字符串（prepare 内部就调了 `describePairingCodeError`，
 * 单服务端拒绝那条长文案也是它自己生成的），原样透传即可，别再套一层
 * 「配对码无法解析：」。传进来的若是原始异常，交给 lib 映射。
 */
export function pairingCodeError(err: unknown): string {
  if (typeof err === 'string') return err;
  return describePairingCodeError(err);
}

/**
 * jsQR 回落路径的解码节流与降采样（评审 m1）。
 *
 * BarcodeDetector 路径因为 `await detect()` 天然限频，问题只在 jsQR：
 * 每个 rAF 把整帧（可达 1920×1080）画进 canvas 再 `getImageData` + jsQR，
 * 手机上就是 60fps 满负荷，取景框卡顿、发烫。
 *
 * 二维码在取景框里通常占很大面积，640px 宽足够解；节流到 ~10fps 对扫码
 * 体感没有影响（人举着手机对准也要一两秒）。
 */
export const QR_SCAN_INTERVAL_MS = 100;
export const QR_MAX_EDGE = 640;

/** 把 (w,h) 等比缩到最长边 ≤ QR_MAX_EDGE；已经够小就原样返回 */
export function qrScanSize(
  w: number,
  h: number,
  maxEdge = QR_MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(w, h);
  if (longest <= maxEdge || longest === 0) return { width: w, height: h };
  const scale = maxEdge / longest;
  // 取整且至少 1px——0 宽的 canvas 会让 getImageData 抛
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** 摄像头不可用的原因（决定降级提示的措辞） */
export type CameraFailure =
  | 'insecure-context'
  | 'unsupported'
  | 'denied'
  | 'not-found'
  | 'in-use'
  | 'unknown';

/**
 * 把 `getUserMedia` 抛出的 DOMException 归类。名字取自 W3C 规范：
 * NotAllowedError = 用户拒绝，NotFoundError = 没有摄像头，
 * NotReadableError = 设备被别的程序占着。
 */
export function classifyCameraError(err: unknown): CameraFailure {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'not-found';
    case 'NotReadableError':
    case 'AbortError':
      return 'in-use';
    default:
      return 'unknown';
  }
}

/** 降级提示：说清楚为什么没有取景框，以及还能怎么办 */
export function cameraFailureText(failure: CameraFailure): string {
  switch (failure) {
    case 'insecure-context':
      return '当前页面不是安全上下文（需要 https 或 localhost），浏览器不允许访问摄像头。请用下面的粘贴框。';
    case 'unsupported':
      return '这个浏览器不支持摄像头取景（缺少 getUserMedia）。请用下面的粘贴框。';
    case 'denied':
      return '摄像头权限被拒绝。可以在地址栏的站点设置里重新允许，或直接用下面的粘贴框。';
    case 'not-found':
      return '没有找到可用的摄像头。请用下面的粘贴框。';
    case 'in-use':
      return '摄像头被其它程序占用，无法打开。关掉占用它的程序后重试，或用下面的粘贴框。';
    case 'unknown':
      return '摄像头打开失败。请用下面的粘贴框。';
  }
}

/** 状态行文案（原型第 3 步下方那行「等待 agent 确认…」） */
export function phaseText(phase: PairingPhase): string {
  switch (phase) {
    case 'idle':
      return '';
    case 'ready':
      return '请与 agent 终端比对安全码';
    case 'waiting':
      return '等待 agent 确认…';
    case 'verifying':
      return '正在验证登记…';
    case 'done':
      return '完成';
    case 'aborted':
      return '已中止';
    case 'failed':
      return '配对失败';
    case 'disposed':
      return '';
  }
}

/** phase → 状态行色调 */
export function phaseTone(phase: PairingPhase): 'neutral' | 'wait' | 'ok' | 'err' {
  switch (phase) {
    case 'waiting':
    case 'verifying':
      return 'wait';
    case 'done':
      return 'ok';
    case 'aborted':
    case 'failed':
      return 'err';
    default:
      return 'neutral';
  }
}

/** 当前该点亮第几步（原型 `.step.on`）：1 启动 agent / 2 扫码 / 3 比对 */
export function activeStep(phase: PairingPhase): 1 | 2 | 3 {
  switch (phase) {
    case 'ready':
    case 'waiting':
    case 'verifying':
    case 'done':
      return 3;
    default:
      return 2;
  }
}

/** 出错后能不能「重试」（回到粘贴/扫码那一步重来） */
export function canRetry(phase: PairingPhase): boolean {
  return phase === 'failed' || phase === 'aborted';
}

/**
 * 第 1 步的命令行。serverUrl 已知（重新配对第二台机器）就填进去，
 * 未知时给占位符——照抄一条连不上的地址比留空更误导。
 */
export function agentCommand(serverUrl: string | null): string {
  const target = serverUrl ?? '<服务端地址>';
  return `bun run dev:agent -- --server ${target} --pair`;
}
