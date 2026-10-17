/**
 * 错误分类（黑名单策略）。
 *
 * 核心断言：**没列进黑名单的一律 retryable**——这是黑名单设计的全部意义，
 * 上游文案变了也不会让任务静默卡死。
 */
import { describe, expect, test } from 'bun:test';
import {
  classifyError,
  classifyResultSubtype,
  errorText,
  isAbortError,
} from './errors.ts';

describe('classifyError · fatal 黑名单', () => {
  test('认证类 → auth', () => {
    for (const message of [
      'Invalid API key',
      'authentication_error: bad credentials',
      'OAuth token has expired, please run /login',
    ]) {
      const result = classifyError(new Error(message));
      expect(result.retryable).toBe(false);
      expect(result).toMatchObject({ kind: 'auth' });
    }
  });

  test('额度类 → quota', () => {
    const result = classifyError(new Error('Usage limit reached for your plan'));
    expect(result).toMatchObject({ retryable: false, kind: 'quota' });
  });

  test('配置类 → config', () => {
    const result = classifyError(new Error('foo is not a valid model'));
    expect(result).toMatchObject({ retryable: false, kind: 'config' });
  });

  test('大小写不敏感', () => {
    expect(classifyError(new Error('INVALID API KEY'))).toMatchObject({ kind: 'auth' });
  });
});

describe('classifyError · 瞬时（默认可重试）', () => {
  test('网络/5xx/进程崩一律可重试', () => {
    for (const message of [
      'socket hang up',
      'ECONNRESET',
      'Internal server error (500)',
      'stream closed unexpectedly',
      'claude process exited with code 1',
    ]) {
      const result = classifyError(new Error(message));
      expect(result.retryable).toBe(true);
    }
  });

  test('对抗性输入：fatal 关键词嵌在 URL/JSON/工具输出里不得误判', () => {
    // 分类输入是上游任意错误文本（result.errors 拼接），里面会嵌工具输出、
    // URL、JSON 片段。宽泛子串曾让这 6 条全部误判成 fatal——而误判 fatal
    // 的代价是任务停死 + 错误归因，与黑名单设计的初衷正好相反。
    const mustRetry = [
      // 'billing' 出现在 URL 路径里
      'Connection reset while fetching https://api.stripe.com/v1/billing/meters',
      // 工具读了个不存在的文件，任务本可以继续
      "ENOENT: no such file or directory, open '/tmp/scratch-123'",
      // 5xx 的响应体里带 invalid_request_error 字样
      '500 Internal Server Error: {"type":"invalid_request_error"}',
      // 代理层的 unauthorized，不是我们的认证失败
      'upstream connect error: unauthorized proxy CONNECT',
      '503 Service Unavailable',
      'Error: socket hang up while reading response',
    ];
    for (const message of mustRetry) {
      const result = classifyError(new Error(message));
      expect({ message, retryable: result.retryable }).toEqual({
        message,
        retryable: true,
      });
    }
  });

  test('真正的 fatal 仍被正确识别（收紧后没有矫枉过正）', () => {
    expect(classifyError(new Error('billing_error: card declined'))).toMatchObject({
      retryable: false,
      kind: 'quota',
    });
    expect(classifyError(new Error('401 Unauthorized'))).toMatchObject({
      retryable: false,
      kind: 'auth',
    });
    expect(classifyError(new Error('spawn claude ENOENT'))).toMatchObject({
      retryable: false,
      kind: 'config',
    });
  });

  test('陌生的新错误文案默认可重试（黑名单策略的关键）', () => {
    const result = classifyError(new Error('some brand new upstream wording nobody has seen'));
    expect(result).toEqual({
      retryable: true,
      reason: 'some brand new upstream wording nobody has seen',
    });
  });
});

describe('classifyError · retryAt 提取', () => {
  test('ISO 时间可解析', () => {
    const result = classifyError(
      new Error('Usage limit reached. Your limit will reset at 2026-08-30T15:00:00Z'),
    );
    expect(result).toMatchObject({ retryable: false, kind: 'quota' });
    expect((result as { retryAt?: number }).retryAt).toBe(Date.parse('2026-08-30T15:00:00Z'));
  });

  test('unix 秒级时间戳可解析', () => {
    const result = classifyError(new Error('quota exceeded, resets at 1756500000'));
    expect((result as { retryAt?: number }).retryAt).toBe(1756500000 * 1000);
  });

  test('解析不出就不给 retryAt（不显示错误的倒计时）', () => {
    const result = classifyError(new Error('Usage limit reached, resets at some point'));
    expect(result).toMatchObject({ kind: 'quota' });
    expect((result as { retryAt?: number }).retryAt).toBeUndefined();
  });
});

describe('classifyResultSubtype', () => {
  test('重试有害的三个 subtype 直接判 fatal', () => {
    // 这三类原样重跑必然以同样方式再失败一次，纯烧额度
    expect(classifyResultSubtype('error_max_turns', '')).toMatchObject({
      retryable: false,
      kind: 'config',
    });
    expect(classifyResultSubtype('error_max_budget_usd', '')).toMatchObject({
      retryable: false,
      kind: 'quota',
    });
    expect(
      classifyResultSubtype('error_max_structured_output_retries', ''),
    ).toMatchObject({ retryable: false, kind: 'config' });
  });

  test('泛执行错误交回文本分类', () => {
    expect(classifyResultSubtype('error_during_execution', 'socket hang up')).toBeUndefined();
  });

  test('有 detail 时用 detail 作为消息', () => {
    const result = classifyResultSubtype('error_max_turns', '具体原因');
    expect(result).toMatchObject({ message: '具体原因' });
  });
});

describe('errorText / isAbortError', () => {
  test('errorText 处理各种输入', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('plain string')).toBe('plain string');
    expect(errorText({ code: 42 })).toContain('42');
  });

  test('isAbortError 只认 AbortError 这个 name', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(isAbortError(abort)).toBe(true);
    expect(isAbortError(new Error('normal failure'))).toBe(false);
  });

  test('含 aborted 字样的上游瞬时错误不算主动中止（否则会被静默吞掉）', () => {
    // 早先用 message.includes('aborted') 判断，这些全被误判成「用户主动中止」，
    // 结果是不发任何事件、不续跑、状态直接回 idle——任务凭空消失
    for (const message of [
      'Request aborted by upstream gateway after 30s',
      'The connection was aborted due to a network error',
      'transaction aborted, please retry',
    ]) {
      expect(isAbortError(new Error(message))).toBe(false);
      // 且必须被判成可重试，才会走自动续跑
      expect(classifyError(new Error(message)).retryable).toBe(true);
    }
  });

  test('给了本端 signal 时以 signal 为准', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';

    const controller = new AbortController();
    // 我们没 abort 过 → 不认（说明是上游自己抛的 AbortError）
    expect(isAbortError(abort, controller.signal)).toBe(false);

    controller.abort();
    expect(isAbortError(abort, controller.signal)).toBe(true);
  });
});
