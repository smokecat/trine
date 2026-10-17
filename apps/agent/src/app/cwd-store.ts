/**
 * 工作目录收藏：`~/.trine/cwd.json`（协议 §6.2 / 决策 7：agent 端持久化，每机器一份）。
 *
 * `{ favorites: string[], defaultCwd: string }`。defaultCwd 是 client 新建会话时
 * 的预填值，初始取 home 目录。路径按字面存，不做存在性校验——client 加进来的
 * 目录 agent 这边可能暂时不存在（还没 clone），真正用它开会话时 SDK 会报错，
 * 那才是合适的报错点。
 *
 * 文件坏了 → warn + 回到默认值，**不阻止启动**：这是个便利列表，丢了重加即可，
 * 不像 identity/recipients 那样值得炸掉让人看。
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { z } from 'zod';

export const CwdFileSchema = z.object({
  v: z.literal(1),
  favorites: z.array(z.string().min(1)),
  defaultCwd: z.string().min(1),
});
export type CwdFile = z.infer<typeof CwdFileSchema>;

export interface CwdSnapshot {
  favorites: string[];
  defaultCwd: string;
}

export class CwdStore {
  #data: CwdFile;

  private constructor(
    private readonly path: string,
    data: CwdFile,
  ) {
    this.#data = data;
  }

  static async load(
    path: string,
    options: { log?: (line: string) => void; defaultCwd?: string } = {},
  ): Promise<CwdStore> {
    const log = options.log ?? (() => {});
    const fallback: CwdFile = {
      v: 1,
      favorites: [],
      defaultCwd: options.defaultCwd ?? homedir(),
    };
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log(`[cwd] 读取失败，用默认值：${(err as Error).message}`);
      }
      return new CwdStore(path, fallback);
    }
    try {
      return new CwdStore(path, CwdFileSchema.parse(JSON.parse(raw)));
    } catch (err) {
      log(`[cwd] 文件损坏，用默认值：${(err as Error).message}`);
      return new CwdStore(path, fallback);
    }
  }

  snapshot(): CwdSnapshot {
    return { favorites: [...this.#data.favorites], defaultCwd: this.#data.defaultCwd };
  }

  /** @returns 是否真的新增了（重复加返回 false，但不算错） */
  async add(path: string): Promise<boolean> {
    if (this.#data.favorites.includes(path)) return false;
    this.#data.favorites.push(path);
    await this.#persist();
    return true;
  }

  async remove(path: string): Promise<boolean> {
    const before = this.#data.favorites.length;
    this.#data.favorites = this.#data.favorites.filter((p) => p !== path);
    if (this.#data.favorites.length === before) return false;
    await this.#persist();
    return true;
  }

  async setDefault(path: string): Promise<void> {
    if (this.#data.defaultCwd === path) return;
    this.#data.defaultCwd = path;
    await this.#persist();
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#data, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }
}
