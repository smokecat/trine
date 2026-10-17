/**
 * ExitPlanMode 计划卡——plan 模式下 Claude 写完计划、请求批准执行。
 *
 * 协议上它是一次权限请求（canUseTool），沿用权限卡的生命周期：pending 时可操作、
 * 「已等待 N 秒」走秒（`now` 由 ChatView 统一 tick），resolved / invalidated 后
 * 按钮消失、显式标注结果。三个动作与 decision 形状见 plan-model.ts。
 *
 * - 计划正文走现有 `Markdown`（streamdown + 外链图片拦截等安全处理），绝不自己
 *   dangerouslySetInnerHTML；pending 时限高可滚动，resolved 后折叠、可展开再看；
 * - 手机宽度：按钮全宽堆叠、高 40px（sm 以上横排 32px），与提问卡一致；
 * - 旧 agent（< 0.6.0，`supportsOptions=false`）不认 message / setMode：不显示
 *   「自动接受编辑」与反馈框，只留两个做得到的动作，并说明原因。
 */
import { useState } from 'react';
import type { PermissionEntry } from '@/lib/reducer.ts';
import { formatSeconds } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { Markdown } from './Markdown.tsx';
import { Disclosure } from './Messages.tsx';
import type { PermissionDecision } from './PermissionCard.tsx';
import { SubagentSourceNote } from './SubagentSourceNote.tsx';
import { parsePlanInput, planDecision, planResultText, type PlanAction, type PlanInput } from './plan-model.ts';

const RESULT_TONE = {
  green: 'text-green',
  amber: 'text-amber',
  muted: 'text-text-3',
} as const;

export function PlanCard({
  entry,
  deviceId,
  now,
  supportsOptions = true,
  onRespond,
  subagentSource,
}: {
  entry: PermissionEntry;
  deviceId: string | null;
  now: number;
  /** agent 是否支持 message / setMode（≥ 0.6.0） */
  supportsOptions?: boolean;
  onRespond: (decision: PermissionDecision) => void;
  /** 子 agent 发起的计划：父 Task 卡的描述（'' = 找不到父卡）；主线程 undefined */
  subagentSource?: string | undefined;
}): React.JSX.Element | null {
  const parsed = parsePlanInput(entry.input);
  // 调用方（Timeline）已按 isPlanRequest 分流，这里只是兜底
  if (parsed === null) return null;
  return (
    <PlanCardBody
      entry={entry}
      plan={parsed}
      deviceId={deviceId}
      now={now}
      supportsOptions={supportsOptions}
      onRespond={onRespond}
      subagentSource={subagentSource}
    />
  );
}

function PlanCardBody({
  entry,
  plan,
  deviceId,
  now,
  supportsOptions,
  onRespond,
  subagentSource,
}: {
  entry: PermissionEntry;
  plan: PlanInput;
  deviceId: string | null;
  now: number;
  supportsOptions: boolean;
  onRespond: (decision: PermissionDecision) => void;
  subagentSource: string | undefined;
}): React.JSX.Element {
  const pending = entry.state === 'pending';
  const [feedback, setFeedback] = useState('');
  const act = (action: PlanAction): void => {
    onRespond(planDecision(action, entry.input, feedback, { supportsOptions }));
  };

  const planBody = (
    <div
      data-testid="plan-body"
      className="bg-surface-2 border-border max-h-[55vh] overflow-auto rounded-lg border px-3 py-2.5 sm:max-h-96"
    >
      <Markdown text={plan.plan} streaming={false} />
    </div>
  );

  return (
    <li
      data-testid="entry-plan"
      data-state={entry.state}
      className={cn(
        'overflow-hidden rounded-[14px] border',
        pending ? 'border-amber-border bg-surface' : 'border-border bg-surface',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2 px-3.5 py-2 text-[13px] font-semibold',
          pending ? 'bg-amber-soft' : 'bg-surface-2',
        )}
      >
        <span aria-hidden>📋</span>
        Claude 请求批准计划
        <span
          data-testid="plan-waited"
          className={cn(
            'tabular ml-auto font-mono text-[12px] font-normal',
            pending ? 'text-amber' : 'text-text-3',
          )}
        >
          {pending ? `已等待 ${formatSeconds(Math.max(0, now - entry.requestedAt))}` : '已响应'}
        </span>
      </div>
      {subagentSource !== undefined && <SubagentSourceNote label={subagentSource} />}

      <div className="flex flex-col gap-2 px-3.5 py-2.5">
        {plan.planFilePath !== undefined && (
          <div data-testid="plan-file" className="text-text-3 truncate font-mono text-[11px]" title={plan.planFilePath}>
            {plan.planFilePath}
          </div>
        )}
        {pending ? planBody : <Disclosure summary="查看计划">{planBody}</Disclosure>}
      </div>

      {pending ? (
        <div className="flex flex-col gap-2 px-3.5 pb-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {supportsOptions && (
              <Button data-testid="plan-approve-auto" className="h-10 sm:h-8" onClick={() => act('approve_auto')}>
                批准并自动接受编辑
              </Button>
            )}
            <Button
              variant={supportsOptions ? 'outline' : 'default'}
              data-testid="plan-approve-manual"
              className="h-10 sm:h-8"
              onClick={() => act('approve_manual')}
            >
              批准，逐个确认编辑
            </Button>
          </div>
          <div className="border-border flex flex-col gap-2 border-t border-dashed pt-2.5">
            {supportsOptions && (
              <Textarea
                data-testid="plan-feedback"
                className="min-h-[64px] resize-y text-[13px]"
                placeholder="（可选）告诉 Claude 计划要怎么改"
                aria-label="继续规划的反馈"
                maxLength={4000}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
              />
            )}
            <Button
              variant="outline"
              data-testid="plan-keep-planning"
              className="h-10 sm:h-8 sm:self-start"
              onClick={() => act('keep_planning')}
            >
              继续规划
            </Button>
            {!supportsOptions && (
              <div data-testid="plan-legacy-note" className="text-text-3 text-[11.5px]">
                该机器的 agent 版本较旧，升级到 0.6.0 后可「批准并自动接受编辑」、给继续规划附反馈
              </div>
            )}
          </div>
        </div>
      ) : (
        <ResolvedFooter entry={entry} deviceId={deviceId} />
      )}
    </li>
  );
}

function ResolvedFooter({ entry, deviceId }: { entry: PermissionEntry; deviceId: string | null }): React.JSX.Element {
  const result = planResultText(entry, deviceId);
  return (
    <div className="border-border flex flex-col gap-1.5 border-t border-dashed px-3.5 py-2">
      <div data-testid="plan-result" className={cn('text-[12.5px]', RESULT_TONE[result.tone])}>
        {result.text}
      </div>
      {result.feedback !== undefined && (
        <div
          data-testid="plan-feedback-text"
          className="border-border-strong text-text-2 border-l-2 pl-2.5 text-[12.5px] break-words whitespace-pre-wrap"
        >
          {result.feedback}
        </div>
      )}
    </div>
  );
}
