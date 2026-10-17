/**
 * 配对页（原型「配对」屏 `#scr-pair`，方案 §4.5）：三步布局。
 *
 *   ① 在目标机器上启动 agent（命令块）
 *   ② 扫描或粘贴配对码（摄像头取景框 + 粘贴框，解码失败给可读原因）
 *   ③ 比对安全码（6 位数字 + 4 emoji，「不一致，中止」）
 *
 * 状态机在 `lib/pairing.ts`，本视图只做「逐 phase 渲染 + 三个动作」：
 * `prepare(code)` / `start()` / `abort()`。**配对完成的权威判据是
 * authenticate 成功**（评审 B2），所以 done 之后还有一步 `completePairing`
 * ——它才是写 PeerState、接入连接的地方，界面上属于「正在验证登记…」之后
 * 的「完成」。
 *
 * 旧 QR（无 machineId）回落：`completePairing` 会等首条在线 machine.status
 * 来定 machineId（评审阶段 1 B2 修好了这条路径），界面必须提示用户核对，
 * 因为多机场景下先到的那条可能是别的机器。
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { AppHead } from '@/components/shell/AppHead.tsx';
import { CameraScanner } from '@/components/pair/CameraScanner.tsx';
import { CodeBlock, Step } from '@/components/pair/PairSteps.tsx';
import {
  activeStep,
  agentCommand,
  canRetry,
  pairingCodeError,
  phaseText,
  phaseTone,
} from '@/components/pair/pair-text.ts';
import { systemClock } from '@/lib/adapters.ts';
import { browserSocketFactory } from '@/lib/adapters.browser.ts';
import type { PairingFlow, PairingSnapshot } from '@/lib/pairing.ts';
import { useClient, useTrine } from '@/app/runtime.ts';
import { cn } from '@/lib/utils.ts';

const TONE_CLASS = {
  neutral: 'text-text-2',
  wait: 'text-brand-ink',
  ok: 'text-green',
  err: 'text-red',
} as const;

export function PairView(): React.JSX.Element {
  const client = useClient();
  const navigate = useNavigate();
  const serverUrl = useTrine((s) => s.serverUrl);
  const machines = useTrine((s) => s.machines);
  const [code, setCode] = useState('');
  const [snap, setSnap] = useState<PairingSnapshot | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [completing, setCompleting] = useState<string | null>(null);
  const flowRef = useRef<PairingFlow | null>(null);

  useEffect(() => () => flowRef.current?.dispose(), []);

  // done（authenticate 已成功）→ 写 PeerState 并接入
  useEffect(() => {
    if (!client || snap?.phase !== 'done' || !snap.result || completing !== null) return;
    setCompleting('正在写入配对信息并接入…');
    client
      .completePairing(snap.result)
      .then((machineId) => {
        const name = client.machine(machineId)?.name ?? machineId;
        toast.success(`已配对 ${name}`, {
          description:
            snap.result?.machineId === undefined
              ? '配对码未带 machineId，已按首台在线 agent 识别，请到机器页核对。'
              : undefined,
        });
        navigate('/');
      })
      .catch((err: unknown) => {
        setCompleting(`接入失败：${err instanceof Error ? err.message : String(err)}`);
      });
  }, [client, snap, completing, navigate]);

  const phase = snap?.phase ?? 'idle';
  const step = activeStep(phase);
  const busy = phase === 'waiting' || phase === 'verifying' || completing !== null;

  /** 解析配对码（扫码与粘贴共用）。失败给可读原因，不进 flow 的 failed 态 */
  const prepare = (text: string): void => {
    if (!client) return;
    const trimmed = text.trim();
    if (trimmed === '') return;
    setCode(trimmed);
    setCodeError(null);
    flowRef.current?.dispose();
    const flow = client.createPairingFlow({
      createSocket: browserSocketFactory,
      clock: systemClock,
      onChange: setSnap,
      log: (l) => console.info(l),
    });
    flowRef.current = flow;
    const next = flow.prepare(trimmed);
    setSnap(next);
    if (next.phase === 'failed') setCodeError(pairingCodeError(next.error ?? '配对码无法解析'));
  };

  const reset = (): void => {
    flowRef.current?.dispose();
    flowRef.current = null;
    setSnap(null);
    setCodeError(null);
    setCompleting(null);
  };

  return (
    <>
      <AppHead back={machines && Object.keys(machines).length > 0 ? '/machines' : '/'} title="添加机器" />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
        <Step
          n={1}
          active={step === 1}
          title="在目标机器上启动 agent"
          desc="在装有 claude CLI 的机器上运行（它会在终端打印二维码与 trine1: 配对码）："
        >
          <CodeBlock>{agentCommand(serverUrl)}</CodeBlock>
          {serverUrl === null && (
            <p className="text-text-3 mt-1.5 text-[11.5px]">
              把 &lt;服务端地址&gt; 换成你的 trine 服务端（本机开发用
              <span className="font-mono"> http://localhost:5173</span>）。
            </p>
          )}
        </Step>

        <Step
          n={2}
          active={step === 2}
          title="扫描或粘贴配对码"
          desc="用摄像头扫终端里的二维码，或把 trine1: 开头的那一整段粘进来。"
        >
          <div className="flex flex-col gap-3">
            <CameraScanner onScan={prepare} disabled={busy} />
            <div className="flex flex-col gap-2">
              <Textarea
                data-testid="pair-code"
                className="min-h-20 font-mono text-xs"
                placeholder="trine1:…"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={busy}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  data-testid="pair-parse"
                  disabled={code.trim() === '' || !client || busy}
                  onClick={() => prepare(code)}
                >
                  解析配对码
                </Button>
                {(snap !== null || codeError !== null) && !busy && (
                  <Button variant="ghost" onClick={reset} data-testid="pair-reset">
                    清空重来
                  </Button>
                )}
              </div>
              {codeError !== null && (
                <p data-testid="pair-code-error" className="text-red text-xs">
                  {codeError}
                </p>
              )}
            </div>
          </div>
        </Step>

        <Step
          n={3}
          active={step === 3}
          title="比对安全码"
          desc="两端会各自算出同一组安全码。请在 2 分钟内在 agent 终端比对并确认；两端完全一致才确认，不一致请中止。"
        >
          {snap?.sas ? (
            <div className="flex flex-col gap-3">
              <div
                data-testid="pair-sas"
                className="border-border bg-surface w-fit rounded-[12px] border px-4 py-3"
              >
                <div className="font-mono text-[30px] leading-tight font-medium tracking-[0.12em] tabular">
                  {snap.sas.digits}
                </div>
                <div className="mt-1 flex gap-2.5 text-[26px]">
                  {snap.sas.emoji.map((e, i) => (
                    <span key={`${e}-${i}`}>{e}</span>
                  ))}
                </div>
              </div>

              <dl className="text-text-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
                <dt>服务端</dt>
                <dd className="font-mono break-all">{snap.serverUrl}</dd>
                <dt>机器</dt>
                <dd className="font-mono break-all">
                  {snap.machineId ?? '（配对码未带 machineId，将按首台在线 agent 识别，请事后核对）'}
                </dd>
              </dl>

              <div className="flex flex-wrap gap-2">
                {phase === 'ready' && (
                  <Button data-testid="pair-start" onClick={() => flowRef.current?.start()}>
                    两端一致，开始配对
                  </Button>
                )}
                {(phase === 'ready' || phase === 'waiting') && (
                  <Button
                    variant="outline"
                    data-testid="pair-abort"
                    onClick={() => flowRef.current?.abort()}
                  >
                    不一致，中止
                  </Button>
                )}
                {canRetry(phase) && (
                  <Button variant="outline" data-testid="pair-retry" onClick={reset}>
                    重试
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <p className="text-text-3 text-[13px]">解析配对码后，这里会显示本端的安全码。</p>
          )}

          {snap !== null && phase !== 'idle' && (
            <div
              data-testid="pair-phase"
              data-phase={phase}
              className={cn('mt-3 text-[13px]', TONE_CLASS[phaseTone(phase)])}
            >
              <span className="font-medium">{phaseText(phase)}</span>
              {phase === 'verifying' && (
                <span className="text-text-3">（第 {snap.attempts} 次探测）</span>
              )}
              {snap.error !== null && <div className="text-red mt-1">{snap.error}</div>}
              {completing !== null && <div className="text-text-2 mt-1">{completing}</div>}
            </div>
          )}
        </Step>

        <p className="text-text-3 mt-2 text-[11px]">
          本设备 id：<span className="font-mono break-all">{client?.deviceId ?? '—'}</span>
        </p>
      </div>
    </>
  );
}
