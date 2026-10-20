/**
 * 聊天页（原型「会话」屏）——本应用的核心视图。
 *
 * 这里只做**组装与接线**，画面全在 `components/chat/**` 与
 * `components/composer/**`：
 *
 *   AppHead（标题 · 元信息行 → 设置 sheet · 机器 chip）
 *   Timeline（判别式渲染 + 自动跟随）
 *   HeartbeatFooter（运行中常驻）
 *   Composer（自增高 + / 菜单 + 发送/停止并存）
 *
 * ## 三个时钟
 *
 * 1. **1s tick**：驱动权限卡「已等待 N 秒」与心跳的本地插值。只在运行中或
 *    有 pending 权限时才跑——空闲会话挂一个空转的 interval 没有意义。
 * 2. **心跳快照 + receivedAt**：快照是权威，本地累加负责两帧之间的插值
 *    （见 heartbeat-model.ts）。用本地接收时刻而不是 agent 的 ts。
 * 3. **`requestedAt`**（agent 时钟）：权限等待时长的起点，方案 §5 如此定。
 *    两端时钟差会让这个数偏，heartbeat-model 里夹到了 ≥0（已知偏差见汇报）。
 *
 * ## 本机转录历史
 *
 * 服务端中转帧只覆盖「配对后、经 trine 跑过、7 天内」的 run。会话同步结束后
 * （`shouldAutoLoadHistory`）自动向 agent 要一页本机转录历史，前插到时间线开头；
 * 还有更早的就在顶部给「加载更早」。加载中 / 失败只在顶部一行轻提示。
 *
 * ## 回退
 *
 * 用户消息上的「回退到这里」→ RewindDialog（预览 + 选模式）→ `session.rewind`。
 * 只在 agent ≥ 0.9.0、机器在线、会话空闲且没有后台任务时给入口（agent 也会拒绝
 * busy）。时间线的截断由 agent 广播的 `session.rewound` 驱动；回退了对话且输入框
 * 为空时把原消息填回去，方便改了再发。
 *
 * ## `/status` `/mcp` 是本地信息卡
 *
 * 按需请求、不轮询（方案 §0 行 i：这类请求占 agent 的并发名额）。结果不进
 * 时间线（它不是会话内容），只活在本地 state 里，刷新即消失。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import type { McpServerStatus, PermissionMode, RewindMode } from '@trine/core';
import { AppHead } from '@/components/shell/AppHead.tsx';
import { ChipLabel, StatePill, StatusDot } from '@/components/shell/StatusDot.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { HistoryHead, InfoCard, type HistoryHeadState } from '@/components/chat/Messages.tsx';
import { HeartbeatFooter } from '@/components/chat/HeartbeatFooter.tsx';
import { BgTaskBar } from '@/components/chat/BgTaskBar.tsx';
import { Timeline, type TimelineHandlers } from '@/components/chat/Timeline.tsx';
import { lastEditable, PendingTray } from '@/components/chat/PendingTray.tsx';
import type { PendingActionKind } from '@/components/chat/entry-status.ts';
import { RewindDialog } from '@/components/chat/RewindDialog.tsx';
import { rewindDoneMessage } from '@/components/chat/rewind-model.ts';
import type { PermissionDecision } from '@/components/chat/PermissionCard.tsx';
import { heartbeatView } from '@/components/chat/heartbeat-model.ts';
import { resolvedAliasModel, shortModel } from '@/components/list/sorting.ts';
import { Composer } from '@/components/composer/Composer.tsx';
import { useAttachmentDrafts } from '@/components/composer/use-attachment-drafts.ts';
import { attachmentRefs, hasFiles } from '@/lib/attachment-model.ts';
import type { SlashItem } from '@/components/composer/slash-model.ts';
import {
  SessionSettingsSheet,
  type SessionSettingsActions,
  type SettingsSection,
} from '@/components/sheets/SessionSettingsSheet.tsx';
import { isPermissionMode } from '@/components/sheets/permission-mode.ts';
import { useListSessionsOnce, useNow } from '@/components/list/use-session-refresh.ts';
import { useSessionActions } from '@/components/list/use-session-actions.ts';
import { RenameDialog } from '@/components/list/RenameDialog.tsx';
import { SessionHeadMenu } from '@/components/chat/SessionHeadMenu.tsx';
import { SessionUsage } from '@/components/usage/PlanUsage.tsx';
import { supportsContextRefresh } from '@/components/usage/usage-model.ts';
import { composerOfflineHint } from '@/components/banners/conditions.ts';
import { useClient, useTrine } from '@/app/runtime.ts';
import {
  agentSupportsAttachments,
  agentSupportsBgTaskStop,
  agentSupportsHistory,
  agentSupportsPlanOptions,
  agentSupportsRewind,
  agentSupportsSubagentHistory,
  bgRunningCount,
  bgTasksStale,
  emptyTimeline,
  isPendingEntry,
  rewindTargetId,
  shouldAutoLoadHistory,
  type PermissionEntry,
  type TimelineEntry,
  type UserEntry,
} from '@/lib/reducer.ts';
import { timelineKey } from '@/lib/storage.ts';
import { formatCost } from '@/lib/format.ts';
import { waitingForOfTool } from '@/lib/waiting.ts';

type InfoCardState =
  | { kind: 'status'; rows: { label: string; value: string }[] }
  | { kind: 'mcp'; servers: McpServerStatus[] }
  | { kind: 'error'; message: string };

const MCP_STATE_LABEL: Record<McpServerStatus['state'], string> = {
  connected: '✓ 已连接',
  failed: '✗ 连接失败',
  needs_auth: '⚠ 需要认证',
};

export function ChatView(): React.JSX.Element {
  const { machineId = '', sessionId = '' } = useParams();
  const client = useClient();
  const key = timelineKey(machineId, sessionId);

  const timeline = useTrine((s) => s.timelines[key]) ?? emptyTimeline();
  const machine = useTrine((s) => s.machines[machineId]);
  /** 重置时间过了要改显示「已重置」，按分钟级节拍重渲染即可 */
  const usageNow = useNow(60_000);
  const meta = useTrine((s) => s.sessions[machineId]?.[sessionId]);
  const caps = useTrine((s) => s.capabilities[key]);
  const draft = useTrine((s) => s.drafts[key] ?? '');
  const syncing = useTrine((s) => s.syncing[key]);
  const setDraft = useTrine((s) => s.setDraft);
  const deviceId = useTrine((s) => s.deviceId);
  const prefs = useTrine((s) => s.prefs);

  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [infoCard, setInfoCard] = useState<InfoCardState | null>(null);
  // `/rename`（无参数）与头部「⋯ → 重命名」打开的对话框；动作来自
  // useSessionActions(machineId)——这台 agent 不支持（版本过旧）或从标签页时
  // 不给回调，斜杠菜单里连 /rename 都不出现、头部菜单也不渲染
  const sessionActions = useSessionActions(machineId);
  const { onRename } = sessionActions;
  const navigate = useNavigate();
  // 从归档视图点进来的（SessionRow 带 state.from）：返回 / 被删后跳回 /archived（评审 minor 9）
  const backTo = backTarget(useLocation().state);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameBusy, setRenameBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** 正在确认回退的目标用户消息（RewindDialog 打开中） */
  const [rewindTarget, setRewindTarget] = useState<UserEntry | null>(null);
  /** 历史拉取的本地进度（按会话 key 记，切会话不串） */
  const [historyLoad, setHistoryLoad] = useState<{ key: string; state: 'loading' | 'error'; message?: string } | null>(null);

  // 心跳快照的**本地**到达时刻：快照对象换了就重新计时
  const heartbeat = timeline.heartbeat;
  const receivedAtRef = useRef({ snapshot: heartbeat, at: Date.now() });
  if (receivedAtRef.current.snapshot !== heartbeat) {
    receivedAtRef.current = { snapshot: heartbeat, at: Date.now() };
  }

  useEffect(() => {
    if (!client || machineId === '' || sessionId === '') return;
    // 已永久删除（浏览器后退 / 书签深链回来）：client 拒绝打开，这里提示并跳回（评审 CM1）
    if (!client.openSession(machineId, sessionId)) {
      toast.info('会话已删除');
      navigate(backTo, { replace: true });
      return;
    }
    return () => client.closeSession(machineId, sessionId);
  }, [client, machineId, sessionId, navigate, backTo]);

  // 会话被永久删除（别的设备删的、或墓碑命中）：本地缓存 client 已清，这里跳回列表
  useEffect(() => {
    if (!client || machineId === '' || sessionId === '') return;
    return client.on('sessionRemoved', (m, s) => {
      if (m !== machineId || s !== sessionId) return;
      toast.info('该会话已被永久删除');
      navigate(backTo, { replace: true });
    });
  }, [client, machineId, sessionId, navigate, backTo]);

  // 打开会话时顺手拉一次机器的目录列表（设置 sheet 要用；机器离线就不发）
  useEffect(() => {
    if (!client || machineId === '' || machine?.online !== true || machine.cwd !== null) return;
    void client.request(machineId, { type: 'cwd.list.request' }).catch(() => {
      /* 拿不到就让 sheet 显示「正在读取…」，不打扰用户 */
    });
  }, [client, machineId, machine?.online, machine?.cwd]);

  // 直接开聊天页（刷新、或从推送点进来）而这个会话的 meta 还没有时补一次
  // session.list——头部的 cwd·model·mode 与设置 sheet 的当前值全靠它。
  //
  // 走与 Layout 同一套 TTL/去重判据（评审 M5）：早先这里是独立的一发，
  // 「agent 列表里已不存在的会话」meta 永远 undefined，机器每次 online
  // 翻转就再拉一次全量 listSessions。
  const listSessionsOnce = useListSessionsOnce();
  useEffect(() => {
    if (machineId === '' || machine?.online !== true || meta !== undefined) return;
    // 拿不到就退化成「会话设置 ▾」，不打扰用户（TTL 到期后自然再试一次）
    listSessionsOnce(machineId);
  }, [listSessionsOnce, machineId, machine?.online, meta]);

  const loadHistory = useCallback(
    (older: boolean) => {
      if (!client || machineId === '' || sessionId === '') return;
      setHistoryLoad({ key, state: 'loading' });
      client
        .loadHistory(machineId, sessionId, { older })
        .then(() => setHistoryLoad((cur) => (cur?.key === key ? null : cur)))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setHistoryLoad((cur) => (cur?.key === key ? { key, state: 'error', message } : cur));
        });
    },
    [client, machineId, sessionId, key],
  );

  // 同步结束后自动要一页本机历史（每条时间线一次：拉过就记在 timeline.history 上）。
  // 失败不自动重试（避免对离线/出错的 agent 空转），顶部给「重试」；机器上下线
  // 翻转会让依赖变化、自然再试一次
  // （失败后依赖不变、effect 不会再跑，所以不会空转）
  const autoLoad = shouldAutoLoadHistory({ timeline, syncing, machine });
  useEffect(() => {
    if (!autoLoad) return;
    loadHistory(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在判据翻转时触发
  }, [autoLoad, key, machine?.online]);

  // 打开会话时补拉斜杠命令清单：不必等 sync（agent 不拉起会话、只按 cwd 探测）。
  // 判据（在线 / agent ≥ 0.5.0 / 还没有命令）在 client.loadCommands 里；
  // 失败静默——菜单退化成只有会话控制命令，首条消息后 init 自然补上
  const agentVersion = machine?.info?.agentVersion;
  useEffect(() => {
    if (!client || machineId === '' || sessionId === '' || machine?.online !== true) return;
    void client.loadCommands(machineId, sessionId).catch(() => {});
  }, [client, machineId, sessionId, machine?.online, agentVersion]);

  const pendingPermission = useMemo(
    () =>
      timeline.entries.find(
        (e): e is PermissionEntry => e.kind === 'permission' && e.state === 'pending',
      ),
    [timeline.entries],
  );

  const running = timeline.state === 'running' || timeline.state === 'waiting_permission';
  // 在等什么：时间线上最早一条 pending 的工具为准；时间线里没有（历史未加载等）
  // 退回 agent 给的 meta.waitingFor（旧 agent 不带 → 按普通权限）
  const waitingFor =
    pendingPermission !== undefined ? waitingForOfTool(pendingPermission.toolName) : meta?.waitingFor;

  // 1s tick：只在需要走秒时才挂。
  //
  // 「有条目正在撤回中」也算（评审 C-2）：运行结束后的空闲会话里点撤回，
  // 早先 `running || pendingPermission` 两条都不成立、没有任何东西触发重渲染，
  // 「撤回中…」的角标 5s 后不会自己变。终态迁移本身由 client 的结算定时器
  // 做（不依赖有没有人在看这个会话），这里只是让角标跟着走秒。
  const hasRecalling = timeline.entries.some((e) => e.kind === 'user' && e.recallingAt !== undefined);
  // 后台任务在跑：条上的「运行中 N 秒」要走秒。时间线里有快照以它为准（agent
  // 变化即发全量），没有（刷新后、或还没收到过）退回列表 meta 的 bgRunning
  const bgTasks = timeline.bgTasks;
  // agent 重启 / 崩溃后落盘快照里的 running 已陈旧：按 agent 权威的 meta.bgRunning 对账（评审 M2）
  const bgStale = bgTasksStale({ bgTasks, meta, agentVersion: machine?.info?.agentVersion });
  const bgRunning = bgTasks === undefined ? (meta?.bgRunning ?? 0) : bgStale ? 0 : bgRunningCount(bgTasks);
  const needsTick = running || pendingPermission !== undefined || hasRecalling || bgRunning > 0;
  useEffect(() => {
    if (!needsTick) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [needsTick]);

  const hbView = useMemo(
    () =>
      heartbeat === null
        ? null
        : heartbeatView(
            heartbeat,
            receivedAtRef.current.at,
            now,
            pendingPermission?.requestedAt ?? null,
            waitingFor,
          ),
    [heartbeat, now, pendingPermission, waitingFor],
  );

  // ---------------------------------------------------------------------
  // 动作
  // ---------------------------------------------------------------------

  const attach = useAttachmentDrafts(key);
  const attachDisabledReason = agentSupportsAttachments(machine?.info?.agentVersion)
    ? undefined
    : machine?.info === undefined
      ? '还不知道这台 agent 的版本，暂时不能添加附件'
      : '这台 agent 版本过旧（需要 0.11.0 以上），不支持附件';

  const send = useCallback(
    (text: string) => {
      if (!client) return;
      client.sendInput(machineId, sessionId, text, attach.take());
      setDraft(key, '');
    },
    [client, machineId, sessionId, key, setDraft, attach],
  );

  // 拖拽文件到页面任意位置：显示遮罩，松手即加为附件。计数器配对 enter/leave
  // （进出子元素也会触发），只认带文件的拖拽（拖选中的文字不算）
  const [dragging, setDragging] = useState(false);
  const addAttachments = attach.add;
  useEffect(() => {
    let depth = 0;
    const onEnter = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer?.types)) return;
      e.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const onOver = (e: DragEvent): void => {
      // 不 preventDefault 浏览器就不认这是落点，松手会直接打开文件
      if (hasFiles(e.dataTransfer?.types)) e.preventDefault();
    };
    const onLeave = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer?.types)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer?.types)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (attachDisabledReason !== undefined) {
        toast.error(attachDisabledReason);
        return;
      }
      addAttachments(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [addAttachments, attachDisabledReason]);

  // 还没进入对话的本设备消息进输入框上方的托盘，其余照常进时间线（reducer isPendingEntry）
  const [timelineEntries, pendingEntries] = useMemo(() => {
    const shown: TimelineEntry[] = [];
    const pending: UserEntry[] = [];
    for (const e of timeline.entries) {
      if (isPendingEntry(e, running)) pending.push(e);
      else shown.push(e);
    }
    return [pending.length === 0 ? timeline.entries : shown, pending] as const;
  }, [timeline.entries, running]);

  const onPendingAction = useCallback(
    (action: PendingActionKind, entry: UserEntry) => {
      if (!client) return;
      const edit = action === 'edit';
      switch (action) {
        case 'edit':
        case 'recall':
          if (entry.status === 'queued') client.recallQueued(machineId, sessionId, entry.id, { edit });
          else if (entry.status === 'parked') client.recallParked(machineId, sessionId, entry.id);
          else client.discardPending(machineId, sessionId, entry.id, { edit });
          break;
        case 'resend':
          client.resendPending(machineId, sessionId, entry.id);
          break;
        case 'discard':
          client.discardPending(machineId, sessionId, entry.id);
          break;
      }
    },
    [client, machineId, sessionId],
  );

  const editLastPending = useCallback((): boolean => {
    const target = lastEditable(pendingEntries);
    if (target === undefined) return false;
    onPendingAction('edit', target);
    return true;
  }, [pendingEntries, onPendingAction]);

  const handlers: TimelineHandlers = useMemo(
    () => ({
      onUserAction: (action, entry) => {
        if (!client) return;
        switch (action) {
          case 'recall_parked':
            client.recallParked(machineId, sessionId, entry.id);
            break;
          case 'recall_queued':
            client.recallQueued(machineId, sessionId, entry.id);
            break;
          case 'retry':
            client.retryInput(machineId, sessionId, entry.id);
            break;
          case 'resend':
            // expired / cancelled 的条目已是终态，只能以新 clientMsgId 重发（旧条目随之删掉）
            if (!client.resendPending(machineId, sessionId, entry.id)) {
              client.sendInput(machineId, sessionId, entry.text, attachmentRefs(entry));
            }
            break;
        }
      },
      onRespondPermission: (requestId, decision: PermissionDecision) => {
        client?.respondPermission(machineId, sessionId, requestId, decision.verdict, {
          ...(decision.updatedInput === undefined ? {} : { updatedInput: decision.updatedInput }),
          ...(decision.remember === undefined ? {} : { remember: decision.remember }),
          ...(decision.message === undefined ? {} : { message: decision.message }),
          ...(decision.setMode === undefined ? {} : { setMode: decision.setMode }),
        });
      },
      onResumeAt: (at) => {
        client?.send(machineId, { type: 'run.resumeAt', sessionId, at });
      },
      onStop: () => client?.stopRun(machineId, sessionId),
      onOpenAttachment: (entry, index) =>
        client === null
          ? Promise.reject(new Error('还没准备好'))
          : client.openAttachment(machineId, sessionId, entry.id, index),
      attachmentUrl: (blobId) => client?.attachmentUrl(blobId),
      onLoadSubagentHistory: (toolUseId) =>
        client ? client.loadSubagentHistory(machineId, sessionId, toolUseId) : Promise.reject(new Error('未连接')),
    }),
    [client, machineId, sessionId],
  );

  // 回退入口：条件不满足时不给回调，用户消息上就不出按钮（见文件头「回退」）
  const canRewind =
    client !== null &&
    machine?.online === true &&
    agentSupportsRewind(machine.info?.agentVersion) &&
    !running &&
    bgRunning === 0;
  const openRewind = useCallback((entry: UserEntry) => setRewindTarget(entry), []);
  const rewindId = rewindTarget === null ? undefined : rewindTargetId(rewindTarget);
  const loadRewindPreview = useCallback(() => {
    if (!client || rewindId === undefined) return Promise.reject(new Error('未连接'));
    return client.previewRewind(machineId, sessionId, rewindId);
  }, [client, machineId, sessionId, rewindId]);
  const confirmRewind = useCallback(
    async (mode: RewindMode) => {
      if (!client || rewindId === undefined || rewindTarget === null) throw new Error('未连接');
      const result = await client.rewind(machineId, sessionId, rewindId, mode);
      const prefill = mode !== 'code' && draft.trim() === '';
      if (prefill) setDraft(key, result.text ?? rewindTarget.text);
      setRewindTarget(null);
      toast.success(rewindDoneMessage(result, mode, prefill));
    },
    [client, machineId, sessionId, rewindId, rewindTarget, draft, key, setDraft],
  );

  const stopBgTask = useCallback(
    (taskId: string) => {
      if (!client) return;
      // 应答复用 session.mutate.response：拒绝（not_found / io）会 reject
      client.stopBgTask(machineId, sessionId, taskId).catch((err: unknown) => {
        toast.error(`停止后台任务失败：${err instanceof Error ? err.message : String(err)}`);
      });
    },
    [client, machineId, sessionId],
  );

  // 头部 ctx 手动刷新（agent ≥ 0.13.0）：新值随 session.updated 到；这里只提示失败
  const canRefreshContext = client !== null && meta !== undefined && supportsContextRefresh(machine?.info);
  const refreshContext = useCallback(async (): Promise<void> => {
    if (!client) return;
    try {
      const res = await client.refreshContext(machineId, sessionId);
      if (!res.ok) toast.error(`刷新上下文用量失败：${res.error?.message ?? '未知原因'}`);
    } catch (err) {
      toast.error(`刷新上下文用量失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [client, machineId, sessionId]);

  const requestStatus = useCallback(() => {
    if (!client) return;
    setInfoCard(null);
    client
      .request(machineId, { type: 'session.status.request', sessionId })
      .then((res) => {
        if (res.type !== 'session.status.response') return;
        setInfoCard({
          kind: 'status',
          rows: [
            { label: '模型', value: res.model === '' ? '默认' : res.model },
            { label: '工作目录', value: res.cwd },
            { label: '权限模式', value: res.permissionMode },
            { label: '本会话成本', value: formatCost(res.costUsd) },
            {
              label: '上下文',
              value:
                res.contextLimitTokens === 0
                  ? '暂无数据（每轮结束后更新，也可点头部的 ctx 刷新）'
                  : `${res.contextUsedTokens.toLocaleString()} / ${res.contextLimitTokens.toLocaleString()} tokens`,
            },
            {
              label: 'agent',
              value: `${res.agentVersion} · claude ${res.claudeVersion} · ${machine?.name ?? machineId}`,
            },
          ],
        });
      })
      .catch((err: unknown) => {
        setInfoCard({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      });
  }, [client, machineId, sessionId, machine?.name]);

  const requestMcp = useCallback(() => {
    if (!client) return;
    setInfoCard(null);
    client
      .request(machineId, { type: 'mcp.status.request', sessionId })
      .then((res) => {
        if (res.type !== 'mcp.status.response') return;
        setInfoCard({ kind: 'mcp', servers: res.servers });
      })
      .catch((err: unknown) => {
        setInfoCard({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      });
  }, [client, machineId, sessionId]);

  const settingsActions: SessionSettingsActions = useMemo(
    () => ({
      setModel: (model) => client?.send(machineId, { type: 'session.setModel', sessionId, model }),
      setPermissionMode: (mode) =>
        client?.send(machineId, { type: 'session.setPermissionMode', sessionId, mode }),
      setCwd: (cwd) => client?.send(machineId, { type: 'session.setCwd', sessionId, cwd }),
      addCwd: (path) => client?.send(machineId, { type: 'cwd.add', path }),
      removeCwd: (path) => client?.send(machineId, { type: 'cwd.remove', path }),
      setDefaultCwd: (path) => client?.send(machineId, { type: 'cwd.setDefault', path }),
      requestStatus,
      resetScopeCursor: () => client?.resetScopeCursor(machineId, sessionId),
      resetOutSeq: () => client?.resetOutSeq(machineId, sessionId),
    }),
    [client, machineId, sessionId, requestStatus],
  );

  const openSettings = useCallback((section: SettingsSection | null) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);

  const onSlashPick = useCallback(
    (item: SlashItem) => {
      const action = item.action;
      switch (action.kind) {
        case 'sheet':
          setDraft(key, '');
          openSettings(action.section);
          break;
        case 'status':
          setDraft(key, '');
          requestStatus();
          break;
        case 'mcp':
          setDraft(key, '');
          requestMcp();
          break;
        case 'apply':
          setDraft(key, '');
          if (action.command === 'model') settingsActions.setModel(action.arg);
          else if (action.command === 'cwd') settingsActions.setCwd(action.arg);
          else if (isPermissionMode(action.arg)) {
            // bypass 不许从命令行一步到位——两击确认在 sheet 里
            if (action.arg === 'bypassPermissions') openSettings('permission');
            else settingsActions.setPermissionMode(action.arg);
          } else {
            openSettings('permission');
          }
          break;
        case 'rename':
          setDraft(key, '');
          if (action.title === '') setRenameOpen(true);
          else void Promise.resolve(onRename?.(machineId, sessionId, action.title)).catch(() => {});
          break;
        case 'send':
          send(action.text);
          break;
        case 'fill':
          setDraft(key, action.text);
          break;
      }
    },
    [key, setDraft, openSettings, requestStatus, requestMcp, settingsActions, send, onRename, machineId, sessionId],
  );

  // ---------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------

  if (machineId === '' || sessionId === '') return <MissingSession />;

  // 心跳里的当前工具：id 取自快照，耗时取插值后的值。
  //
  // **两个 primitive 而不是一个对象**（评审 N4）：对象字面量每次渲染都是新
  // 引用，`Timeline` 把它传给每一个 `Entry` 时会把 `memo` 的浅比较全部打穿。
  // 而 ChatView 的 1s tick 恰恰只在 `running || pendingPermission` 时才挂
  // ——也就是说，m4 想优化的那个场景（有工具在跑）里 500 条时间线每秒整表
  // 重画，`now={needsTick(entry) ? now : 0}` 那层用心被完全旁路。
  const runningToolId =
    heartbeat?.currentTool !== undefined && hbView?.currentTool != null
      ? heartbeat.currentTool.toolUseId
      : null;
  const runningElapsedMs = hbView?.currentTool?.elapsedMs ?? 0;

  // capabilities.models 是别名解析后的具体 ID，不当候选（否则预置别名旁边又冒出具体版本）
  const knownModels = Array.from(
    new Set([...prefs.knownModels, ...(meta !== undefined && meta.model !== '' ? [meta.model] : [])]),
  );
  const resolvedModel = meta === undefined ? undefined : resolvedAliasModel(meta.model, caps?.models);
  const offline = machine !== undefined && machine.online === false;
  const emptyAndSyncing = timeline.entries.length === 0 && syncing !== undefined;

  const historyHead: HistoryHeadState =
    historyLoad?.key === key
      ? historyLoad.state === 'loading'
        ? { kind: 'loading' }
        : { kind: 'error', message: historyLoad.message ?? '未知错误' }
      : timeline.history?.hasMore === true && agentSupportsHistory(machine?.info?.agentVersion)
        ? { kind: 'more' }
        : { kind: 'none' };

  return (
    <>
      <AppHead
        back={backTo}
        title={meta?.title !== undefined && meta.title !== '' ? meta.title : sessionId.slice(0, 8)}
        meta={
          <span className="flex min-w-0 items-baseline gap-2.5">
            <button
              type="button"
              data-testid="session-meta"
              className="hover:text-text-2 min-w-0 truncate text-left transition-colors"
              onClick={() => openSettings(null)}
              title="会话设置：模型 / 权限模式 / 工作目录"
            >
              {meta === undefined
                ? '会话设置 ▾'
                : `${cwdTail(meta.cwd)} · ${shortModel(meta.model)} · ${meta.permissionMode} ▾`}
            </button>
            <SessionUsage
              context={meta?.context}
              rateLimits={machine?.info?.rateLimits}
              now={usageNow}
              onRefreshContext={canRefreshContext ? refreshContext : undefined}
            />
          </span>
        }
        right={
          <div className="flex shrink-0 items-center gap-1.5">
            {timeline.state !== null && <StatePill state={timeline.state} waitingFor={waitingFor} />}
            {/* 空闲但还有后台任务在跑：弱提示，不显示成运行中 */}
            {!running && bgRunning > 0 && (
              <span data-testid="bg-running-chip">
                <ChipLabel title="子进程里还有后台任务在跑">后台 {bgRunning}</ChipLabel>
              </span>
            )}
            <ChipLabel>
              <StatusDot tone={machine?.online === true ? 'on' : 'off'} />
              {machine?.name ?? machineId}
            </ChipLabel>
            <SessionHeadMenu
              machineId={machineId}
              sessionId={sessionId}
              meta={meta}
              actions={sessionActions}
              onRequestRename={() => setRenameOpen(true)}
            />
          </div>
        }
      />

      {emptyAndSyncing ? (
        <TimelineSkeleton />
      ) : (
        <Timeline
          entries={timelineEntries}
          syncing={syncing}
          deviceId={deviceId}
          now={now}
          runningToolId={runningToolId}
          runningElapsedMs={runningElapsedMs}
          handlers={handlers}
          planOptions={agentSupportsPlanOptions(machine?.info?.agentVersion)}
          // machine.info 还没到时不下「版本过旧」的结论（评审 m4）
          subagentHistory={machine?.info == null ? null : agentSupportsSubagentHistory(machine.info.agentVersion)}
          onRewind={canRewind ? openRewind : undefined}
          head={
            <HistoryHead
              state={historyHead}
              onLoadMore={() => loadHistory(true)}
              // 首页就失败时 history 还没记上，重试即重拉首页；翻页失败则重试翻页
              onRetry={() => loadHistory(timeline.history !== undefined)}
            />
          }
          extra={
            infoCard !== null && (
              <InfoCardSlot card={infoCard} onDismiss={() => setInfoCard(null)} />
            )
          }
        />
      )}

      {bgTasks !== undefined && bgTasks.length > 0 && (
        <BgTaskBar
          tasks={bgTasks}
          now={now}
          stale={bgStale}
          canStop={agentSupportsBgTaskStop(machine?.info?.agentVersion)}
          onStop={stopBgTask}
        />
      )}
      {running && hbView !== null && <HeartbeatFooter view={hbView} />}

      <Composer
        value={draft}
        onChange={(text) => setDraft(key, text)}
        onSend={send}
        onStop={() => client?.stopRun(machineId, sessionId)}
        onSlashPick={onSlashPick}
        running={running}
        // 离线提示只此一处（评审 m6）：会话页里同屏两条同义提示（顶部横幅 +
        // 这一条）。留贴着输入行为的这条，顶部横幅在会话页不再出；排队数并进来，
        // 免得两处各说一半
        offlineHint={offline ? composerOfflineHint(machine) : null}
        sources={{
          slashCommands: caps?.slashCommands ?? [],
          ...(onRename === undefined ? { unavailable: ['rename'] as const } : {}),
        }}
        snippets={prefs.promptSnippets}
        onManageSnippets={() => navigate('/settings')}
        sendKey={prefs.sendKey}
        pending={pendingEntries.length > 0 ? <PendingTray entries={pendingEntries} onAction={onPendingAction} /> : undefined}
        onEditLast={editLastPending}
        attachments={{
          drafts: attach.drafts,
          ready: attach.ready,
          onAdd: attach.add,
          onRemove: attach.remove,
          onRetry: attach.retry,
          disabledReason: attachDisabledReason,
        }}
      />

      {dragging && (
        <div
          data-testid="drop-overlay"
          className="bg-background/80 border-brand pointer-events-none fixed inset-3 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed"
        >
          <div className="text-text text-[15px]">
            {attachDisabledReason ?? '松手添加为附件'}
          </div>
        </div>
      )}

      <RewindDialog
        open={rewindTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRewindTarget(null);
        }}
        messageText={rewindTarget?.text ?? ''}
        loadPreview={loadRewindPreview}
        onConfirm={confirmRewind}
      />

      <SessionSettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        section={settingsSection}
        meta={meta}
        knownModels={knownModels}
        resolvedModel={resolvedModel}
        cwd={machine?.cwd ?? null}
        actions={settingsActions}
      />

      {onRename !== undefined && (
        <RenameDialog
          open={renameOpen}
          onOpenChange={(open) => {
            if (!renameBusy) setRenameOpen(open);
          }}
          initialTitle={meta?.title ?? ''}
          busy={renameBusy}
          onSubmit={(title) => {
            const result = onRename(machineId, sessionId, title);
            if (!(result instanceof Promise)) {
              setRenameOpen(false);
              return;
            }
            setRenameBusy(true);
            result.then(
              () => {
                setRenameBusy(false);
                setRenameOpen(false);
              },
              () => setRenameBusy(false),
            );
          }}
        />
      )}
    </>
  );
}

function InfoCardSlot({
  card,
  onDismiss,
}: {
  card: InfoCardState;
  onDismiss: () => void;
}): React.JSX.Element {
  if (card.kind === 'status') {
    return (
      <InfoCard
        title="会话状态"
        rows={card.rows}
        foot="本地即时渲染——数据来自 agent 的状态上报，不往返 Claude、不产生成本"
        onDismiss={onDismiss}
      />
    );
  }
  if (card.kind === 'mcp') {
    return (
      <InfoCard
        title="MCP 服务器"
        rows={
          card.servers.length === 0
            ? [{ label: '—', value: '该会话没有配置 MCP 服务器' }]
            : card.servers.map((s) => ({
                label: s.name,
                value: `${MCP_STATE_LABEL[s.state]} · ${s.toolCount} tools`,
              }))
        }
        foot="来自 agent 的 system/init 能力上报"
        onDismiss={onDismiss}
      />
    );
  }
  return (
    <InfoCard
      title="请求失败"
      rows={[{ label: '原因', value: card.message }]}
      foot="机器离线或 agent 忙时会失败，稍后重试"
      onDismiss={onDismiss}
    />
  );
}

function TimelineSkeleton(): React.JSX.Element {
  return (
    <div data-testid="timeline-skeleton" className="flex min-h-0 flex-1 flex-col gap-3 px-3.5 py-3.5">
      <div className="text-text-3 self-center text-xs">
        <span className="motion-safe:animate-pulse">正在同步历史…</span>
      </div>
      <Skeleton className="h-9 w-[55%] self-end rounded-[14px]" />
      <Skeleton className="h-16 w-[85%] rounded-lg" />
      <Skeleton className="h-9 w-full rounded-xl" />
      <Skeleton className="h-12 w-[70%] rounded-lg" />
    </div>
  );
}

function MissingSession(): React.JSX.Element {
  return (
    <>
      <AppHead back="/" title="会话不存在" />
      <div className="text-text-3 flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center text-sm">
        没有找到这个会话——它可能已被 agent 清理。
        <Button variant="outline" size="sm" onClick={() => history.back()}>
          返回
        </Button>
      </div>
    </>
  );
}

/** location.state 里的来源 → 返回目标。只认白名单，别让任意 state 决定跳转 */
function backTarget(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  return from === '/archived' ? '/archived' : '/';
}

/** 头部元信息行只放目录尾段——完整路径在设置 sheet 里 */
function cwdTail(cwd: string): string {
  if (cwd === '') return '默认目录';
  const parts = cwd.split('/').filter((p) => p !== '');
  return parts.length <= 1 ? cwd : `…/${parts.slice(-1)[0] ?? ''}`;
}

