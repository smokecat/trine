/**
 * zustand store：`TrineClient` 与 `LeaderElector` 的镜像 + 纯 UI 态。
 *
 * 用 vanilla `createStore` 而不是 React 版 `create`：store 可以在 bun test 里
 * 不带 React 构造与断言；React 侧用 `useStore(store, selector)` 订阅。
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { TrineClient } from '../lib/client.ts';
import type { LeaderElector } from '../lib/leader.ts';
import { defaultPrefs, timelineKey } from '../lib/storage.ts';
import type { Notice, TrineState } from './types.ts';

export type TrineStore = StoreApi<TrineState>;

export function createTrineStore(): TrineStore {
  return createStore<TrineState>()((set) => ({
    deviceId: null,
    connection: { status: 'idle', attempt: 0, nextRetryAt: null, lastCloseCode: null, lastError: null },
    queuedCount: 0,
    leader: { state: 'idle', instanceId: '', mode: 'locks' },
    machines: {},
    paired: false,
    serverUrl: null,
    sessions: {},
    doneAt: {},
    capabilities: {},
    syncing: {},
    timelines: {},
    drafts: {},
    setDraft: (key, text) => set((s) => ({ drafts: { ...s.drafts, [key]: text } })),
    attachmentDrafts: {},
    updateAttachmentDrafts: (key, update) =>
      set((s) => ({ attachmentDrafts: { ...s.attachmentDrafts, [key]: update(s.attachmentDrafts[key] ?? []) } })),
    prefs: defaultPrefs(),
    notices: [],
    droppedCount: 0,
    dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
  }));
}

/** 把 client 的当前快照与后续事件镜像进 store；返回解绑函数 */
export function bindClient(store: TrineStore, client: TrineClient, now: () => number = () => Date.now()): () => void {
  const snapshotAll = (): void => {
    const machines: TrineState['machines'] = {};
    for (const m of client.machines()) machines[m.machineId] = m;
    const sessions: TrineState['sessions'] = {};
    const timelines: TrineState['timelines'] = {};
    const capabilities: TrineState['capabilities'] = {};
    for (const [machineId, mp] of Object.entries(client.peer?.machines ?? {})) {
      sessions[machineId] = client.sessions(machineId);
      for (const sessionId of Object.keys(mp.sessions)) {
        const key = timelineKey(machineId, sessionId);
        timelines[key] = client.timeline(machineId, sessionId);
        const caps = client.capabilities(machineId, sessionId);
        if (caps) capabilities[key] = caps;
      }
    }
    store.setState({
      deviceId: client.deviceId,
      connection: client.connection,
      queuedCount: client.queuedCount,
      syncing: client.syncing,
      machines,
      paired: client.isPaired,
      serverUrl: client.peer?.serverUrl ?? null,
      sessions,
      timelines,
      capabilities,
      prefs: client.prefs,
    });
  };
  snapshotAll();

  const offs = [
    client.on('connection', (connection) => store.setState({ connection })),
    client.on('queue', (queuedCount) => store.setState({ queuedCount })),
    client.on('sync', (syncing) => store.setState({ syncing })),
    // 「已完成」本地叠加态：run.done 打标，重新开跑 / 致命错误 / 点进去看过即清
    client.on('event', (machineId, event) => {
      if (event.type !== 'run.done' && event.type !== 'run.state' && event.type !== 'error.fatal') return;
      if (event.sessionId === undefined) return; // 这三类都是会话级事件，理论上必有；防御机器级
      const key = timelineKey(machineId, event.sessionId);
      if (event.type === 'run.done') {
        store.setState((s) => ({ doneAt: { ...s.doneAt, [key]: now() } }));
      } else if (
        (event.type === 'run.state' && (event.state === 'running' || event.state === 'stopped' || event.state === 'error')) ||
        event.type === 'error.fatal'
      ) {
        store.setState((s) =>
          s.doneAt[key] === undefined ? s : (() => {
            const next = { ...s.doneAt };
            delete next[key];
            return { doneAt: next };
          })(),
        );
      }
    }),
    client.on('peer', () => snapshotAll()),
    client.on('machine', (machine) => store.setState((s) => ({ machines: { ...s.machines, [machine.machineId]: machine } }))),
    client.on('sessions', (machineId, sessions) => store.setState((s) => ({ sessions: { ...s.sessions, [machineId]: sessions } }))),
    client.on('timeline', (machineId, sessionId, timeline) =>
      store.setState((s) => ({ timelines: { ...s.timelines, [timelineKey(machineId, sessionId)]: timeline } })),
    ),
    client.on('capabilities', (machineId, sessionId, caps) =>
      store.setState((s) => ({ capabilities: { ...s.capabilities, [timelineKey(machineId, sessionId)]: caps } })),
    ),
    client.on('prefs', (prefs) => store.setState({ prefs })),
    // 撤回来编辑的消息放回输入框：输入框里已有字就放在前面，不覆盖用户正在写的
    client.on('restoreDraft', (machineId, sessionId, text) =>
      store.setState((s) => {
        const key = timelineKey(machineId, sessionId);
        const current = s.drafts[key] ?? '';
        return { drafts: { ...s.drafts, [key]: current.trim() === '' ? text : `${text}\n\n${current}` } };
      }),
    ),
    // 会话被永久删除：sessions 已由 'sessions' 事件同步，这里清掉按 key 镜像的几份
    client.on('sessionRemoved', (machineId, sessionId) =>
      store.setState((s) => {
        const key = timelineKey(machineId, sessionId);
        const { [key]: _tl, ...timelines } = s.timelines;
        const { [key]: _caps, ...capabilities } = s.capabilities;
        const { [key]: _draft, ...drafts } = s.drafts;
        const { [key]: _attachments, ...attachmentDrafts } = s.attachmentDrafts;
        const { [key]: _sync, ...syncing } = s.syncing;
        return { timelines, capabilities, drafts, attachmentDrafts, syncing };
      }),
    ),
    client.on('notice', (notice) => {
      if (notice.kind === 'dropped') {
        store.setState((s) => ({ droppedCount: s.droppedCount + 1 }));
        return;
      }
      const scope = 'scope' in notice ? notice.scope : '';
      const id = `${notice.kind}:${notice.machineId}:${scope}`;
      const item: Notice = { id, notice, at: now() };
      store.setState((s) => ({ notices: [...s.notices.filter((n) => n.id !== id), item] }));
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}

/** 镜像选举状态 */
export function bindLeader(store: TrineStore, elector: LeaderElector): void {
  store.setState({ leader: elector.snapshot() });
}
