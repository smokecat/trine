/**
 * 已配对 client 收件人名册：`~/.trine/recipients.json`。
 *
 * D8 拍板的「矩阵式独立配对」落在这里——每台 client 设备一对独立密钥，
 * agent 维护 deviceId → X25519 公钥 的映射，出站事件**对每个收件人各
 * seal 一份**。
 *
 * ## 为什么不是一把共享密钥
 *
 * crypto_box 是点对点的：一份密文只有持有对应私钥的那一台设备解得开。
 * 想让 N 台设备都能读，要么给它们同一把私钥（Happy 式根密钥复制——
 * 任一设备泄露即全部历史对等泄露、且无法单独撤销），要么加密 N 份。
 * 个人工具的设备数是个位数，N 份密文的代价远小于共享密钥的失效模式。
 *
 * ## 与身份文件的分工
 *
 * identity.json 是**自己的**密钥（含私钥，0600）；本文件是**别人的**公钥
 * （无私钥）。分开存的实际好处：备份、审阅、误传的风险等级不同，
 * 而且删掉本文件只是「所有设备需重新配对」，删掉 identity.json 是
 * 「这台机器换了身份」。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { randomToken } from '@trine/core/crypto';

const RecipientSchema = z.object({
  /** 服务端登记的设备主键，也是 relay 路由的对端标识 */
  deviceId: z.string().min(1).max(128),
  /** X25519：给这台设备 seal 用 */
  boxPubKey: z.string().min(1),
  /** Ed25519：agent 当初背书的那把，留作核对与将来撤销用 */
  signPubKey: z.string().min(1),
  pairedAt: z.number().int().nonnegative(),
});
export type Recipient = z.infer<typeof RecipientSchema>;

export const RecipientBookSchema = z.object({
  v: z.literal(1),
  recipients: z.array(RecipientSchema),
});
export type RecipientBook = z.infer<typeof RecipientBookSchema>;

export function defaultRecipientsPath(): string {
  return join(homedir(), '.trine', 'recipients.json');
}

/**
 * 已配对设备名册。内存态为准，每次变更同步落盘。
 *
 * 规模是「用户有几台设备」——个位数，全量读写不值得上增量或数据库。
 */
export class RecipientBookStore {
  #recipients = new Map<string, Recipient>();

  private constructor(private readonly path: string) {}

  /** 读盘装载；文件不存在视为空名册（全新 agent 还没配对过任何设备） */
  static async load(path = defaultRecipientsPath()): Promise<RecipientBookStore> {
    const store = new RecipientBookStore(path);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return store;
      throw err;
    }
    // 与 identity.json 一致：坏文件抛错不静默重建——静默重建等于悄悄
    // 把所有已配对设备踢下线，而用户只会看到「消息发不出去」
    const book = RecipientBookSchema.parse(JSON.parse(raw));
    for (const r of book.recipients) store.#recipients.set(r.deviceId, r);
    return store;
  }

  list(): Recipient[] {
    return [...this.#recipients.values()];
  }

  get(deviceId: string): Recipient | null {
    return this.#recipients.get(deviceId) ?? null;
  }

  has(deviceId: string): boolean {
    return this.#recipients.has(deviceId);
  }

  get size(): number {
    return this.#recipients.size;
  }

  /**
   * 登记一台新配对的设备（同 deviceId 覆盖）。
   *
   * 覆盖是对的：走到这里说明本次配对已经过了 SAS 人工比对 + 服务端的
   * 背书校验，用户确实在给这台 deviceId 换一套新密钥（重装、清缓存）。
   * 但注意这**只在 agent 本地成立**——服务端那边同 deviceId 换公钥是
   * 硬拒的（防设备接管），所以那种情况下配对根本走不到这一步。
   */
  async add(recipient: Recipient): Promise<void> {
    this.#recipients.set(recipient.deviceId, recipient);
    await this.#persist();
  }

  /** 移除一台设备（machine.unpair 的落点，本任务未接协议） */
  async remove(deviceId: string): Promise<boolean> {
    const existed = this.#recipients.delete(deviceId);
    if (existed) await this.#persist();
    return existed;
  }

  async #persist(): Promise<void> {
    const book: RecipientBook = { v: 1, recipients: this.list() };
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // 与 identity 同样走临时文件 + rename：写到一半崩掉不会留下半个 JSON，
    // 那会让下次启动直接抛「名册损坏」
    const tmp = `${this.path}.${randomToken(8)}.tmp`;
    await writeFile(tmp, JSON.stringify(book, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
