/**
 * 会话设置 sheet（头部元信息行点开，原型 `openSessionSheet`）。
 *
 * 三件事 + 一个高级区：
 * - **模型**：`prefs.knownModels`（预置为家族别名）+ 当前会话模型的 chips +
 *   自由输入（本地列表才是选择器的主体，所以必须允许打字输入没列出来的）。
 *   别名会话额外显示它当前指向的具体模型（取自 capabilities.models）。
 * - **权限模式**：4 档 chips；`bypassPermissions` **两击确认**——首击 chip
 *   变红并出警告文案，再击才真的发。这是原型拍板的（NOTES.chat 问题 4）：
 *   它等同 `claude --permission-mode bypassPermissions`，一旦切过去所有工具
 *   都不再询问，误触的代价太大。
 * - **工作目录**：agent 端持久化的 favorites（决策 7），可增删、设默认、
 *   切换。切换**下一轮生效**（当前这轮 Claude 已经在跑了），文案要说清楚。
 * - **高级**：重置本会话游标 / 重置出站计数器——开发闭环反复擦库时的恢复
 *   入口（评审 B6），平时不该用，所以折叠起来并写明用途。
 *
 * 所有改动都是发协议帧（`session.setModel` 等），不等应答：agent 会用
 * `session.updated` 广播回来，store 自然更新。
 */
import { useEffect, useState } from 'react';
import type { PermissionMode, SessionMeta } from '@trine/core';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet.tsx';
import { Chip } from '@/components/shell/StatusDot.tsx';
import { Disclosure } from '@/components/chat/Messages.tsx';
import { cn } from '@/lib/utils.ts';
import {
  clickMode,
  PERMISSION_MODE_OPTIONS,
  pendingWarning,
  type ModePickerState,
} from './permission-mode.ts';

export type SettingsSection = 'model' | 'cwd' | 'permission';

export interface SessionSettingsActions {
  setModel: (model: string) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setCwd: (cwd: string) => void;
  addCwd: (path: string) => void;
  removeCwd: (path: string) => void;
  setDefaultCwd: (path: string) => void;
  requestStatus: () => void;
  resetScopeCursor: () => void;
  resetOutSeq: () => void;
}

export function SessionSettingsSheet({
  open,
  onOpenChange,
  section,
  meta,
  knownModels,
  resolvedModel,
  cwd,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 从 `/model` `/cwd` `/permission` 打开时滚到/强调对应段 */
  section: SettingsSection | null;
  meta: SessionMeta | undefined;
  knownModels: string[];
  /** 当前别名实际对应的具体模型（见 resolvedAliasModel）；未知不显示 */
  resolvedModel?: string | undefined;
  /** agent 端的目录 favorites（`cwd.list.response`），null = 还没拿到 */
  cwd: { favorites: string[]; defaultCwd: string } | null;
  actions: SessionSettingsActions;
}): React.JSX.Element {
  const [customModel, setCustomModel] = useState('');
  const [newCwd, setNewCwd] = useState('');
  // 两击确认走与新建 sheet **同一个**状态机（permission-mode.ts）。
  // 本 sheet 的已生效值是外部的 `meta.permissionMode`，所以每次交互都以它
  // 为准重新播种，只有 `pending` 是本地的。
  const [pending, setPending] = useState<PermissionMode | null>(null);

  // 每次打开重置两击确认与草稿——上次没点完的状态不该留到下次
  useEffect(() => {
    if (open) {
      setPending(null);
      setCustomModel('');
      setNewCwd('');
    }
  }, [open]);

  const modeState: ModePickerState = { value: meta?.permissionMode ?? 'default', pending };
  const pickMode = (mode: PermissionMode): void => {
    const next = clickMode(modeState, mode);
    setPending(next.pending);
    // value 真的变了才下发（首击只置 pending，clickMode 会保持原 value）
    if (next.pending === null && next.value !== modeState.value) actions.setPermissionMode(next.value);
  };

  const warning = pendingWarning(modeState);
  const favorites = cwd?.favorites ?? [];
  const defaultCwd = cwd?.defaultCwd ?? '';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        data-testid="session-settings"
        className="max-h-[88dvh] gap-0 overflow-y-auto rounded-t-2xl"
      >
        <SheetHeader className="px-4 pt-4 pb-2">
          <SheetTitle>会话设置</SheetTitle>
          <SheetDescription className="text-text-3 text-[12px]">
            模型与权限模式立即生效，切换目录下一轮生效
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-4 pb-6">
          {/* --- 模型 --- */}
          <Section title="模型" highlight={section === 'model'}>
            <div className="flex flex-wrap gap-1.5">
              {knownModels.map((m) => (
                <Chip
                  key={m}
                  data-testid="model-chip"
                  selected={meta?.model === m}
                  onClick={() => actions.setModel(m)}
                >
                  <span className="font-mono">{m}</span>
                </Chip>
              ))}
            </div>
            <div className="mt-2 flex gap-1.5">
              <Input
                data-testid="model-custom"
                className="h-8 flex-1 font-mono text-[12px]"
                placeholder="自定义模型名"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customModel.trim() !== '') {
                    actions.setModel(customModel.trim());
                    setCustomModel('');
                  }
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={customModel.trim() === ''}
                onClick={() => {
                  actions.setModel(customModel.trim());
                  setCustomModel('');
                }}
              >
                使用
              </Button>
            </div>
            {meta?.model === '' && (
              <div className="text-text-3 mt-1.5 text-[11.5px]">当前：默认（agent 未上报模型）</div>
            )}
            {resolvedModel !== undefined && (
              <div data-testid="model-resolved" className="text-text-3 mt-1.5 text-[11.5px]">
                {meta?.model} 当前指向 <span className="font-mono">{resolvedModel}</span>
              </div>
            )}
          </Section>

          {/* --- 权限模式 --- */}
          <Section title="权限模式" highlight={section === 'permission'}>
            <div className="flex flex-wrap gap-1.5">
              {PERMISSION_MODE_OPTIONS.map((opt) => {
                const danger = pending === opt.value;
                return (
                  <Chip
                    key={opt.value}
                    data-testid="mode-chip"
                    data-mode={opt.value}
                    data-pending={String(danger)}
                    selected={meta?.permissionMode === opt.value}
                    className={cn(danger && 'border-red bg-red-soft text-red font-medium')}
                    onClick={() => pickMode(opt.value)}
                  >
                    {opt.label}
                  </Chip>
                );
              })}
            </div>
            {warning !== '' && (
              <div data-testid="bypass-warning" className="text-red mt-1.5 text-[11.5px]">
                {warning}
              </div>
            )}
          </Section>

          {/* --- 工作目录 --- */}
          <Section title="工作目录" highlight={section === 'cwd'}>
            <div className="flex flex-col gap-1.5">
              {favorites.length === 0 && (
                <div className="text-text-3 text-[12px]">
                  {cwd === null ? '正在读取 agent 的常用目录…' : '还没有常用目录'}
                </div>
              )}
              {favorites.map((path) => {
                const current = meta?.cwd === path;
                return (
                  <div key={path} className="flex items-center gap-1.5">
                    <button
                      type="button"
                      data-testid="cwd-pick"
                      data-current={String(current)}
                      className={cn(
                        'flex-1 truncate rounded-[9px] border px-2.5 py-[7px] text-left font-mono text-[12px]',
                        current
                          ? 'border-brand-border bg-brand-soft text-brand-ink'
                          : 'border-border-strong bg-surface text-text-2',
                      )}
                      onClick={() => actions.setCwd(path)}
                      title="切换到此目录（下一轮生效）"
                    >
                      {path}
                    </button>
                    <button
                      type="button"
                      aria-label={path === defaultCwd ? '默认目录' : '设为默认目录'}
                      className={cn(
                        // 触控目标 ≥36px（评审 m9）：原先 px-1 约 20px
                        'inline-flex size-9 shrink-0 items-center justify-center rounded-md text-[15px]',
                        path === defaultCwd ? 'text-amber' : 'text-text-3',
                      )}
                      onClick={() => actions.setDefaultCwd(path)}
                    >
                      ★
                    </button>
                    <button
                      type="button"
                      aria-label="从常用目录移除"
                      className="text-text-3 hover:text-red inline-flex size-9 shrink-0 items-center justify-center rounded-md text-[15px]"
                      onClick={() => actions.removeCwd(path)}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
              {meta !== undefined && !favorites.includes(meta.cwd) && meta.cwd !== '' && (
                <div className="border-brand-border bg-brand-soft text-brand-ink truncate rounded-[9px] border px-2.5 py-[7px] font-mono text-[12px]">
                  {meta.cwd}
                  <span className="text-text-3 ml-1.5 font-sans text-[11px]">当前（未收藏）</span>
                </div>
              )}
            </div>
            <div className="mt-2 flex gap-1.5">
              <Input
                data-testid="cwd-add"
                className="h-8 flex-1 font-mono text-[12px]"
                placeholder="~/path/to/project"
                value={newCwd}
                onChange={(e) => setNewCwd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newCwd.trim() !== '') {
                    actions.addCwd(newCwd.trim());
                    setNewCwd('');
                  }
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={newCwd.trim() === ''}
                onClick={() => {
                  actions.addCwd(newCwd.trim());
                  setNewCwd('');
                }}
              >
                添加
              </Button>
            </div>
            <div className="text-text-3 mt-1.5 text-[11.5px]">切换目录在下一轮消息生效</div>
          </Section>

          <Button
            variant="outline"
            data-testid="open-status"
            onClick={() => {
              actions.requestStatus();
              onOpenChange(false);
            }}
          >
            查看会话状态（/status）
          </Button>

          {/* --- 高级：出问题时的恢复入口，平时不该碰 --- */}
          <Disclosure summary="高级">
            <div className="flex flex-col gap-2">
              <div className="text-text-3 text-[11.5px]">
                只在「服务端数据被重置、本地却收不到新消息」时才需要。平时用它会让本地历史缺一段。
              </div>
              <Button
                size="sm"
                variant="outline"
                data-testid="reset-cursor"
                onClick={() => actions.resetScopeCursor()}
              >
                重置本会话游标并重新同步
              </Button>
              <div className="text-text-3 text-[11.5px]">
                出站计数器失效（seq 越界）导致消息发不出去时，归零后可重新发送。
              </div>
              <Button
                size="sm"
                variant="outline"
                data-testid="reset-outseq"
                onClick={() => actions.resetOutSeq()}
              >
                重置本会话出站计数器
              </Button>
            </div>
          </Disclosure>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Section({
  title,
  highlight,
  children,
}: {
  title: string;
  highlight: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      data-testid={`settings-${title}`}
      className={cn(
        'rounded-xl',
        highlight && 'ring-brand-border -m-2 bg-brand-soft/40 p-2 ring-1',
      )}
    >
      <div className="text-text-3 mb-1.5 text-[11px] tracking-[0.06em] uppercase">{title}</div>
      {children}
    </section>
  );
}
