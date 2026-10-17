/**
 * AskUserQuestion 专用提问卡——Claude 用这个工具向用户提选择题。
 *
 * 协议上它就是一次权限请求（canUseTool），所以沿用权限卡那套生命周期：
 * pending 时可作答并「已等待 N 秒」走秒（`now` 由 ChatView 统一 tick 传下来），
 * resolved / invalidated 后按钮消失、显式标注结果。
 *
 * - 提交 = `allow` + `updatedInput: { ...原 input, answers }`（拼法见
 *   ask-question-model.ts）；
 * - 跳过 = `deny`：Claude 收到拒绝后通常改口在对话里问，用户用输入框回答；
 * - 已回答态从 `approvedInput` 读回 answers（刷新 / 多设备都靠它），逐题显示
 *   「问题 → 回答」。
 *
 * 选项的 `preview` 是模型给的任意文本，只放进 `<pre>` 按纯文本展示，绝不当
 * HTML 注入。
 */
import { useState } from 'react';
import type { PermissionEntry } from '@/lib/reducer.ts';
import { formatSeconds } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import type { PermissionDecision } from './PermissionCard.tsx';
import { SubagentSourceNote } from './SubagentSourceNote.tsx';
import { permissionResultText } from './permission-model.ts';
import {
  answeredInput,
  buildAnswers,
  editOther,
  emptySelection,
  parseAskQuestionInput,
  readAnswers,
  toggleOption,
  toggleOther,
  type AskQuestion,
  type AskQuestionInput,
  type QuestionSelection,
} from './ask-question-model.ts';

/** 本设备 / 别的设备的回答来源文案，与权限卡 `permissionResultText` 同口径 */
function answeredByText(entry: PermissionEntry, deviceId: string | null): string {
  if (entry.resolvedBy === undefined) return '';
  return entry.resolvedBy === deviceId ? '（本设备）' : `（${entry.resolvedBy}）`;
}

export function AskQuestionCard({
  entry,
  deviceId,
  now,
  onRespond,
  subagentSource,
}: {
  entry: PermissionEntry;
  deviceId: string | null;
  now: number;
  onRespond: (decision: PermissionDecision) => void;
  /** 子 agent 发起的提问：父 Task 卡的描述（'' = 找不到父卡）；主线程 undefined */
  subagentSource?: string | undefined;
}): React.JSX.Element | null {
  const parsed = parseAskQuestionInput(entry.input);
  // 调用方（Timeline）已按 isAskQuestionRequest 分流，这里只是兜底
  if (parsed === null) return null;
  return (
    <AskQuestionCardBody
      entry={entry}
      input={parsed}
      deviceId={deviceId}
      now={now}
      onRespond={onRespond}
      subagentSource={subagentSource}
    />
  );
}

function AskQuestionCardBody({
  entry,
  input,
  deviceId,
  now,
  onRespond,
  subagentSource,
}: {
  entry: PermissionEntry;
  input: AskQuestionInput;
  deviceId: string | null;
  now: number;
  onRespond: (decision: PermissionDecision) => void;
  subagentSource: string | undefined;
}): React.JSX.Element {
  const pending = entry.state === 'pending';
  const [selections, setSelections] = useState<QuestionSelection[]>(() => input.questions.map(() => emptySelection()));
  const answers = pending ? buildAnswers(input, selections) : null;

  const update = (index: number, next: QuestionSelection): void => {
    setSelections((prev) => prev.map((s, i) => (i === index ? next : s)));
  };

  const submit = (): void => {
    if (answers === null) return;
    onRespond({ verdict: 'allow', updatedInput: answeredInput(entry.input, answers) });
  };

  return (
    <li
      data-testid="entry-ask-question"
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
        <span aria-hidden>?</span>
        Claude 在提问
        <span
          data-testid="ask-waited"
          className={cn(
            'tabular ml-auto font-mono text-[12px] font-normal',
            pending ? 'text-amber' : 'text-text-3',
          )}
        >
          {pending ? `已等待 ${formatSeconds(Math.max(0, now - entry.requestedAt))}` : '已响应'}
        </span>
      </div>
      {subagentSource !== undefined && <SubagentSourceNote label={subagentSource} />}

      {pending ? (
        <>
          <div className="flex flex-col gap-4 px-3.5 py-3">
            {input.questions.map((q, i) => (
              <QuestionField
                key={q.question}
                index={i}
                question={q}
                selection={selections[i] ?? emptySelection()}
                onChange={(next) => update(i, next)}
              />
            ))}
          </div>
          <div className="flex flex-col gap-2 px-3.5 pb-3 sm:flex-row sm:flex-wrap">
            <Button
              data-testid="ask-submit"
              className="h-10 sm:h-8"
              disabled={answers === null}
              onClick={submit}
            >
              提交回答
            </Button>
            <Button
              variant="outline"
              data-testid="ask-skip"
              className="h-10 sm:h-8"
              onClick={() => onRespond({ verdict: 'deny' })}
            >
              跳过，改用文字回答
            </Button>
          </div>
        </>
      ) : (
        <ResolvedBody entry={entry} input={input} deviceId={deviceId} />
      )}
    </li>
  );
}

function QuestionField({
  index,
  question: q,
  selection,
  onChange,
}: {
  index: number;
  question: AskQuestion;
  selection: QuestionSelection;
  onChange: (next: QuestionSelection) => void;
}): React.JSX.Element {
  const labelId = `ask-q-${index}`;
  const role = q.multiSelect ? 'checkbox' : 'radio';
  return (
    <fieldset data-testid="ask-question" className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {q.header !== '' && (
          <span
            data-testid="ask-header"
            className="bg-amber-soft text-amber border-amber-border rounded-full border px-2 py-px text-[11px] font-medium"
          >
            {q.header}
          </span>
        )}
        {q.multiSelect && <span className="text-text-3 text-[11px]">可多选</span>}
      </div>
      <div id={labelId} className="text-text text-[14px] leading-snug font-medium">
        {q.question}
      </div>
      <div
        role={q.multiSelect ? 'group' : 'radiogroup'}
        aria-labelledby={labelId}
        className="flex flex-col gap-1.5"
      >
        {q.options.map((o) => {
          const checked = selection.selected.includes(o.label);
          return (
            <div key={o.label} className="flex flex-col gap-1.5">
              <button
                type="button"
                role={role}
                aria-checked={checked}
                data-testid="ask-option"
                onClick={() => onChange(toggleOption(q, selection, o.label))}
                className={cn(
                  'flex min-h-10 w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                  'focus-visible:ring-ring/50 outline-none focus-visible:ring-3',
                  checked ? 'border-brand bg-brand-soft' : 'border-border bg-surface hover:bg-surface-2',
                )}
              >
                <Indicator multi={q.multiSelect} checked={checked} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-text text-[13.5px] font-medium break-words">{o.label}</span>
                  {o.description !== '' && (
                    <span className="text-text-2 text-[12px] leading-snug break-words">{o.description}</span>
                  )}
                </span>
              </button>
              {checked && o.preview !== undefined && (
                <pre
                  data-testid="ask-preview"
                  className="bg-code-bg border-border text-text-2 max-h-64 overflow-auto rounded-lg border px-2.5 py-2 font-mono text-[11.5px] whitespace-pre"
                >
                  {o.preview}
                </pre>
              )}
            </div>
          );
        })}
        <div
          className={cn(
            'flex min-h-10 w-full flex-col gap-2 rounded-lg border px-3 py-2',
            selection.otherOn ? 'border-brand bg-brand-soft' : 'border-border bg-surface',
          )}
        >
          <button
            type="button"
            role={role}
            aria-checked={selection.otherOn}
            data-testid="ask-other"
            onClick={() => onChange(toggleOther(q, selection))}
            className="focus-visible:ring-ring/50 flex items-center gap-2.5 rounded text-left outline-none focus-visible:ring-3"
          >
            <Indicator multi={q.multiSelect} checked={selection.otherOn} />
            <span className="text-text text-[13.5px] font-medium">其他</span>
          </button>
          <Input
            data-testid="ask-other-input"
            className="bg-surface h-10 sm:h-8"
            placeholder="自行输入答案"
            aria-label={`「${q.question}」的其他答案`}
            value={selection.otherText}
            onChange={(e) => onChange(editOther(q, selection, e.target.value))}
          />
        </div>
      </div>
    </fieldset>
  );
}

/** 单选圆点 / 多选方框（纯装饰，语义在按钮的 role + aria-checked 上） */
function Indicator({ multi, checked }: { multi: boolean; checked: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-0.5 flex size-4 shrink-0 items-center justify-center border',
        multi ? 'rounded-[4px]' : 'rounded-full',
        checked ? 'border-brand bg-brand text-brand-fg' : 'border-border-strong bg-surface',
      )}
    >
      {checked && (multi ? <span className="text-[10px] leading-none">✓</span> : <span className="bg-brand-fg size-1.5 rounded-full" />)}
    </span>
  );
}

function ResolvedBody({
  entry,
  input,
  deviceId,
}: {
  entry: PermissionEntry;
  input: AskQuestionInput;
  deviceId: string | null;
}): React.JSX.Element {
  const questionList = (
    <ul className="flex flex-col gap-1 px-3.5 pt-2.5">
      {input.questions.map((q) => (
        <li key={q.question} className="text-text-2 text-[13px] leading-snug">
          {q.question}
        </li>
      ))}
    </ul>
  );

  if (entry.state === 'invalidated') {
    return (
      <>
        {questionList}
        <div data-testid="ask-result" className="text-text-3 px-3.5 py-2 text-[12.5px]">
          {permissionResultText(entry, deviceId).text}
        </div>
      </>
    );
  }

  const by = answeredByText(entry, deviceId);
  if (entry.verdict !== 'allow') {
    return (
      <>
        {questionList}
        <div data-testid="ask-result" className="text-text-3 px-3.5 py-2 text-[12.5px]">
          已跳过{by}——改在对话里回答
        </div>
      </>
    );
  }

  const answers = readAnswers(entry.approvedInput);
  if (answers === null) {
    // 旧 agent 不回报 updatedInput：知道答过了，但不知道答了什么
    return (
      <>
        {questionList}
        <div data-testid="ask-result" className="text-green px-3.5 py-2 text-[12.5px]">
          ✓ 已回答{by}
        </div>
      </>
    );
  }
  return (
    <>
      <dl className="flex flex-col gap-2 px-3.5 pt-2.5">
        {input.questions.map((q) => {
          const answer = answers[q.question];
          return (
            <div key={q.question} data-testid="ask-answer" className="flex flex-col gap-0.5">
              <dt className="text-text-2 text-[12.5px] leading-snug">{q.question}</dt>
              <dd className="text-text text-[13.5px] font-medium break-words">
                <span aria-hidden className="text-text-3">→ </span>
                {answer ?? <span className="text-text-3 font-normal">（未读到答案）</span>}
              </dd>
            </div>
          );
        })}
      </dl>
      <div data-testid="ask-result" className="text-green px-3.5 py-2 text-[12.5px]">
        ✓ 已回答{by}
      </div>
    </>
  );
}
