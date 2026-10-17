/**
 * 权限卡 / 提问卡 / 计划卡顶部的来源标注（subagent-view）：子 agent 发起的请求
 * （permission.request 带 parentToolUseId）标「来自子 agent：<父 Task 卡的描述>」；
 * 父卡不在时间线上（被裁 / 在更早的历史页）就只写「来自子 agent」。
 */
export function SubagentSourceNote({ label }: { label: string }): React.JSX.Element {
  return (
    <div
      data-testid="perm-subagent-source"
      className="text-text-2 border-border flex min-w-0 items-center gap-1.5 border-b px-3.5 py-1.5 text-[12px]"
    >
      <span aria-hidden>🤖</span>
      <span className="min-w-0 truncate">{label === '' ? '来自子 agent' : `来自子 agent：${label}`}</span>
    </div>
  );
}
