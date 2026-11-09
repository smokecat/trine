/**
 * 文件浏览器正文：面包屑 + 目录列表（目录在前）。被 agent 拒绝的条目（密钥类、指向范围外的
 * 符号链接）带锁、不能点。点开头的条目是否显示由面板的开关决定（默认显示）。
 */
import { FileIcon, FileTextIcon, FolderIcon, ImageIcon, LockIcon } from 'lucide-react';
import type { FsEntry } from '@trine/core';
import type { FsListing } from '@/lib/client.ts';
import { formatBytes, formatRelativeTime } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { joinPath, pathCrumbs, visibleEntries } from './file-model.ts';

function entryIcon(entry: FsEntry): React.JSX.Element {
  if (entry.denied === true) return <LockIcon className="text-text-3 size-4" />;
  if (entry.type === 'dir') return <FolderIcon className="text-brand size-4" />;
  const lower = entry.name.toLowerCase();
  if (/\.(md|markdown|mdx|txt)$/.test(lower)) return <FileTextIcon className="text-text-2 size-4" />;
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/.test(lower)) return <ImageIcon className="text-text-2 size-4" />;
  return <FileIcon className="text-text-3 size-4" />;
}

/**
 * 面包屑：完整绝对路径，从 `/` 开始。命中的根（会话目录 / 信任目录）及其之下正常显示，
 * 之上的段变淡但照样能点——能不能看由 agent 判断。`root` 省略 = 当前路径不在范围内。
 */
export function Breadcrumbs({
  path,
  root,
  onBrowse,
  className,
}: {
  path: string;
  root?: string | undefined;
  onBrowse: (dir: string) => void;
  className?: string;
}): React.JSX.Element {
  const crumbs = pathCrumbs(path, root);
  return (
    <nav data-testid="file-breadcrumbs" className={cn('flex min-w-0 flex-wrap items-center gap-0.5 font-mono text-[12px]', className)}>
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={c.path} className="flex min-w-0 items-center gap-0.5">
            {i > 1 && <span className="text-text-3">/</span>}
            <button
              type="button"
              data-testid="file-crumb"
              data-in-scope={c.inScope || undefined}
              onClick={() => onBrowse(c.path)}
              disabled={last}
              title={c.inScope ? c.path : `${c.path}（会话目录与信任目录之外）`}
              className={cn(
                'max-w-[14rem] truncate rounded px-0.5',
                last ? 'text-text' : c.inScope ? 'text-text-2 hover:text-text hover:underline' : 'text-text-3 hover:text-text-2 hover:underline',
                c.path === root && !last && 'font-medium',
              )}
            >
              {c.label}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

export function FileList({
  listing,
  showHidden,
  onBrowse,
  onOpen,
  now = Date.now(),
}: {
  listing: FsListing;
  showHidden: boolean;
  onBrowse: (dir: string) => void;
  onOpen: (path: string) => void;
  now?: number;
}): React.JSX.Element {
  const entries = visibleEntries(listing.entries, showHidden);
  const hidden = listing.entries.length - entries.length;
  return (
    <div data-testid="file-list">
      {entries.length === 0 && (
        <div className="text-text-3 px-4 py-6 text-center text-[13px]">
          {hidden > 0 ? `空目录（另有 ${hidden} 个隐藏条目）` : '空目录'}
        </div>
      )}
      <ul>
        {entries.map((e) => {
          const path = joinPath(listing.path, e.name);
          const clickable = e.denied !== true && e.type !== 'other';
          return (
            <li key={e.name}>
              <button
                type="button"
                data-testid="file-entry"
                data-name={e.name}
                data-type={e.type}
                data-denied={e.denied === true || undefined}
                disabled={!clickable}
                title={e.denied === true ? '不提供查看（密钥类文件或范围外的链接）' : path}
                onClick={() => (e.type === 'dir' ? onBrowse(path) : onOpen(path))}
                className={cn(
                  'flex w-full items-center gap-2.5 px-4 py-2 text-left text-[13px]',
                  clickable ? 'hover:bg-surface-2 cursor-pointer' : 'text-text-3 cursor-default',
                )}
              >
                <span className="shrink-0">{entryIcon(e)}</span>
                <span className="min-w-0 flex-1 truncate">
                  {e.name}
                  {e.type === 'dir' ? '/' : ''}
                </span>
                {e.size !== undefined && <span className="text-text-3 tabular shrink-0 text-[11.5px]">{formatBytes(e.size)}</span>}
                {e.mtime !== undefined && (
                  <span className="text-text-3 tabular hidden w-20 shrink-0 text-right text-[11.5px] sm:inline">{formatRelativeTime(e.mtime, now)}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {listing.truncated && <div className="text-text-3 px-4 py-2 text-[12px]">条目太多，只列出前 {listing.entries.length} 个</div>}
    </div>
  );
}
