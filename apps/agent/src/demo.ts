/**
 * 本地演示脚本：不经网络层直接驱动本机 claude，验证桥接层四件事——
 *
 * 1. 启动会话 + 流式输出（assistant.delta 打字机效果）
 * 2. 触发一次权限请求并**程序化批准**（模拟 client 的 permission.respond）
 * 3. resume 恢复同一会话，验证上下文延续
 * 4. 会话列表（SDK listSessions）
 *
 * 跑法：
 *   bun run apps/agent/src/demo.ts              # 全流程
 *   bun run apps/agent/src/demo.ts --step=chat  # 只跑第 1 步
 *
 * 前置：本机已装并登录 claude CLI（订阅 OAuth 即可，不需要 API key）。
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from './bridge/emitter.ts';
import { SessionManager } from './bridge/manager.ts';
import type { OutboundEvent } from './bridge/types.ts';

/** 演示用的工作目录：临时目录，避免污染真实仓库 */
const DEMO_CWD = process.env['TRINE_DEMO_CWD'] ?? process.cwd();
const MODEL = process.env['TRINE_DEMO_MODEL'] ?? 'claude-sonnet-4-5';

const color = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function banner(text: string): void {
  console.log(`\n${color.bold(color.cyan(`── ${text} ${'─'.repeat(Math.max(0, 56 - text.length))}`))}`);
}

/**
 * 事件打印器：把桥接层产出的完整事件渲染成人看得懂的一行行。
 * 这就是未来 WS 层要做的事——只不过那边是加密后发出去。
 */
function makePrinter(): (out: OutboundEvent) => void {
  let streaming = false;

  return ({ event }) => {
    const seq = color.dim(`#${String(event.seq).padStart(3, '0')}`);

    switch (event.type) {
      case 'assistant.delta': {
        if (!streaming) {
          process.stdout.write(`${seq} ${color.green('claude')} `);
          streaming = true;
        }
        process.stdout.write(event.text);
        return;
      }
      case 'assistant.done': {
        if (streaming) {
          process.stdout.write('\n');
          streaming = false;
        } else {
          console.log(`${seq} ${color.green('claude')} ${event.text}`);
        }
        return;
      }
      case 'thinking.start':
        console.log(`${seq} ${color.dim('思考中…')}`);
        return;
      case 'user.message':
        console.log(`${seq} ${color.bold('你')} ${event.text}`);
        return;
      case 'tool.start':
        console.log(`${seq} ${color.yellow('🔧')} ${event.toolName} ${color.dim(event.argSummary)}`);
        return;
      case 'tool.end':
        console.log(`${seq} ${color.dim(`   ${event.resultSummary}`)}`);
        return;
      case 'permission.request':
        console.log(
          `${seq} ${color.yellow('🔐 权限请求')} ${event.toolName} ` +
            `${color.dim(JSON.stringify(event.input).slice(0, 100))}`,
        );
        return;
      case 'permission.resolved':
        console.log(`${seq} ${color.green('✓ 已' + (event.verdict === 'allow' ? '批准' : '拒绝'))}`);
        return;
      case 'permission.invalidated':
        console.log(`${seq} ${color.dim(`权限请求失效：${event.reason}`)}`);
        return;
      case 'run.state':
        console.log(`${seq} ${color.dim(`状态 → ${event.state}`)}`);
        return;
      case 'run.done':
        console.log(
          `${seq} ${color.green('✓ 完成')} ${color.dim(
            `${event.durationMs}ms · $${event.costUsd.toFixed(4)} · ` +
              `${event.toolCount} 次工具 · ${event.permissionCount} 次权限`,
          )}`,
        );
        return;
      case 'run.heartbeat':
        console.log(
          color.dim(
            `${seq} ⏱ ${(event.runElapsedMs / 1000).toFixed(1)}s` +
              (event.currentTool === undefined
                ? ''
                : ` · 🔧 ${event.currentTool.name} ${(event.currentTool.elapsedMs / 1000).toFixed(1)}s`) +
              ` · 静默 ${(event.silentMs / 1000).toFixed(1)}s · ${event.phase}`,
          ),
        );
        return;
      case 'input.queued':
        console.log(`${seq} ${color.dim(`📬 已排队 ${event.clientMsgId}`)}`);
        return;
      case 'error.transient':
        console.log(`${seq} ${color.yellow(`⚠ 瞬时错误（第 ${event.attempt} 次自动恢复）：${event.reason}`)}`);
        return;
      case 'error.fatal':
        console.log(`${seq} ${color.red(`✗ ${event.kind}：${event.message}`)}`);
        return;
      case 'session.capabilities':
        console.log(
          `${seq} ${color.dim(
            `能力：${event.slashCommands.length} 个命令 · 模型 ${event.models.join(',')} · ` +
              `${event.mcpServers.length} 个 MCP`,
          )}`,
        );
        return;
      case 'session.updated':
        return; // 太吵，演示里不打印
      default:
        console.log(`${seq} ${color.dim(event.type)}`);
    }
  };
}

/** 等到条件成立或超时 */
async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 180_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待「${label}」超时（${timeoutMs}ms）`);
    }
    await Bun.sleep(50);
  }
}

async function main(): Promise<void> {
  const step = process.argv.find((a) => a.startsWith('--step='))?.split('=')[1] ?? 'all';
  const print = makePrinter();
  const events: OutboundEvent[] = [];
  const emitter = new EventEmitter({
    sink: (out) => {
      events.push(out);
      print(out);
    },
  });
  const manager = new SessionManager({ emitter, maxConcurrent: 3 });
  const sessionId = randomUUID();

  console.log(color.bold('\ntrine agent 桥接层演示'));
  console.log(color.dim(`会话 ${sessionId}`));
  console.log(color.dim(`目录 ${DEMO_CWD} · 模型 ${MODEL}`));

  // -------------------------------------------------------------------------
  banner('步骤 1 · 启动会话与流式输出');
  // -------------------------------------------------------------------------
  const { session } = manager.acquire({
    sessionId,
    cwd: DEMO_CWD,
    model: MODEL,
    permissionMode: 'default',
  });

  session.send(
    randomUUID(),
    '用一句话介绍你自己，不要使用任何工具。',
  );
  await waitFor(
    () => events.some((e) => e.event.type === 'run.done'),
    '第一轮完成',
  );

  if (step === 'chat') {
    await manager.closeAll('演示结束');
    return;
  }

  // -------------------------------------------------------------------------
  banner('步骤 2 · 权限请求捕获与程序化批准');
  // -------------------------------------------------------------------------
  console.log(color.dim('（要求 claude 跑一条 Bash 命令，权限请求会被本脚本自动批准）'));

  // 模拟 client：收到 permission.request 就批准，并 remember 该模式
  let approvedCount = 0;
  const approver = setInterval(() => {
    for (const pending of session.permissions.snapshot()) {
      approvedCount += 1;
      console.log(color.dim(`   → 程序化批准 ${pending.requestId}（${pending.toolName}）`));
      session.respondPermission({
        requestId: pending.requestId,
        verdict: 'allow',
        remember: { scope: 'session', pattern: `${pending.toolName}(touch *)` },
        resolvedBy: 'demo-script',
      });
    }
  }, 100);

  const doneBefore = events.filter((e) => e.event.type === 'run.done').length;
  // 刻意挑一条**写操作**命令。只读命令（echo/ls/cat…）通常已被用户 settings 的
  // allow 规则或只读判定提前批准，而被 allow 规则批准的调用**根本不会到达
  // canUseTool**（权限评估六步里 allow 规则排在回调之前），演示就看不到权限流程。
  // 写文件则一定会问。
  const probeFile = `/tmp/trine-demo-${Date.now()}.txt`;
  session.send(
    randomUUID(),
    `请用 Bash 工具执行 \`touch ${probeFile}\`，完成后告诉我。`,
  );
  await waitFor(
    () => events.filter((e) => e.event.type === 'run.done').length > doneBefore,
    '权限轮完成',
  );
  const permissionEvents = events.filter((e) => e.event.type === 'permission.request');
  console.log(
    permissionEvents.length > 0
      ? color.green(`✓ 捕获并程序化批准了 ${approvedCount} 次权限请求`)
      : color.yellow(
          '⚠ 本轮没有触发权限请求——可能本机 settings 已放行该命令（属正常情况）',
        ),
  );
  console.log(color.dim(`   已记住的模式：${session.permissions.rememberedPatterns.join(', ') || '(无)'}`));

  // --- 第二轮：同类命令验证 remember 命中后不再挂起（决策 2 第 1 条）---
  if (permissionEvents.length > 0) {
    banner('步骤 2b · remember 命中：同类命令不再打扰');
    const approvedBefore = approvedCount;
    const doneBefore2 = events.filter((e) => e.event.type === 'run.done').length;

    session.send(randomUUID(), `再执行 \`touch ${probeFile}-2\`。`);
    await waitFor(
      () => events.filter((e) => e.event.type === 'run.done').length > doneBefore2,
      'remember 轮完成',
    );

    const newRequests = approvedCount - approvedBefore;
    console.log(
      newRequests === 0
        ? color.green('✓ remember 命中，本轮零次权限打扰')
        : color.yellow(`⚠ 本轮仍有 ${newRequests} 次权限请求（pattern 未覆盖该命令）`),
    );
  }
  clearInterval(approver);

  // -------------------------------------------------------------------------
  banner('步骤 3 · 会话列表');
  // -------------------------------------------------------------------------
  const list = await manager.list({ cwd: DEMO_CWD, limit: 5 });
  console.log(color.dim(`最近 ${list.length} 个会话：`));
  for (const item of list.slice(0, 5)) {
    const mark = item.sessionId === sessionId ? color.green(' ←本次') : '';
    console.log(
      color.dim(`   ${item.sessionId.slice(0, 8)} · ${item.state} · ${item.title.slice(0, 40)}`) + mark,
    );
  }

  // -------------------------------------------------------------------------
  banner('步骤 4 · resume 恢复会话');
  // -------------------------------------------------------------------------
  // 先彻底关掉当前会话（释放子进程），再以 resume 起一个新的
  await manager.release(sessionId, '演示：关闭以便 resume');
  console.log(color.dim('已关闭会话，正在以 resume 恢复…'));

  const { session: resumed } = manager.acquire({
    sessionId,
    cwd: DEMO_CWD,
    model: MODEL,
    permissionMode: 'default',
    resume: true,
  });

  const doneBeforeResume = events.filter((e) => e.event.type === 'run.done').length;
  resumed.send(randomUUID(), '我刚才让你做的第一件事是什么？简短回答。');
  await waitFor(
    () => events.filter((e) => e.event.type === 'run.done').length > doneBeforeResume,
    'resume 轮完成',
  );

  // -------------------------------------------------------------------------
  banner('小结');
  // -------------------------------------------------------------------------
  const byType = new Map<string, number>();
  for (const { event } of events) {
    byType.set(event.type, (byType.get(event.type) ?? 0) + 1);
  }
  console.log(color.dim('事件统计：'));
  for (const [type, count] of [...byType].sort((a, b) => b[1] - a[1])) {
    console.log(color.dim(`   ${type.padEnd(24)} ${count}`));
  }

  // seq 单调性自检（决策 1 的核心不变量）
  const bySeqScope = new Map<string, number[]>();
  for (const { event, scope } of events) {
    const key = scope ?? '(machine)';
    const list = bySeqScope.get(key) ?? [];
    list.push(event.seq);
    bySeqScope.set(key, list);
  }
  let monotonic = true;
  for (const [key, seqs] of bySeqScope) {
    // 每条流：首帧必须是 1（0 是 sync.request sinceSeq 的保留值，服务端拒收），
    // 其后逐帧 +1
    const startsAtOne = seqs[0] === 1;
    const contiguous = seqs.every((s, i) => i === 0 || s === seqs[i - 1]! + 1);
    const ok = startsAtOne && contiguous;
    if (!ok) monotonic = false;
    console.log(
      color.dim(`   seq 序列 ${key.slice(0, 12)}：${seqs.length} 帧 ${seqs[0]}..${seqs.at(-1)} `) +
        (ok ? color.green('单调且从 1 起 ✓') : color.red('异常 ✗')),
    );
  }

  await manager.closeAll('演示结束');
  console.log(
    monotonic
      ? color.green('\n✓ 演示完成，seq 单调性自检通过')
      : color.red('\n✗ seq 单调性自检失败'),
  );
  process.exit(monotonic ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(color.red(`\n演示失败：${err instanceof Error ? err.message : String(err)}`));
  if (err instanceof Error && err.stack !== undefined) {
    console.error(color.dim(err.stack));
  }
  process.exit(1);
});
