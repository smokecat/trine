/**
 * 扩展的 React 胶水：目录、读取（含订阅续租）、动作执行、全局弹窗（确认 / 关联选择器）的状态。
 * 规则在 lib/ext-model.ts；这里只管 client 引用、页面可见性与组件生命周期。
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { ExtCatalogItem, ExtLocalEffect, ExtPlan, ExtPoint } from '@trine/core';
import { useClient, useTrine } from '@/app/runtime.ts';
import { copyText } from '@/lib/clipboard.ts';
import type { TrineClient } from '@/lib/client.ts';
import {
  applyLocalEffects,
  ExtCatalogCache,
  isNewer,
  readKey,
  responseKey,
  runTokenAction,
  supportsExtensions,
  type ExtActionPlanEvent,
  type ExtActionResult,
  type ExtReadResponse,
  type ReadTarget,
} from '@/lib/ext-model.ts';

/** 订阅租约：面板可见期间每 4 分钟续一次 5 分钟的租约 */
const WATCH_TTL_MS = 5 * 60_000;
const WATCH_RENEW_MS = 4 * 60_000;

// ---------------------------------------------------------------------------
// 模块级单例（跟着 client 走）
// ---------------------------------------------------------------------------

interface ExtRuntime {
  client: TrineClient;
  catalogs: ExtCatalogCache;
  /** 读取结果：readKey → 最新一份 */
  views: Map<string, ExtReadResponse>;
  listeners: Set<() => void>;
}

let runtime: ExtRuntime | null = null;

function runtimeFor(client: TrineClient): ExtRuntime {
  if (runtime?.client === client) return runtime;
  const rt: ExtRuntime = {
    client,
    catalogs: new ExtCatalogCache(async (machineId) => {
      const res = await client.extRequest(machineId, { type: 'ext.catalog.request' } as never, ['ext.catalog.response']);
      return { rev: res.rev, items: res.items };
    }),
    views: new Map(),
    listeners: new Set(),
  };
  // 推送（不带 reqId）与应答都经这里落进 views
  client.on('event', (machineId, event) => {
    if (event.type !== 'ext.read.response') return;
    const key = responseKey(machineId, event);
    if (!isNewer(rt.views.get(key), event)) return;
    rt.views.set(key, event);
    for (const l of rt.listeners) l();
  });
  runtime = rt;
  return rt;
}

function useRuntimeExt(): ExtRuntime | null {
  const client = useClient();
  return client === null ? null : runtimeFor(client);
}

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------

/** 这台机器的扩展目录；agent 不支持扩展时为 null */
export function useExtCatalog(machineId: string | undefined): ExtCatalogItem[] | null {
  const rt = useRuntimeExt();
  const summary = useTrine((s) => (machineId === undefined ? undefined : s.machines[machineId]?.info?.extensions));
  const online = useTrine((s) => (machineId === undefined ? false : s.machines[machineId]?.online === true));
  const supported = useTrine((s) => machineId !== undefined && supportsExtensions(s.machines[machineId]?.info));
  const subscribe = useCallback((l: () => void) => rt?.catalogs.subscribe(l) ?? (() => {}), [rt]);
  const state = useSyncExternalStore(subscribe, () => (machineId === undefined ? undefined : rt?.catalogs.get(machineId)));
  useEffect(() => {
    if (rt === null || machineId === undefined || summary === undefined || !online) return;
    rt.catalogs.ensure(machineId, summary.rev).catch(() => {});
  }, [rt, machineId, summary?.rev, online]);
  if (!supported) return null;
  return state?.items ?? [];
}

export function invalidateCatalog(client: TrineClient, machineId: string): void {
  runtimeFor(client).catalogs.invalidate(machineId);
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export interface ExtReadState {
  response: ExtReadResponse | undefined;
  loading: boolean;
  /** 发不出去 / 超时 */
  failure: string | undefined;
  refresh: () => void;
}

/**
 * 读一个扩展视图；watch 时在挂载期间、页面可见时持有订阅（agent 有变化就推）。
 * target 为 null 时什么都不做。
 */
export function useExtRead(target: ReadTarget | null, options: { watch?: boolean; query?: string } = {}): ExtReadState {
  const rt = useRuntimeExt();
  const key = target === null ? '' : readKey(target);
  const subscribe = useCallback(
    (l: () => void) => {
      if (rt === null) return () => {};
      rt.listeners.add(l);
      return () => rt.listeners.delete(l);
    },
    [rt],
  );
  const response = useSyncExternalStore(subscribe, () => (key === '' ? undefined : rt?.views.get(key)));
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const visible = usePageVisible();
  const watch = options.watch === true && visible;
  const query = options.query;
  // agent 重启 / 扩展变更时 rev 会变：重新读取、重建订阅（旧进程的订阅随进程没了）
  const catalogRev = useTrine((s) => (target === null ? undefined : s.machines[target.machineId]?.info?.extensions?.rev));

  const send = useCallback(
    (extra: { force?: boolean; watchTtl?: number }) => {
      if (rt === null || target === null) return Promise.resolve();
      setLoading(true);
      return rt.client
        .extRequest(
          target.machineId,
          {
            type: 'ext.read',
            ext: target.ext,
            op: target.op,
            point: target.point,
            ...(target.targetSessionId === undefined ? {} : { targetSessionId: target.targetSessionId }),
            ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
            ...(query === undefined || query === '' ? {} : { args: { query } }),
            locale: 'zh-CN',
            ...(extra.force === true ? { force: true } : {}),
            ...(extra.watchTtl === undefined ? {} : { watch: { ttlMs: extra.watchTtl } }),
          } as never,
          ['ext.read.response'],
        )
        .then(() => setFailure(undefined))
        .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)))
        .finally(() => setLoading(false));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rt, key, query],
  );

  useEffect(() => {
    if (target === null) return;
    void send(watch ? { watchTtl: WATCH_TTL_MS } : {});
    if (!watch) return;
    const timer = setInterval(() => void send({ watchTtl: WATCH_TTL_MS }), WATCH_RENEW_MS);
    return () => {
      clearInterval(timer);
      // 退订：不等应答
      if (rt !== null) {
        rt.client.extSend(target.machineId, {
          type: 'ext.read',
          reqId: `unwatch-${Date.now()}`,
          ext: target.ext,
          op: target.op,
          point: target.point,
          ...(target.targetSessionId === undefined ? {} : { targetSessionId: target.targetSessionId }),
          ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
          ...(query === undefined || query === '' ? {} : { args: { query } }),
          locale: 'zh-CN',
          watch: { ttlMs: 0 },
        } as never);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, watch, send, catalogRev]);

  const refresh = useCallback(() => void send({ force: true }), [send]);
  return { response, loading, failure, refresh };
}

function usePageVisible(): boolean {
  return useSyncExternalStore(
    (l) => {
      document.addEventListener('visibilitychange', l);
      return () => document.removeEventListener('visibilitychange', l);
    },
    () => document.visibilityState === 'visible',
    () => true,
  );
}

// ---------------------------------------------------------------------------
// 全局弹窗：确认、关联选择器
// ---------------------------------------------------------------------------

interface ConfirmRequest {
  plan: ExtPlan;
  resolve: (ok: boolean) => void;
}

export interface LinkPickerRequest {
  machineId: string;
  sessionIds: string[];
}

export interface WorkspacePanelRequest {
  machineId: string;
  cwd: string;
}

interface ExtUiState {
  confirm: ConfirmRequest | null;
  linkPicker: LinkPickerRequest | null;
  workspacePanel: WorkspacePanelRequest | null;
}

let uiState: ExtUiState = { confirm: null, linkPicker: null, workspacePanel: null };
const uiListeners = new Set<() => void>();

function setUi(patch: Partial<ExtUiState>): void {
  uiState = { ...uiState, ...patch };
  for (const l of uiListeners) l();
}

export function useExtUi(): ExtUiState {
  return useSyncExternalStore(
    (l) => {
      uiListeners.add(l);
      return () => uiListeners.delete(l);
    },
    () => uiState,
  );
}

export function requestConfirm(plan: ExtPlan): Promise<boolean> {
  // 同时只有一个确认：前一个视为取消
  uiState.confirm?.resolve(false);
  return new Promise((resolve) => setUi({ confirm: { plan, resolve } }));
}

export function settleConfirm(ok: boolean): void {
  const pending = uiState.confirm;
  setUi({ confirm: null });
  pending?.resolve(ok);
}

export function openLinkPicker(request: LinkPickerRequest): void {
  setUi({ linkPicker: request });
}

export function closeLinkPicker(): void {
  setUi({ linkPicker: null });
}

export function openWorkspacePanel(request: WorkspacePanelRequest): void {
  setUi({ workspacePanel: request });
}

export function closeWorkspacePanel(): void {
  setUi({ workspacePanel: null });
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

export interface ActionContext {
  machineId: string;
  /** 动作所在会话（插入 / 代发的目标） */
  sessionId?: string;
  /** 本地插入到输入框；不在会话页时为 undefined（插入类动作退化为复制） */
  insert?: (text: string) => void;
  refresh: () => void;
}

/** 执行一个视图动作（local 或 token） */
export function useExtAction(): (action: { local?: readonly ExtLocalEffect[]; token?: string; label: string }, ctx: ActionContext) => Promise<void> {
  const client = useClient();
  const navigate = useNavigate();

  const model = useTrine((s) => s.prefs.defaultModel);
  const permissionMode = useTrine((s) => s.prefs.defaultPermissionMode);
  const newSession = useMemo(() => ({ model, permissionMode }), [model, permissionMode]);

  return useCallback(
    async (action, ctx) => {
      if (client === null) return;
      // 结果回来时用户可能已经离开发起的页面（组件也可能已卸载）：看浏览器当前地址，
      // 迟到的跳转 / 插入不作用到别的页面
      const origin = window.location.pathname;
      const stillHere = (): boolean => window.location.pathname === origin;
      const apply = async (effects: readonly ExtLocalEffect[]): Promise<void> => {
        // 同一个动作的多段插入合成一次（逐段插入会被 React 合批成只剩最后一段）
        const inserts: string[] = [];
        await applyLocalEffects(effects, {
          insert: (text) => inserts.push(text),
          copy: copyWithToast,
          refresh: ctx.refresh,
        });
        if (inserts.length === 0) return;
        const text = inserts.join('\n');
        if (ctx.insert !== undefined && stillHere()) ctx.insert(text);
        else void copyWithToast(text);
      };
      if (action.local !== undefined && action.token === undefined) {
        await apply(action.local);
        return;
      }
      if (action.token === undefined) return;
      const outcome = await runTokenAction(action.token, {
        uuid: () => crypto.randomUUID(),
        newSessionDefaults: () => newSession,
        confirm: requestConfirm,
        prepare: (token, invocationId, ns) =>
          client.extRequest(ctx.machineId, { type: 'ext.action.prepare', token, invocationId, newSession: ns } as never, [
            'ext.action.plan',
            'ext.action.result',
          ]) as Promise<ExtActionPlanEvent | ExtActionResult>,
        commit: (planId, invocationId) =>
          client.extRequest(ctx.machineId, { type: 'ext.action.commit', planId, invocationId } as never, [
            'ext.action.result',
            'ext.action.plan',
          ]) as Promise<ExtActionResult>,
        cancel: (planId) => {
          client.extSend(ctx.machineId, { type: 'ext.action.cancel', planId } as never);
        },
      });
      if (outcome.kind === 'cancelled') return;
      if (outcome.kind === 'failed') {
        toast.error(
          outcome.code === 'unknown_outcome'
            ? `「${action.label}」没有收到结果（${outcome.message}），请稍后刷新确认是否已执行`
            : `「${action.label}」失败：${outcome.message}`,
        );
        return;
      }
      const result = outcome.result;
      if (result.sent?.queued === true) {
        client.adoptAgentSentInput(ctx.machineId, result.sent.targetSessionId, result.sent.clientMsgId, result.sent.text);
      }
      if (result.local !== undefined) await apply(result.local);
      if (result.message !== undefined) toast.success(result.message);
      ctx.refresh();
      if (result.createdSessionId !== undefined) {
        const path = `/s/${encodeURIComponent(ctx.machineId)}/${encodeURIComponent(result.createdSessionId)}`;
        if (stillHere()) navigate(path);
        else toast.success('新会话已建好', { action: { label: '打开', onClick: () => navigate(path) } });
      }
    },
    [client, navigate, newSession],
  );
}

async function copyWithToast(text: string): Promise<boolean> {
  try {
    await copyText(text);
    toast.success('已复制');
    return true;
  } catch (err) {
    toast.error(`复制失败：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 关联的增删（宿主界面上的手动关联） */
export async function updateLinks(
  client: TrineClient,
  machineId: string,
  sessionId: string,
  ext: string,
  change: { add?: { ref: string; label: string }[]; remove?: string[] },
): Promise<void> {
  const res = await client.extRequest(
    machineId,
    { type: 'session.links.update', targetSessionId: sessionId, ext, ...change } as never,
    ['session.links.update.response'],
  );
  if (!res.ok) throw new Error(res.error?.message ?? '关联失败');
}

export type { ExtPoint };
