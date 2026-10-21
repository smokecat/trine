/**
 * 扩展相关的两份本地文件（extensions.json、session-links.json）共用的读写手法，
 * 与 session-flags / cwd-store 一致：tmp + rename + 0600；坏文件改名留底后按空启动。
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { z } from 'zod';

export async function writeAtomic(path: string, payload: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, payload, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/**
 * 读并校验。不存在 → empty()；读失败 → empty() + log；解析失败 → 原文件改名为
 * `.corrupt-<ts>` 后 empty() + log（都不阻止启动）。
 */
export async function loadJsonFile<S extends z.ZodType>(
  path: string,
  schema: S,
  empty: () => z.infer<S>,
  options: { log: (line: string) => void; now: () => number; tag: string },
): Promise<z.infer<S>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      options.log(`[${options.tag}] 读取失败，按空启动：${(err as Error).message}`);
    }
    return empty();
  }
  try {
    return schema.parse(JSON.parse(raw)) as z.infer<S>;
  } catch (err) {
    const backup = `${path}.corrupt-${options.now()}`;
    try {
      await rename(path, backup);
      options.log(`[${options.tag}] 文件损坏，原文件已移到 ${backup}，按空启动：${(err as Error).message}`);
    } catch (renameErr) {
      options.log(`[${options.tag}] 文件损坏且无法留底（${(renameErr as Error).message}），按空启动：${(err as Error).message}`);
    }
    return empty();
  }
}

/** 串行写盘：每次写最新全量快照，失败置脏、下次改动时补写 */
export class SerialWriter {
  readonly #path: string;
  readonly #serialize: () => string;
  readonly #log: (line: string) => void;
  #dirty = false;
  #writing: Promise<void> = Promise.resolve();

  constructor(path: string, serialize: () => string, log: (line: string) => void) {
    this.#path = path;
    this.#serialize = serialize;
    this.#log = log;
  }

  persist(): Promise<void> {
    this.#dirty = true;
    const next = this.#writing
      .catch(() => {})
      .then(async () => {
        if (!this.#dirty) return;
        this.#dirty = false;
        try {
          await writeAtomic(this.#path, this.#serialize());
        } catch (err) {
          this.#dirty = true;
          this.#log(`[ext] 落盘失败 ${this.#path}：${(err as Error).message}`);
          throw err;
        }
      });
    this.#writing = next;
    return next;
  }

  async flush(): Promise<void> {
    if (this.#dirty) await this.persist().catch(() => {});
    else await this.#writing.catch(() => {});
  }
}

/** 只认自有属性（键来自远端，别撞原型链） */
export function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function put<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}
