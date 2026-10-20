/**
 * 机器详情（原型「机器」屏的展开态，方案 §5「机器」）：
 * 信息 → 改名 → Claude（更新，agent >= 0.4.0）→ 会话 → 高级（重置游标）→ 从本设备移除。
 *
 * 三个动作的语义边界要写在界面上，否则用户会误解：
 * - **改名**走 `machine.rename`，是 agent 端的名字，其它设备也会变（乐观更新）；
 * - **重置本机所有会话游标**是「服务端序号被重置」后的恢复手段（方案 §4.3
 *   游标倒退探测的手动版），会清掉本地时间线重新同步；
 * - **从本设备移除**只删本地（agent 未实现 `machine.unpair`，方案 §0 行 k），
 *   必须明说 agent 侧仍保留配对记录，否则用户以为已经解绑了。
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Separator } from '@/components/ui/separator.tsx';
import { AppHead } from '@/components/shell/AppHead.tsx';
import { StatusDot } from '@/components/shell/StatusDot.tsx';
import { ConfirmDialog } from '@/components/machines/ConfirmDialog.tsx';
import { ClaudeUpdateSection } from '@/components/machines/ClaudeUpdateSection.tsx';
import { supportsClaudeUpdate } from '@/components/machines/claude-update.ts';
import {
  machineHeartbeatLine,
  machinePlatformLine,
  machineTone,
  machineVersionLine,
  parkedWarnLine,
} from '@/components/machines/machine-text.ts';
import { SessionList } from '@/components/list/SessionList.tsx';
import { countActiveSessions, countLiveSessions, liveSessionsLine } from '@/components/list/sorting.ts';
import { countArchived, DEFAULT_LIST_QUERY, type ListQuery } from '@/components/list/filtering.ts';
import { useNow } from '@/components/list/use-session-refresh.ts';
import { useSessionActions } from '@/components/list/use-session-actions.ts';
import { useListShowTemp } from '@/components/list/use-list-query.ts';
import { useClient, useTrine } from '@/app/runtime.ts';

export function MachineDetailView(): React.JSX.Element {
  const { machineId = '' } = useParams();
  const client = useClient();
  const navigate = useNavigate();
  const machine = useTrine((s) => s.machines[machineId]);
  const machines = useTrine((s) => s.machines);
  const sessions = useTrine((s) => s.sessions);
  const now = useNow();
  const sessionActions = useSessionActions();
  const [name, setName] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  // 稳定引用：SessionList 内 useMemo 以 query 为依赖，每次渲染新建对象会让它失效（评审 minor 7）。
  // 放在早退之前（hooks 规则）
  const [showTemp, setShowTemp] = useListShowTemp();
  const listQuery: ListQuery = useMemo(
    () => ({ ...DEFAULT_LIST_QUERY, machine: machineId, groupBy: 'none', showTemp }),
    [machineId, showTemp],
  );

  if (!machine) {
    return (
      <>
        <AppHead back="/machines" backOnDesktop title="机器" />
        <p className="text-text-3 p-10 text-center text-sm">
          没有这台机器（可能已从本设备移除）。
        </p>
      </>
    );
  }

  const draft = name ?? machine.name;
  const platform = machinePlatformLine(machine.info);
  const warn = parkedWarnLine(machine.parkedCount);
  const activeCount = countActiveSessions(sessions[machine.machineId]);
  const live = liveSessionsLine(countLiveSessions(sessions[machine.machineId]), machine.info?.maxSessions);
  // 计数与列表都不含已归档（session-list-v2 §4.5，评审 M4）；归档数单独标出
  const archivedCount = countArchived(sessions, machine.machineId);
  const totalCount = Object.keys(sessions[machine.machineId] ?? {}).length - archivedCount;

  return (
    <>
      <AppHead
        back="/machines"
        backOnDesktop
        title={machine.name}
        meta={machine.machineId}
        right={<StatusDot tone={machineTone(machine.online)} />}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          <dt className="text-text-3">状态</dt>
          <dd className="tabular" data-testid="detail-heartbeat">
            {machineHeartbeatLine(machine.online, machine.lastSeenAt, now)}
          </dd>
          <dt className="text-text-3">平台</dt>
          <dd className="font-mono text-xs">{platform === '' ? '未知' : platform}</dd>
          <dt className="text-text-3">版本</dt>
          <dd className="font-mono text-xs" data-testid="detail-versions">
            {machineVersionLine(machine.info)}
          </dd>
          <dt className="text-text-3">会话</dt>
          <dd>
            {totalCount} 个
            {activeCount > 0 && <span className="text-brand-ink"> · {activeCount} 个活跃</span>}
            {archivedCount > 0 && <span className="text-text-3"> · 另有 {archivedCount} 个已归档</span>}
          </dd>
          {live !== '' && (
            <>
              <dt className="text-text-3">子进程</dt>
              <dd className="tabular" data-testid="detail-live">
                {live.replace('子进程 ', '')}
              </dd>
            </>
          )}
          {warn !== '' && (
            <>
              <dt className="text-text-3">排队</dt>
              <dd className="text-amber">📮 {warn}</dd>
            </>
          )}
          {machine.cwd && (
            <>
              <dt className="text-text-3">默认目录</dt>
              <dd className="font-mono text-xs break-all">{machine.cwd.defaultCwd || '—'}</dd>
            </>
          )}
        </dl>

        {machine.lastError && (
          <div className="border-red bg-red-soft text-red rounded-[12px] border px-3 py-2 text-xs">
            ⚠ 机器级错误（{machine.lastError.kind}）：{machine.lastError.message}
          </div>
        )}

        <Separator />

        <section className="flex flex-col gap-2">
          <h2 className="font-medium">改名</h2>
          <p className="text-text-3 text-xs">
            会同步到 agent（machine.rename），其它客户端设备也会看到新名字。
          </p>
          <div className="flex gap-2">
            <Input
              data-testid="rename-input"
              value={draft}
              onChange={(e) => setName(e.target.value)}
              className="font-mono"
            />
            <Button
              data-testid="rename-save"
              disabled={draft.trim() === '' || draft.trim() === machine.name}
              onClick={() => {
                client?.renameMachine(machine.machineId, draft.trim());
                setName(null);
                toast.success(`已改名为 ${draft.trim()}`);
              }}
            >
              保存
            </Button>
          </div>
        </section>

        {client && supportsClaudeUpdate(machine.info) && (
          <>
            <Separator />
            <ClaudeUpdateSection
              machineName={machine.name}
              online={machine.online}
              claudeVersion={machine.info?.claudeVersion}
              update={() => client.updateClaude(machine.machineId)}
            />
          </>
        )}

        <Separator />

        <section className="flex flex-col gap-2">
          <h2 className="font-medium">这台机器上的会话</h2>
          <SessionList
            sessions={sessions}
            machines={machines}
            query={listQuery}
            actions={sessionActions}
            onShowTemp={setShowTemp}
            variant="compact"
            now={now}
          />
        </section>

        <Separator />

        <section className="flex flex-col gap-2">
          <h2 className="font-medium">高级</h2>
          <p className="text-text-3 text-xs">
            服务端库被删/重建后，旧游标会把新消息当成重放丢弃（症状：agent
            在线、连接正常，但回复一条都不显示）。重置后会清空本地时间线并重新同步。
          </p>
          <Button
            variant="outline"
            className="w-fit"
            data-testid="reset-cursors"
            onClick={() => setConfirmReset(true)}
          >
            重置本机所有会话游标
          </Button>
        </section>

        <Separator />

        <section className="border-red/40 flex flex-col gap-2 rounded-[14px] border p-3">
          <h2 className="text-red font-medium">从本设备移除</h2>
          <p className="text-text-3 text-xs">
            只清除<strong>本设备</strong>的本地记录（密钥、时间线、游标）。
            agent 侧仍保留配对记录——要彻底解绑需要在那台机器上操作。
          </p>
          <Button
            variant="destructive"
            className="w-fit"
            data-testid="forget-machine"
            onClick={() => setConfirmForget(true)}
          >
            从本设备移除…
          </Button>
        </section>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        testId="confirm-reset-cursors"
        title={`重置 ${machine.name} 的全部游标？`}
        description={
          <>
            <p>本机器级事件流与它名下每个会话的同步游标都会归零，本地时间线清空后重新拉取。</p>
            <p>服务端留存窗口有限（每子流 2000 帧），更早的历史拉不回来。</p>
          </>
        }
        confirmLabel="重置并重新同步"
        onConfirm={() => {
          // 交给 lib 一次做完：它能看到 peer.sessions ∪ 已加载时间线 ∪ 打开的
          // 会话的并集，而 store 里的 `sessions` 在这个按钮的适用场景下可能不全
          const count = client?.resetMachineCursors(machine.machineId) ?? 0;
          setConfirmReset(false);
          toast.success(`已重置 ${count} 条流的游标，正在重新同步`);
        }}
      />

      <ConfirmDialog
        open={confirmForget}
        onOpenChange={setConfirmForget}
        testId="confirm-forget"
        busy={busy}
        title={`从本设备移除 ${machine.name}？`}
        description={
          <>
            <p>本设备保存的密钥、全部会话历史与同步游标会被删除，且无法恢复。</p>
            <p>
              <strong>agent 侧仍保留配对记录</strong>
              ——要重新使用这台机器，在它上面重新出配对码再扫一次即可。
            </p>
          </>
        }
        confirmLabel="移除"
        onConfirm={() => {
          setBusy(true);
          void client
            ?.forgetMachine(machine.machineId)
            .then(() => {
              toast.success(`已从本设备移除 ${machine.name}`);
              navigate('/machines');
            })
            .finally(() => {
              setBusy(false);
              setConfirmForget(false);
            });
        }}
      />
    </>
  );
}
