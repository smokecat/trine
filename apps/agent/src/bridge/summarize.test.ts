/**
 * 工具卡摘要生成。重点是**未知工具优雅降级**——MCP 工具名千奇百怪，
 * 摘要难看可以接受，抛错不行。
 */
import { describe, expect, test } from 'bun:test';
import {
  backgroundSubagentEnd,
  formatDuration,
  outputPreview,
  subagentReportText,
  subagentRunStats,
  summarizeToolArgs,
  summarizeToolResult,
  toSingleLine,
  toolFilePath,
  withFilePath,
} from './summarize.ts';

describe('summarizeToolArgs', () => {
  test('Bash 取命令', () => {
    expect(summarizeToolArgs('Bash', { command: 'git status' })).toBe('git status');
  });

  test('文件类工具取路径，长路径缩写', () => {
    expect(summarizeToolArgs('Read', { file_path: '/tmp/a.ts' })).toBe('/tmp/a.ts');
    const long = summarizeToolArgs('Edit', {
      file_path: '/very/deeply/nested/path/that/goes/on/forever/and/ever/file.ts',
    });
    expect(long.startsWith('…/')).toBe(true);
    expect(long).toContain('file.ts');
  });

  test('Grep/Glob 带 pattern 与范围', () => {
    expect(summarizeToolArgs('Grep', { pattern: 'TODO', path: '/src' })).toBe('TODO in /src');
    expect(summarizeToolArgs('Glob', { pattern: '*.ts' })).toBe('*.ts');
  });

  test('多行命令压成单行', () => {
    expect(summarizeToolArgs('Bash', { command: 'echo a\necho b' })).toBe('echo a echo b');
  });

  test('超长参数截断', () => {
    const result = summarizeToolArgs('Bash', { command: 'x'.repeat(500) });
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith('…')).toBe(true);
  });

  test('未知工具降级到第一个字符串字段', () => {
    expect(summarizeToolArgs('mcp__dune__searchDocs', { query: 'ethereum' })).toBe(
      'query: ethereum',
    );
  });

  test('无字符串字段时给字段名列表', () => {
    expect(summarizeToolArgs('WeirdTool', { count: 3, flag: true })).toBe('count, flag');
  });

  test('空输入/非对象不抛错', () => {
    expect(() => summarizeToolArgs('X', undefined)).not.toThrow();
    expect(summarizeToolArgs('X', undefined)).toBe('');
    expect(summarizeToolArgs('X', null)).toBe('');
    expect(summarizeToolArgs('X', {})).toBe('');
  });
});

describe('summarizeToolResult', () => {
  test('正常结果 → ok', () => {
    const { status, resultSummary } = summarizeToolResult('Bash', {
      text: 'done',
      isError: false,
      durationMs: 820,
    });
    expect(status).toBe('ok');
    expect(resultSummary).toContain('✓');
    expect(resultSummary).toContain('820ms');
  });

  test('isError → error', () => {
    const { status, resultSummary } = summarizeToolResult('Bash', {
      text: 'command not found',
      isError: true,
      durationMs: 100,
    });
    expect(status).toBe('error');
    expect(resultSummary).toContain('✗');
  });

  test('结果里有 failed → warn', () => {
    const { status, resultSummary } = summarizeToolResult('Bash', {
      text: '3 passed, 1 failed',
      isError: false,
      durationMs: 3_500,
    });
    expect(status).toBe('warn');
    expect(resultSummary).toContain('1 failed');
    expect(resultSummary).toContain('3.5s');
  });

  test('diff stat 被识别', () => {
    const { resultSummary } = summarizeToolResult('Edit', {
      text: 'applied +9 −2',
      isError: false,
      durationMs: 50,
    });
    expect(resultSummary).toContain('+9 −2');
  });

  test('非编辑类工具的输出里出现 +N −N 不被误报成 diff stat', () => {
    // Bash 输出里一段普通文本/算式里的 `+3 -1` 不该被当成 diff 统计
    const { resultSummary } = summarizeToolResult('Bash', {
      text: 'score changed by +3 -1 over the window',
      isError: false,
      durationMs: 50,
    });
    expect(resultSummary).not.toContain('+3 −1');
  });

  test('Grep 结果给匹配条数', () => {
    const { resultSummary } = summarizeToolResult('Grep', {
      text: 'a.ts:1\nb.ts:2\nc.ts:3',
      isError: false,
      durationMs: 10,
    });
    expect(resultSummary).toContain('3 条匹配');
  });
});

describe('formatDuration', () => {
  test('三档格式', () => {
    expect(formatDuration(820)).toBe('820ms');
    expect(formatDuration(3_500)).toBe('3.5s');
    expect(formatDuration(130_000)).toBe('2m10s');
  });
});

describe('outputPreview', () => {
  test('空结果不给 preview', () => {
    expect(outputPreview('')).toBeUndefined();
  });

  test('短结果原样', () => {
    expect(outputPreview('short')).toBe('short');
  });

  test('长结果保留尾部并加省略前缀', () => {
    const preview = outputPreview('a'.repeat(3000) + 'TAIL');
    expect(preview!.startsWith('…')).toBe(true);
    expect(preview!.endsWith('TAIL')).toBe(true);
    expect(preview!.length).toBeLessThan(3000);
  });
});

describe('toSingleLine', () => {
  test('折叠空白', () => {
    expect(toSingleLine('  a \n\t b  ')).toBe('a b');
  });
});

describe('后台任务相关摘要', () => {
  test('Bash run_in_background → 参数摘要带「后台」标记；结果摘要换成「已在后台运行 · id」', () => {
    expect(summarizeToolArgs('Bash', { command: 'sleep 25 && echo BG_DONE', run_in_background: true })).toBe('后台 · sleep 25 && echo BG_DONE');
    expect(summarizeToolArgs('Bash', { command: 'ls', run_in_background: false })).toBe('ls');
    const r = summarizeToolResult('Bash', {
      text: 'Command running in background with ID: bd4zj554r. Output is being written to: /tmp/x/tasks/bd4zj554r.output. You will be notified when it completes. To check interim output, use Read on that file path.',
      isError: false,
      durationMs: 300,
    });
    expect(r).toEqual({ status: 'ok', resultSummary: '✓ 已在后台运行 · bd4zj554r' });
    // 普通 Bash 结果不受影响
    expect(summarizeToolResult('Bash', { text: 'hello', isError: false, durationMs: 10 }).resultSummary).toBe('✓ hello · 10ms');
  });

  test('Agent run_in_background → 参数摘要带「后台」；结果「后台子 agent 已启动」', () => {
    expect(summarizeToolArgs('Agent', { description: '后台执行 sleep 并回报', prompt: 'x', run_in_background: true })).toBe('后台 · 后台执行 sleep 并回报');
    const r = summarizeToolResult('Agent', {
      text: 'Async agent launched successfully. (This tool result is internal metadata — never quote…)\nagentId: afef8add13fcef5a0',
      isError: false,
      durationMs: 300,
    });
    expect(r).toEqual({ status: 'ok', resultSummary: '✓ 后台子 agent 已启动' });
  });

  test('TaskOutput / TaskStop 参数摘要', () => {
    expect(summarizeToolArgs('TaskOutput', { task_id: 'bd4zj554r' })).toBe('bd4zj554r');
    expect(summarizeToolArgs('TaskOutput', { task_id: 'bd4zj554r', block: true, timeout: 30_000 })).toBe('bd4zj554r · 等待完成 · 30.0s');
    expect(summarizeToolArgs('BashOutput', { bash_id: 'b1' })).toBe('b1');
    expect(summarizeToolArgs('TaskStop', { task_id: 'bnhjy1pyc' })).toBe('stop bnhjy1pyc');
  });
});

describe('子 agent 结果（Agent / Task）', () => {
  test('subagentRunStats：结构化优先，<usage> 块兜底；都没有 undefined', () => {
    expect(subagentRunStats({ status: 'completed', totalToolUseCount: 3, totalDurationMs: 18288 }, '')).toEqual({ toolUses: 3, durationMs: 18288 });
    expect(subagentRunStats(undefined, 'x\n<usage>subagent_tokens: 1\ntool_uses: 0\nduration_ms: 900</usage>')).toEqual({ toolUses: 0, durationMs: 900 });
    // 非 completed（如后台启动）的结构化输出不当完成统计
    expect(subagentRunStats({ status: 'async_launched', totalToolUseCount: 0 }, '')).toBeUndefined();
    expect(subagentRunStats(undefined, 'no usage here')).toBeUndefined();
  });

  test('摘要：✓ N 次工具调用 · 耗时；报告里的 warning 字样不判 warn；失败仍走 ✗', () => {
    expect(
      summarizeToolResult('Agent', { text: 'warning: foo\n<usage>tool_uses: 2\nduration_ms: 1500</usage>', isError: false, durationMs: 9 }),
    ).toEqual({ status: 'ok', resultSummary: '✓ 2 次工具调用 · 1.5s' });
    expect(summarizeToolResult('Task', { text: '', isError: false, durationMs: 700, structured: { totalToolUseCount: 1 } })).toEqual({
      status: 'ok',
      resultSummary: '✓ 1 次工具调用 · 700ms',
    });
    expect(summarizeToolResult('Agent', { text: 'boom', isError: true, durationMs: 1000 }).status).toBe('error');
  });

  test('subagentReportText：认不出格式原样返回', () => {
    expect(subagentReportText(undefined, 'plain text')).toBe('plain text');
  });
});

describe('后台子 agent（评审 M1）', () => {
  test('backgroundSubagentEnd：completed / failed / stopped；缺 usage 也有摘要', () => {
    expect(backgroundSubagentEnd('completed', { tool_uses: 3, duration_ms: 18_288 }, '报告')).toEqual({
      status: 'ok',
      durationMs: 18_288,
      resultSummary: '✓ 3 次工具调用 · 18.3s',
      outputPreview: '报告',
    });
    expect(backgroundSubagentEnd('failed', { tool_uses: 1 }, '')).toEqual({ status: 'error', durationMs: 0, resultSummary: '✗ 子 agent 失败 · 1 次工具调用' });
    expect(backgroundSubagentEnd('stopped', undefined, undefined)).toEqual({ status: 'warn', durationMs: 0, resultSummary: '⏹ 子 agent 已停止' });
    expect(backgroundSubagentEnd('completed', undefined, undefined).resultSummary).toBe('✓ 子 agent 已完成');
  });

  test('subagentReportText：后台启动回执（内部元数据）剥成空串', () => {
    expect(subagentReportText({ status: 'async_launched' }, 'whatever')).toBe('');
    expect(subagentReportText(undefined, 'Async agent launched successfully. (This tool result is internal metadata …)')).toBe('');
  });
});

describe('toolFilePath', () => {
  test('文件类工具给完整路径，其余 undefined', () => {
    const long = `/w/${'a/'.repeat(40)}plan.md`;
    expect(toolFilePath('Read', { file_path: long })).toBe(long);
    expect(toolFilePath('Edit', { file_path: '/w/a.ts' })).toBe('/w/a.ts');
    expect(toolFilePath('NotebookEdit', { notebook_path: '/w/n.ipynb' })).toBe('/w/n.ipynb');
    expect(toolFilePath('Bash', { command: 'cat /w/a.ts' })).toBeUndefined();
    expect(toolFilePath('Read', {})).toBeUndefined();
    expect(withFilePath('Grep', { pattern: 'x' })).toEqual({});
    expect(withFilePath('Write', { file_path: '/w/b.md' })).toEqual({ filePath: '/w/b.md' });
  });
});
