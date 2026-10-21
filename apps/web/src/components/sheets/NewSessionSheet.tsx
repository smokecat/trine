/**
 * 新建会话 sheet（原型 `openNewSessSheet`：机器 → 工作目录 → 模型 → 权限模式）。
 *
 * 产品口径「全部有默认值——两击可建」：打开即可点「开始会话」，四个分区
 * 都预填。默认值来源依次是：
 *   机器   — 在线的第一台（在线优先排序），没有在线机器就第一台
 *   目录   — 该机器的 `defaultCwd`（agent 端存），没有就上一次用过的
 *   模型   — 设置页的「新会话默认值」（prefs.defaultModel，初值 opus[1m]）
 *   权限   — 同上（prefs.defaultPermissionMode，初值 bypass）
 *
 * 默认值是用户在设置页明确选的（bypass 在那里已两击确认过），所以这里直接
 * 预选、不再要求确认；在本 sheet 里**改选** bypass 仍走两击确认。
 *
 * cwd 列表是 agent 端数据，打开 sheet 时对在线机器发一次 `cwd.list.request`
 * （不轮询；离线机器不发——评审 C4「离线机器的机器级请求静默无回执」）。
 *
 * 「从任务开始」（扩展 U7，机器有提供 newSession 的扩展时才出现）：选一项预填首条消息，
 * 建好后自动关联。顺序是 建会话 → 关联（等回执，失败只提示）→ 发首条消息 → 跳转，
 * 先关联再发，扩展在这一轮结束时看得到关联。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { PermissionMode } from '@trine/core';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet.tsx';
import { Chip, StatusDot } from '@/components/shell/StatusDot.tsx';
import { useClient, useTrine } from '@/app/runtime.ts';
import { cn } from '@/lib/utils.ts';
import { ExtNewSessionPicker, useNewSessionExtensions, type NewSessionStart } from '@/components/ext/ExtNewSessionPicker.tsx';
import { CwdPicker } from './CwdPicker.tsx';
import {
  clickMode,
  initialModeState,
  OFFLINE_HINT,
  PERMISSION_MODE_OPTIONS,
  pendingWarning,
  type ModePickerState,
} from './permission-mode.ts';

/** 分区标题（原型 `.form-row .lbl`） */
function Label({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="text-text-3 mb-1.5 text-[11px] tracking-[0.05em] uppercase">{children}</div>
  );
}

export function NewSessionSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const client = useClient();
  const navigate = useNavigate();
  const machines = useTrine((s) => s.machines);
  const sessions = useTrine((s) => s.sessions);
  const knownModels = useTrine((s) => s.prefs.knownModels);
  const defaultModel = useTrine((s) => s.prefs.defaultModel);
  const defaultMode = useTrine((s) => s.prefs.defaultPermissionMode);

  const machineList = useMemo(
    () =>
      Object.values(machines).sort(
        (a, b) => Number(b.online === true) - Number(a.online === true) || (a.name < b.name ? -1 : 1),
      ),
    [machines],
  );

  const [machineId, setMachineId] = useState('');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [modeState, setModeState] = useState<ModePickerState>(() => initialModeState(defaultMode));
  const [customModel, setCustomModel] = useState('');
  const [creating, setCreating] = useState(false);
  const [cwdRequested, setCwdRequested] = useState<string | null>(null);
  const [start, setStart] = useState<NewSessionStart | null>(null);
  const [prompt, setPrompt] = useState('');

  const machine = machines[machineId];
  const offline = machine !== undefined && machine.online !== true;
  const startExts = useNewSessionExtensions(machineId);
  // 选中后扩展被停用 / 移除（别的设备改了设置）：这一节会消失，选择与预填的文字一并作废，
  // 不能把用户已经看不到的内容发出去
  const startAvailable = start !== null && !offline && startExts.some((e) => e.id === start.ext);
  useEffect(() => {
    if (start !== null && !startAvailable) {
      setStart(null);
      setPrompt('');
    }
  }, [start, startAvailable]);

  // 起点属于某个目录下的数据：换机器 / 换目录就清掉（连同预填的文字）
  const changeStart = (next: NewSessionStart | null): void => {
    setStart(next);
    setPrompt(next?.prompt ?? '');
  };
  const changeCwd = (next: string): void => {
    setCwd(next);
    if (next !== cwd) changeStart(null);
  };

  // 打开时选默认机器（在线优先）
  useEffect(() => {
    if (!open) return;
    if (machineId !== '' && machines[machineId] !== undefined) return;
    const first = machineList[0];
    if (first) setMachineId(first.machineId);
  }, [open, machineId, machineList, machines]);

  // 换机器 / 打开时：对在线机器拉一次常用目录
  useEffect(() => {
    if (!open || !client || machineId === '' || cwdRequested === machineId) return;
    if (machines[machineId]?.online !== true) return;
    setCwdRequested(machineId);
    client
      .request(machineId, { type: 'cwd.list.request' })
      .catch((err: unknown) => console.info(`[cwd] ${err instanceof Error ? err.message : String(err)}`));
  }, [open, client, machineId, machines, cwdRequested]);

  // 默认目录：机器的 defaultCwd，其次该机器最近一个会话的 cwd
  useEffect(() => {
    if (!open || machineId === '') return;
    const fav = machines[machineId]?.cwd;
    const recent = Object.values(sessions[machineId] ?? {}).sort(
      (a, b) => b.lastActivityAt - a.lastActivityAt,
    )[0];
    const next = fav?.defaultCwd ?? recent?.cwd ?? '';
    setCwd((cur) => (cur === '' ? next : cur));
  }, [open, machineId, machines, sessions]);

  // 每次打开按设置页的默认值预选（上次没建成的选择不留到下次）
  useEffect(() => {
    if (!open) return;
    setModel(defaultModel);
    setModeState(initialModeState(defaultMode));
    setStart(null);
    setPrompt('');
  }, [open, defaultModel, defaultMode]);

  const modelChips = useMemo(() => {
    const set = new Set(knownModels);
    if (model !== '') set.add(model);
    return [...set];
  }, [knownModels, model]);

  const create = async (): Promise<void> => {
    // 离线机器直接不做：`client.request()` 对 online === false 立即 reject
    // （机器级帧离线本就被服务端静默丢弃，不存在「排队等上线」这回事）
    if (!client || offline || creating || machineId === '' || cwd.trim() === '') return;
    setCreating(true);
    try {
      const meta = await client.createSession(machineId, {
        cwd: cwd.trim(),
        model: model.trim(),
        permissionMode: modeState.value,
      });
      const from = startAvailable ? start : null;
      if (from?.link !== undefined) await linkNewSession(meta.sessionId, from);
      if (from !== null && prompt.trim() !== '') client.sendInput(machineId, meta.sessionId, prompt.trim());
      onOpenChange(false);
      navigate(`/s/${machineId}/${meta.sessionId}`);
    } catch (err) {
      toast.error('新建会话失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCreating(false);
    }
  };

  /** 关联失败不挡建会话：会话已经建好，提示用户手动关联 */
  const linkNewSession = async (sessionId: string, from: NewSessionStart): Promise<void> => {
    if (!client || from.link === undefined) return;
    const failed = (reason: string): void => {
      toast.warning('会话已建好，但没能关联', { description: `${from.link!.label}：${reason}。可在会话菜单里手动关联。` });
    };
    try {
      const res = await client.extRequest(
        machineId,
        { type: 'session.links.update', targetSessionId: sessionId, ext: from.ext, add: [from.link] } as never,
        ['session.links.update.response'],
      );
      if (!res.ok) failed(res.error?.message ?? '未知错误');
    } catch (err) {
      failed(err instanceof Error ? err.message : String(err));
    }
  };

  const warning = pendingWarning(modeState);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[88dvh] overflow-y-auto" data-testid="new-session-sheet">
        <SheetHeader>
          <SheetTitle>新建会话</SheetTitle>
          <SheetDescription>全部字段有默认值——两击可建。</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 px-4 pb-6">
          {machineList.length === 0 ? (
            <p className="text-text-2 text-sm">还没有配对任何机器。</p>
          ) : (
            <>
              <section>
                <Label>机器</Label>
                <div className="flex flex-wrap gap-1.5">
                  {machineList.map((m) => (
                    <Chip
                      key={m.machineId}
                      data-testid="ns-machine"
                      data-machine-id={m.machineId}
                      selected={machineId === m.machineId}
                      onClick={() => {
                        setMachineId(m.machineId);
                        setCwd('');
                        changeStart(null);
                      }}
                    >
                      <StatusDot tone={m.online === true ? 'on' : 'off'} />
                      {m.name}
                    </Chip>
                  ))}
                </div>
                {offline && (
                  <p data-testid="ns-offline" className="text-amber mt-1.5 text-[11.5px]">
                    {OFFLINE_HINT}
                  </p>
                )}
              </section>

              <section>
                <Label>工作目录</Label>
                <CwdPicker
                  favorites={machine?.cwd?.favorites ?? []}
                  defaultCwd={machine?.cwd?.defaultCwd ?? ''}
                  value={cwd}
                  onChange={changeCwd}
                  disabled={offline}
                  loading={machine?.cwd === null && !offline}
                  onAdd={(p) => client?.send(machineId, { type: 'cwd.add', path: p })}
                  onRemove={(p) => client?.send(machineId, { type: 'cwd.remove', path: p })}
                  onSetDefault={(p) => client?.send(machineId, { type: 'cwd.setDefault', path: p })}
                />
              </section>

              {!offline && startExts.length > 0 && (
                <section data-testid="ns-start">
                  <Label>{startExts.length === 1 ? (startExts[0]!.contributes.newSession?.title ?? '从扩展开始') : '从扩展开始'}（可选）</Label>
                  <ExtNewSessionPicker
                    machineId={machineId}
                    cwd={cwd.trim()}
                    extensions={startExts}
                    selected={start}
                    onSelect={changeStart}
                  />
                  {start !== null && (
                    <Textarea
                      data-testid="ns-prompt"
                      className="mt-1.5 max-h-48 min-h-20 text-[13px]"
                      placeholder="首条消息（留空则只建会话）"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                    />
                  )}
                </section>
              )}

              <section>
                <Label>模型</Label>
                <div className="flex flex-wrap gap-1.5">
                  {modelChips.map((m) => (
                    <Chip
                      key={m}
                      data-testid="ns-model"
                      selected={model === m}
                      onClick={() => setModel(m)}
                      className="font-mono"
                    >
                      {m}
                    </Chip>
                  ))}
                </div>
                <div className="mt-1.5 flex gap-1.5">
                  <Input
                    className="h-8 font-mono text-xs"
                    placeholder="自定义模型名"
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      e.preventDefault();
                      if (customModel.trim() === '') return;
                      setModel(customModel.trim());
                      setCustomModel('');
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    disabled={customModel.trim() === ''}
                    onClick={() => {
                      setModel(customModel.trim());
                      setCustomModel('');
                    }}
                  >
                    使用
                  </Button>
                </div>
              </section>

              <section>
                <Label>权限模式</Label>
                <div className="flex flex-wrap gap-1.5">
                  {PERMISSION_MODE_OPTIONS.map((opt) => {
                    const selected = modeState.value === opt.value;
                    const pending = modeState.pending === opt.value;
                    return (
                      <Chip
                        key={opt.value}
                        data-testid="ns-mode"
                        data-mode={opt.value}
                        data-pending={pending}
                        selected={selected}
                        onClick={() => setModeState((s) => clickMode(s, opt.value))}
                        className={cn(pending && 'border-red bg-red-soft text-red font-medium')}
                      >
                        {opt.label}
                      </Chip>
                    );
                  })}
                </div>
                {warning !== '' && (
                  <p data-testid="ns-mode-warning" className="text-red mt-1.5 text-[11.5px]">
                    {warning}
                  </p>
                )}
              </section>

              <div className="flex gap-2 pt-1">
                <Button
                  data-testid="ns-create"
                  disabled={offline || creating || machineId === '' || cwd.trim() === ''}
                  onClick={() => void create()}
                >
                  {creating ? '创建中…' : '开始会话'}
                </Button>
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  取消
                </Button>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
