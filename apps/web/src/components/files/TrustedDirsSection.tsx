/**
 * 机器详情页「文件浏览」一节：信任目录的列表与增删（trusted-browse-dirs）。
 * TRINE_FILES_ALLOW 来源的只读（要在机器上改环境变量）。真值在 agent（machine.info.files.roots）。
 */
import { useState } from 'react';
import { PlusIcon, XIcon } from 'lucide-react';
import type { FilesRoot } from '@trine/core';
import { useClient } from '@/app/runtime.ts';
import { formatDateTime } from '@/lib/format.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { ConfirmDialog } from '@/components/machines/ConfirmDialog.tsx';
import { normalizeDirInput } from './file-model.ts';
import { TrustDirDialog, trustErrorText, useFilesInfo } from './TrustDir.tsx';

export function TrustedDirsSection({
  machineId,
  online,
  roots,
}: {
  machineId: string;
  online: boolean;
  roots: readonly FilesRoot[];
}): React.JSX.Element {
  const client = useClient();
  const home = useFilesInfo(machineId)?.home;
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = draft.trim();
  // 根目录 agent 也会拒绝，这里先挡掉（`/..`、`~/../..` 这类写法规范化后再判断）
  const normalized = normalizeDirInput(trimmed, home);
  const valid =
    normalized !== undefined ? normalized !== '/' : trimmed === '~' || trimmed.startsWith('~/');

  const remove = (path: string): void => {
    if (client === null) return;
    setBusy(true);
    setError(null);
    client.setDirTrusted(machineId, path, false).then(
      () => {
        setBusy(false);
        setRemoving(null);
      },
      (err: unknown) => {
        setBusy(false);
        setRemoving(null);
        setError(trustErrorText(err));
      },
    );
  };

  return (
    <section id="files" className="flex scroll-mt-16 flex-col gap-2" data-testid="trusted-dirs">
      <h2 className="font-medium">文件浏览：信任目录</h2>
      <p className="text-text-3 text-xs">
        「浏览文件」默认只能看会话目录。这里的目录及其子目录也可以浏览（也是文件面板「位置」菜单里的预设目录），对这台机器的所有会话和已配对设备生效；密钥类文件始终不可见。根目录 / 不能信任。
      </p>
      {roots.length === 0 ? (
        <p className="text-text-3 text-xs">还没有信任目录。</p>
      ) : (
        <ul className="border-border divide-border divide-y rounded-[12px] border">
          {roots.map((r) => (
            <li key={r.path} data-testid="trusted-dir" data-path={r.path} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs break-all">{r.path}</div>
                <div className="text-text-3 text-[11px]">
                  {r.source === 'env' ? '来自环境变量 TRINE_FILES_ALLOW，要在机器上修改' : r.addedAt === undefined ? '信任目录' : `信任于 ${formatDateTime(r.addedAt)}`}
                </div>
              </div>
              {r.source === 'trusted' && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`取消信任 ${r.path}`}
                  title="取消信任"
                  data-testid="trusted-dir-remove"
                  disabled={!online || busy}
                  onClick={() => setRemoving(r.path)}
                >
                  <XIcon />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) setAdding(trimmed);
        }}
      >
        <Input
          data-testid="trusted-dir-input"
          value={draft}
          placeholder="/path/to/dir 或 ~/dir"
          onChange={(e) => setDraft(e.target.value)}
          className="font-mono"
          disabled={!online}
        />
        <Button type="submit" variant="outline" data-testid="trusted-dir-add" disabled={!online || !valid}>
          <PlusIcon />
          信任
        </Button>
      </form>
      {!online && <p className="text-text-3 text-xs">机器离线，暂时不能修改。</p>}
      {error !== null && (
        <p className="text-red text-xs" data-testid="trusted-dir-error">
          {error}
        </p>
      )}
      {adding !== null && (
        <TrustDirDialog
          machineId={machineId}
          path={adding}
          open
          onOpenChange={(open) => !open && setAdding(null)}
          onTrusted={() => setDraft('')}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="取消信任这个目录？"
        description={
          <>
            <code className="font-mono text-xs break-all">{removing}</code>
            <p>之后只有会话目录在它之下的会话还能浏览其中的文件。</p>
          </>
        }
        confirmLabel="取消信任"
        busy={busy}
        onConfirm={() => removing !== null && remove(removing)}
        testId="trusted-dir-remove-confirm"
      />
    </section>
  );
}
