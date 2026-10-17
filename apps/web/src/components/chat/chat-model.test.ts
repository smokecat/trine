/**
 * 聊天视图纯逻辑的单测：用户消息角标、心跳平滑、权限卡文案与改参数解析。
 *
 * React 组件层不在这里测（渲染差异靠 Playwright 真链路看），但凡是「算出来
 * 的东西」——状态机映射、时间累加、文案生成、JSON 解析——都在这里钉住。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { matchesPattern } from '@trine/core/permission';
import {
  markRecalling,
  setLocalStatus,
  settleRecalls,
  type PermissionEntry,
  type ToolEntry,
  type UserEntry,
} from '@/lib/reducer.ts';
import { resultText } from './ToolCard.tsx';
import { safeUrlTransform } from './Markdown.tsx';
import { RECALL_PENDING_MS, userEntryBadge } from './entry-status.ts';
import { SILENT_WARN_MS, heartbeatView } from './heartbeat-model.ts';
import {
  editorSeed,
  parseEditedInput,
  permissionParamView,
  permissionResultText,
  effectiveRememberOption,
  rememberOption,
} from './permission-model.ts';

const expiry = (at: number): string => `T${at}`;

function user(patch: Partial<UserEntry>): UserEntry {
  return { kind: 'user', id: 'c1', text: 'hi', local: true, seq: 0, ts: 0, ...patch };
}

describe('userEntryBadge', () => {
  test('已确认与他人回显不显示角标', () => {
    expect(userEntryBadge(user({ status: 'confirmed' }), expiry).label).toBeUndefined();
    expect(userEntryBadge(user({ local: false }), expiry).label).toBeUndefined();
    expect(userEntryBadge(user({}), expiry).label).toBeUndefined();
  });

  test('sending / queued：queued 可撤回 agent 队列', () => {
    expect(userEntryBadge(user({ status: 'sending' }), expiry)).toEqual({
      label: '发送中…',
      tone: 'muted',
    });
    const queued = userEntryBadge(user({ status: 'queued' }), expiry);
    expect(queued.label).toBe('已排队 · 任务结束后发送');
    expect(queued.action).toEqual({ kind: 'recall_queued', label: '撤回' });
  });

  test('parked 带有效期与撤回；无 expiresAt 时不编造时间', () => {
    const withExpiry = userEntryBadge(user({ status: 'parked', expiresAt: 42 }), expiry);
    expect(withExpiry.label).toBe('机器离线，已在服务端排队 · T42 前有效');
    expect(withExpiry.tone).toBe('amber');
    expect(withExpiry.action).toEqual({ kind: 'recall_parked', label: '撤回' });
    expect(userEntryBadge(user({ status: 'parked' }), expiry).label).toBe('机器离线，已在服务端排队');
  });

  test('expired 重发走新 clientMsgId，failed 沿用原 id', () => {
    expect(userEntryBadge(user({ status: 'expired' }), expiry).action?.kind).toBe('resend');
    const failed = userEntryBadge(user({ status: 'failed', failReason: '连接断开前未能发出' }), expiry);
    expect(failed.label).toBe('发送失败：连接断开前未能发出');
    expect(failed.tone).toBe('red');
    expect(failed.action?.kind).toBe('retry');
  });
});

describe('heartbeatView', () => {
  const snapshot = {
    at: 1_000,
    runElapsedMs: 30_000,
    currentTool: { toolUseId: 't1', name: 'Bash', elapsedMs: 4_000 },
    silentMs: 3_000,
    phase: 'tool' as const,
  };

  test('两帧之间按本地时钟累加', () => {
    const v = heartbeatView(snapshot, 500_000, 502_500, null);
    expect(v.runElapsedMs).toBe(32_500);
    expect(v.currentTool).toEqual({ name: 'Bash', elapsedMs: 6_500 });
    expect(v.silentMs).toBe(5_500);
  });

  test('用本地 receivedAt 而不是 agent 的 at——两端时钟差不影响计时', () => {
    // snapshot.at 远在未来（agent 时钟快了 10 分钟），计时仍只受本地漂移影响
    const skewed = { ...snapshot, at: 500_000 + 600_000 };
    expect(heartbeatView(skewed, 500_000, 501_000, null).runElapsedMs).toBe(31_000);
  });

  test('时钟回拨时漂移夹到 0，计时器不倒走', () => {
    const v = heartbeatView(snapshot, 500_000, 499_000, null);
    expect(v.runElapsedMs).toBe(30_000);
    expect(v.silentMs).toBe(3_000);
  });

  test('静默 <60s 中性、≥60s 才提醒（方案 §0 行 j：工具后静默 ~40s 属常态）', () => {
    const at59 = heartbeatView({ ...snapshot, silentMs: 59_000 }, 0, 0, null);
    expect(at59.silentWarn).toBe(false);
    const at60 = heartbeatView({ ...snapshot, silentMs: SILENT_WARN_MS }, 0, 0, null);
    expect(at60.silentWarn).toBe(true);
    // 40s 是常态那一档，必须不报警
    expect(heartbeatView({ ...snapshot, silentMs: 40_000 }, 0, 0, null).silentWarn).toBe(false);
  });

  test('等待批准按 requestedAt 计时；无 pending 为 null', () => {
    expect(heartbeatView(snapshot, 0, 0, null).waitingMs).toBeNull();
    expect(heartbeatView(snapshot, 0, 9_000, 2_000).waitingMs).toBe(7_000);
    // requestedAt 来自 agent 时钟，比本地 now 还晚时不给负数
    expect(heartbeatView(snapshot, 0, 1_000, 5_000).waitingMs).toBe(0);
  });

  test('无当前工具时 currentTool 为 null', () => {
    const { currentTool, ...rest } = snapshot;
    expect(heartbeatView({ ...rest, phase: 'run' }, 0, 0, null).currentTool).toBeNull();
  });
});

describe('permissionParamView', () => {
  test('Bash → 可编辑命令块', () => {
    expect(permissionParamView('Bash', { command: 'git status' })).toEqual({
      kind: 'command',
      label: 'Bash',
      command: 'git status',
    });
  });

  test('Write/Edit → 路径 + 内容摘要', () => {
    expect(permissionParamView('Write', { file_path: '/a/b.ts', content: 'x' })).toEqual({
      kind: 'file',
      label: 'Write',
      filePath: '/a/b.ts',
      content: 'x',
    });
    expect(permissionParamView('Edit', { file_path: '/a/b.ts', new_string: 'y' })).toEqual({
      kind: 'file',
      label: 'Edit',
      filePath: '/a/b.ts',
      content: 'y',
    });
  });

  test('其他工具与形状不对的输入 → JSON', () => {
    expect(permissionParamView('Grep', { pattern: 'x' })).toEqual({
      kind: 'json',
      label: 'Grep',
      json: '{\n  "pattern": "x"\n}',
    });
    // Bash 缺 command（协议上可能，UI 不能崩）
    expect(permissionParamView('Bash', {}).kind).toBe('json');
    expect(permissionParamView('Bash', null).kind).toBe('json');
  });
});

describe('rememberOption', () => {
  test('与 core 的 suggestRememberPattern 同源：Bash 首词+子命令、无尾空格', () => {
    expect(rememberOption('Bash', { command: 'git commit -m x' })?.pattern).toBe('Bash(git commit*)');
    expect(rememberOption('Write', { file_path: '/repo/src/a.ts' })?.pattern).toBe('Write(/repo/src/*)');
  });

  test('不支持记住的工具与复合命令：返回 null（不显示复选框）', () => {
    expect(rememberOption('Grep', { pattern: 'x' })).toBeNull();
    expect(rememberOption('mcp__dune__query', { q: 1 })).toBeNull();
    expect(rememberOption('Bash', { command: 'git push && rm -rf /' })).toBeNull();
  });

  test('文案是事实描述，不出现「安全 / 仅允许 / 可信」这类承诺', () => {
    const forbidden = ['安全', '仅允许', '可信', '放心', '无害', '受信'];
    for (const input of [
      { tool: 'Bash', input: { command: 'git commit -m x' } },
      { tool: 'Read', input: { file_path: '/repo/src/a.ts' } },
      { tool: 'WebFetch', input: { url: 'https://example.com/a' } },
    ]) {
      const opt = rememberOption(input.tool, input.input);
      expect(opt).not.toBeNull();
      expect(opt?.label).toBe(`本会话内不再询问 ${opt?.pattern}`);
      for (const word of forbidden) expect(opt?.label).not.toContain(word);
    }
  });
});

describe('effectiveRememberOption（改参数后重算）', () => {
  const bashView = permissionParamView('Bash', { command: 'rm -rf x' });
  const edit = (draft: string) => parseEditedInput(bashView, { command: 'rm -rf x' }, draft);

  test('未进入编辑态：等同按原始参数算', () => {
    expect(effectiveRememberOption('Bash', { command: 'rm -rf x' }, null)?.pattern).toBe('Bash(rm*)');
  });

  test('越权回归：把 rm -rf x 改成 ls -la 后，绝不再提供 Bash(rm*)', () => {
    // 真实形状：用户点「改参数后批准」，把危险命令换成无害命令
    const parsed = edit('ls -la');
    expect(parsed.ok).toBe(true);
    // 主参数变了 → 选项消失，respond() 因此不会带上任何 remember
    expect(effectiveRememberOption('Bash', { command: 'rm -rf x' }, parsed)).toBeNull();
  });

  test('改后仍是同一类调用（同 pattern）：选项保留', () => {
    const parsed = edit('rm -rf y');
    expect(effectiveRememberOption('Bash', { command: 'rm -rf x' }, parsed)?.pattern).toBe('Bash(rm*)');
  });

  test('改后带了元字符（core 不给建议）→ null', () => {
    expect(effectiveRememberOption('Bash', { command: 'rm -rf x' }, edit('rm x && curl evil'))).toBeNull();
  });

  test('编辑内容解析失败 → null（没有可靠 input 可算 pattern）', () => {
    const jsonView = permissionParamView('Grep', { pattern: 'x' });
    const bad = parseEditedInput(jsonView, { pattern: 'x' }, '{ 坏 json');
    expect(bad.ok).toBe(false);
    expect(effectiveRememberOption('Read', { file_path: '/a/b.ts' }, bad)).toBeNull();
  });

  /**
   * 这条是 B1 真正的安全不变式（评审点名要的那条）：
   * **凡是能被交出去的 pattern，必须命中实际提交的 input。**
   *
   * 前面几条测的是「什么时候不给选项」，这条测的是「给了的一定对」——
   * 前者错了是体验问题，后者错了就是越权。用 core 的 `matchesPattern`
   * （agent 登记后真正用来判放行的那个函数）来验，不自己复述规则。
   */
  test('不变式：凡是给出的 pattern，必然命中实际提交的 input', () => {
    const cases: { tool: string; original: Record<string, unknown>; draft: string }[] = [
      { tool: 'Bash', original: { command: 'rm -rf x' }, draft: 'rm -rf y' },
      { tool: 'Bash', original: { command: 'git commit -m a' }, draft: 'git commit -m b' },
      { tool: 'Bash', original: { command: 'ls -la' }, draft: 'ls /tmp' },
      { tool: 'Read', original: { file_path: '/repo/src/a.ts' }, draft: JSON.stringify({ file_path: '/repo/src/b.ts' }) },
      { tool: 'Write', original: { file_path: '/repo/src/a.ts' }, draft: JSON.stringify({ file_path: '/repo/src/c.ts' }) },
      { tool: 'WebFetch', original: { url: 'https://a.example/x' }, draft: JSON.stringify({ url: 'https://a.example/y' }) },
      // 改到另一类调用：这些应当返回 null（不给选项），循环里会跳过
      { tool: 'Bash', original: { command: 'rm -rf x' }, draft: 'ls -la' },
      { tool: 'Write', original: { file_path: '/repo/src/a.ts' }, draft: JSON.stringify({ file_path: '/etc/passwd' }) },
    ];
    let given = 0;
    for (const c of cases) {
      const view = permissionParamView(c.tool, c.original);
      const parsed = parseEditedInput(view, c.original, c.draft);
      const opt = effectiveRememberOption(c.tool, c.original, parsed);
      if (opt === null) continue; // 没给选项，不构成风险
      given++;
      expect(parsed.ok).toBe(true);
      const submitted = (parsed as { ok: true; value: unknown }).value as Record<string, unknown>;
      // 关键断言：agent 登记这条 pattern 后，它确实覆盖用户刚批准的这次调用
      expect(matchesPattern(opt.pattern, c.tool, submitted)).toBe(true);
    }
    expect(given).toBeGreaterThan(0); // 别因为全被跳过而假绿
  });

  test('Write 改到另一个目录 → 选项消失（pattern 变了）', () => {
    const view = permissionParamView('Write', { file_path: '/repo/src/a.ts' });
    const parsed = parseEditedInput(view, { file_path: '/repo/src/a.ts' }, JSON.stringify({ file_path: '/etc/passwd' }));
    expect(effectiveRememberOption('Write', { file_path: '/repo/src/a.ts' }, parsed)).toBeNull();
  });
});

describe('PermissionCard 渲染的「记住」文案', () => {
  // M9：早先组件硬编码了一份与 label 同义的 JSX，于是上面那条「不出现安全
  // 字眼」的断言断的是没人用的 label，组件真正显示什么完全不受管（假绿）。
  // 这里对组件源码做字符串级断言，钉住「渲染的就是 label 本身」这个结构。
  const source = readFileSync(new URL('./PermissionCard.tsx', import.meta.url), 'utf8');
  /** 去掉注释后的源码——红线管的是渲染出去的文案，不是解释这条红线的注释 */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('渲染 remember.label 本身，而不是另写一份同义文案', () => {
    expect(code).toContain('{remember.label}');
    // 硬编码的那句已经不在渲染路径上
    expect(code).not.toContain('本会话内不再询问');
  });

  test('组件渲染路径上不出现安全承诺字眼', () => {
    for (const word of ['安全', '仅允许', '可信', '放心', '无害', '受信']) {
      expect(code).not.toContain(word);
    }
  });
});

describe('parseEditedInput', () => {
  const bash = permissionParamView('Bash', { command: 'ls', description: 'list' });

  test('Bash 只换 command，其余字段保留', () => {
    expect(parseEditedInput(bash, { command: 'ls', description: 'list' }, '  ls -la  ')).toEqual({
      ok: true,
      value: { command: 'ls -la', description: 'list' },
    });
  });

  test('Bash 空命令不可提交', () => {
    expect(parseEditedInput(bash, {}, '   ')).toEqual({ ok: false, error: '命令不能为空' });
  });

  test('JSON 工具：合法对象通过，非法/非对象被拒', () => {
    const view = permissionParamView('Grep', { pattern: 'a' });
    expect(parseEditedInput(view, {}, '{"pattern":"b"}')).toEqual({ ok: true, value: { pattern: 'b' } });
    expect(parseEditedInput(view, {}, '{oops').ok).toBe(false);
    expect(parseEditedInput(view, {}, '[1,2]')).toEqual({ ok: false, error: '参数必须是 JSON 对象' });
    expect(parseEditedInput(view, {}, '"str"').ok).toBe(false);
  });

  test('编辑框初值：Bash 给命令原文，其余给格式化 JSON', () => {
    expect(editorSeed(bash, { command: 'ls' })).toBe('ls');
    expect(editorSeed(permissionParamView('Grep', { p: 1 }), { p: 1 })).toBe('{\n  "p": 1\n}');
  });
});

describe('permissionResultText', () => {
  function perm(patch: Partial<PermissionEntry>): PermissionEntry {
    return {
      kind: 'permission',
      id: 'r1',
      toolName: 'Bash',
      input: {},
      requestedAt: 0,
      state: 'resolved',
      seq: 1,
      ts: 0,
      ...patch,
    };
  }

  test('本设备批准 vs 其他设备批准', () => {
    expect(permissionResultText(perm({ verdict: 'allow', resolvedBy: 'web-1' }), 'web-1')).toEqual({
      text: '✓ 已批准（本设备）',
      tone: 'green',
    });
    expect(permissionResultText(perm({ verdict: 'allow', resolvedBy: 'phone-2' }), 'web-1').text).toBe(
      '✓ 已批准（phone-2）',
    );
    expect(permissionResultText(perm({ verdict: 'allow' }), 'web-1').text).toBe('✓ 已批准');
  });

  test('拒绝', () => {
    expect(permissionResultText(perm({ verdict: 'deny', resolvedBy: 'web-1' }), 'web-1')).toEqual({
      text: '✗ 已拒绝（本设备）',
      tone: 'red',
    });
  });

  test('失效态给原因与恢复办法', () => {
    const r = permissionResultText(perm({ state: 'invalidated', reason: 'agent 重启' }), 'web-1');
    expect(r.text).toBe('⌀ 请求已失效（agent 重启）——如需继续，直接发消息让 Claude 重试');
    expect(permissionResultText(perm({ state: 'invalidated' }), 'web-1').text).toBe(
      '⌀ 请求已失效——如需继续，直接发消息让 Claude 重试',
    );
  });
});

describe('工具卡结果文案', () => {
  function tool(patch: Partial<ToolEntry>): ToolEntry {
    return { kind: 'tool', id: 't1', toolName: 'Write', argSummary: 'a.txt', seq: 1, ts: 0, ...patch };
  }

  test('agent 的 resultSummary 已含状态号与耗时，不再重复拼（回归：「✓ ✓ 已写入 · 2m10s · 2:10」）', () => {
    const entry = tool({ status: 'ok', resultSummary: '✓ 已写入 · 2m10s', durationMs: 130_000 });
    expect(resultText(entry, 'ok')).toBe('✓ 已写入 · 2m10s');
  });

  test('agent 没给摘要时才本地回落到状态号 + 时长', () => {
    expect(resultText(tool({ status: 'error', durationMs: 1_500 }), 'error')).toBe('✗ 1s');
    expect(resultText(tool({ status: 'warn' }), 'warn')).toBe('⚠');
    expect(resultText(tool({ status: 'ok', resultSummary: '' }), 'ok')).toBe('✓');
  });
});

describe('markdown 外链图片（M4）', () => {
  // streamdown 2.6.0 的 harden 默认 allowedImagePrefixes:['*']，assistant 文本
  // 里的外域图片会让用户浏览器直接外连。这里钉住渲染层的 urlTransform 判据。
  test('img src：外域一律丢（返回 null → 不设 src，浏览器不发请求）', () => {
    for (const bad of [
      'http://evil.example/x.png',
      'https://evil.example/x.png',
      '//evil.example/x.png', // 协议相对
      'HTTPS://EVIL.example/x.png',
      'blob:https://evil.example/abc',
      'filesystem:http://evil.example/x',
    ]) {
      expect(safeUrlTransform(bad, 'src')).toBeNull();
    }
  });

  test('img src：data:image 与同源相对路径放行', () => {
    expect(safeUrlTransform('data:image/png;base64,AAA', 'src')).toBe('data:image/png;base64,AAA');
    expect(safeUrlTransform('/icons/a.png', 'src')).toBe('/icons/a.png');
    expect(safeUrlTransform('./a.png', 'src')).toBe('./a.png');
    expect(safeUrlTransform('a.png', 'src')).toBe('a.png');
  });

  test('data: 但不是图片（脚本载荷）不放行', () => {
    expect(safeUrlTransform('data:text/html;base64,PHNjcmlwdD4=', 'src')).toBeNull();
    expect(safeUrlTransform('data:application/javascript,alert(1)', 'src')).toBeNull();
  });

  test('链接（href）不受影响：用户主动点击才离开', () => {
    expect(safeUrlTransform('https://example.com/a', 'href')).toBe('https://example.com/a');
  });

  // 注：这一组只测 `safeUrlTransform` 这个**纯函数**的判据，它测不出
  // 「管线里还有别的属性能带 URL 出去」——`<source srcset>` 就绕过了它
  // （评审 N1）。真正的防线是 `markdown-render.test.tsx` 的真渲染断言。
  test('Markdown.tsx 确实把 urlTransform 传给了 Streamdown', () => {
    const src = readFileSync(new URL('./Markdown.tsx', import.meta.url), 'utf8');
    expect(src).toContain('urlTransform={safeUrlTransform}');
  });
});

describe('撤回 agent 队列的乐观态（M6）', () => {
  // `input.recall` 在协议上没有回执，撤回成功就是「什么都没发生」。
  // 早先点了撤回条目原样不动、按钮还能无限点，用户不知道成没成。
  const T0 = 1_700_000_000_000;
  const queued = (over: Partial<UserEntry> = {}): UserEntry => ({
    kind: 'user', id: 'm-1', text: 'hi', local: true, status: 'queued', seq: 0, ts: T0, ...over,
  });

  test('未撤回：按钮可点', () => {
    const b = userEntryBadge(queued(), () => 'X', T0);
    expect(b.action).toEqual({ kind: 'recall_queued', label: '撤回' });
  });

  test('已发出撤回：进「撤回中…」且按钮禁用', () => {
    const b = userEntryBadge(queued({ recallingAt: T0 }), () => 'X', T0 + 1_000);
    expect(b.label).toBe('已排队 · 撤回中…');
    expect(b.action).toEqual({ kind: 'recall_queued', label: '撤回中…', disabled: true });
  });

  test('超时后恢复可点（撤成了就是没有任何后续）', () => {
    const b = userEntryBadge(queued({ recallingAt: T0 }), () => 'X', T0 + RECALL_PENDING_MS);
    expect(b.action).toEqual({ kind: 'recall_queued', label: '撤回' });
  });

  test('markRecalling 只对 queued 生效且不重复置', () => {
    const tl = { lastAppliedSeq: 0, entries: [queued()], heartbeat: null, state: null };
    const once = markRecalling(tl, 'm-1', T0);
    expect((once.entries[0] as UserEntry).recallingAt).toBe(T0);
    // 再点一次不改时刻（按钮已禁用，这是防御）
    expect(markRecalling(once, 'm-1', T0 + 5)).toBe(once);
    // sending 态没有「撤回」这回事
    const sending = { ...tl, entries: [queued({ status: 'sending' })] };
    expect(markRecalling(sending, 'm-1', T0)).toBe(sending);
  });

  test('撤回失败（user.message 回显升 confirmed）时清掉乐观态，不留「撤回中」', () => {
    const tl = { lastAppliedSeq: 0, entries: [queued({ recallingAt: T0 })], heartbeat: null, state: null };
    const done = setLocalStatus(tl, 'm-1', 'confirmed');
    const e = done.entries[0] as UserEntry;
    expect(e.status).toBe('confirmed');
    expect(e.recallingAt).toBeUndefined();
    // 关键：**没有**被标成 failed——那是终态，会挡住 confirmed 且显示「发送失败」
    expect(userEntryBadge(e, () => 'X', T0 + 1_000).label).toBeUndefined();
  });

  // 撤回**成功**的落地（评审 C-2）。早先这条路径什么都不做：recallingAt
  // 永远留着、条目永远参与 tick，角标从「撤回中…」悄悄变回「撤回」，
  // 用户不知道到底撤没撤成。
  describe('撤回成功 → recalled 终态（C-2）', () => {
    const tl = (over: Partial<UserEntry> = {}) => ({
      lastAppliedSeq: 0,
      entries: [queued({ recallingAt: T0, ...over })],
      heartbeat: null,
      state: null,
    });

    test('到点结算：清掉 recallingAt，进「已撤回」终态', () => {
      const after = settleRecalls(tl(), T0);
      const e = after.entries[0] as UserEntry;
      expect(e.status).toBe('recalled');
      expect(e.recallingAt).toBeUndefined();
      expect(userEntryBadge(e, () => 'X', T0 + 10_000)).toEqual({ label: '已撤回', tone: 'muted' });
    });

    test('没到点不动（引用都不变，不触发重渲染）', () => {
      const before = tl();
      expect(settleRecalls(before, T0 - 1)).toBe(before);
    });

    test('recalled 是终态：后到的 queued/parked 覆盖不了它', () => {
      const recalled = settleRecalls(tl(), T0);
      expect((setLocalStatus(recalled, 'm-1', 'queued').entries[0] as UserEntry).status).toBe('recalled');
      expect((setLocalStatus(recalled, 'm-1', 'parked').entries[0] as UserEntry).status).toBe('recalled');
    });

    test('期间已被别的事件推进（撤回没赶上）就不插手', () => {
      // user.message 回显先到 → confirmed，recallingAt 已在那时被清掉
      const confirmed = setLocalStatus(tl(), 'm-1', 'confirmed');
      expect(settleRecalls(confirmed, T0 + 10_000)).toBe(confirmed);
      // parked 的撤回走的是另一条路（park.recall 有回执），不该被这里顺手结算
      const parked = tl({ status: 'parked' });
      expect(settleRecalls(parked, T0 + 10_000)).toBe(parked);
    });

    test('「已撤回」不给重发按钮——同 clientMsgId 会被 agent 去重表吃掉', () => {
      const e = settleRecalls(tl(), T0).entries[0] as UserEntry;
      expect(userEntryBadge(e, () => 'X', T0).action).toBeUndefined();
    });
  });
});
