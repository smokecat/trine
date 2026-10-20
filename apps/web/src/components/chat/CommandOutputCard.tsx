/**
 * 本地斜杠命令的输出卡（`/usage`、`/cost`、`/context`…）：CLI 直接给出、不调模型的输出。
 *
 * - 默认：等宽原样显示（终端排版的换行、缩进都要保住；当 Markdown 渲染会糊成一段），
 *   超过 `COLLAPSE_LINES` 行先折起来；
 * - `/usage`：解析成用量进度条 + 可展开的「用量构成」分组；解析不了回落原样显示。
 *
 * 解析见 command-output-model.ts。
 */
import { useState } from 'react';
import { cn } from '@/lib/utils.ts';
import { usageTone, type UsageTone } from '@/components/usage/usage-model.ts';
import { parseUsageReport, type UsageReport } from './command-output-model.ts';

const COLLAPSE_LINES = 16;

const BAR_CLASS: Record<UsageTone, string> = {
  normal: 'bg-brand',
  warn: 'bg-amber',
  danger: 'bg-red',
};

const PERCENT_CLASS: Record<UsageTone, string> = {
  normal: 'text-text',
  warn: 'text-amber',
  danger: 'text-red',
};

function UsageReportView({ report }: { report: UsageReport }): React.JSX.Element {
  const [showSections, setShowSections] = useState(false);
  return (
    <div className="flex flex-col gap-3" data-testid="usage-report">
      {report.intro.length > 0 && <p className="text-text-3 text-xs">{report.intro.join(' ')}</p>}
      <ul className="flex flex-col gap-2.5">
        {report.windows.map((w) => {
          const tone = usageTone(w.percent);
          return (
            <li key={w.label} data-testid="usage-window" className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate">{w.label}</span>
                <span className={cn('tabular font-mono font-semibold', PERCENT_CLASS[tone])}>{w.percent}%</span>
              </div>
              <div
                className="bg-surface-2 h-1.5 overflow-hidden rounded-full"
                role="progressbar"
                aria-label={w.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={w.percent}
              >
                <div className={cn('h-full rounded-full', BAR_CLASS[tone])} style={{ width: `${Math.min(100, w.percent)}%` }} />
              </div>
              {w.resets !== undefined && (
                <div className="text-text-3 text-[11.5px]" {...(w.resetsFull === undefined ? {} : { title: w.resetsFull })}>
                  {w.resets} 重置
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {report.sections.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            data-testid="usage-sections-toggle"
            className="text-text-3 hover:text-text-2 w-fit text-xs transition-colors"
            onClick={() => setShowSections((v) => !v)}
          >
            {showSections ? '收起用量构成 ▴' : '查看用量构成 ▾'}
          </button>
          {showSections && (
            <div className="border-border flex flex-col gap-2.5 border-t pt-2.5" data-testid="usage-sections">
              {report.sections.map((section, i) => (
                <section key={`${i}:${section.title}`} className="flex flex-col gap-1">
                  <h4 className="text-[12.5px] font-medium">{section.title}</h4>
                  {section.notes.map((note, j) => (
                    <p key={j} className="text-text-3 text-[11.5px]">
                      {note}
                    </p>
                  ))}
                  {section.items.length > 0 && (
                    <ul className="text-text-2 flex list-disc flex-col gap-0.5 pl-4 text-xs">
                      {section.items.map((item, j) => (
                        <li key={j}>{item}</li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RawOutput({ text }: { text: string }): React.JSX.Element {
  const lineCount = text.split('\n').length;
  const collapsible = lineCount > COLLAPSE_LINES;
  const [expanded, setExpanded] = useState(false);
  const shown = collapsible && !expanded ? text.split('\n').slice(0, COLLAPSE_LINES).join('\n') : text;
  return (
    <div className="flex flex-col gap-1.5">
      <pre
        data-testid="command-output-text"
        className="text-text-2 overflow-x-auto font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap"
      >
        {shown}
      </pre>
      {collapsible && (
        <button
          type="button"
          className="text-text-3 hover:text-text-2 w-fit text-xs transition-colors"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '收起 ▴' : `展开全部（${lineCount} 行）▾`}
        </button>
      )}
    </div>
  );
}

export function CommandOutputCard({ command, text }: { command: string; text: string }): React.JSX.Element {
  const report = command === 'usage' ? parseUsageReport(text) : null;
  return (
    <div
      data-testid="command-output"
      data-command={command}
      className="border-border bg-surface flex flex-col gap-2.5 rounded-xl border px-3.5 py-3"
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="bg-surface-2 text-text-2 rounded-md px-1.5 py-0.5 font-mono">
          {command === '' ? '本地命令' : `/${command}`}
        </span>
        <span className="text-text-3">{command === 'usage' ? '用量' : '命令输出'}</span>
      </div>
      {report === null ? <RawOutput text={text} /> : <UsageReportView report={report} />}
    </div>
  );
}
