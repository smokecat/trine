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
 */
import { useState } from 'react';
import { PlusIcon, StarIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { cn } from '@/lib/utils.ts';

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
}: CwdPickerProps): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const trimmed = draft.trim();
  const custom = value !== '' && !favorites.includes(value);

  return (
    <div className="flex flex-col gap-1.5" data-testid="cwd-picker">
      {loading && favorites.length === 0 && (
        <p className="text-text-3 text-xs">正在从机器拉取常用目录…</p>
      )}
      {!loading && favorites.length === 0 && (
        <p className="text-text-3 text-xs">这台机器还没有常用目录，直接在下面输入一个路径。</p>
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
              onClick={() => onChange(path)}
              className={cn(
                'min-w-0 flex-1 truncate rounded-[10px] border px-2.5 py-1.5 text-left font-mono text-xs transition-colors',
                selected
                  ? 'border-brand-border bg-brand-soft text-brand-ink'
                  : 'border-border bg-surface-2 text-text-2 hover:border-border-strong',
              )}
            >
              {path}
            </button>
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
        );
      })}

      {custom && (
        <div className="border-brand-border bg-brand-soft text-brand-ink truncate rounded-[10px] border px-2.5 py-1.5 font-mono text-xs">
          {value}
          <span className="text-text-3 ml-1.5 font-sans text-[11px]">（自定义）</span>
        </div>
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
