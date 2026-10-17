/**
 * 「/」命令菜单的浮层（原型 `.slash-menu`）。
 *
 * 浮在 composer **上方**（不是下拉）：移动端软键盘从下方顶上来，下拉菜单
 * 会被键盘完全遮住。键盘上下选择 + Enter 确认 + Esc 关闭；移动端直接点。
 *
 * `onPointerDown` 里 preventDefault 是要紧的一笔：不阻止的话点菜单会先让
 * textarea 失焦，移动端软键盘收起、视口跳动，选中后还要重新聚焦。
 *
 * 分组/过滤/索引推进都在 slash-model.ts（纯函数，有单测），这里只画。
 */
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils.ts';
import { flattenSlashGroups, type SlashGroup, type SlashItem } from './slash-model.ts';

const SOURCE_LABEL = {
  project: 'project',
  user: 'user',
  skill: 'skill',
  plugin: 'plugin',
} as const;

export function SlashMenu({
  groups,
  activeIndex,
  onPick,
}: {
  groups: SlashGroup[];
  activeIndex: number;
  onPick: (item: SlashItem) => void;
}): React.JSX.Element | null {
  const items = flattenSlashGroups(groups);
  const activeRef = useRef<HTMLButtonElement>(null);

  // 键盘移动选中项时把它滚进视野
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (items.length === 0) return null;

  let flatIndex = -1;
  return (
    <div
      data-testid="slash-menu"
      role="listbox"
      aria-label="命令菜单"
      className={cn(
        'border-border-strong bg-surface absolute inset-x-3 bottom-full z-30 mb-1.5',
        'max-h-[46vh] overflow-y-auto rounded-[14px] border p-1.5 shadow-[var(--shadow-card)]',
      )}
      // 点菜单不让 textarea 失焦（移动端软键盘不收）
      onPointerDown={(e) => e.preventDefault()}
    >
      {groups.map((group) => (
        <div key={group.title}>
          <div className="text-text-3 px-2.5 pt-2 pb-0.5 text-[11px] tracking-[0.05em] uppercase">
            {group.title}
          </div>
          {group.items.map((item) => {
            flatIndex += 1;
            const index = flatIndex;
            const active = index === activeIndex;
            return (
              <button
                key={`${group.title}:${item.label}`}
                ref={active ? activeRef : undefined}
                type="button"
                role="option"
                aria-selected={active}
                data-testid="slash-item"
                data-active={String(active)}
                className={cn(
                  'flex w-full items-baseline gap-2 rounded-[9px] px-2.5 py-2 text-left',
                  active ? 'bg-surface-2' : 'hover:bg-surface-2',
                )}
                onClick={() => onPick(item)}
              >
                <span className="shrink-0 font-mono text-[12.5px] font-medium">{item.label}</span>
                {item.description !== undefined && (
                  <span className="text-text-3 min-w-0 flex-1 truncate text-[12px]">
                    {item.description}
                  </span>
                )}
                {item.source !== undefined && (
                  <span className="border-border text-text-3 ml-auto shrink-0 rounded-[5px] border px-[5px] py-px text-[10px]">
                    {SOURCE_LABEL[item.source]}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
