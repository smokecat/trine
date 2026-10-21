/**
 * 设置 → 扩展（U4）：按机器列出已注册的扩展，启用 / 停用、权限（全托管或逐项）、最近错误。
 * 设置存在 agent 上，对这台机器的全部设备生效。安装只能在 agent 机器上用 `trine-agent ext add`。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { DEFAULT_EXT_CAPABILITY_POLICY, type ExtCapability, type ExtCatalogItem, type ExtPolicy, type ExtPolicyValue } from '@trine/core';
import { Switch } from '@/components/ui/switch.tsx';
import { Chip } from '@/components/shell/StatusDot.tsx';
import { useClient, useTrine } from '@/app/runtime.ts';
import { invalidateCatalog, useExtCatalog } from './use-ext.ts';

const CAPABILITY_LABEL: Record<ExtCapability, string> = {
  'prompt.insert': '插入文字到输入框',
  'links.write': '修改会话关联',
  invoke: '执行扩展自己的操作（如归档任务）',
  'prompt.send': '直接发送消息',
  'session.create': '新建会话并发送',
};

const VALUE_LABEL: Record<ExtPolicyValue, string> = { allow: '允许', confirm: '每次确认', deny: '禁止' };

export function ExtensionsSettings(): React.JSX.Element | null {
  const machines = useTrine((s) => s.machines);
  const supported = Object.values(machines).filter((m) => m.info?.extensions !== undefined);
  if (supported.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" data-testid="ext-settings">
      <h2 className="font-medium">扩展</h2>
      <p className="text-text-3 text-xs">
        扩展是 agent 机器上的程序，在 agent 机器上用 <code className="font-mono">trine-agent ext add &lt;目录&gt;</code> 安装。
        这里的设置存在 agent 上，对这台机器的所有设备生效。
      </p>
      {supported.map((m) => (
        <MachineExtensions key={m.machineId} machineId={m.machineId} name={m.name} />
      ))}
    </section>
  );
}

function MachineExtensions({ machineId, name }: { machineId: string; name: string }): React.JSX.Element {
  const catalog = useExtCatalog(machineId);
  return (
    <div className="flex flex-col gap-2">
      <div className="text-text-2 font-mono text-[12.5px]">{name}</div>
      {catalog !== null && catalog.length === 0 && <p className="text-text-3 text-xs">还没有安装扩展。</p>}
      {catalog?.map((ext) => <ExtensionCard key={ext.id} machineId={machineId} ext={ext} />)}
    </div>
  );
}

function ExtensionCard({ machineId, ext }: { machineId: string; ext: ExtCatalogItem }): React.JSX.Element {
  const client = useClient();
  const [busy, setBusy] = useState(false);

  const save = async (patch: { enabled?: boolean; policy?: ExtPolicy }): Promise<void> => {
    if (client === null) return;
    setBusy(true);
    try {
      const res = await client.extRequest(machineId, { type: 'ext.config.set', ext: ext.id, ...patch } as never, ['ext.config.response']);
      if (!res.ok) throw new Error(res.error?.message ?? '保存失败');
      invalidateCatalog(client, machineId);
    } catch (err) {
      toast.error(`保存扩展设置失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const setCapability = (capability: ExtCapability, value: ExtPolicyValue): void => {
    void save({ policy: { trust: 'custom', capabilities: { ...ext.policy.capabilities, [capability]: value } } });
  };

  const declared = ext.capabilities.filter((c): c is ExtCapability => c in CAPABILITY_LABEL);
  return (
    <div className="border-border flex flex-col gap-2 rounded-xl border p-3" data-testid="ext-card" data-ext-id={ext.id}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            {ext.name} <span className="text-text-3 text-xs font-normal">{ext.version}</span>
          </div>
          {ext.description !== undefined && <div className="text-text-3 text-xs">{ext.description}</div>}
          {ext.status === 'error' && <div className="text-red text-xs">不可用：{ext.lastError ?? '未知原因'}</div>}
          {ext.status !== 'error' && ext.lastError !== undefined && <div className="text-amber text-xs">最近错误：{ext.lastError}</div>}
        </div>
        <Switch
          checked={ext.enabled}
          disabled={busy || ext.status === 'error'}
          aria-label={ext.enabled ? '停用' : '启用'}
          data-testid="ext-enabled"
          onCheckedChange={(enabled) => void save({ enabled })}
        />
      </div>
      {declared.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-text-3 text-xs">权限</span>
            <Chip selected={ext.policy.trust === 'full'} onClick={() => void save({ policy: { trust: 'full', capabilities: ext.policy.capabilities } })}>
              全托管
            </Chip>
            <Chip
              selected={ext.policy.trust === 'custom'}
              onClick={() => void save({ policy: { trust: 'custom', capabilities: ext.policy.capabilities } })}
            >
              自定义
            </Chip>
          </div>
          {ext.policy.trust === 'full' ? (
            <p className="text-text-3 text-xs">全托管：扩展声明的能力全部允许，点击后直接执行、不弹确认（包括它以后新声明的能力）。</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {declared.map((capability) => {
                const value = ext.policy.capabilities[capability] ?? DEFAULT_EXT_CAPABILITY_POLICY[capability];
                return (
                  <li key={capability} className="flex flex-wrap items-center gap-1.5">
                    <span className="text-text-2 min-w-0 flex-1 text-xs">{CAPABILITY_LABEL[capability]}</span>
                    {(['allow', 'confirm', 'deny'] as const).map((v) => (
                      <Chip key={v} selected={value === v} onClick={() => setCapability(capability, v)}>
                        {VALUE_LABEL[v]}
                      </Chip>
                    ))}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
