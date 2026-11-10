/**
 * 机器详情的「引擎」一节（multi-engine）：每个引擎一张卡，版本、状态和更新。限额在上面的「用量」行。
 * 只有一个引擎时不显示，界面和只用 Claude 时一样（更新区块由 MachineDetailView 直接放）。
 */
import { CLAUDE_ENGINE_ID, type EngineSummary, type MachineInfo } from '@trine/core';
import { EngineUpdateSection } from '@/components/machines/EngineUpdateSection.tsx';
import { claudeLatestView, CODEX_RUNNING_NOTE, engineLatestView, shortClaudeVersion, supportsClaudeUpdate } from '@/components/machines/claude-update.ts';
import type { useClient } from '@/app/runtime.ts';
import { EngineName } from '@/components/shell/EngineIcon.tsx';

type Client = NonNullable<ReturnType<typeof useClient>>;
type Info = MachineInfo | null | undefined;

function EngineCard({
  engine,
  machineId,
  machineName,
  online,
  info,
  client,
  now,
}: {
  engine: EngineSummary;
  machineId: string;
  machineName: string;
  online: boolean | null;
  info: Info;
  client: Client | null | undefined;
  now: number;
}): React.JSX.Element {
  const isClaude = engine.id === CLAUDE_ENGINE_ID;
  const claudeUpdatable = isClaude && supportsClaudeUpdate(info ?? null);
  const latest = isClaude ? null : engineLatestView(engine);
  return (
    <div data-testid="engine-card" data-engine={engine.id} className="border-border flex flex-col gap-2 rounded-[12px] border px-3 py-2.5">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <EngineName engineId={engine.id} name={engine.displayName} className="gap-1.5 self-center font-medium" iconClassName="size-4" />
        <span className="text-text-3 font-mono text-xs">{engine.version === undefined ? '版本未知' : shortClaudeVersion(engine.version)}</span>
      </p>
      <p className="text-xs" data-testid="engine-status">
        {engine.unavailableReason !== undefined ? (
          <span className="text-amber">{engine.unavailableReason}</span>
        ) : engine.available && engine.capabilities.interactive !== true ? (
          <span className="text-text-3">目前只能查看</span>
        ) : (
          <span className="text-green">可用</span>
        )}
      </p>
      {client && claudeUpdatable && (
        <EngineUpdateSection
          showTitle={false}
          machineName={machineName}
          online={online}
          version={info?.claudeVersion}
          update={() => client.updateClaude(machineId)}
          latest={claudeLatestView(info)}
          check={() => client.checkClaude(machineId)}
          now={now}
        />
      )}
      {client && !isClaude && engine.capabilities.update === true && (
        <EngineUpdateSection
          showTitle={false}
          engineName={engine.displayName}
          command={`${engine.id} update`}
          idPrefix={engine.id}
          runningNote={CODEX_RUNNING_NOTE}
          machineName={machineName}
          online={online}
          version={engine.version}
          update={() => client.updateEngine(machineId, engine.id)}
          latest={latest}
          check={() => client.checkEngine(machineId, engine.id)}
          now={now}
        />
      )}
    </div>
  );
}

export function EngineCards(props: {
  engines: readonly EngineSummary[];
  machineId: string;
  machineName: string;
  online: boolean | null;
  info: Info;
  client: Client | null | undefined;
  now: number;
}): React.JSX.Element {
  const { engines, ...rest } = props;
  return (
    <section className="flex flex-col gap-2" data-testid="detail-engines">
      <h2 className="font-medium">引擎</h2>
      {engines.map((engine) => (
        <EngineCard key={engine.id} engine={engine} {...rest} />
      ))}
    </section>
  );
}
