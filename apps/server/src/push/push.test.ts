/**
 * 推送层单测：脱敏、在线抑制、去抖、超时重试。
 *
 * 全部用注入的 fake channel / fake fetch / 手动时钟——**没有一处真睡、
 * 没有一次真网络请求**。真机 Bark 推送验证不在本轮（device key 不在手上）。
 */
import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../config.ts';
import { BarkChannel, NonRetryableError } from './bark.ts';
import { PushDispatcher, type DispatcherOptions } from './dispatcher.ts';
import { createPushDispatcher } from './index.ts';
import { machineLabel, parseAliases, renderPushMessage } from './text.ts';
import type { PushChannel, PushEvent, PushMessage } from './types.ts';

/** 记录投递内容的测试替身 */
class FakeChannel implements PushChannel {
  readonly name = 'fake';
  readonly sent: PushMessage[] = [];
  failWith: Error | null = null;

  async send(message: PushMessage): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
  }
}

function event(over: Partial<PushEvent> = {}): PushEvent {
  return {
    machineId: 'a1b2c3d4e5f6',
    hint: 'run_done',
    at: 1_000,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('文案渲染与脱敏（D6 硬约束）', () => {
  test('推送内容只有机器标识与事件类型固定文案', () => {
    const msg = renderPushMessage(event({ hint: 'permission_pending' }));
    expect(msg.title).toBe('a1b2c3d4');
    expect(msg.body).toBe('等待权限确认');
    expect(msg.group).toBe('a1b2c3d4');
    // 结构里就没有第四个字段——没有正文可填的地方
    expect(Object.keys(msg).sort()).toEqual(['body', 'group', 'title']);
  });

  test('三种事件类型各有固定中文文案', () => {
    expect(renderPushMessage(event({ hint: 'run_done' })).body).toBe('任务完成');
    expect(renderPushMessage(event({ hint: 'run_error' })).body).toBe(
      '任务出错',
    );
    expect(renderPushMessage(event({ hint: 'permission_pending' })).body).toBe(
      '等待权限确认',
    );
  });

  test('提问 / 计划两类挂起请求各有固定文案（只有事件类型，不带正文）', () => {
    const q = renderPushMessage(event({ hint: 'question_pending' }));
    expect(q.body).toBe('Claude 在提问');
    expect(Object.keys(q).sort()).toEqual(['body', 'group', 'title']);
    expect(renderPushMessage(event({ hint: 'plan_pending' })).body).toBe('等待批准计划');
  });

  test('machineId 默认只取 8 字符短前缀，不泄露完整标识', () => {
    expect(machineLabel('a1b2c3d4e5f6g7h8')).toBe('a1b2c3d4');
    // 短于 8 的照原样，不补齐
    expect(machineLabel('mbp')).toBe('mbp');
  });

  test('别名命中时用用户配置的明文名', () => {
    const aliases = { a1b2c3d4e5f6: 'mbp' };
    expect(renderPushMessage(event(), aliases).title).toBe('mbp');
    // 未配别名的机器仍退回短前缀
    expect(renderPushMessage(event({ machineId: 'zzzz9999' }), aliases).title)
      .toBe('zzzz9999');
  });

  test('sessionId 参与去抖但绝不进推送内容', () => {
    const msg = renderPushMessage(
      event({ sessionId: '秘密会话名-可能含隐私' }),
    );
    expect(JSON.stringify(msg)).not.toContain('秘密会话名');
  });

  test('别名解析：逗号分隔，非法条目跳过而不炸', () => {
    expect(parseAliases('aaa=mbp, bbb = vps ')).toEqual({
      aaa: 'mbp',
      bbb: 'vps',
    });
    expect(parseAliases('=空key,没有等号,ccc=')).toEqual({});
    expect(parseAliases(undefined)).toEqual({});
  });

  test('按第一个 = 切分：别名值里可以有 =（文档承诺）', () => {
    expect(parseAliases('aaa=m=b=p')).toEqual({ aaa: 'm=b=p' });
  });

  test('别名值含逗号会被截断——这是文档里写明的格式限制', () => {
    expect(parseAliases('aaa=m,b')).toEqual({ aaa: 'm' });
  });
});

// ---------------------------------------------------------------------------

describe('分发判定', () => {
  function setup(over: Partial<DispatcherOptions> = {}) {
    const channel = new FakeChannel();
    const dispatcher = new PushDispatcher({
      suppressWhenOnline: false,
      dedupeWindowMs: 0,
      ...over,
    });
    dispatcher.register(channel);
    return { channel, dispatcher };
  }

  test('未注册渠道时静默禁用', () => {
    const dispatcher = new PushDispatcher();
    expect(dispatcher.enabled).toBe(false);
    expect(dispatcher.dispatch(event())).toEqual({
      kind: 'skipped',
      reason: 'no_channel',
    });
  });

  test('正常投递把渲染后的消息交给渠道', async () => {
    const { channel, dispatcher } = setup({});
    expect(dispatcher.dispatch(event())).toEqual({ kind: 'sent', channels: 1 });
    await Promise.resolve();
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]!.body).toBe('任务完成');
  });

  test('在线抑制：有 client 在线时不推', () => {
    let online = true;
    const { channel, dispatcher } = setup({
      suppressWhenOnline: true,
      hasOnlineClient: () => online,
    });
    expect(dispatcher.dispatch(event())).toEqual({
      kind: 'skipped',
      reason: 'client_online',
    });
    expect(channel.sent).toHaveLength(0);

    online = false;
    expect(dispatcher.dispatch(event()).kind).toBe('sent');
  });

  test('在线抑制可关闭', () => {
    const { dispatcher } = setup({
      suppressWhenOnline: false,
      hasOnlineClient: () => true,
    });
    expect(dispatcher.dispatch(event()).kind).toBe('sent');
  });

  test('被抑制的事件不占去抖名额（下线后第一条仍能推出去）', () => {
    let online = true;
    let clock = 0;
    const { dispatcher } = setup({
      suppressWhenOnline: true,
      hasOnlineClient: () => online,
      dedupeWindowMs: 30_000,
      now: () => clock,
    });
    expect(dispatcher.dispatch(event())).toEqual({
      kind: 'skipped',
      reason: 'client_online',
    });
    clock += 1_000;
    online = false;
    // 若抑制时记了去抖，这条会被误判 deduped
    expect(dispatcher.dispatch(event()).kind).toBe('sent');
  });
});

// ---------------------------------------------------------------------------

describe('去抖（防权限请求风暴刷屏）', () => {
  function setup(windowMs = 30_000) {
    let clock = 0;
    const channel = new FakeChannel();
    const dispatcher = new PushDispatcher({
      suppressWhenOnline: false,
      dedupeWindowMs: windowMs,
      now: () => clock,
    });
    dispatcher.register(channel);
    return {
      channel,
      dispatcher,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  test('窗口内同一 (machine, session, hint) 只推一次', () => {
    const { dispatcher, advance, channel } = setup();
    const e = event({ sessionId: 's1', hint: 'permission_pending' });
    expect(dispatcher.dispatch(e).kind).toBe('sent');
    for (let i = 0; i < 10; i++) {
      advance(1_000);
      expect(dispatcher.dispatch(e)).toEqual({
        kind: 'skipped',
        reason: 'deduped',
      });
    }
    expect(channel.sent).toHaveLength(1);
  });

  test('窗口过后重新放行', () => {
    const { dispatcher, advance } = setup(30_000);
    const e = event({ sessionId: 's1' });
    expect(dispatcher.dispatch(e).kind).toBe('sent');
    advance(29_999);
    expect(dispatcher.dispatch(e).kind).toBe('skipped');
    advance(1);
    expect(dispatcher.dispatch(e).kind).toBe('sent');
  });

  test('不同会话 / 不同事件类型 / 不同机器各自成桶', () => {
    const { dispatcher } = setup();
    expect(dispatcher.dispatch(event({ sessionId: 's1' })).kind).toBe('sent');
    // 同机器同 hint，另一个会话——是另一件事，该通知
    expect(dispatcher.dispatch(event({ sessionId: 's2' })).kind).toBe('sent');
    // 同会话另一种事件
    expect(
      dispatcher.dispatch(event({ sessionId: 's1', hint: 'run_error' })).kind,
    ).toBe('sent');
    // 另一台机器
    expect(
      dispatcher.dispatch(event({ sessionId: 's1', machineId: 'other' })).kind,
    ).toBe('sent');
  });

  test('窗口为 0 时关闭去抖', () => {
    const { dispatcher } = setup(0);
    const e = event({ sessionId: 's1' });
    expect(dispatcher.dispatch(e).kind).toBe('sent');
    expect(dispatcher.dispatch(e).kind).toBe('sent');
  });

  test('无 sessionId 的机器级事件也能去抖', () => {
    const { dispatcher } = setup();
    expect(dispatcher.dispatch(event()).kind).toBe('sent');
    expect(dispatcher.dispatch(event()).kind).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------

describe('渠道失败不影响主链路', () => {
  test('渠道抛错走 onError，dispatch 本身不抛', async () => {
    const channel = new FakeChannel();
    channel.failWith = new Error('bark down');
    const errors: string[] = [];
    const dispatcher = new PushDispatcher({
      suppressWhenOnline: false,
      dedupeWindowMs: 0,
      onError: (name, err) =>
        errors.push(`${name}:${(err as Error).message}`),
    });
    dispatcher.register(channel);

    // 同步返回，不抛
    expect(() => dispatcher.dispatch(event())).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toEqual(['fake:bark down']);
  });

  test('onError 自身抛出不会变成 unhandled rejection', async () => {
    // console.info 在 fd 异常时会抛；那是在 Promise 的 catch 回调里，
    // 抛出去就是没人接的 rejection
    const channel = new FakeChannel();
    channel.failWith = new Error('投递失败');
    const dispatcher = new PushDispatcher({
      suppressWhenOnline: false,
      dedupeWindowMs: 0,
      onError: () => {
        throw new Error('日志管道也坏了');
      },
    });
    dispatcher.register(channel);

    const rejections: unknown[] = [];
    const onUnhandled = (err: unknown) => rejections.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      expect(() => dispatcher.dispatch(event())).not.toThrow();
      // 给微任务队列跑完的机会
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(rejections).toEqual([]);
  });

  test('渠道同步抛出不会打穿到调用方（WS 消息处理器无 try/catch）', () => {
    const rude: PushChannel = {
      name: 'rude',
      // 违反接口约定的实现：入口就同步抛
      send: () => {
        throw new Error('同步抛了');
      },
    };
    const errors: string[] = [];
    const dispatcher = new PushDispatcher({
      suppressWhenOnline: false,
      dedupeWindowMs: 0,
      onError: (name) => errors.push(name),
    });
    dispatcher.register(rude);
    expect(() => dispatcher.dispatch(event())).not.toThrow();
    expect(errors).toEqual(['dispatch']);
  });

  test('dispatch 是同步的：不会把主链路挂在慢渠道上', () => {
    let released!: () => void;
    const slow: PushChannel = {
      name: 'slow',
      send: () => new Promise<void>((resolve) => (released = resolve)),
    };
    const dispatcher = new PushDispatcher({
      suppressWhenOnline: false,
      dedupeWindowMs: 0,
    });
    dispatcher.register(slow);
    const started = Date.now();
    expect(dispatcher.dispatch(event()).kind).toBe('sent');
    // 渠道还挂着，dispatch 已经回来了
    expect(Date.now() - started).toBeLessThan(50);
    released();
  });
});

// ---------------------------------------------------------------------------

describe('Bark 渠道', () => {
  /** fake fetch：按预设脚本依次响应，记录每次请求 */
  function fakeFetch(script: (Response | Error)[]) {
    const calls: { url: string; body: unknown; hasSignal: boolean }[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const step = script[calls.length];
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')),
        hasSignal: Boolean(init?.signal),
      });
      if (step instanceof Error) throw step;
      return step ?? new Response('', { status: 500 });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  function channel(
    script: (Response | Error)[],
    over: Partial<ConstructorParameters<typeof BarkChannel>[0]> = {},
  ) {
    const { impl, calls } = fakeFetch(script);
    const slept: number[] = [];
    const ch = new BarkChannel({
      serverUrl: 'https://api.day.app',
      deviceKey: 'SECRET-KEY',
      fetchImpl: impl,
      sleep: async (ms) => {
        slept.push(ms);
      },
      ...over,
    });
    return { ch, calls, slept };
  }

  const message: PushMessage = {
    title: 'mbp',
    body: '任务完成',
    group: 'mbp',
  };

  test('payload 只含机器标识、事件文案与渠道常量', () => {
    const { ch } = channel([]);
    const payload = ch.buildPayload(message);
    expect(payload).toEqual({
      device_key: 'SECRET-KEY',
      title: 'mbp',
      body: '任务完成',
      group: 'mbp',
      call: '0',
      isArchive: '1',
    });
    // 逐字段自查：不该出现的键一个都没有
    for (const forbidden of [
      'ciphertext',
      'nonce',
      'sessionId',
      'session_id',
      'cwd',
      'text',
      'content',
    ]) {
      expect(payload).not.toHaveProperty(forbidden);
    }
  });

  test('POST 到 <server>/push，device key 不进 URL', async () => {
    const { ch, calls } = channel([new Response('', { status: 200 })]);
    await ch.send(message);
    expect(calls[0]!.url).toBe('https://api.day.app/push');
    expect(calls[0]!.url).not.toContain('SECRET-KEY');
  });

  test('serverUrl 末尾多余斜杠被规整', async () => {
    const { ch, calls } = channel([new Response('', { status: 200 })], {
      serverUrl: 'https://bark.example.com///',
    });
    await ch.send(message);
    expect(calls[0]!.url).toBe('https://bark.example.com/push');
  });

  test('每次请求都带超时 signal（不会永久定格）', async () => {
    const { ch, calls } = channel([new Response('', { status: 200 })]);
    await ch.send(message);
    expect(calls[0]!.hasSignal).toBe(true);
  });

  test('5xx 按 1s/3s 退避重试 2 次后放弃', async () => {
    const { ch, calls, slept } = channel([
      new Response('', { status: 502 }),
      new Response('', { status: 503 }),
      new Response('', { status: 500 }),
    ]);
    await expect(ch.send(message)).rejects.toThrow(/status=500/);
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([1_000, 3_000]);
  });

  test('中途成功即停，不再重试', async () => {
    const { ch, calls, slept } = channel([
      new Response('', { status: 500 }),
      new Response('', { status: 200 }),
    ]);
    await ch.send(message);
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([1_000]);
  });

  test('网络错误（含超时中断）同样重试', async () => {
    const { ch, calls } = channel([
      new Error('The operation timed out'),
      new Error('connect ECONNREFUSED'),
      new Response('', { status: 200 }),
    ]);
    await ch.send(message);
    expect(calls).toHaveLength(3);
  });

  test('4xx 不重试——device key 写错重试多少次都是错的', async () => {
    const { ch, calls, slept } = channel([
      new Response('', { status: 400 }),
      new Response('', { status: 200 }),
    ]);
    await expect(ch.send(message)).rejects.toThrow(/status=400/);
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  test('4xx 的放弃信号是类型而非错误消息文本', async () => {
    const { ch } = channel([new Response('', { status: 403 })]);
    await expect(ch.send(message)).rejects.toBeInstanceOf(NonRetryableError);
  });

  test('消息里带「不重试」字样的普通错误仍然重试满 3 次', async () => {
    // 回归：曾用 err.message.includes('不重试') 判定放弃，自建
    // bark-server 的中文错误页 / 企业代理的中文报错会误触发，
    // 导致本该重试的网络故障被静默跳过
    const { ch, calls, slept } = channel([
      new Error('代理返回：上游不可达，不重试'),
      new Error('代理返回：上游不可达，不重试'),
      new Error('代理返回：上游不可达，不重试'),
    ]);
    await expect(ch.send(message)).rejects.toThrow(/上游不可达/);
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([1_000, 3_000]);
  });

  test('失败日志不含 device key', async () => {
    const lines: string[] = [];
    const { ch } = channel(
      [new Response('', { status: 500 }), new Response('', { status: 500 })],
      { retryDelaysMs: [1], log: (l) => lines.push(l) },
    );
    await expect(ch.send(message)).rejects.toThrow();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain('SECRET-KEY');
  });
});

// ---------------------------------------------------------------------------

describe('按配置装配', () => {
  test('未配 Bark 时 dispatcher 禁用', () => {
    const dispatcher = createPushDispatcher({
      config: loadConfig({ barkServerUrl: '', barkDeviceKey: '' }),
      hasOnlineClient: () => false,
    });
    expect(dispatcher.enabled).toBe(false);
    expect(dispatcher.channelNames).toEqual([]);
  });

  test('配齐 Bark 时注册渠道', () => {
    const dispatcher = createPushDispatcher({
      config: loadConfig({
        barkServerUrl: 'https://api.day.app',
        barkDeviceKey: 'k',
      }),
      hasOnlineClient: () => false,
    });
    expect(dispatcher.enabled).toBe(true);
    expect(dispatcher.channelNames).toEqual(['bark']);
  });

  test('装配时打印已加载的别名 key，便于对照发现拼错', () => {
    const lines: string[] = [];
    createPushDispatcher({
      config: loadConfig({ pushAliases: 'aaa=mbp,bbb=vps' }),
      hasOnlineClient: () => false,
      log: (l) => lines.push(l),
    });
    const line = lines.find((l) => l.includes('机器别名'));
    expect(line).toContain('2 条');
    expect(line).toContain('aaa');
    expect(line).toContain('bbb');
  });

  test('无别名时不打这行日志', () => {
    const lines: string[] = [];
    createPushDispatcher({
      config: loadConfig({ pushAliases: '' }),
      hasOnlineClient: () => false,
      log: (l) => lines.push(l),
    });
    expect(lines.find((l) => l.includes('机器别名'))).toBeUndefined();
  });

  test('别名配置贯通到文案', async () => {
    const dispatcher = createPushDispatcher({
      config: loadConfig({
        pushAliases: 'a1b2c3d4e5f6=mbp',
        pushSuppressWhenOnline: false,
        pushDedupeWindowMs: 0,
      }),
      hasOnlineClient: () => false,
    });
    const channel = new FakeChannel();
    dispatcher.register(channel);
    dispatcher.dispatch(event());
    await Promise.resolve();
    expect(channel.sent[0]!.title).toBe('mbp');
  });
});

describe('推送配置不变量', () => {
  test('只配一半的 Bark 拒绝启动', () => {
    expect(() => loadConfig({ barkServerUrl: 'https://api.day.app' })).toThrow(
      /TRINE_BARK_KEY/,
    );
    expect(() => loadConfig({ barkDeviceKey: 'k' })).toThrow(/TRINE_BARK_URL/);
  });

  test('非 http(s) 的 Bark 地址拒绝启动', () => {
    expect(() =>
      loadConfig({ barkServerUrl: 'api.day.app', barkDeviceKey: 'k' }),
    ).toThrow(/http/);
  });

  test('两者都留空是合法的（推送可选）', () => {
    expect(() => loadConfig()).not.toThrow();
  });
});
