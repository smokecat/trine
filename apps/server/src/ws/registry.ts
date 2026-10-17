/**
 * 在线连接注册表：内存态，进程重启即清空（D2：内存路由 + SQLite 存序号）。
 *
 * 路由模型（单用户工具，刻意不做多租户）：
 * - agent 连接按 machineId 索引，一台机器同一时刻只允许一条活跃连接
 *   （后来者顶掉先来者：agent 重连时旧连接多半已是半死的 TCP，
 *   留着会让帧发进黑洞）；
 * - client 连接不绑机器——一个 client 设备可以同时看多台机器，
 *   agent 发来的帧向**全部**在线 client 广播（多设备同步是 §1.1 的需求）。
 */

/** WS 连接的最小接口，便于测试替身 */
export interface Sendable {
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
  readonly readyState?: number;
}

export interface Conn<T extends Sendable = Sendable> {
  ws: T;
  deviceId: string;
  role: 'client' | 'agent';
  /** agent 连接的机器标识（= deviceId），client 连接为 undefined */
  machineId?: string;
  connectedAt: number;
  /** 最后一次收到任何入站帧/pong 的时刻，空闲断连判据 */
  lastSeenAt: number;
  /** 已发出但未收到 pong 的 ping 数，连续未响应即判死 */
  pendingPings: number;
  /**
   * 本连接近期发过的 pair.* 帧时刻，滑动窗口频率上限用（见 hub 的
   * `allowPairFrame`）。挂在连接上，断开即消失——配对是短暂人工流程，
   * 不值得为它在库里留记录。
   */
  pairFrameTimes?: number[];
}

/**
 * 免认证的配对连接（`hello { role:'pairing' }`，D8）。
 *
 * 刻意**不是** `Conn`、也刻意不进 `ConnectionRegistry`：注册表里的连接会
 * 收到 machine.status 广播、relay fanout、补发……而这条连接的对端身份完全
 * 未经验证，一个字节的会话数据都不该流向它。它能做的只有收发 `pair.*`。
 *
 * 生命周期极短：配对成功后 client 换正式 token 以 `role:'client'` 重连，
 * 这条连接随即关闭；没在短空闲超时内完成配对的也会被清理掉。
 */
export interface PairingConn<T extends Sendable = Sendable> {
  ws: T;
  role: 'pairing';
  /** 自报值，**未经任何验证**，仅供日志与限流 key */
  deviceId: string;
  /**
   * 来源标识（IP）。用于**按来源**的 pairing 连接配额——单一攻击源占不满
   * 全局槽位。取值：信任反代头时用 XFF/X-Real-IP，否则退到 socket 对端 IP
   * （不可伪造）。捕获点见 server.ts 的 fetch。
   */
  source: string;
  connectedAt: number;
  lastSeenAt: number;
  /**
   * 首次发出合法 pair.begin 的时刻；未 begin 前为 null。
   * 空连接短宽限（PAIRING_BEGIN_GRACE_MS）据此判定：连上迟迟不 begin 的
   * 纯占坑连接会被踢掉。
   */
  beganAt: number | null;
  pairFrameTimes?: number[];
}

/**
 * 能发 `pair.*` 帧的连接：已认证的 client/agent，或免认证的 pairing 连接。
 * hub 的配对处理对三者一视同仁地限流，但**登记动作只认 `agent`**。
 */
export type PairPeer<T extends Sendable = Sendable> =
  | Conn<T>
  | PairingConn<T>;

export class ConnectionRegistry<T extends Sendable = Sendable> {
  private readonly clients = new Map<T, Conn<T>>();
  private readonly agents = new Map<string, Conn<T>>();
  private readonly byWs = new Map<T, Conn<T>>();

  /**
   * 登记 agent 连接，返回被顶掉的旧连接（调用方负责关它）。
   */
  addAgent(conn: Conn<T>): Conn<T> | null {
    const machineId = conn.machineId!;
    const previous = this.agents.get(machineId) ?? null;
    if (previous && previous.ws !== conn.ws) {
      this.agents.delete(machineId);
      this.byWs.delete(previous.ws);
    }
    this.agents.set(machineId, conn);
    this.byWs.set(conn.ws, conn);
    return previous && previous.ws !== conn.ws ? previous : null;
  }

  addClient(conn: Conn<T>): void {
    this.clients.set(conn.ws, conn);
    this.byWs.set(conn.ws, conn);
  }

  remove(ws: T): Conn<T> | null {
    const conn = this.byWs.get(ws);
    if (!conn) return null;
    this.byWs.delete(ws);
    this.clients.delete(ws);
    if (conn.role === 'agent' && conn.machineId) {
      // 只在仍是自己占位时删——否则会误删顶替上来的新连接
      if (this.agents.get(conn.machineId)?.ws === ws) {
        this.agents.delete(conn.machineId);
      }
    }
    return conn;
  }

  get(ws: T): Conn<T> | null {
    return this.byWs.get(ws) ?? null;
  }

  agent(machineId: string): Conn<T> | null {
    return this.agents.get(machineId) ?? null;
  }

  isAgentOnline(machineId: string): boolean {
    return this.agents.has(machineId);
  }

  allClients(): Conn<T>[] {
    return [...this.clients.values()];
  }

  /**
   * 是否有任意在线 client。
   *
   * 刻意**不按 machineId 区分**：client 连接不绑机器（见文件头注释），
   * 一个 client 设备同时看所有机器。「有 client 在线」就等于「人正对着
   * 某个屏幕」，这正是在线抑制想判断的东西。
   */
  hasOnlineClient(): boolean {
    return this.clients.size > 0;
  }

  allAgents(): Conn<T>[] {
    return [...this.agents.values()];
  }

  all(): Conn<T>[] {
    return [...this.byWs.values()];
  }

  get size(): number {
    return this.byWs.size;
  }
}
