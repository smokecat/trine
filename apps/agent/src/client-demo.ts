/**
 * 开发用脚本 client：验证 agent 常驻进程的完整链路，也是 web-mvp 客户端逻辑的参考。
 *
 *   # 1. 配对（把 agent --pair 打出的配对码整段粘进来）
 *   bun run apps/agent/src/client-demo.ts --pair 'trine1:....'
 *
 *   # 2. 常规使用（REPL）
 *   bun run apps/agent/src/client-demo.ts
 *     /new [cwd]      新建会话（默认 cwd = 当前目录）并切到它
 *     /use <sid>      切到已知会话
 *     /list           会话列表        /status  当前会话状态
 *     /stop           停止当前任务    /cwd     目录收藏
 *     /quit           退出
 *     y / n           应答挂起中的权限请求
 *     其他任意文本 → input.send 到当前会话
 *
 *   env: TRINE_CLIENT_HOME（默认 ~/.trine-client）TRINE_CLIENT_DEVICE（默认 demo-client）
 *        TRINE_DEMO_MODEL（默认 sonnet）
 *
 * ## 与 agent 侧对称的三件事（web-mvp 也得做）
 *
 * - 入站按 (sessionId) 做 seq 单调校验，游标持久化到 peer.json，重连按游标 sync.request；
 * - c2a 出站 seq 持久化（否则脚本重启即撞 seq_not_monotonic）；
 * - 收到 relay.reject{seq_not_monotonic, expectedAfter} 时跳号重发（与 agent 的 outbox
 *   同款机制，验证 §4c 双向可用；也是多 client 并发 c2a 的收敛方向）；
 *   seq_too_far_ahead 不自愈，明确报错。
 *
 * 密钥文件权限与 agent 一致（0700/0600、tmp+rename）。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { z } from 'zod';
import {
  decodePairingPayload,
  deriveSas,
  generateKeyPair,
  generateSignKeyPair,
  openJson,
  sealJson,
  sodiumReady,
} from '@trine/core/crypto';
import {
  assertEnvelopeBinding,
  AgentToClientEventSchema,
  decodeTransportFrame,
  encodeTransportFrame,
  type AgentToClientEvent,
  type ClientToAgentEvent,
  type TransportFrame,
} from '@trine/core';
import { AuthClient, httpBase, wsEndpoint } from '@trine/core/net';

const HOME = process.env['TRINE_CLIENT_HOME'] ?? join(homedir(), '.trine-client');
const DEVICE_ID = process.env['TRINE_CLIENT_DEVICE'] ?? 'demo-client';
const MODEL = process.env['TRINE_DEMO_MODEL'] ?? 'sonnet';
const IDENTITY_PATH = join(HOME, 'identity.json');
const PEER_PATH = join(HOME, 'peer.json');
/** 出站缓冲每 scope 条数（与 agent outbox 同量级） */
const OUTBOX_CAPACITY = 64;

const color = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

const KeyPairSchema = z.object({ publicKey: z.string().min(1), secretKey: z.string().min(1) });
const IdentitySchema = z.object({
  v: z.literal(1),
  deviceId: z.string().min(1),
  sign: KeyPairSchema,
  box: KeyPairSchema,
});
type Identity = z.infer<typeof IdentitySchema>;

const PeerSchema = z.object({
  v: z.literal(1),
  serverUrl: z.string().min(1),
  machineId: z.string().min(1),
  agentBoxPubKey: z.string().min(1),
  /** scope key（sessionId；机器级空串）→ 最后已用 c2a seq */
  outSeq: z.record(z.string(), z.number().int().nonnegative()),
  /** scope key → 已见最大 a2c seq */
  inCursors: z.record(z.string(), z.number().int().nonnegative()),
  sessions: z.array(z.string()),
  currentSession: z.string().optional(),
});
type Peer = z.infer<typeof PeerSchema>;

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    return schema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`${path} 读取/解析失败：${(err as Error).message}`);
  }
}

async function loadOrCreateIdentity(): Promise<Identity> {
  const existing = await readJson(IDENTITY_PATH, IdentitySchema);
  if (existing) return existing;
  const identity: Identity = {
    v: 1,
    deviceId: DEVICE_ID,
    sign: generateSignKeyPair(),
    box: generateKeyPair(),
  };
  await writeJson(IDENTITY_PATH, identity);
  console.log(color.dim(`已生成 client 身份 ${IDENTITY_PATH}（deviceId=${identity.deviceId}）`));
  return identity;
}

// ---------------------------------------------------------------------------
// WS 小封装：带等待器
// ---------------------------------------------------------------------------

class Socket {
  readonly ws: WebSocket;
  #waiters: { match: (f: TransportFrame) => boolean; resolve: (f: TransportFrame) => void }[] = [];
  onFrame: ((frame: TransportFrame) => void) | undefined = undefined;
  onClose: ((code: number) => void) | undefined = undefined;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      let frame: TransportFrame;
      try {
        frame = decodeTransportFrame(String(ev.data));
      } catch (err) {
        console.log(color.yellow(`⚠ 丢弃无法解析的帧：${(err as Error).message}`));
        return;
      }
      const idx = this.#waiters.findIndex((w) => w.match(frame));
      if (idx >= 0) this.#waiters.splice(idx, 1)[0]!.resolve(frame);
      this.onFrame?.(frame);
    });
    ws.addEventListener('close', (ev) => this.onClose?.(ev.code));
  }

  static async open(url: string, hello: TransportFrame): Promise<Socket> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error(`无法连接 ${url}`)), { once: true });
    });
    ws.send(encodeTransportFrame(hello));
    return new Socket(ws);
  }

  send(frame: TransportFrame): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(encodeTransportFrame(frame));
    return true;
  }

  wait<K extends TransportFrame['type']>(
    type: K,
    match: (f: Extract<TransportFrame, { type: K }>) => boolean = () => true,
    timeoutMs = 5 * 60_000,
  ): Promise<Extract<TransportFrame, { type: K }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), timeoutMs);
      this.#waiters.push({
        match: (f) => f.type === type && match(f as never),
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f as never);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

// ---------------------------------------------------------------------------
// 配对
// ---------------------------------------------------------------------------

async function pair(payloadText: string): Promise<void> {
  const payload = decodePairingPayload(payloadText.trim());
  const identity = await loadOrCreateIdentity();
  const sas = deriveSas(
    payload.agentPubKey,
    { boxPubKey: identity.box.publicKey, signPubKey: identity.sign.publicKey, deviceId: identity.deviceId },
    payload.qrSecret,
  );

  console.log(color.dim(`连接 ${payload.serverUrl}（pairing 角色）…`));
  const socket = await Socket.open(wsEndpoint(payload.serverUrl), {
    type: 'hello',
    v: 1,
    role: 'pairing',
    deviceId: identity.deviceId,
  });
  socket.send({
    type: 'pair.begin',
    pairingToken: payload.pairingToken,
    clientPubKey: identity.box.publicKey,
    clientSignPubKey: identity.sign.publicKey,
    clientDeviceId: identity.deviceId,
  });
  console.log(
    `\n${color.bold('本端校验码')} ${color.cyan(sas.digits)}  ${sas.emoji.join(' ')}\n` +
      color.dim('请在 agent 终端比对：完全一致才在那边输入 y。等待 agent 确认（最多 5 分钟）…'),
  );

  const confirmed = await Promise.race([
    socket.wait('pair.confirm', (f) => f.pairingToken === payload.pairingToken).then(() => 'confirm' as const),
    socket.wait('pair.abort', (f) => f.pairingToken === payload.pairingToken).then(() => 'abort' as const),
  ]);
  socket.close();
  if (confirmed === 'abort') {
    console.log(color.red('agent 中止了配对（校验码不一致或用户拒绝）。'));
    process.exit(1);
  }

  // 背书登记已完成：换 token 验证一下，再以 client 接入拿 machineId
  const auth = new AuthClient({
    baseUrl: httpBase(payload.serverUrl),
    deviceId: identity.deviceId,
    signKeys: identity.sign,
  });
  const token = (await auth.authenticate()).token;
  console.log(color.green('✓ 服务端已登记本设备（挑战-应答换 token 成功）'));

  // machineId 优先取 QR 里带的那个：它由 agent 自己写、走带外通道，
  // 权威且不受多机干扰。旧版 QR（无该字段）才回落到「接入后第一条在线
  // 的 machine.status」——那在多机场景下可能先到的是别的机器，会记错。
  let machineId = payload.machineId;
  if (machineId === undefined) {
    const client = await Socket.open(wsEndpoint(payload.serverUrl), {
      type: 'hello',
      v: 1,
      role: 'client',
      deviceId: identity.deviceId,
      authToken: token,
    });
    const status = await client.wait('machine.status', (f) => f.online, 10_000).catch(() => null);
    client.close();
    if (!status) {
      console.log(color.red('没有看到在线的 agent，无法确定 machineId；请确认 agent 仍在运行后重试。'));
      process.exit(1);
    }
    machineId = status.machineId;
    console.log(
      color.dim(`配对码未带 machineId（旧版 agent），回落取首条在线机器：${machineId}`),
    );
  }

  const peer: Peer = {
    v: 1,
    serverUrl: payload.serverUrl,
    machineId,
    agentBoxPubKey: payload.agentPubKey,
    outSeq: {},
    inCursors: {},
    sessions: [],
  };
  await writeJson(PEER_PATH, peer);
  console.log(color.green(`✓ 配对完成：machine=${peer.machineId}，已写 ${PEER_PATH}`));
  console.log(color.dim('现在不带参数再跑一次本脚本即可进入 REPL。'));
}

// ---------------------------------------------------------------------------
// 常规：REPL
// ---------------------------------------------------------------------------

interface Outgoing {
  event: ClientToAgentEvent;
}

class DemoClient {
  #socket: Socket | null = null;
  #token: string | null = null;
  #rl: Interface | null = null;
  #pendingPermission: { sessionId: string; requestId: string; toolName: string } | null = null;
  /** 出站缓冲（自愈重发用）：scope key → 最近 N 条 */
  readonly #outbox = new Map<string, Outgoing[]>();
  readonly #handledRejects = new Set<string>();
  #streaming = false;
  #stopping = false;

  constructor(
    private readonly identity: Identity,
    private peer: Peer,
    private readonly auth: AuthClient,
  ) {}

  async start(): Promise<void> {
    await this.#connect();
    this.#rl = createInterface({ input: process.stdin, output: process.stdout });
    this.#rl.setPrompt(this.#promptText());
    this.#rl.prompt();
    this.#rl.on('line', (line) => {
      void this.#onLine(line.trim()).finally(() => this.#rl?.prompt(true));
    });
    this.#rl.on('close', () => void this.quit());
  }

  async quit(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    await this.#persist();
    this.#socket?.close();
    console.log(color.dim('\n再见'));
    process.exit(0);
  }

  // ---- 连接 ----

  async #connect(): Promise<void> {
    if (this.#token === null) this.#token = (await this.auth.authenticate()).token;
    const socket = await Socket.open(wsEndpoint(this.peer.serverUrl), {
      type: 'hello',
      v: 1,
      role: 'client',
      deviceId: this.identity.deviceId,
      authToken: this.#token,
    });
    this.#socket = socket;
    socket.onFrame = (frame) => this.#onFrame(frame);
    socket.onClose = (code) => {
      if (this.#stopping) return;
      this.#say(color.yellow(`连接断开（${code}），2s 后重连`));
      if (code === 4001) this.#token = null;
      setTimeout(() => {
        void this.#connect().catch((err: unknown) => {
          this.#say(color.red(`重连失败：${(err as Error).message}`));
          this.#socket?.onClose?.(0);
        });
      }, 2_000);
    };
    this.#say(color.green(`✓ 已接入 ${this.peer.serverUrl} 作为 ${this.identity.deviceId}`));
    // 重连补发：机器级 + 每个已知会话，各按自己的游标；从没收过的流不发
    // （sinceSeq=0 会把整个留存窗口重放一遍）
    for (const scope of ['', ...this.peer.sessions]) {
      const sinceSeq = this.peer.inCursors[scope] ?? 0;
      if (sinceSeq <= 0) continue;
      socket.send({
        type: 'sync.request',
        machineId: this.peer.machineId,
        ...(scope === '' ? {} : { sessionId: scope }),
        sinceSeq,
      });
    }
  }

  // ---- 入站 ----

  #onFrame(frame: TransportFrame): void {
    switch (frame.type) {
      case 'relay':
        this.#onRelay(frame);
        return;
      case 'relay.reject':
        this.#onReject(frame);
        return;
      case 'machine.status':
        this.#say(
          color.dim(
            `机器 ${frame.machineId} ${frame.online ? color.green('在线') : color.yellow('离线')}`,
          ),
        );
        return;
      case 'input.parked':
        this.#say(color.yellow(`📦 agent 离线，消息已在服务端排队（seq ${frame.seq}）`));
        return;
      case 'parked.count':
        if (frame.parkedCount > 0) this.#say(color.dim(`排队中 ${frame.parkedCount} 条`));
        return;
      case 'park.expired':
        this.#say(color.red(`排队消息已过期（seq ${frame.seq}），请重发`));
        return;
      default:
        return;
    }
  }

  #onRelay(frame: Extract<TransportFrame, { type: 'relay' }>): void {
    if (frame.machineId !== this.peer.machineId) return;
    let event: AgentToClientEvent;
    try {
      const value = openJson(
        { nonce: frame.nonce, ciphertext: frame.ciphertext },
        this.peer.agentBoxPubKey,
        this.identity.box.secretKey,
      );
      event = AgentToClientEventSchema.parse(value);
      assertEnvelopeBinding(event, { sessionId: frame.sessionId, seq: frame.seq }, 'a2c');
    } catch (err) {
      this.#say(color.yellow(`⚠ 丢弃入站帧：${(err as Error).message}`));
      return;
    }
    // 单调游标（与 agent 侧 SeqCursors 同语义）：不高于已见即重放/乱序，丢
    const scope = frame.sessionId ?? '';
    const last = this.peer.inCursors[scope] ?? 0;
    if (frame.seq <= last) {
      this.#say(color.dim(`（丢弃重放帧 ${scope || '(machine)'}#${frame.seq} ≤ ${last}）`));
      return;
    }
    this.peer.inCursors[scope] = frame.seq;
    void this.#persist();
    this.#print(event);
  }

  /**
   * client 侧的 reject 自愈：与 agent outbox 同款——跳号到 expectedAfter+1，
   * 重发缓冲里 seq ∈ [被拒, expectedAfter] 的帧。c2a 只有一个收件人（agent），
   * 不需要按收件人区分。
   */
  #onReject(frame: Extract<TransportFrame, { type: 'relay.reject' }>): void {
    const scope = frame.sessionId ?? '';
    const label = frame.sessionId ?? '(machine)';
    if (frame.reason === 'seq_too_far_ahead') {
      // 本地领先服务端过多：跳号往前无解，重发必再拒（与 agent outbox 同款处理）
      this.#say(
        color.red(
          `✗ 本地 c2a seq 领先服务端过多 ${label}#${frame.seq}（服务端高水位 ${frame.expectedAfter ?? '?'}）；` +
            `该流后续消息会持续被拒。恢复：退出后删除 ${PEER_PATH} 里 outSeq 对应条目再启动`,
        ),
      );
      return;
    }
    if (frame.reason !== 'seq_not_monotonic') {
      this.#say(color.red(`✗ 帧被拒（${frame.reason}）${label}#${frame.seq}`));
      return;
    }
    const key = `${scope}#${frame.seq}`;
    if (this.#handledRejects.has(key)) return;
    this.#handledRejects.add(key);
    const expectedAfter = frame.expectedAfter;
    if (expectedAfter === undefined) {
      this.#say(color.red(`✗ 帧被拒（${frame.reason}）且服务端未给 expectedAfter，无法自愈`));
      return;
    }
    const next = (this.peer.outSeq[scope] ?? 0) + 1;
    if (next <= expectedAfter) this.peer.outSeq[scope] = expectedAfter;
    const buffer = this.#outbox.get(scope) ?? [];
    const pending = buffer.filter((o) => o.event.seq >= frame.seq && o.event.seq <= expectedAfter);
    if (pending.length === 0) {
      this.#say(color.dim(`（reject ${label}#${frame.seq} 已处理或已滚出缓冲）`));
      return;
    }
    const seqs: number[] = [];
    for (const item of pending) {
      const seq = this.#takeSeq(scope);
      const event = { ...item.event, seq } as ClientToAgentEvent;
      item.event = event;
      this.#sendRaw(event);
      seqs.push(seq);
    }
    void this.#persist();
    this.#say(
      color.yellow(
        `↻ seq 失配自愈 ${label}：被拒 #${frame.seq}，高水位 ${expectedAfter}，重发 ${seqs.length} 帧 → ${seqs[0]}..${seqs.at(-1)}`,
      ),
    );
  }

  // ---- 出站 ----

  #takeSeq(scope: string): number {
    const seq = (this.peer.outSeq[scope] ?? 0) + 1;
    this.peer.outSeq[scope] = seq;
    return seq;
  }

  /** 补信封、记缓冲、发出、持久化 seq */
  #send(body: Record<string, unknown> & { type: ClientToAgentEvent['type']; sessionId?: string }): void {
    const scope = body.sessionId ?? '';
    const event = {
      ...body,
      ts: Date.now(),
      seq: this.#takeSeq(scope),
      dir: 'c2a',
    } as ClientToAgentEvent;
    let buffer = this.#outbox.get(scope);
    if (buffer === undefined) {
      buffer = [];
      this.#outbox.set(scope, buffer);
    }
    buffer.push({ event });
    if (buffer.length > OUTBOX_CAPACITY) buffer.shift();
    this.#sendRaw(event);
    void this.#persist();
  }

  #sendRaw(event: ClientToAgentEvent): void {
    const box = sealJson(event, this.peer.agentBoxPubKey, this.identity.box.secretKey);
    const ok = this.#socket?.send({
      type: 'relay',
      machineId: this.peer.machineId,
      ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      seq: event.seq,
      nonce: box.nonce,
      ciphertext: box.ciphertext,
    });
    if (!ok) this.#say(color.red('✗ 连接不在，帧未发出（重连后请重发）'));
  }

  // ---- REPL ----

  async #onLine(line: string): Promise<void> {
    if (line === '') return;
    if (this.#pendingPermission && (line === 'y' || line === 'n')) {
      const p = this.#pendingPermission;
      this.#pendingPermission = null;
      this.#send({
        type: 'permission.respond',
        sessionId: p.sessionId,
        requestId: p.requestId,
        verdict: line === 'y' ? 'allow' : 'deny',
      });
      this.#rl?.setPrompt(this.#promptText());
      return;
    }
    if (line.startsWith('/')) {
      await this.#command(line);
      return;
    }
    const sid = this.peer.currentSession;
    if (sid === undefined) {
      this.#say(color.yellow('还没有当前会话：先 /new 或 /use <sid>'));
      return;
    }
    this.#send({ type: 'input.send', sessionId: sid, clientMsgId: randomUUID(), text: line });
  }

  async #command(line: string): Promise<void> {
    const [cmd, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ');
    const sid = this.peer.currentSession;
    switch (cmd) {
      case '/new':
        this.#send({
          type: 'session.create',
          reqId: randomUUID(),
          cwd: arg === '' ? process.cwd() : arg,
          model: MODEL,
          permissionMode: 'default',
        });
        return;
      case '/use':
        if (arg === '') return this.#say('用法：/use <sessionId>');
        this.peer.currentSession = arg;
        if (!this.peer.sessions.includes(arg)) this.peer.sessions.push(arg);
        await this.#persist();
        this.#rl?.setPrompt(this.#promptText());
        return;
      case '/list':
        this.#send({ type: 'session.list.request', reqId: randomUUID() });
        return;
      case '/status':
        if (sid === undefined) return this.#say(color.yellow('没有当前会话'));
        this.#send({ type: 'session.status.request', sessionId: sid, reqId: randomUUID() });
        return;
      case '/stop':
        if (sid === undefined) return this.#say(color.yellow('没有当前会话'));
        this.#send({ type: 'run.stop', sessionId: sid });
        return;
      case '/cwd':
        this.#send({ type: 'cwd.list.request', reqId: randomUUID() });
        return;
      case '/quit':
      case '/exit':
        await this.quit();
        return;
      default:
        this.#say(color.yellow(`不认识的命令 ${cmd}；可用：/new /use /list /status /stop /cwd /quit`));
    }
  }

  #promptText(): string {
    if (this.#pendingPermission) return color.yellow('权限 y/n> ');
    const sid = this.peer.currentSession;
    return `${color.cyan(sid === undefined ? '(无会话)' : sid.slice(0, 8))}> `;
  }

  /** 在 REPL 提示符之上打印一行 */
  #say(line: string): void {
    if (this.#streaming) {
      process.stdout.write('\n');
      this.#streaming = false;
    }
    console.log(line);
  }

  async #persist(): Promise<void> {
    await writeJson(PEER_PATH, this.peer);
  }

  // ---- 事件渲染（借 demo.ts 的 printer，按 AgentToClientEvent 改）----

  #print(event: AgentToClientEvent): void {
    const seq = color.dim(`#${String(event.seq).padStart(3, '0')}`);
    switch (event.type) {
      case 'assistant.delta':
        if (!this.#streaming) {
          process.stdout.write(`\n${seq} ${color.green('claude')} `);
          this.#streaming = true;
        }
        process.stdout.write(event.text);
        return;
      case 'assistant.done':
        if (this.#streaming) {
          process.stdout.write('\n');
          this.#streaming = false;
        } else {
          this.#say(`${seq} ${color.green('claude')} ${event.text}`);
        }
        return;
      case 'thinking.start':
        this.#say(`${seq} ${color.dim('思考中…')}`);
        return;
      case 'user.message':
        this.#say(`${seq} ${color.bold('你')} ${event.text}`);
        return;
      case 'tool.start':
        this.#say(`${seq} ${color.yellow('🔧')} ${event.toolName} ${color.dim(event.argSummary)}`);
        return;
      case 'tool.end':
        this.#say(`${seq} ${color.dim(`   ${event.resultSummary}`)}`);
        return;
      case 'permission.request':
        this.#pendingPermission = {
          sessionId: event.sessionId ?? '',
          requestId: event.requestId,
          toolName: event.toolName,
        };
        this.#say(
          `${seq} ${color.yellow('🔐 权限请求')} ${event.toolName} ${color.dim(
            JSON.stringify(event.input).slice(0, 120),
          )}\n    ${color.bold('输入 y 批准 / n 拒绝')}`,
        );
        this.#rl?.setPrompt(this.#promptText());
        return;
      case 'permission.resolved':
        this.#say(
          `${seq} ${color.green(`✓ 已${event.verdict === 'allow' ? '批准' : '拒绝'}`)} ${color.dim(
            event.resolvedBy ?? '',
          )}`,
        );
        return;
      case 'permission.invalidated':
        if (this.#pendingPermission?.requestId === event.requestId) this.#pendingPermission = null;
        this.#say(`${seq} ${color.dim(`权限请求失效：${event.reason}`)}`);
        this.#rl?.setPrompt(this.#promptText());
        return;
      case 'run.state':
        this.#say(`${seq} ${color.dim(`状态 → ${event.state}`)}`);
        return;
      case 'run.done':
        this.#say(
          `${seq} ${color.green('✓ 完成')} ${color.dim(
            `${event.durationMs}ms · $${event.costUsd.toFixed(4)} · ${event.toolCount} 次工具 · ${event.permissionCount} 次权限`,
          )}`,
        );
        return;
      case 'run.heartbeat':
        this.#say(
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
        this.#say(`${seq} ${color.dim(`📬 已排队 ${event.clientMsgId}`)}`);
        return;
      case 'input.cancelled':
        this.#say(`${seq} ${color.dim(`📭 排队消息未执行（${event.reason}）${event.clientMsgId}`)}`);
        return;
      case 'error.transient':
        this.#say(`${seq} ${color.yellow(`⚠ 瞬时错误（第 ${event.attempt} 次自动恢复）：${event.reason}`)}`);
        return;
      case 'error.fatal':
        this.#say(`${seq} ${color.red(`✗ ${event.kind}：${event.message}`)}`);
        return;
      case 'session.capabilities':
        this.#say(
          `${seq} ${color.dim(
            `能力：${event.slashCommands.length} 个命令 · 模型 ${event.models.join(',')} · ${event.mcpServers.length} 个 MCP`,
          )}`,
        );
        return;
      case 'session.create.response': {
        const created = event.session.sessionId;
        this.peer.currentSession = created;
        if (!this.peer.sessions.includes(created)) this.peer.sessions.push(created);
        void this.#persist();
        this.#say(`${seq} ${color.green('✓ 新会话')} ${created} ${color.dim(event.session.cwd)}`);
        this.#rl?.setPrompt(this.#promptText());
        return;
      }
      case 'session.created':
        return; // 发起端靠 response 已处理；其余设备的列表增量，这里不打印
      case 'session.list.response':
        this.#say(`${seq} ${color.dim(`会话列表（${event.sessions.length}）：`)}`);
        for (const s of event.sessions.slice(0, 10)) {
          const mark = s.sessionId === this.peer.currentSession ? color.green(' ←当前') : '';
          this.#say(color.dim(`   ${s.sessionId} · ${s.state} · ${s.cwd} · ${s.title.slice(0, 40)}`) + mark);
        }
        return;
      case 'session.status.response':
        this.#say(
          `${seq} ${color.dim(
            `状态：model=${event.model} cwd=${event.cwd} mode=${event.permissionMode} $${event.costUsd.toFixed(4)} agent=${event.agentVersion} claude=${event.claudeVersion}`,
          )}`,
        );
        return;
      case 'session.updated':
        return; // 太吵
      case 'machine.info':
        this.#say(
          `${seq} ${color.dim(
            `机器：${event.info.name} · ${event.info.platform} ${event.info.osVersion} · agent ${event.info.agentVersion} · claude ${event.info.claudeVersion} · 活跃会话 ${event.info.activeSessionCount}`,
          )}`,
        );
        return;
      case 'cwd.list.response':
      case 'cwd.updated':
        this.#say(`${seq} ${color.dim(`目录收藏：默认 ${event.defaultCwd}；${event.favorites.join(', ') || '(无)'}`)}`);
        return;
      default:
        this.#say(`${seq} ${color.dim(event.type)}`);
    }
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await sodiumReady();
  const argv = process.argv.slice(2);
  const pairIdx = argv.indexOf('--pair');
  if (pairIdx >= 0) {
    const payload = argv[pairIdx + 1];
    if (!payload) {
      console.error('用法：client-demo --pair <配对码>');
      process.exit(2);
    }
    await pair(payload);
    process.exit(0);
  }

  const identity = await readJson(IDENTITY_PATH, IdentitySchema);
  const peer = await readJson(PEER_PATH, PeerSchema);
  if (!identity || !peer) {
    console.error(color.red(`尚未配对：请先 client-demo --pair <配对码>（HOME=${HOME}）`));
    process.exit(2);
  }
  const auth = new AuthClient({
    baseUrl: httpBase(peer.serverUrl),
    deviceId: identity.deviceId,
    signKeys: identity.sign,
  });
  const client = new DemoClient(identity, peer, auth);
  process.on('SIGINT', () => void client.quit());
  await client.start();
}

main().catch((err: unknown) => {
  console.error(color.red(`失败：${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
