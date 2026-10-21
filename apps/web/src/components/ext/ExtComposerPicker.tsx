/**
 * 输入框的扩展入口（U9）：在片段面板的位置列出扩展的候选项（pick，point=composerAction），
 * 选中一项执行它的效果。这里是编辑语境，agent 只允许 prompt.insert 与 links.add（签发 token 时强制）。
 */
import { useEffect, useMemo, useState } from 'react';
import type { ExtCatalogItem, ExtWirePickItem } from '@trine/core';
import { Input } from '@/components/ui/input.tsx';
import { extensionsFor } from '@/lib/ext-model.ts';
import { cn } from '@/lib/utils.ts';
import { ExtBadgeChip } from './ExtView.tsx';
import { useExtAction, useExtCatalog, useExtRead } from './use-ext.ts';

/** 这台机器提供输入框入口的扩展；没有时为空数组（不支持扩展时为 null） */
export function useComposerExtensions(machineId: string): ExtCatalogItem[] | null {
  const catalog = useExtCatalog(machineId);
  return useMemo(() => (catalog === null ? null : extensionsFor(catalog, 'composerAction')), [catalog]);
}

export function composerPickerLabel(exts: readonly ExtCatalogItem[]): string {
  return exts.length === 1 ? (exts[0]!.contributes.composerAction?.label ?? exts[0]!.name) : '扩展';
}

export function ExtComposerPicker({
  machineId,
  sessionId,
  extensions,
  onInsert,
  onClose,
}: {
  machineId: string;
  sessionId: string;
  extensions: readonly ExtCatalogItem[];
  onInsert: (text: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [active, setActive] = useState(extensions[0]?.id);
  const ext = extensions.find((e) => e.id === active) ?? extensions[0];
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  const read = useExtRead(
    ext === undefined ? null : { machineId, ext: ext.id, op: 'pick', point: 'composerAction', targetSessionId: sessionId },
    { query: debounced },
  );
  const run = useExtAction();
  const items = (read.response?.ok === true ? read.response.items : undefined) ?? [];

  const choose = (item: ExtWirePickItem): void => {
    onClose();
    void run(
      { ...(item.local === undefined ? {} : { local: item.local }), ...(item.token === undefined ? {} : { token: item.token }), label: item.title },
      { machineId, sessionId, insert: onInsert, refresh: read.refresh },
    );
  };

  return (
    <div className="flex min-h-0 flex-col" data-testid="ext-composer-picker">
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5">
        {extensions.length > 1 ? (
          extensions.map((e) => (
            <button
              key={e.id}
              type="button"
              className={cn('rounded-full px-2 py-0.5 text-[11.5px]', e.id === ext?.id ? 'bg-brand-soft text-brand-ink' : 'text-text-3 hover:text-text')}
              onClick={() => setActive(e.id)}
            >
              {e.contributes.composerAction?.label ?? e.name}
            </button>
          ))
        ) : (
          <span className="text-text-3 text-[11px] tracking-[0.05em]">{ext?.contributes.composerAction?.label ?? ext?.name} · {ext?.name}</span>
        )}
      </div>
      <div className="px-3 pb-1.5">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="搜索"
          className="h-7 text-[12.5px]"
        />
      </div>
      <ul className="min-h-0 overflow-y-auto px-1.5 pb-1.5">
        {read.response === undefined && read.failure === undefined && <li className="text-text-3 px-2.5 py-2 text-[12.5px]">加载中…</li>}
        {read.failure !== undefined && <li className="text-red px-2.5 py-2 text-[12.5px]">{read.failure}</li>}
        {read.response?.ok === false && <li className="text-red px-2.5 py-2 text-[12.5px]">{read.response.error?.message}</li>}
        {read.response?.ok === true && items.length === 0 && <li className="text-text-3 px-2.5 py-2 text-[12.5px]">没有可用的条目</li>}
        {items.map((item) => {
          const clickable = item.local !== undefined || item.token !== undefined;
          return (
            <li key={item.id}>
              <button
                type="button"
                data-testid="ext-composer-item"
                disabled={!clickable}
                onClick={() => choose(item)}
                className="hover:bg-surface-2 flex w-full flex-col items-start rounded-[9px] px-2.5 py-1.5 text-left disabled:opacity-50"
              >
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[13px]">{item.title}</span>
                  {item.badges?.map((b, i) => <ExtBadgeChip key={i} badge={b} />)}
                </span>
                {item.subtitle !== undefined && <span className="text-text-3 line-clamp-1 text-[12px]">{item.subtitle}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
