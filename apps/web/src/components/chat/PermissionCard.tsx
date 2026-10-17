/**
 * 权限卡（原型 `.perm`）——远程操控里最要紧的一张卡。
 *
 * 五件事（NOTES.chat 第 5 条 + 方案 §5）：
 * 1. **完整参数**，不截断：Bash 给整条命令（mono 大块），Edit/Write 给
 *    file_path + 内容摘要，其他工具给 JSON（可折叠）。人在手机上批准一条
 *    看不全的命令 = 没有批准。
 * 2. **已等待 N 秒**，本地按 `requestedAt` 走秒——agent 正阻塞在这儿。
 * 3. **改参数后批准**：Bash 原地编辑命令文本域；其他工具编 JSON，解析
 *    失败就禁用提交（宁可不让点，也不能把坏参数送过去）。
 * 4. **「记住」只在真能生效时出现**：`suggestRememberPattern` 返回 null
 *    就不显示复选框（评审 B3：给了永不命中的选项＝功能坏了）。文案是
 *    事实描述，见 permission-model.ts 的红线说明。
 * 5. **已响应 / 已失效态显式标注**：按钮置灰而不是悬空可点（NOTES.states
 *    第 3 条）——agent 重启后 pending 权限不可恢复。
 *
 * 计时的 tick 由 ChatView 统一驱动（`now` 从上面传下来），避免每张卡各挂
 * 一个 setInterval。
 */
import { useState } from 'react';
import type { PermissionMode } from '@trine/core';
import type { PermissionEntry } from '@/lib/reducer.ts';
import { formatSeconds } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { Disclosure } from './Messages.tsx';
import { SubagentSourceNote } from './SubagentSourceNote.tsx';
import {
  editorSeed,
  effectiveRememberOption,
  parseEditedInput,
  permissionParamView,
  permissionResultText,
} from './permission-model.ts';

export interface PermissionDecision {
  verdict: 'allow' | 'deny';
  updatedInput?: unknown;
  remember?: { scope: 'session'; pattern: string };
  /** 拒绝附言（计划卡「继续规划」的反馈） */
  message?: string;
  /** 批准同时切换会话权限模式（计划卡「批准并自动接受编辑」） */
  setMode?: PermissionMode;
}

const RESULT_TONE = {
  green: 'text-green',
  red: 'text-red',
  muted: 'text-text-3',
} as const;

export function PermissionCard({
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
  /** 子 agent 发起的请求：父 Task 卡的描述（'' = 找不到父卡）；主线程请求 undefined */
  subagentSource?: string | undefined;
}): React.JSX.Element {
  const pending = entry.state === 'pending';
  /**
   * 已响应且是「改参数后批准」时，参数区显示**实际被执行的**那份
   * （`approvedInput`，验收 5）——早先这里恒显示 `entry.input`，也就是最初的
   * 请求；改后的值只活在批准那一刻的组件 state 里，刷新后回放的是原始请求，
   * 其他设备更是从头到尾看不到实际批了什么。
   *
   * 编辑与「记住」的判据仍一律按 `entry.input` 算（pending 态才用得上它们，
   * 那时 approvedInput 必然不存在）。
   */
  const approved = !pending && entry.approvedInput !== undefined ? entry.approvedInput : null;
  const view = permissionParamView(entry.toolName, approved ?? entry.input);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() =>
    editorSeed(permissionParamView(entry.toolName, entry.input), entry.input),
  );
  const [rememberChecked, setRememberChecked] = useState(false);

  const parsed = editing ? parseEditedInput(permissionParamView(entry.toolName, entry.input), entry.input, draft) : null;
  // 「记住」按**编辑后**的参数重算：把 `rm -rf x` 改成 `ls -la` 再勾记住，
  // 绝不能登记成 `Bash(rm*)`（见 permission-model.ts 的说明）
  const remember = effectiveRememberOption(entry.toolName, entry.input, parsed);
  const result = pending ? null : permissionResultText(entry, deviceId);

  const respond = (verdict: 'allow' | 'deny'): void => {
    const decision: PermissionDecision = { verdict };
    if (verdict === 'allow' && editing && parsed?.ok === true) decision.updatedInput = parsed.value;
    // remember 为 null（选项已消失）时绝不带上——rememberChecked 可能是
    // 编辑前勾的，那条 pattern 已经不是用户正在批准的这次调用了
    if (verdict === 'allow' && rememberChecked && remember !== null) {
      decision.remember = { scope: 'session', pattern: remember.pattern };
    }
    onRespond(decision);
  };

  return (
    <li
      data-testid="entry-permission"
      data-state={entry.state}
      data-tool={entry.toolName}
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
        <span aria-hidden>✋</span>
        权限请求
        <span
          data-testid="perm-waited"
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
        <div className="text-text-3 text-[11px] tracking-[0.06em] uppercase">{view.label}</div>

        {/* 下面的参数区不是「请求的」而是「实际批准执行的」，必须说清楚 */}
        {approved !== null && (
          <div data-testid="perm-approved-note" className="text-amber text-[11.5px]">
            已按修改后的参数批准（下方为实际执行的参数）
          </div>
        )}

        {/* --- 参数区 --- */}
        {editing ? (
          <>
            <Textarea
              data-testid="perm-editor"
              className={cn(
                'bg-code-bg min-h-[72px] resize-y font-mono text-[12.5px]',
                view.kind === 'command' ? 'max-h-40' : 'max-h-72',
              )}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="编辑调用参数"
            />
            {parsed?.ok === false && (
              <div data-testid="perm-editor-error" className="text-red text-[11.5px]">
                {parsed.error}
              </div>
            )}
          </>
        ) : view.kind === 'command' ? (
          <pre
            data-testid="perm-command"
            className="bg-code-bg border-border rounded-lg border px-2.5 py-2 font-mono text-[12.5px] break-all whitespace-pre-wrap"
          >
            {view.command}
          </pre>
        ) : view.kind === 'file' ? (
          <>
            <pre
              data-testid="perm-command"
              className="bg-code-bg border-border rounded-lg border px-2.5 py-2 font-mono text-[12.5px] break-all whitespace-pre-wrap"
            >
              {view.filePath}
            </pre>
            {view.content !== undefined && (
              <Disclosure summary="内容摘要">
                <pre className="bg-code-bg border-border text-text-2 max-h-48 overflow-auto rounded-lg border px-2.5 py-2 font-mono text-[11.5px] whitespace-pre-wrap">
                  {view.content}
                </pre>
              </Disclosure>
            )}
          </>
        ) : (
          <Disclosure summary="完整参数（JSON）" defaultOpen>
            <pre
              data-testid="perm-command"
              className="bg-code-bg border-border max-h-56 overflow-auto rounded-lg border px-2.5 py-2 font-mono text-[12px] whitespace-pre-wrap"
            >
              {view.json}
            </pre>
          </Disclosure>
        )}

        {/* --- agent 给的建议（弱文案，不代替用户判断；折叠起来免得挤掉按钮） --- */}
        {entry.suggestions !== undefined && entry.suggestions.length > 0 && (
          <Disclosure summary={`agent 附带的建议（${entry.suggestions.length}）`}>
            <pre className="text-text-3 bg-code-bg border-border max-h-32 overflow-auto rounded-lg border px-2.5 py-2 font-mono text-[11px] break-all whitespace-pre-wrap">
              {entry.suggestions.map((s) => JSON.stringify(s)).join('\n')}
            </pre>
          </Disclosure>
        )}

        {pending && (
          <div className="text-text-3 text-[11.5px]">agent 正阻塞等待这次决定</div>
        )}
      </div>

      {pending ? (
        <>
          <div className="flex flex-wrap gap-2 px-3.5 pb-2.5">
            <Button
              size="sm"
              data-testid="perm-allow"
              disabled={editing && parsed?.ok === false}
              onClick={() => respond('allow')}
            >
              {editing ? '按此参数批准' : '批准'}
            </Button>
            {!editing && (
              <Button size="sm" variant="outline" data-testid="perm-edit" onClick={() => setEditing(true)}>
                改参数后批准
              </Button>
            )}
            <Button size="sm" variant="outline" data-testid="perm-deny" className="border-red text-red" onClick={() => respond('deny')}>
              拒绝
            </Button>
          </div>
          {remember !== null && (
            <label className="text-text-2 flex items-center gap-2 px-3.5 pb-3 text-[12.5px]">
              <input
                type="checkbox"
                data-testid="perm-remember"
                className="accent-brand size-[15px]"
                checked={rememberChecked}
                onChange={(e) => setRememberChecked(e.target.checked)}
              />
              {/*
                文案红线见 permission-model.ts：只陈述规则做什么，不做安全承诺。
                **必须渲染 `remember.label` 本身**——早先这里硬编码了一份同义
                JSX，于是「不得出现安全字眼」的单测断的是没人用的 label，
                组件真正显示什么完全不受管（假绿）。
              */}
              <span data-testid="perm-remember-label">{remember.label}</span>
            </label>
          )}
        </>
      ) : (
        result !== null && (
          <div
            data-testid="perm-result"
            className={cn(
              'border-border border-t border-dashed px-3.5 py-2 text-[12.5px]',
              RESULT_TONE[result.tone],
            )}
          >
            {result.text}
          </div>
        )
      )}
    </li>
  );
}
