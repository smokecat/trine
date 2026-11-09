/**
 * 信任目录（trusted-browse-dirs，agent ≥ 0.24.0，按 machine.info.files.roots 有无判断）：
 * - `TrustDirDialog`：信任一个目录前的确认（讲清楚影响范围；home 及其上级加强提示）
 * - `OutOfScopeNotice`：浏览到范围外时代替报错的说明卡片，带「信任此目录…」入口
 * - `LocationMenu`：文件面板的「位置」菜单（会话目录 + 信任目录，即预设目录）
 *
 * 列表真值在 agent：增删成功后 agent 重发 machine.info，这里不做乐观更新。
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { BookmarkIcon, ChevronDownIcon, FolderIcon, HouseIcon, ShieldAlertIcon, ShieldCheckIcon } from 'lucide-react';
import type { FilesRoot, MachineFilesInfo } from '@trine/core';
import { useClient, useTrine } from '@/app/runtime.ts';
import { FilesTrustError } from '@/lib/client.ts';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { cn } from '@/lib/utils.ts';
import { isUnder, normalizeDirInput, trustRisk } from './file-model.ts';

/** 这台机器的文件查看能力；undefined = 不支持或已关闭 */
export function useFilesInfo(machineId: string): MachineFilesInfo | undefined {
  return useTrine((s) => s.machines[machineId]?.info?.files);
}

export function trustErrorText(err: unknown): string {
  if (err instanceof FilesTrustError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** 信任的影响说明（对话框与机器详情页共用） */
export function TrustScopeText(): React.JSX.Element {
  return (
    <>
      <p>信任后，这台机器上的所有会话、所有已配对的设备都能浏览这个目录及其子目录里的文件。</p>
      <p className="text-text-3">
        密钥类文件（.env、私钥、.ssh、.git 内部等）、trine 自己的目录和 /proc 这类系统目录依然不可查看。可以随时在机器详情页取消信任。
      </p>
    </>
  );
}

export function TrustDirDialog({
  machineId,
  path,
  open,
  onOpenChange,
  onTrusted,
}: {
  machineId: string;
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 成功后（参数是 agent 实际存下的路径） */
  onTrusted?: (path: string) => void;
}): React.JSX.Element {
  const client = useClient();
  const home = useFilesInfo(machineId)?.home;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 按 agent 会存下的样子判断（`~/..`、末尾 `/` 这类写法）；规范不了的原样显示，交给 agent 校验
  const shown = normalizeDirInput(path, home) ?? path;
  const isRoot = shown === '/';
  const risk = isRoot ? undefined : trustRisk(shown, home);
  const change = (next: boolean): void => {
    if (busy) return;
    setError(null);
    onOpenChange(next);
  };
  const confirm = (): void => {
    if (client === null) return;
    setBusy(true);
    setError(null);
    client.setDirTrusted(machineId, path, true).then(
      (saved) => {
        setBusy(false);
        onOpenChange(false);
        onTrusted?.(saved);
      },
      (err: unknown) => {
        setBusy(false);
        setError(trustErrorText(err));
      },
    );
  };
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent data-testid="trust-dir-dialog" className="max-w-[min(30rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>信任这个目录？</DialogTitle>
          <DialogDescription asChild>
            <div className="text-text-2 flex flex-col gap-2 text-sm">
              <code data-testid="trust-dir-path" className="bg-surface-2 rounded px-2 py-1 font-mono text-[12.5px] break-all">
                {shown}
              </code>
              {isRoot && <p className="text-red font-medium">根目录 / 不能设为信任目录。</p>}
              {risk !== undefined && (
                <p data-testid="trust-dir-risk" className="text-red flex gap-1.5 font-medium">
                  <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" />
                  {risk === 'home'
                    ? '这是 agent 用户的 home 目录：其下的全部项目、配置和文档都会变成可浏览的。'
                    : '这个目录包含 agent 用户的 home 目录：home 里的全部内容和其他用户可读的文件都会变成可浏览的。'}
                </p>
              )}
              <TrustScopeText />
              {error !== null && (
                <p data-testid="trust-dir-error" className="text-red">
                  {error}
                </p>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => change(false)} disabled={busy}>
            取消
          </Button>
          <Button
            variant={risk === undefined ? 'default' : 'destructive'}
            data-testid="trust-dir-confirm"
            disabled={busy || client === null || isRoot}
            onClick={confirm}
          >
            {busy ? '正在信任…' : '信任'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 浏览到范围外的目录（denied + out_of_scope，或旧 agent 的 denied）时的说明。
 * `canTrust` = agent 支持信任目录；不支持时只提示 TRINE_FILES_ALLOW。
 */
export function OutOfScopeNotice({
  path,
  canTrust,
  onTrust,
  onSessionDir,
}: {
  path: string;
  canTrust: boolean;
  onTrust: () => void;
  onSessionDir: () => void;
}): React.JSX.Element {
  return (
    <div data-testid="file-out-of-scope" className="mx-auto flex max-w-md flex-col items-center gap-3 p-8 text-center text-[13px]">
      <ShieldAlertIcon className="text-amber size-8" />
      <div className="text-text font-medium">这个目录不在可浏览范围内</div>
      <code className="bg-surface-2 text-text-2 rounded px-2 py-1 font-mono text-[12px] break-all">{path}</code>
      <p className="text-text-2">
        默认只能浏览会话目录。
        {canTrust
          ? '把这个目录（或它的上级）设为信任目录后即可浏览；'
          : path === '/'
            ? '根目录 / 不能设为信任目录，请进入具体的子目录；'
            : '这台 agent 版本较旧，只能在机器上用环境变量 TRINE_FILES_ALLOW 加目录；'}
        信任对这台机器的所有会话和已配对设备生效，密钥类文件始终不可见。
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {canTrust && (
          <Button size="sm" data-testid="file-trust-open" onClick={onTrust}>
            <ShieldCheckIcon />
            信任此目录…
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onSessionDir}>
          回到会话目录
        </Button>
      </div>
    </div>
  );
}

/**
 * 「位置」菜单：会话目录 + 信任目录（TRINE_FILES_ALLOW 的标「环境变量」）。当前目录可浏览但
 * 不是任何一项时，可以把它也加进来。
 */
export function LocationMenu({
  machineId,
  roots,
  current,
  sessionDir,
  onBrowse,
  onTrustCurrent,
}: {
  machineId: string;
  roots: readonly FilesRoot[];
  /** 当前所在目录（还没加载出来时 undefined） */
  current: string | undefined;
  /** 会话目录（列表 root 为会话 cwd 时才知道） */
  sessionDir: string | undefined;
  /** undefined = 会话目录 */
  onBrowse: (dir: string | undefined) => void;
  onTrustCurrent: (dir: string) => void;
}): React.JSX.Element {
  const active = (p: string): boolean => current !== undefined && isUnder(current, p);
  const canAddCurrent = current !== undefined && current !== '/' && current !== sessionDir && !roots.some((r) => r.path === current);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" data-testid="file-locations" className="text-text-2 h-7 gap-1 px-2 text-[12px]" title="位置：会话目录与信任目录">
          <BookmarkIcon />
          位置
          <ChevronDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(24rem,90vw)]">
        <DropdownMenuItem data-testid="file-location" data-path="" onSelect={() => onBrowse(undefined)}>
          <HouseIcon />
          <span className={cn('truncate', sessionDir !== undefined && active(sessionDir) && 'font-medium')}>会话目录</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-text-3 text-[11.5px] font-normal">信任目录</DropdownMenuLabel>
        {roots.length === 0 && <div className="text-text-3 px-2 pb-1.5 text-[12px]">还没有。浏览到上级目录时可以信任它。</div>}
        {roots.map((r) => (
          <DropdownMenuItem key={r.path} data-testid="file-location" data-path={r.path} onSelect={() => onBrowse(r.path)} title={r.path}>
            <FolderIcon />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn('truncate', active(r.path) && 'font-semibold')}>{r.path.slice(r.path.lastIndexOf('/') + 1) || '/'}</span>
              {/* 长路径保留尾部（rtl 截断从左边省略），LTR 文本包一层避免标点跑位 */}
              <span className="text-text-3 truncate font-mono text-[11px] [direction:rtl]">
                <bdi>{r.path}</bdi>
              </span>
            </span>
            {r.source === 'env' && <span className="text-text-3 shrink-0 text-[11px]">环境变量</span>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {canAddCurrent && (
          <DropdownMenuItem data-testid="file-trust-current" onSelect={() => onTrustCurrent(current)}>
            <ShieldCheckIcon />
            信任当前目录…
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link to={`/machines/${machineId}#files`} data-testid="file-locations-manage">
            管理信任目录…
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
