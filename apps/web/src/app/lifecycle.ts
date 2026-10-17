/**
 * client 生命周期接线：把「选举结果」变成「恰好一个正在运行的 TrineClient」。
 *
 * 零浏览器依赖（runtime.ts 注入浏览器适配器与 store），所以能在 bun test 里
 * 用内存锁快速切换主从来验证不变量：**任何时刻最多一个 TrineClient 在运行**。
 *
 * ## 代际号（评审阶段 1 B5）
 *
 * `TrineClient.create` 是异步的（sodium + IndexedDB）。主→从→主的快速切换里，
 * 第一次 create 还在途，第二次又发起了；两个都完成时若只看「现在是不是主」，
 * 两个都会 bind + start——同 deviceId 两条 socket、两份 outSeq，正是单主要消灭
 * 的东西。每次 create/dispose 都递增代际，create 完成时代际不符就把刚建的
 * client 直接丢弃（它从未 start，没有任何副作用）。
 *
 * ## 错误面（评审阶段 1 B6）
 *
 * `TrineClient.create` 抛错（identity 损坏）不能是 unhandled rejection：
 * 通过 `onError` 交给 runtime 写入错误态，Layout 显示可操作的错误页。
 */
import type { TrineClient } from '../lib/client.ts';
import type { LeaderSnapshot } from '../lib/leader.ts';

export interface ClientLifecycleOptions {
  /** 建一个 client（未 start） */
  createClient: () => Promise<TrineClient>;
  /** client 就位（已 bind，将要 start）；返回解绑函数 */
  onClient: (client: TrineClient) => () => void;
  /** 当前 client 被拆掉（已 stop） */
  onClientGone?: () => void;
  onError: (message: string) => void;
}

export class ClientLifecycle {
  #generation = 0;
  #client: TrineClient | null = null;
  #unbind: (() => void) | null = null;
  #inflight: Promise<void> | null = null;

  constructor(private readonly options: ClientLifecycleOptions) {}

  get client(): TrineClient | null {
    return this.#client;
  }

  /** 选举状态变化：主 → 建 client；其他 → 拆 client */
  onLeaderChange(snapshot: LeaderSnapshot): void {
    if (snapshot.state === 'leader') this.#acquire();
    else this.dispose();
  }

  /** 拆掉当前 client（若有），并让在途的 create 作废 */
  dispose(): void {
    this.#generation++;
    const client = this.#client;
    this.#client = null;
    this.#unbind?.();
    this.#unbind = null;
    if (client) {
      client.stop();
      this.options.onClientGone?.();
    }
  }

  /** 测试用：等在途的 create 结束 */
  async settle(): Promise<void> {
    await this.#inflight;
  }

  #acquire(): void {
    // 已有活 client 且没有在途 create：什么都不用做（重复的 leader 通知）
    if (this.#client !== null && this.#inflight === null) return;
    const generation = ++this.#generation;
    const run = async (): Promise<void> => {
      let created: TrineClient;
      try {
        created = await this.options.createClient();
      } catch (err) {
        if (generation === this.#generation) this.options.onError(err instanceof Error ? err.message : String(err));
        return;
      }
      if (generation !== this.#generation) {
        // 期间又切过主从：这个 client 从未 start，直接丢
        return;
      }
      // 防御：理论上到这里 #client 必为 null（任何 dispose 都会让代际过期）
      if (this.#client !== null) {
        this.#unbind?.();
        this.#client.stop();
      }
      this.#client = created;
      this.#unbind = this.options.onClient(created);
      created.start();
    };
    const p = run().finally(() => {
      if (this.#inflight === p) this.#inflight = null;
    });
    this.#inflight = p;
  }
}
