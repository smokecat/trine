/**
 * 会话页的扩展入口（U1）与面板（U2）。
 *
 * - 入口：有关联时显示第一个提供徽章的扩展给的徽章（`▤ 关联名 · 状态`），否则一个图标按钮。
 * - 面板：桌面右侧抽屉、手机底部 sheet；多个扩展用 tab 切换。打开期间持有订阅，agent 有变化就推。
 */
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BlocksIcon, RefreshCwIcon } from 'lucide-react';
import type { ExtCatalogItem, ExtWireAction, ExtWireItem, SessionMeta } from '@trine/core';
import { Button } from '@/components/ui/button.tsx';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet.tsx';
import { useIsDesktop } from '@/components/shell/use-media-query.ts';
import { useClient, useTrine } from '@/app/runtime.ts';
import { extensionsFor } from '@/lib/ext-model.ts';
import { cn } from '@/lib/utils.ts';
import { ExtBadgeChip, ExtView } from './ExtView.tsx';
import { updateLinks, useExtAction, useExtCatalog, useExtRead } from './use-ext.ts';

const EMPTY_SESSIONS: Record<string, SessionMeta> = {};

/** 会话头的扩展入口：不支持扩展、或没有提供会话面板的扩展时不渲染 */
export function ExtHeadEntry({
  machineId,
  sessionId,
  meta,
  onOpen,
}: {
  machineId: string;
  sessionId: string;
  meta: SessionMeta | undefined;
  onOpen: () => void;
}): React.JSX.Element | null {
  const catalog = useExtCatalog(machineId);
  const panels = useMemo(() => extensionsFor(catalog ?? [], 'sessionPanel'), [catalog]);
  const badgeExt = useMemo(() => {
    const linkedExts = new Set((meta?.links ?? []).map((l) => l.ext));
    return extensionsFor(catalog ?? [], 'sessionBadge').find((e) => linkedExts.has(e.id));
  }, [catalog, meta?.links]);
  const badge = useExtRead(
    badgeExt === undefined ? null : { machineId, ext: badgeExt.id, op: 'badge', point: 'sessionBadge', targetSessionId: sessionId },
    { watch: true },
  );
  if (catalog === null || panels.length === 0) return null;
  const link = badgeExt === undefined ? undefined : meta?.links?.find((l) => l.ext === badgeExt.id);
  const value = badge.response?.ok === true ? badge.response.badge : undefined;
  return (
    <button
      type="button"
      data-testid="ext-head-entry"
      onClick={onOpen}
      title={link === undefined ? '扩展' : `关联：${(meta?.links ?? []).map((l) => l.label).join('、')}`}
      className={cn(
        'border-border bg-surface-2 text-text-2 hover:text-text inline-flex max-w-[16rem] shrink items-center gap-1 rounded-full border px-[9px] py-[3px] text-[11.5px]',
      )}
    >
      <BlocksIcon className="size-3.5 shrink-0" />
      {link !== undefined && <span className="hidden min-w-0 truncate sm:inline">{link.label}</span>}
      {link !== undefined && <span className="bg-brand size-1.5 shrink-0 rounded-full sm:hidden" aria-hidden />}
      {value != null && <ExtBadgeChip badge={value} className="hidden sm:inline-flex" />}
      {badge.response?.ok === false && (
        <span className="text-text-3" title={badge.response.error?.message}>
          !
        </span>
      )}
    </button>
  );
}

/**
 * 扩展面板：会话面板（sessionId，U2）或工作区面板（cwd，U6：不进会话也能看任务列表、开新会话）。
 */
export function ExtPanelSheet({
  open,
  onOpenChange,
  machineId,
  sessionId,
  cwd,
  meta,
  onInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machineId: string;
  /** 会话面板 */
  sessionId?: string;
  /** 工作区面板（没有 sessionId 时） */
  cwd?: string;
  meta?: SessionMeta | undefined;
  /** 插入到输入框；工作区面板没有输入框，插入类动作退化为复制 */
  onInsert?: (text: string) => void;
}): React.JSX.Element {
  const desktop = useIsDesktop();
  const catalog = useExtCatalog(machineId);
  const point = sessionId === undefined ? 'workspacePanel' : 'sessionPanel';
  const panels = useMemo(() => extensionsFor(catalog ?? [], point), [catalog, point]);
  const [active, setActive] = useState<string | undefined>(undefined);
  const ext = panels.find((p) => p.id === active) ?? panels[0];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={desktop ? 'right' : 'bottom'}
        data-testid="ext-panel"
        className={cn('gap-0 overflow-y-auto', desktop ? 'w-[min(26rem,100vw)] sm:max-w-none' : 'max-h-[85dvh] rounded-t-2xl')}
      >
        <SheetHeader className="px-4 pt-4 pb-2">
          <SheetTitle>{ext?.contributes[point]?.title ?? '扩展'}</SheetTitle>
          <SheetDescription className="text-text-3 text-[12px]">
            {ext === undefined ? '没有可用的扩展' : `${ext.name} ${ext.version}`}
            {cwd !== undefined && <span className="block truncate font-mono">{cwd}</span>}
          </SheetDescription>
        </SheetHeader>
        {panels.length > 1 && (
          <div className="flex flex-wrap gap-1.5 px-4 pb-2">
            {panels.map((p) => (
              <Button key={p.id} size="sm" variant={p.id === ext?.id ? 'default' : 'outline'} className="h-7" onClick={() => setActive(p.id)}>
                {p.contributes[point]?.title ?? p.name}
              </Button>
            ))}
          </div>
        )}
        <div className="px-4 pb-6">
          {open && ext !== undefined && (
            <PanelBody
              key={ext.id}
              ext={ext}
              machineId={machineId}
              {...(sessionId === undefined ? {} : { sessionId })}
              {...(cwd === undefined ? {} : { cwd })}
              meta={meta}
              {...(onInsert === undefined
                ? {}
                : {
                    onInsert: (text: string) => {
                      onInsert(text);
                      onOpenChange(false);
                    },
                  })}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PanelBody({
  ext,
  machineId,
  sessionId,
  cwd,
  meta,
  onInsert,
}: {
  ext: ExtCatalogItem;
  machineId: string;
  sessionId?: string;
  cwd?: string;
  meta: SessionMeta | undefined;
  onInsert?: (text: string) => void;
}): React.JSX.Element {
  const client = useClient();
  const read = useExtRead(
    sessionId !== undefined
      ? { machineId, ext: ext.id, op: 'view', point: 'sessionPanel', targetSessionId: sessionId }
      : { machineId, ext: ext.id, op: 'view', point: 'workspacePanel', cwd: cwd ?? '' },
    { watch: true },
  );
  const sessions = useTrine((s) => s.sessions[machineId]) ?? EMPTY_SESSIONS;
  const run = useExtAction();
  const [busy, setBusy] = useState<string | null>(null);
  const linkedRefs = useMemo(
    () => new Set((meta?.links ?? []).filter((l) => l.ext === ext.id).map((l) => l.ref)),
    [meta?.links, ext.id],
  );

  const onAction = (action: ExtWireAction, item: ExtWireItem | undefined): void => {
    const id = item === undefined ? action.id : `${item.id}/${action.id}`;
    setBusy(id);
    void run(
      { ...(action.local === undefined ? {} : { local: action.local }), ...(action.token === undefined ? {} : { token: action.token }), label: action.label },
      {
        machineId,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(onInsert === undefined ? {} : { insert: onInsert }),
        refresh: read.refresh,
      },
    ).finally(() => setBusy(null));
  };

  const onToggleLink = (item: ExtWireItem, linked: boolean): void => {
    if (client === null || item.link === undefined || sessionId === undefined) return;
    void updateLinks(client, machineId, sessionId, ext.id, linked ? { add: [item.link] } : { remove: [item.link.ref] }).catch((err: unknown) =>
      toast.error(`关联失败：${err instanceof Error ? err.message : String(err)}`),
    );
  };

  const response = read.response;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end">
        <Button size="sm" variant="ghost" className="text-text-3 h-7 gap-1 text-[12px]" onClick={read.refresh} disabled={read.loading}>
          <RefreshCwIcon className={cn('size-3.5', read.loading && 'motion-safe:animate-spin')} />
          刷新
        </Button>
      </div>
      {response === undefined && read.failure === undefined && <p className="text-text-3 text-[13px]">加载中…</p>}
      {read.failure !== undefined && <p className="text-red text-[13px]">{read.failure}</p>}
      {response?.ok === false && (
        <div className="text-[13px]">
          <p className="text-red">{response.error?.message ?? '扩展出错'}</p>
          {response.error?.code === 'invalid_output' && (
            <p className="text-text-3 mt-1 text-[12px]">扩展返回了无法识别的内容，可在 agent 机器上运行 trine-agent ext test {ext.id} view 排查。</p>
          )}
        </div>
      )}
      {response?.ok === true && response.view !== undefined && (
        <ExtView
          view={response.view}
          machineId={machineId}
          sessions={sessions}
          linkedRefs={linkedRefs}
          {...(sessionId === undefined ? {} : { onToggleLink })}
          onAction={onAction}
          busyAction={busy}
        />
      )}
    </div>
  );
}
