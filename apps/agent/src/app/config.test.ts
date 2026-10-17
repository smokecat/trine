import { describe, expect, test } from 'bun:test';
import { ConfigError, DEFAULT_MODEL, agentPaths, loadAgentConfig } from './config.ts';

const env = { TRINE_SERVER: 'https://relay.example' };

describe('loadAgentConfig', () => {
  test('最小配置：env 给 server，其余默认', () => {
    const config = loadAgentConfig([], env);
    expect(config.serverUrl).toBe('https://relay.example');
    expect(config.pair).toBe(false);
    expect(config.home.endsWith('/.trine')).toBe(true);
    expect(config.defaultModel).toBe(DEFAULT_MODEL);
    expect(config.maxSessions).toBeUndefined();
    expect(config.idleTimeoutMs).toBeUndefined();
    expect(config.name).toBeUndefined();
    expect(config.claudeBin).toBeUndefined();
  });

  test('--claude-bin 覆盖 TRINE_CLAUDE_BIN；空白当未设', () => {
    expect(loadAgentConfig(['--claude-bin', '/opt/claude'], { ...env, TRINE_CLAUDE_BIN: '/ignored' }).claudeBin).toBe(
      '/opt/claude',
    );
    expect(loadAgentConfig([], { ...env, TRINE_CLAUDE_BIN: ' /usr/local/bin/claude ' }).claudeBin).toBe(
      '/usr/local/bin/claude',
    );
    expect(loadAgentConfig([], { ...env, TRINE_CLAUDE_BIN: '  ' }).claudeBin).toBeUndefined();
    expect(() => loadAgentConfig(['--claude-bin'], env)).toThrow(ConfigError);
  });

  test('argv 覆盖 env；三种写法都收', () => {
    const config = loadAgentConfig(
      ['--pair', '--server', 'wss://a.example', '--home=/tmp/h', '--name', 'MBP'],
      { ...env, TRINE_HOME: '/ignored', TRINE_NAME: 'ignored' },
    );
    expect(config).toMatchObject({
      pair: true,
      serverUrl: 'wss://a.example',
      home: '/tmp/h',
      name: 'MBP',
    });
  });

  test('env 里的数值项与模型', () => {
    const config = loadAgentConfig([], {
      ...env,
      TRINE_DEFAULT_MODEL: ' claude-opus-4 ',
      TRINE_MAX_SESSIONS: '3',
      TRINE_IDLE_TIMEOUT_MS: '60000',
    });
    expect(config.defaultModel).toBe('claude-opus-4');
    expect(config.maxSessions).toBe(3);
    expect(config.idleTimeoutMs).toBe(60_000);
  });

  test('缺 server / 非法 URL / 坏数值 / 未知开关都报 ConfigError', () => {
    expect(() => loadAgentConfig([], {})).toThrow(ConfigError);
    expect(() => loadAgentConfig(['--server', 'not a url'], {})).toThrow(ConfigError);
    expect(() => loadAgentConfig([], { ...env, TRINE_MAX_SESSIONS: '0' })).toThrow(ConfigError);
    expect(() => loadAgentConfig([], { ...env, TRINE_MAX_SESSIONS: 'x' })).toThrow(ConfigError);
    // 拼错的开关不能被静默吞掉
    expect(() => loadAgentConfig(['--sever', 'x'], env)).toThrow(ConfigError);
    expect(() => loadAgentConfig(['positional'], env)).toThrow(ConfigError);
    expect(() => loadAgentConfig(['--server'], env)).toThrow(ConfigError);
    expect(() => loadAgentConfig(['--pair=yes'], env)).toThrow(ConfigError);
  });

  test('agentPaths 固定文件名', () => {
    expect(agentPaths('/h')).toEqual({
      identity: '/h/identity.json',
      recipients: '/h/recipients.json',
      state: '/h/state.json',
      cwd: '/h/cwd.json',
      sessions: '/h/sessions.json',
    });
  });
});

describe('enrollment CLI configuration', () => {
  test('--enroll accepts no secret argument and unsafe URLs are rejected without echoing them', () => {
    expect(loadAgentConfig(['--enroll'], env).enroll).toBe(true);
    expect(() => loadAgentConfig(['--enroll=secret'], env)).toThrow('--enroll 不接受值');
    for (const url of ['http://relay.example', 'https://user:secret@relay.example', 'https://relay.example?secret=private']) {
      try {
        loadAgentConfig(['--server', url], {});
        throw new Error('unsafe URL was accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect(String(error)).not.toContain('private');
        expect(String(error)).not.toContain('user:secret');
      }
    }
  });
});
