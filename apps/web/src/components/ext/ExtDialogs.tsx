/**
 * 全局挂一次的扩展弹窗：执行计划确认、关联选择器。状态在 use-ext.ts 的模块级 store，
 * 菜单、面板等任何地方都能打开它们。
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { ExtPlan, ExtPlanStep } from '@trine/core';
import { Button } from '@/components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import { useClient, useTrine } from '@/app/runtime.ts';
import { extensionsFor, permissionModeLabel } from '@/lib/ext-model.ts';
import { cn } from '@/lib/utils.ts';
import { ExtBadgeChip } from './ExtView.tsx';
import { closeLinkPicker, settleConfirm, updateLinks, useExtCatalog, useExtRead, useExtUi, type LinkPickerRequest } from './use-ext.ts';

export function ExtDialogsHost(): React.JSX.Element {
  const ui = useExtUi();
  return (
    <>
      <PlanConfirmDialog plan={ui.confirm?.plan ?? null} />
      {ui.linkPicker !== null && <LinkPickerDialog request={ui.linkPicker} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// 计划确认
// ---------------------------------------------------------------------------

function PlanConfirmDialog({ plan }: { plan: ExtPlan | null }): React.JSX.Element {
  const destructive = plan?.steps.some((s) => s.type === 'invoke' && s.destructive) === true;
  return (
    <Dialog open={plan !== null} onOpenChange={(open) => !open && settleConfirm(false)}>
      <DialogContent data-testid="ext-confirm" className="max-w-[min(32rem,calc(100vw-2rem))]">
        {plan !== null && (
          <>
            <DialogHeader>
              <DialogTitle>确认：{plan.actionLabel}</DialogTitle>
              <DialogDescription className="text-text-3 text-[12px]">
                来自扩展「{plan.extName}」{plan.extVersion === '' ? '' : ` ${plan.extVersion}`}。确认后按下面的内容执行，不会再改变。
              </DialogDescription>
            </DialogHeader>
            <div className="flex max-h-[55dvh] flex-col gap-3 overflow-y-auto text-[13px]">
              {plan.steps.map((step, i) => (
                <PlanStepView key={i} step={step} />
              ))}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => settleConfirm(false)}>
                取消
              </Button>
              <Button variant={destructive ? 'destructive' : 'default'} data-testid="ext-confirm-ok" onClick={() => settleConfirm(true)}>
                确认执行
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, children, warn = false }: { label: string; children: React.ReactNode; warn?: boolean }): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <span className="text-text-3 w-16 shrink-0">{label}</span>
      <span className={cn('min-w-0 break-all', warn && 'text-red font-medium')}>{children}</span>
    </div>
  );
}

function PromptBox({ text }: { text: string }): React.JSX.Element {
  return (
    <pre className="bg-code-bg border-border max-h-48 overflow-auto rounded-lg border p-2 font-mono text-[12px] whitespace-pre-wrap">{text}</pre>
  );
}

function PlanStepView({ step }: { step: ExtPlanStep }): React.JSX.Element {
  switch (step.type) {
    case 'session.create':
      return (
        <div className="border-border flex flex-col gap-1 rounded-xl border p-3" data-testid="plan-session-create">
          <div className="font-medium">新建会话并发送</div>
          <Row label="目录">{step.cwd}</Row>
          {step.title !== undefined && <Row label="标题">{step.title}</Row>}
          <Row label="模型">{step.model}</Row>
          <Row label="权限" warn={step.permissionMode === 'bypassPermissions'}>
            {permissionModeLabel(step.permissionMode)}
          </Row>
          {step.links.length > 0 && <Row label="关联">{step.links.map((l) => l.label).join('、')}</Row>}
          <PromptBox text={step.prompt} />
        </div>
      );
    case 'prompt.send':
      return (
        <div className="border-border flex flex-col gap-1 rounded-xl border p-3" data-testid="plan-prompt-send">
          <div className="font-medium">发送到会话「{step.sessionTitle || step.targetSessionId.slice(0, 8)}」</div>
          <Row label="目录">{step.cwd}</Row>
          <Row label="权限" warn={step.permissionMode === 'bypassPermissions'}>
            {permissionModeLabel(step.permissionMode)}
          </Row>
          {step.busy && <Row label="状态">会话正忙，消息将排队</Row>}
          <PromptBox text={step.text} />
        </div>
      );
    case 'links.add':
      return <div className="border-border rounded-xl border p-3">关联：{step.links.map((l) => l.label).join('、')}</div>;
    case 'links.remove':
      return <div className="border-border rounded-xl border p-3">取消关联 {step.refs.length} 项</div>;
    case 'invoke':
      return (
        <div className={cn('rounded-xl border p-3', step.destructive ? 'border-red/40' : 'border-border')}>
          <div className="font-medium">执行扩展操作：{step.actionLabel}</div>
          {step.confirm !== undefined && <p className="text-text-2 mt-1">{step.confirm}</p>}
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// 关联选择器
// ---------------------------------------------------------------------------

function LinkPickerDialog({ request }: { request: LinkPickerRequest }): React.JSX.Element {
  const catalog = useExtCatalog(request.machineId);
  const pickers = useMemo(() => extensionsFor(catalog ?? [], 'linkPicker'), [catalog]);
  const [extId, setExtId] = useState<string | undefined>(undefined);
  const ext = pickers.find((e) => e.id === extId) ?? pickers[0];
  return (
    <Dialog open onOpenChange={(open) => !open && closeLinkPicker()}>
      <DialogContent data-testid="ext-link-picker" className="max-w-[min(30rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>{ext?.contributes.linkPicker?.title ?? '关联'}</DialogTitle>
          <DialogDescription className="text-text-3 text-[12px]">
            {request.sessionIds.length > 1 ? `给选中的 ${request.sessionIds.length} 个会话设置关联` : '选择要关联到这个会话的条目，可多选'}
          </DialogDescription>
        </DialogHeader>
        {pickers.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {pickers.map((e) => (
              <Button key={e.id} size="sm" variant={e.id === ext?.id ? 'default' : 'outline'} className="h-7" onClick={() => setExtId(e.id)}>
                {e.name}
              </Button>
            ))}
          </div>
        )}
        {ext === undefined ? (
          <p className="text-text-3 text-[13px]">{catalog === null ? '这台 agent 不支持扩展' : '没有提供关联的扩展'}</p>
        ) : (
          <LinkPickerBody key={ext.id} request={request} ext={ext.id} multiple={ext.contributes.linkPicker?.multiple !== false} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function LinkPickerBody({ request, ext, multiple }: { request: LinkPickerRequest; ext: string; multiple: boolean }): React.JSX.Element {
  const client = useClient();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  const single = request.sessionIds.length === 1 ? request.sessionIds[0] : undefined;
  const read = useExtRead(
    { machineId: request.machineId, ext, op: 'pick', point: 'linkPicker', ...(single === undefined ? {} : { targetSessionId: single }) },
    { query: debounced },
  );
  const sessions = useTrine((s) => s.sessions[request.machineId]);
  // 初始勾选：单个会话时是它现有的关联；批量时从空开始（只做添加）
  const initial = useMemo(() => {
    if (single === undefined) return new Set<string>();
    return new Set((sessions?.[single]?.links ?? []).filter((l) => l.ext === ext).map((l) => l.ref));
  }, [sessions, single, ext]);
  const [checked, setChecked] = useState<Set<string> | null>(null);
  const current = checked ?? initial;
  const [saving, setSaving] = useState(false);
  const items = (read.response?.items ?? []).filter((i) => i.link !== undefined);

  const toggle = (ref: string): void => {
    const next = new Set(multiple ? current : []);
    if (current.has(ref)) next.delete(ref);
    else next.add(ref);
    setChecked(next);
  };

  const save = async (): Promise<void> => {
    if (client === null) return;
    setSaving(true);
    try {
      const labels = new Map(items.map((i) => [i.link!.ref, i.link!.label]));
      // 当前结果里看不到的已有关联（被搜索过滤掉）保留，不当作取消
      const add = [...current].filter((r) => !initial.has(r) && labels.has(r)).map((r) => ({ ref: r, label: labels.get(r)! }));
      const remove = [...initial].filter((r) => !current.has(r) && labels.has(r));
      for (const sid of request.sessionIds) {
        await updateLinks(client, request.machineId, sid, ext, {
          ...(add.length === 0 ? {} : { add }),
          ...(remove.length === 0 || single === undefined ? {} : { remove }),
        });
      }
      closeLinkPicker();
    } catch (err) {
      toast.error(`关联失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索" className="h-8" />
      <div className="flex max-h-[50dvh] flex-col gap-1 overflow-y-auto">
        {read.response?.ok === false && <p className="text-red text-[12.5px]">{read.response.error?.message}</p>}
        {read.failure !== undefined && <p className="text-red text-[12.5px]">{read.failure}</p>}
        {read.response === undefined && read.loading && <p className="text-text-3 text-[12.5px]">加载中…</p>}
        {read.response?.ok === true && items.length === 0 && <p className="text-text-3 text-[12.5px]">没有可关联的条目</p>}
        {items.map((item) => {
          const ref = item.link!.ref;
          const on = current.has(ref);
          return (
            <label
              key={item.id}
              data-testid="ext-pick-item"
              className={cn('hover:bg-surface-2 flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5', on && 'bg-brand-soft')}
            >
              <input type={multiple ? 'checkbox' : 'radio'} checked={on} onChange={() => toggle(ref)} className="mt-1" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[13px]">{item.title}</span>
                  {item.badges?.map((b, i) => <ExtBadgeChip key={i} badge={b} />)}
                </span>
                {item.subtitle !== undefined && <span className="text-text-3 block truncate text-[12px]">{item.subtitle}</span>}
              </span>
            </label>
          );
        })}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={() => closeLinkPicker()} disabled={saving}>
          取消
        </Button>
        <Button data-testid="ext-link-save" onClick={() => void save()} disabled={saving || read.response?.ok !== true}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </DialogFooter>
    </div>
  );
}
