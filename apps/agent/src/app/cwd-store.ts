/**
 * 工作目录收藏：`~/.trine/cwd.json`（协议 §6.2 / 决策 7：agent 端持久化，每机器一份）。
 *
 * `{ favorites: string[], defaultCwd: string, pinned?: {cwd: ts}, pinOrder?: string[] }`。defaultCwd 是 client
 * 新建会话时的预填值，初始取 home 目录。pinned 是置顶的工作区（sidebar-pin），键是
 * client 分组用的规范化 cwd，值是置顶时间；旧文件没有这个键，读进来按空处理。路径按字面存，不做存在性校验——client 加进来的
 * 目录 agent 这边可能暂时不存在（还没 clone），真正用它开会话时 SDK 会报错，
 * 那才是合适的报错点。
 *
 * pinOrder（pin-order）是置顶工作区的手动顺序（pinned 的键，越前越靠上），跨设备同步。读进来时规范化：
 * 去重、剔除没置顶的、缺的按置顶时间倒序补到末尾；它坏了只退化它自己（回到时间序），不连带清空
 * 收藏 / 默认目录。新置顶插最前，取消置顶移除，超过上限从 pinOrder 末尾淘汰。旧 agent 重写文件会丢掉
 * pinOrder（退化为时间序），可以接受。
 *
 * 每次改动先在候选快照上算好、写盘成功后才替换内存：写盘失败时内存与文件保持一致。
 *
 * 文件坏了 → warn + 回到默认值，**不阻止启动**：这是个便利列表，丢了重加即可，
 * 不像 identity/recipients 那样值得炸掉让人看。
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { z } from 'zod';
import { movePinOrder, normalizePinOrder, type CwdPinMoveErrorCode } from '@trine/core';

export const CwdFileSchema = z.object({
  v: z.literal(1),
  favorites: z.array(z.string().min(1)),
  defaultCwd: z.string().min(1),
  pinned: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** 宽松读：形状不对由 normalizePinOrder 退化，不让整份文件判损坏 */
  pinOrder: z.unknown().optional(),
});

interface CwdData {
  v: 1;
  favorites: string[];
  defaultCwd: string;
  pinned: Record<string, number>;
  pinOrder: string[];
}

export interface CwdSnapshot {
  favorites: string[];
  defaultCwd: string;
  pinned: Record<string, number>;
  pinOrder: string[];
}

/** 置顶工作区条数上限：路径来自远端，别让文件无限长；超出时从 pinOrder 末尾淘汰 */
export const MAX_PINNED_CWDS = 100;

/** cwd.pin.move 的业务错误：router 原样转成应答里的 error */
export class CwdPinMoveError extends Error {
  constructor(
    readonly code: Exclude<CwdPinMoveErrorCode, 'failed'>,
    message: string,
  ) {
    super(message);
    this.name = 'CwdPinMoveError';
  }
}

const MOVE_REJECTION_TEXT = {
  not_pinned: '要移动的目录没有置顶',
  before_not_pinned: '目标位置的目录没有置顶',
  invalid: '不能移到自己前面',
} as const;

/** 去尾 `/`（根目录保持 `/`）；与 client 分组的规范化一致 */
function normalizeCwd(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '');
  return trimmed === '' && cwd !== '' ? '/' : trimmed;
}

export class CwdStore {
  #data: CwdData;

  private constructor(
    private readonly path: string,
    data: CwdData,
  ) {
    this.#data = data;
  }

  static async load(
    path: string,
    options: { log?: (line: string) => void; defaultCwd?: string } = {},
  ): Promise<CwdStore> {
    const log = options.log ?? (() => {});
    const fallback: CwdData = {
      v: 1,
      favorites: [],
      defaultCwd: options.defaultCwd ?? homedir(),
      pinned: {},
      pinOrder: [],
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
      const file = CwdFileSchema.parse(JSON.parse(raw));
      if (file.pinOrder !== undefined && !Array.isArray(file.pinOrder)) {
        log('[cwd] pinOrder 格式不对，置顶顺序退回按置顶时间');
      }
      return new CwdStore(path, {
        v: 1,
        favorites: file.favorites,
        defaultCwd: file.defaultCwd,
        pinned: file.pinned,
        pinOrder: normalizePinOrder(file.pinOrder, file.pinned),
      });
    } catch (err) {
      log(`[cwd] 文件损坏，用默认值：${(err as Error).message}`);
      return new CwdStore(path, fallback);
    }
  }

  snapshot(): CwdSnapshot {
    return {
      favorites: [...this.#data.favorites],
      defaultCwd: this.#data.defaultCwd,
      pinned: { ...this.#data.pinned },
      pinOrder: [...this.#data.pinOrder],
    };
  }

  /**
   * 置顶 / 取消置顶。已置顶的再置顶保留原时间与位置（幂等，免得重复请求把它挪到最上）。
   * 新置顶插到 pinOrder 最前；超过上限从 pinOrder 末尾淘汰。
   * @returns 是否有改动
   */
  async setPinned(path: string, pinned: boolean, at: number): Promise<boolean> {
    const has = Object.hasOwn(this.#data.pinned, path);
    if (has === pinned) return false;
    // fromEntries 建的是自有属性：path 来自远端，`__proto__` 也不会改到原型
    const entries = Object.entries(this.#data.pinned).filter(([k]) => k !== path);
    let order = this.#data.pinOrder.filter((p) => p !== path);
    if (pinned) {
      entries.push([path, at]);
      order = [path, ...order];
    }
    let next = Object.fromEntries(entries);
    if (order.length > MAX_PINNED_CWDS) {
      const evicted = new Set(order.slice(MAX_PINNED_CWDS));
      order = order.slice(0, MAX_PINNED_CWDS);
      next = Object.fromEntries(entries.filter(([k]) => !evicted.has(k)));
    }
    await this.#commit({ ...this.#data, pinned: next, pinOrder: order });
    return true;
  }

  /**
   * 把置顶的 `path` 移到 `before` 之前（`before = null` = 末尾）。两者都要已置顶且不相同，
   * 否则抛 CwdPinMoveError——不隐式置顶。路径先按字面找，找不到再按去尾 `/` 匹配（旧数据可能带尾 `/`）。
   * @returns 顺序是否真的变了（重复请求返回 false，不写盘）
   */
  async movePin(path: string, before: string | null): Promise<boolean> {
    const key = this.#pinnedKey(path);
    if (key === undefined) throw new CwdPinMoveError('not_pinned', `${path} 没有置顶`);
    const beforeKey = before === null ? null : this.#pinnedKey(before);
    if (beforeKey === undefined) throw new CwdPinMoveError('before_not_pinned', `${before} 没有置顶`);
    const current = this.#data.pinOrder;
    const order = movePinOrder(current, key, beforeKey);
    if (typeof order === 'string') throw new CwdPinMoveError(order, MOVE_REJECTION_TEXT[order]);
    if (order.every((p, i) => p === current[i])) return false;
    await this.#commit({ ...this.#data, pinOrder: order });
    return true;
  }

  /** @returns 是否真的新增了（重复加返回 false，但不算错） */
  async add(path: string): Promise<boolean> {
    if (this.#data.favorites.includes(path)) return false;
    await this.#commit({ ...this.#data, favorites: [...this.#data.favorites, path] });
    return true;
  }

  async remove(path: string): Promise<boolean> {
    const favorites = this.#data.favorites.filter((p) => p !== path);
    if (favorites.length === this.#data.favorites.length) return false;
    await this.#commit({ ...this.#data, favorites });
    return true;
  }

  async setDefault(path: string): Promise<void> {
    if (this.#data.defaultCwd === path) return;
    await this.#commit({ ...this.#data, defaultCwd: path });
  }

  #pinnedKey(path: string): string | undefined {
    if (Object.hasOwn(this.#data.pinned, path)) return path;
    const want = normalizeCwd(path);
    return this.#data.pinOrder.find((p) => normalizeCwd(p) === want);
  }

  /** 候选快照写盘成功后才替换内存 */
  async #commit(next: CwdData): Promise<void> {
    await this.#persist(next);
    this.#data = next;
  }

  async #persist(data: CwdData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }
}
