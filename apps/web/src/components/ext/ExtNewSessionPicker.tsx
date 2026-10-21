/**
 * 新建会话 sheet 的「从任务开始」（U7）：列出扩展的候选项（pick，point=newSession，上下文是选中的目录），
 * 选中一项 → 预填首条消息（候选项的 prompt.insert）、建好会话后自动关联（候选项的 link）。
 *
 * 会话由用户在 sheet 里自己建：预填的文字可以改，关联走宿主的 session.links.update（本人操作），
 * 都不经过扩展的动作 token。agent 签发时也只给 newSession 的候选项留 prompt.insert。
 */
import { useEffect, useMemo, useState } from 'react';
import { XIcon } from 'lucide-react';
import type { ExtCatalogItem, ExtLinkRef, ExtWirePickItem } from '@trine/core';
import { Input } from '@/components/ui/input.tsx';
import { extensionsFor } from '@/lib/ext-model.ts';
import { cn } from '@/lib/utils.ts';
import { ExtBadgeChip } from './ExtView.tsx';
import { useExtCatalog, useExtRead } from './use-ext.ts';

/** 选中的起点：建会话时用 */
export interface NewSessionStart {
  ext: string;
  extName: string;
  itemId: string;
  title: string;
  link: ExtLinkRef | undefined;
  /** 预填的首条消息（候选项的 prompt.insert 依次拼接） */
  prompt: string;
}

/** 这台机器提供「从…开始」的扩展；不支持扩展时为空数组 */
export function useNewSessionExtensions(machineId: string): ExtCatalogItem[] {
  const catalog = useExtCatalog(machineId === '' ? undefined : machineId);
  return useMemo(() => (catalog === null ? [] : extensionsFor(catalog, 'newSession')), [catalog]);
}

export function startOf(ext: ExtCatalogItem, item: ExtWirePickItem): NewSessionStart {
  const prompt = (item.local ?? [])
    .flatMap((e) => (e.type === 'prompt.insert' ? [e.text] : []))
    .join('\n\n');
  return { ext: ext.id, extName: ext.name, itemId: item.id, title: item.title, link: item.link, prompt };
}

export function ExtNewSessionPicker({
  machineId,
  cwd,
  extensions,
  selected,
  onSelect,
}: {
  machineId: string;
  cwd: string;
  extensions: readonly ExtCatalogItem[];
  selected: NewSessionStart | null;
  onSelect: (start: NewSessionStart | null) => void;
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
    ext === undefined || cwd === '' || selected !== null ? null : { machineId, ext: ext.id, op: 'pick', point: 'newSession', cwd },
    { query: debounced },
  );
  const items = (read.response?.ok === true ? read.response.items : undefined) ?? [];

  if (selected !== null) {
    return (
      <div data-testid="ns-start-selected" className="border-border bg-surface-2 flex items-start gap-2 rounded-[9px] border px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px]">{selected.title}</div>
          <div className="text-text-3 text-[11.5px]">
            {selected.extName}
            {selected.link !== undefined && ` · 建好后关联「${selected.link.label}」`}
          </div>
        </div>
        <button
          type="button"
          aria-label="不从这一项开始"
          data-testid="ns-start-clear"
          className="text-text-3 hover:text-text mt-0.5"
          onClick={() => onSelect(null)}
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="ns-start-picker">
      {extensions.length > 1 && (
        <div className="flex items-center gap-1.5">
          {extensions.map((e) => (
            <button
              key={e.id}
              type="button"
              className={cn('rounded-full px-2 py-0.5 text-[11.5px]', e.id === ext?.id ? 'bg-brand-soft text-brand-ink' : 'text-text-3 hover:text-text')}
              onClick={() => setActive(e.id)}
            >
              {e.contributes.newSession?.title ?? e.name}
            </button>
          ))}
        </div>
      )}
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索" className="h-7 text-[12.5px]" />
      <ul className="border-border max-h-48 overflow-y-auto rounded-[9px] border p-1">
        {cwd === '' && <li className="text-text-3 px-2.5 py-1.5 text-[12.5px]">先选工作目录</li>}
        {cwd !== '' && read.response === undefined && read.failure === undefined && (
          <li className="text-text-3 px-2.5 py-1.5 text-[12.5px]">加载中…</li>
        )}
        {read.failure !== undefined && <li className="text-red px-2.5 py-1.5 text-[12.5px]">{read.failure}</li>}
        {read.response?.ok === false && <li className="text-red px-2.5 py-1.5 text-[12.5px]">{read.response.error?.message}</li>}
        {read.response?.ok === true && items.length === 0 && <li className="text-text-3 px-2.5 py-1.5 text-[12.5px]">没有可用的条目</li>}
        {ext !== undefined &&
          items.map((item) => {
            // 只有预填文字或关联的才可选（越界效果被 agent 拿掉后两样都没有）
            const usable = item.local !== undefined || item.link !== undefined;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  data-testid="ns-start-item"
                  disabled={!usable}
                  onClick={() => onSelect(startOf(ext, item))}
                  className="hover:bg-surface-2 flex w-full flex-col items-start rounded-[7px] px-2.5 py-1.5 text-left disabled:opacity-50"
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
