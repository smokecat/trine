/**
 * 扩展视图渲染器：只认固定的词汇（分组、条目、徽章、按钮、受限 Markdown 详情、会话引用），
 * 一切文字当纯文本渲染。浏览器不执行扩展的任何代码。
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { ChevronDownIcon, ChevronRightIcon, LinkIcon, Link2OffIcon } from 'lucide-react';
import type { ExtBadge, ExtWireAction, ExtWireItem, ExtWireView, SessionMeta } from '@trine/core';
import { Button } from '@/components/ui/button.tsx';
import { Markdown } from '@/components/chat/Markdown.tsx';
import { cn } from '@/lib/utils.ts';

const TONE: Record<ExtBadge['tone'], string> = {
  neutral: 'border-border bg-surface-2 text-text-2',
  info: 'border-blue/30 bg-blue-soft text-blue',
  success: 'border-green/30 bg-green-soft text-green',
  warning: 'border-amber-border bg-amber-soft text-amber',
  danger: 'border-red/30 bg-red-soft text-red',
};

export function ExtBadgeChip({ badge, className }: { badge: ExtBadge; className?: string }): React.JSX.Element {
  return (
    <span
      {...(badge.title === undefined ? {} : { title: badge.title })}
      className={cn('inline-flex shrink-0 items-center rounded-full border px-[7px] py-[1px] text-[11px] leading-[16px]', TONE[badge.tone], className)}
    >
      {badge.text}
    </span>
  );
}

export interface ExtViewProps {
  view: ExtWireView;
  machineId: string;
  /** 本机已知会话（会话引用只渲染认识的） */
  sessions: Record<string, SessionMeta>;
  /** 当前会话的关联 ref（本扩展）；有它才显示关联开关 */
  linkedRefs?: ReadonlySet<string>;
  onToggleLink?: (item: ExtWireItem, linked: boolean) => void;
  onAction: (action: ExtWireAction, item: ExtWireItem | undefined) => void;
  busyAction?: string | null;
}

export function ExtView({ view, machineId, sessions, linkedRefs, onToggleLink, onAction, busyAction }: ExtViewProps): React.JSX.Element {
  const empty = view.sections.every((s) => s.items.length === 0);
  return (
    <div className="flex flex-col gap-4" data-testid="ext-view">
      {view.toolbar !== undefined && view.toolbar.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {view.toolbar.map((a) => (
            <ActionButton key={a.id} action={a} busy={busyAction === a.id} onClick={() => onAction(a, undefined)} />
          ))}
        </div>
      )}
      {empty && view.empty !== undefined && <p className="text-text-3 text-[13px]">{view.empty}</p>}
      {view.sections.map((section) => (
        <Section key={section.id} title={section.title} defaultCollapsed={section.collapsed === true} count={section.items.length}>
          {section.items.length === 0 ? (
            section.empty !== undefined && <p className="text-text-3 text-[12.5px]">{section.empty}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {section.items.map((item) => (
                <Item
                  key={item.id}
                  item={item}
                  machineId={machineId}
                  sessions={sessions}
                  linked={item.link !== undefined && linkedRefs?.has(item.link.ref) === true}
                  {...(onToggleLink === undefined || item.link === undefined ? {} : { onToggleLink })}
                  onAction={onAction}
                  busyAction={busyAction ?? null}
                />
              ))}
            </ul>
          )}
        </Section>
      ))}
    </div>
  );
}

function Section({
  title,
  defaultCollapsed,
  count,
  children,
}: {
  title: string | undefined;
  defaultCollapsed: boolean;
  count: number;
  children: React.ReactNode;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  if (title === undefined) return <section>{children}</section>;
  return (
    <section>
      <button
        type="button"
        className="text-text-3 hover:text-text-2 mb-1.5 flex items-center gap-1 text-[12px] font-medium"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        {collapsed ? <ChevronRightIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
        {title}
        <span className="tabular-nums">（{count}）</span>
      </button>
      {!collapsed && children}
    </section>
  );
}

function Item({
  item,
  machineId,
  sessions,
  linked,
  onToggleLink,
  onAction,
  busyAction,
}: {
  item: ExtWireItem;
  machineId: string;
  sessions: Record<string, SessionMeta>;
  linked: boolean;
  onToggleLink?: (item: ExtWireItem, linked: boolean) => void;
  onAction: (action: ExtWireAction, item: ExtWireItem) => void;
  busyAction: string | null;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const refs = (item.sessions ?? []).filter((sid) => sessions[sid] !== undefined);
  const expandable = item.detail !== undefined || refs.length > 0;
  return (
    <li
      data-testid="ext-item"
      data-item-id={item.id}
      className={cn('border-border bg-surface rounded-xl border px-3 py-2.5', linked && 'border-brand-border')}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => expandable && setOpen((o) => !o)}
          aria-expanded={expandable ? open : undefined}
          disabled={!expandable}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {linked && <LinkIcon className="text-brand size-3.5 shrink-0" aria-label="已关联" />}
            <span className="text-text truncate text-[13.5px] font-medium">{item.title}</span>
            {item.badges?.map((b, i) => <ExtBadgeChip key={i} badge={b} />)}
          </div>
          {item.subtitle !== undefined && <div className="text-text-2 mt-0.5 line-clamp-2 text-[12.5px]">{item.subtitle}</div>}
          {item.meta !== undefined && <div className="text-text-3 mt-0.5 text-[11.5px]">{item.meta}</div>}
        </button>
        {onToggleLink !== undefined && (
          <Button
            size="icon"
            variant="ghost"
            className="text-text-3 hover:text-text size-7 shrink-0"
            title={linked ? '取消关联' : '关联到本会话'}
            aria-label={linked ? '取消关联' : '关联到本会话'}
            data-testid="ext-link-toggle"
            onClick={() => onToggleLink(item, !linked)}
          >
            {linked ? <Link2OffIcon className="size-4" /> : <LinkIcon className="size-4" />}
          </Button>
        )}
      </div>
      {open && item.detail !== undefined && (
        <div className="border-border mt-2 border-t pt-2">
          <Markdown text={item.detail} streaming={false} restricted className="text-[12.5px]" />
        </div>
      )}
      {open && refs.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {refs.map((sid) => (
            <Link
              key={sid}
              to={`/s/${encodeURIComponent(machineId)}/${encodeURIComponent(sid)}`}
              className="border-border bg-surface-2 text-text-2 hover:text-text max-w-full truncate rounded-full border px-2 py-0.5 text-[11.5px]"
            >
              ↗ {sessions[sid]!.title || sid.slice(0, 8)}
            </Link>
          ))}
        </div>
      )}
      {item.actions !== undefined && item.actions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.actions.map((a) => (
            <ActionButton key={a.id} action={a} busy={busyAction === `${item.id}/${a.id}`} onClick={() => onAction(a, item)} />
          ))}
        </div>
      )}
    </li>
  );
}

function ActionButton({ action, busy, onClick }: { action: ExtWireAction; busy: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <Button
      size="sm"
      variant={action.destructive === true ? 'destructive' : action.primary === true ? 'default' : 'outline'}
      className="h-7 px-2.5 text-[12px]"
      disabled={busy}
      data-testid="ext-action"
      data-action-id={action.id}
      onClick={onClick}
    >
      {busy ? '处理中…' : action.label}
    </Button>
  );
}
