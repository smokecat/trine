/**
 * 摄像头扫码（原型 `.qr-zone` 的取景框位置，方案 §4.5 第 1 步）。
 *
 * 两条解码路径：
 * - **`BarcodeDetector` 优先**（Chrome/Android 原生，零 JS 解码开销、更稳）；
 * - 缺席时回落 **jsQR**：把当前帧画进离屏 canvas 取 ImageData 逐帧解。
 *
 * 逐帧靠 `requestAnimationFrame` 而不是 setInterval：页面切后台时 rAF 自然停
 * （省电，也避免后台标签页霸着摄像头），回前台自动续上。
 *
 * **降级是一等公民**：非安全上下文（http 且非 localhost）、无 getUserMedia、
 * 用户拒绝、无摄像头、设备被占用——五种情况都不弹错误，而是收起取景框并
 * 说明原因，让用户走粘贴框（原型 `NOTES.pair`「手动输入配对码是无摄像头/
 * 扫码失败的兜底路径」）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { CameraIcon, CameraOffIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import {
  cameraFailureText,
  classifyCameraError,
  QR_SCAN_INTERVAL_MS,
  qrScanSize,
  type CameraFailure,
} from './pair-text.ts';

/** BarcodeDetector 的最小结构（TS lib 里还没有） */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

function barcodeDetectorCtor(): BarcodeDetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === 'function' ? ctor : null;
}

/** 开扫之前就能判定的不可用：安全上下文与 API 存在性 */
function preflight(): CameraFailure | null {
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure-context';
  if (typeof navigator === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined) {
    return 'unsupported';
  }
  return null;
}

export function CameraScanner({
  onScan,
  disabled = false,
}: {
  /** 扫到一段文本就回调；由调用方判断是不是 trine 配对码 */
  onScan: (text: string) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);
  const doneRef = useRef(false);
  /** 正在 start（await getUserMedia 期间）——重入守卫，见 start() */
  const startingRef = useRef(false);
  /** 上次 jsQR 解码时刻，用于限频 */
  const lastScanRef = useRef(0);

  const [scanning, setScanning] = useState(false);
  const [failure, setFailure] = useState<CameraFailure | null>(null);
  const [engine, setEngine] = useState<'barcode-detector' | 'jsqr' | null>(null);

  const stop = useCallback((): void => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    lastScanRef.current = 0;
    setScanning(false);
  }, []);

  // 卸载 / 路由离开一定要关摄像头，否则指示灯一直亮着
  useEffect(() => stop, [stop]);

  const startCamera = useCallback(async (): Promise<void> => {
    const pre = preflight();
    if (pre !== null) {
      setFailure(pre);
      return;
    }
    setFailure(null);
    doneRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // 后置摄像头（手机扫终端屏幕）；桌面只有前置时 ideal 会自动退让
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stop();
        return;
      }
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      await video.play();

      const Ctor = barcodeDetectorCtor();
      if (Ctor !== null) {
        try {
          detectorRef.current = new Ctor({ formats: ['qr_code'] });
          setEngine('barcode-detector');
        } catch {
          detectorRef.current = null;
          setEngine('jsqr');
        }
      } else {
        detectorRef.current = null;
        setEngine('jsqr');
      }
      setScanning(true);

      const tick = async (): Promise<void> => {
        if (doneRef.current) return;
        const v = videoRef.current;
        const canvas = canvasRef.current;
        if (!v || !canvas || v.readyState < 2) {
          rafRef.current = requestAnimationFrame(() => void tick());
          return;
        }
        let text: string | null = null;
        const detector = detectorRef.current;
        if (detector !== null) {
          try {
            const found = await detector.detect(v);
            text = found[0]?.rawValue ?? null;
          } catch {
            // 某些实现对未就绪的帧会抛；下一帧再来
          }
        } else {
          // jsQR 路径：限频 + 降采样（评审 m1）。整帧 1920×1080 每个 rAF 解一次
          // 在手机上是满负荷，而二维码占取景框很大面积，640px 足够解。
          const nowMs = Date.now();
          if (nowMs - lastScanRef.current < QR_SCAN_INTERVAL_MS) {
            rafRef.current = requestAnimationFrame(() => void tick());
            return;
          }
          lastScanRef.current = nowMs;
          const { width: w, height: h } = qrScanSize(v.videoWidth, v.videoHeight);
          if (w > 0 && h > 0) {
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(v, 0, 0, w, h);
              const image = ctx.getImageData(0, 0, w, h);
              text = jsQR(image.data, w, h, { inversionAttempts: 'dontInvert' })?.data ?? null;
            }
          }
        }
        if (text !== null && text !== '') {
          doneRef.current = true;
          stop();
          onScan(text);
          return;
        }
        rafRef.current = requestAnimationFrame(() => void tick());
      };
      rafRef.current = requestAnimationFrame(() => void tick());
    } catch (err) {
      setFailure(classifyCameraError(err));
      stop();
    }
  }, [onScan, stop]);

  const start = useCallback(async (): Promise<void> => {
    // 重入守卫（评审 m2）：`await getUserMedia` 期间 `scanning` 仍是 false，
    // 按钮还能再点——第二条流会覆盖 streamRef，第一条的 track 永不 stop，
    // 摄像头指示灯关不掉
    if (startingRef.current || streamRef.current !== null) return;
    startingRef.current = true;
    try {
      await startCamera();
    } finally {
      startingRef.current = false;
    }
  }, [startCamera]);


  // 非安全上下文/无 API：进页面就该显示原因，不必等用户点一下才知道
  useEffect(() => {
    const pre = preflight();
    if (pre !== null) setFailure(pre);
  }, []);

  if (failure !== null && !scanning) {
    return (
      <div
        data-testid="camera-unavailable"
        data-failure={failure}
        className="border-border bg-surface-2 text-text-2 flex items-start gap-2 rounded-[12px] border px-3 py-2.5 text-xs"
      >
        <CameraOffIcon className="mt-0.5 size-4 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span>{cameraFailureText(failure)}</span>
          {failure !== 'insecure-context' && failure !== 'unsupported' && (
            <Button
              size="xs"
              variant="outline"
              className="w-fit"
              onClick={() => void start()}
              disabled={disabled}
            >
              重试摄像头
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="camera-scanner" data-scanning={scanning}>
      <div
        className={
          'border-border-strong relative aspect-square w-[168px] overflow-hidden rounded-[12px] border bg-black'
        }
      >
        <video
          ref={videoRef}
          muted
          playsInline
          className={scanning ? 'size-full object-cover' : 'hidden'}
        />
        {!scanning && (
          <button
            type="button"
            data-testid="camera-start"
            disabled={disabled}
            onClick={() => void start()}
            className="text-text-3 hover:text-text absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-surface-2 text-xs transition-colors disabled:opacity-50"
          >
            <CameraIcon className="size-6" />
            开摄像头扫码
          </button>
        )}
        {scanning && (
          // 取景辅助框
          <div className="border-brand/70 pointer-events-none absolute inset-[14%] rounded-[8px] border-2" />
        )}
      </div>
      <canvas ref={canvasRef} className="hidden" />
      {scanning && (
        <div className="text-text-3 flex items-center gap-2 text-[11px]">
          <span>把 agent 终端里的二维码对准取景框</span>
          <Button size="xs" variant="ghost" onClick={stop}>
            关闭
          </Button>
        </div>
      )}
      {scanning && engine !== null && (
        <span className="sr-only" data-testid="camera-engine">
          {engine}
        </span>
      )}
    </div>
  );
}
