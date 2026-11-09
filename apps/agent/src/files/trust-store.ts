/**
 * 信任目录：`~/.trine/files.json`（trusted-browse-dirs）。会话 cwd 之外允许浏览的目录，
 * 机器级、所有会话与已配对设备共享，可远程增删（`files.trust.add / remove`）。
 *
 * `{ v: 1, trusted: [{ path, addedAt }] }`。path 是 resolve 过的字面路径（`~` 已展开），
 * 校验在 FileService.trust 里做（存在、是目录、不是 `/`、不是密钥类），这里只管存。
 *
 * 文件坏了 → warn + 回到空列表，**不阻止启动**：丢了的后果是范围变窄，不是变宽。
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { FILES_TRUSTED_MAX } from '@trine/core';

const TrustFileSchema = z.object({
  v: z.literal(1),
  trusted: z.array(z.object({ path: z.string().min(1), addedAt: z.number().int().nonnegative() })).max(FILES_TRUSTED_MAX),
});
type TrustFile = z.infer<typeof TrustFileSchema>;

export interface TrustedDir {
  path: string;
  addedAt: number;
}

export class TrustStore {
  #data: TrustFile;

  private constructor(
    private readonly path: string | undefined,
    data: TrustFile,
  ) {
    this.#data = data;
  }

  /** 不落盘的空列表（测试、echo agent） */
  static memory(initial: readonly TrustedDir[] = []): TrustStore {
    return new TrustStore(undefined, { v: 1, trusted: initial.map((d) => ({ ...d })) });
  }

  static async load(path: string, options: { log?: (line: string) => void } = {}): Promise<TrustStore> {
    const log = options.log ?? (() => {});
    const empty: TrustFile = { v: 1, trusted: [] };
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`[files] 信任目录读取失败，按空列表处理：${(err as Error).message}`);
      return new TrustStore(path, empty);
    }
    try {
      return new TrustStore(path, TrustFileSchema.parse(JSON.parse(raw)));
    } catch (err) {
      log(`[files] 信任目录文件损坏，按空列表处理：${(err as Error).message}`);
      return new TrustStore(path, empty);
    }
  }

  list(): TrustedDir[] {
    return this.#data.trusted.map((d) => ({ ...d }));
  }

  has(path: string): boolean {
    return this.#data.trusted.some((d) => d.path === path);
  }

  get size(): number {
    return this.#data.trusted.length;
  }

  /** @returns 是否新增（已存在返回 false，不算错） */
  async add(path: string, at: number): Promise<boolean> {
    if (this.has(path)) return false;
    if (this.#data.trusted.length >= FILES_TRUSTED_MAX) throw new Error(`信任目录最多 ${FILES_TRUSTED_MAX} 个`);
    const next = { ...this.#data, trusted: [...this.#data.trusted, { path, addedAt: at }] };
    await this.#persist(next);
    this.#data = next;
    return true;
  }

  /** @returns 是否真的删掉了 */
  async remove(path: string): Promise<boolean> {
    if (!this.has(path)) return false;
    const next = { ...this.#data, trusted: this.#data.trusted.filter((d) => d.path !== path) };
    await this.#persist(next);
    this.#data = next;
    return true;
  }

  /** 先写盘再改内存：写失败时内存里的范围不变（不会出现「看着加上了、重启就没了」） */
  async #persist(data: TrustFile): Promise<void> {
    if (this.path === undefined) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }
}
