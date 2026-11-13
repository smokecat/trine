/**
 * 工作目录选择器（原型 `.cwd-list` / `.cwd-row` / `.cwd-add`）。
 *
 * 常用目录存在 **agent 端**（决策 7：每机器一份，全部客户端设备共享），
 * 所以增删/设默认都是发协议帧 `cwd.add / cwd.remove / cwd.setDefault`，
 * 真值以 `cwd.updated` 广播回来为准——本组件不做乐观更新，避免两台设备
 * 同时改时本地显示与 agent 不一致。
 *
 * 「自由输入」与「加入常用」是两件事：输入框里的路径可以直接用来建会话
 * （不入收藏），点「+ 收藏」才写 agent 端列表。
 *
 * 显示：每行拆成目录名（主行）+ 上级路径（次行，放不下时截左边），home 显示成
 * `~`（见 cwd-display.ts）；完整路径在列表下方「已选」里。组件宽度不够 32rem
 * （手机）时，复制 / 设默认 / 移除收进每行的「⋯」菜单，默认目录改用目录名旁的星标表示。
 */
import { useState } from 'react';
import { CopyIcon, MoreHorizontalIcon, PlusIcon, StarIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Input } from '@/components/ui/input.tsx';
import { cn } from '@/lib/utils.ts';
import { splitCwd } from './cwd-display.ts';

export interface CwdPickerProps {
  favorites: string[];
  defaultCwd: string;
  value: string;
  onChange: (cwd: string) => void;
  /** 机器离线时不可改 agent 端列表（帧会被静默忽略或 park） */
  disabled?: boolean;
  onAdd: (path: string) => void;
  onRemove: (path: string) => void;
  onSetDefault: (path: string) => void;
  /** 还没拿到 cwd.list.response */
  loading?: boolean;
  /** 复制目录到剪贴板（不经 agent，离线也能用）；不给 = 没有复制按钮 */
  onCopy?: (path: string) => void;
  /** 自定义目录那一行的标注，缺省「自定义」（目录不存在时传「将新建」） */
  customNote?: string;
  /** agent 用户的 home，用来把路径显示成 `~/…`；不给就显示完整路径 */
  home?: string;
}

/** 目录名 + 上级路径两行；上级路径放不下时截掉左边（rtl 容器 + ltr 隔离，标点不会乱序） */
function CwdLabel({
  path,
  home,
  marker,
  note,
}: {
  path: string;
  home: string | undefined;
  marker?: React.ReactNode;
  note?: React.ReactNode;
}): React.JSX.Element {
  const { name, parent } = splitCwd(path, home);
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-center gap-1">
        <span data-testid="cwd-name" className="line-clamp-2 font-mono text-[13px] font-medium break-all">
          {name}
        </span>
        {marker}
        {note}
      </span>
      {parent !== '' && (
        <span data-testid="cwd-parent" dir="rtl" className="text-text-3 truncate text-left font-mono text-[11px]">
          <bdi dir="ltr">{parent}</bdi>
        </span>
      )}
    </span>
  );
}

function CopyButton({ path, onCopy }: { path: string; onCopy: (path: string) => void }): React.JSX.Element {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      type="button"
      data-testid="cwd-copy"
      title="复制目录"
      aria-label={`复制目录 ${path}`}
      onClick={() => onCopy(path)}
    >
      <CopyIcon className="text-text-3" />
    </Button>
  );
}

export function CwdPicker({
  favorites,
  defaultCwd,
  value,
  onChange,
  disabled = false,
  onAdd,
  onRemove,
  onSetDefault,
  loading = false,
  onCopy,
  customNote = '自定义',
  home,
}: CwdPickerProps): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const trimmed = draft.trim();
  const custom = value !== '' && !favorites.includes(value);

  return (
    <div className="@container/cwd flex flex-col gap-1.5" data-testid="cwd-picker">
      {loading && favorites.length === 0 && (
        <p className="text-text-3 text-xs">正在从机器拉取常用目录…</p>
      )}
      {/* 已经选了目录（含「在此目录新建」的预填）就不再提示去输入路径 */}
      {!loading && favorites.length === 0 && value === '' && (
        <p data-testid="cwd-empty-hint" className="text-text-3 text-xs">
          这台机器还没有常用目录，直接在下面输入一个路径。
        </p>
      )}

      {favorites.map((path) => {
        const selected = path === value;
        const isDefault = path === defaultCwd;
        return (
          <div key={path} className="flex items-center gap-1">
            <button
              type="button"
              data-testid="cwd-pick"
              data-selected={selected}
              title={path}
              onClick={() => onChange(path)}
              className={cn(
                'flex min-w-0 flex-1 rounded-[10px] border px-2.5 py-1.5 text-left transition-colors',
                selected
                  ? 'border-brand-border bg-brand-soft text-brand-ink'
                  : 'border-border bg-surface-2 text-text-2 hover:border-border-strong',
              )}
            >
              <CwdLabel
                path={path}
                home={home}
                marker={
                  isDefault && (
                    <StarIcon
                      data-testid="cwd-default-mark"
                      aria-label="默认目录"
                      className="fill-amber text-amber size-3 shrink-0 @lg/cwd:hidden"
                    />
                  )
                }
              />
            </button>
            <div className="hidden items-center gap-1 @lg/cwd:flex">
              {onCopy !== undefined && <CopyButton path={path} onCopy={onCopy} />}
              <Button
                size="icon-sm"
                variant="ghost"
                type="button"
                disabled={disabled || isDefault}
                title={isDefault ? '当前默认目录' : '设为默认目录'}
                aria-label={`设为默认目录 ${path}`}
                onClick={() => onSetDefault(path)}
              >
                <StarIcon className={cn(isDefault ? 'fill-amber text-amber' : 'text-text-3')} />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                type="button"
                disabled={disabled}
                title="从常用目录移除"
                aria-label={`移除常用目录 ${path}`}
                onClick={() => onRemove(path)}
              >
                <XIcon className="text-text-3" />
              </Button>
            </div>
            <div className="@lg/cwd:hidden">
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    type="button"
                    data-testid="cwd-row-menu"
                    aria-label={`目录操作 ${path}`}
                  >
                    <MoreHorizontalIcon className="text-text-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-auto min-w-36" data-testid="cwd-row-menu-content">
                  {onCopy !== undefined && (
                    <DropdownMenuItem data-testid="cwd-menu-copy" onSelect={() => onCopy(path)}>
                      <CopyIcon />
                      复制目录
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    data-testid="cwd-menu-default"
                    disabled={disabled || isDefault}
                    onSelect={() => onSetDefault(path)}
                  >
                    <StarIcon />
                    {isDefault ? '当前默认目录' : '设为默认目录'}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    data-testid="cwd-menu-remove"
                    variant="destructive"
                    disabled={disabled}
                    onSelect={() => onRemove(path)}
                  >
                    <XIcon />
                    从常用目录移除
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        );
      })}

      {custom && (
        <div className="flex items-center gap-1">
          <div
            data-testid="cwd-custom"
            title={value}
            className="border-brand-border bg-brand-soft text-brand-ink flex min-w-0 flex-1 rounded-[10px] border px-2.5 py-1.5"
          >
            <CwdLabel
              path={value}
              home={home}
              note={
                <span data-testid="cwd-custom-note" className="text-text-3 shrink-0 font-sans text-[11px]">
                  （{customNote}）
                </span>
              }
            />
          </div>
          {onCopy !== undefined && <CopyButton path={value} onCopy={onCopy} />}
        </div>
      )}

      {value !== '' && (
        <p data-testid="cwd-selected-full" className="text-text-3 font-mono text-[11px] break-all">
          <span className="font-sans">已选：</span>
          {value}
        </p>
      )}

      <div className="mt-1 flex gap-1.5">
        <Input
          data-testid="cwd-input"
          className="h-8 font-mono text-xs"
          placeholder="/path/to/project"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (trimmed === '') return;
            onChange(trimmed);
            setDraft('');
          }}
        />
        <Button
          size="sm"
          variant="outline"
          type="button"
          data-testid="cwd-use"
          disabled={trimmed === ''}
          onClick={() => {
            onChange(trimmed);
            setDraft('');
          }}
        >
          使用
        </Button>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          data-testid="cwd-add"
          disabled={disabled || trimmed === '' || favorites.includes(trimmed)}
          title="加入这台机器的常用目录"
          onClick={() => {
            onAdd(trimmed);
            onChange(trimmed);
            setDraft('');
          }}
        >
          <PlusIcon />
          收藏
        </Button>
      </div>
    </div>
  );
}
