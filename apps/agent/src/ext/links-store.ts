/**
 * 会话关联：`<home>/session-links.json`，`{ v:1, links: { [sid]: SessionLink[] } }`。
 *
 * 单独成文件而不并进 sessions.json：旧版 agent 不认识 links，回滚后它全量重写 sessions.json
 * 时会把未知键剥掉；放在它不认识的文件里，回滚再升级也不丢。
 *
 * 写入只有 add / remove，按 (ext, ref) 去重，扩展只能改自己 ext 下的条目（调用方传 ext，
 * 这里不跨 ext 改）。内存先改再落盘，写盘失败回滚本次改动并 reject（调用方回 io）。
 */
import { EXT_LIMITS, SessionLinkSchema, type ExtLinkRef, type SessionLink } from '@trine/core';
import { z } from 'zod';
import { loadJsonFile, own, put, SerialWriter } from './json-file.ts';

const LinksFileSchema = z.object({
  v: z.literal(1),
  links: z.record(z.string(), z.array(SessionLinkSchema)),
});
type LinksFile = z.infer<typeof LinksFileSchema>;

export class LinkLimitError extends Error {
  constructor() {
    super(`每个会话最多 ${EXT_LIMITS.linksPerSession} 条关联`);
    this.name = 'LinkLimitError';
  }
}

export class SessionLinksStore {
  #data: LinksFile;
  readonly #writer: SerialWriter;
  #updates: Promise<unknown> = Promise.resolve();
  /** 每次改动 +1：读取缓存键用（关联变了，扩展视图就该重算） */
  #rev = 0;

  private constructor(path: string, data: LinksFile, log: (line: string) => void) {
    this.#data = data;
    this.#writer = new SerialWriter(path, () => JSON.stringify(this.#data, null, 2), log);
  }

  static async load(
    path: string,
    options: { log?: (line: string) => void; now?: () => number } = {},
  ): Promise<SessionLinksStore> {
    const log = options.log ?? (() => {});
    const data = await loadJsonFile(path, LinksFileSchema, () => ({ v: 1 as const, links: {} }), {
      log,
      now: options.now ?? (() => Date.now()),
      tag: 'links',
    });
    return new SessionLinksStore(path, data, log);
  }

  get rev(): number {
    return this.#rev;
  }

  /** 该会话的全部关联（没有返回 undefined，decorate 据此省略字段） */
  of(sessionId: string): SessionLink[] | undefined {
    const list = own(this.#data.links, sessionId);
    return list === undefined || list.length === 0 ? undefined : list.map((l) => ({ ...l }));
  }

  /** 带某扩展关联的全部会话 id */
  sessionsWith(ext: string): string[] {
    return Object.entries(this.#data.links)
      .filter(([, list]) => list.some((l) => l.ext === ext))
      .map(([sid]) => sid);
  }

  /**
   * 增删一个扩展在某会话下的关联。add 里已存在的 (ext, ref) 只更新 label。
   * @returns 是否有改动
   */
  update(sessionId: string, ext: string, add: readonly ExtLinkRef[], remove: readonly string[], at: number): Promise<boolean> {
    // 串行：写盘失败时回滚到「本次之前」，中间不能夹着别的更新，否则回滚会吞掉它
    const next = this.#updates.catch(() => {}).then(() => this.#update(sessionId, ext, add, remove, at));
    this.#updates = next;
    return next;
  }

  async #update(sessionId: string, ext: string, add: readonly ExtLinkRef[], remove: readonly string[], at: number): Promise<boolean> {
    const before = own(this.#data.links, sessionId);
    const next = (before ?? []).map((l) => ({ ...l }));
    let changed = false;
    const removeSet = new Set(remove);
    for (let i = next.length - 1; i >= 0; i--) {
      const link = next[i]!;
      if (link.ext === ext && removeSet.has(link.ref)) {
        next.splice(i, 1);
        changed = true;
      }
    }
    for (const ref of add) {
      const existing = next.find((l) => l.ext === ext && l.ref === ref.ref);
      if (existing !== undefined) {
        if (existing.label !== ref.label) {
          existing.label = ref.label;
          changed = true;
        }
        continue;
      }
      next.push({ ext, ref: ref.ref, label: ref.label, at });
      changed = true;
    }
    if (!changed) return false;
    if (next.length > EXT_LIMITS.linksPerSession) throw new LinkLimitError();
    this.#set(sessionId, next);
    this.#rev++;
    try {
      await this.#writer.persist();
    } catch (err) {
      this.#set(sessionId, before);
      throw err;
    }
    return true;
  }

  /**
   * 只刷新已有关联的 label（扩展在 badge / view 里带回新名字时）。不新增条目、不算用户意图，
   * 写盘失败不回滚（只是显示用的缓存）。
   * @returns 是否有改动
   */
  refreshLabels(sessionId: string, ext: string, refs: readonly ExtLinkRef[]): boolean {
    const list = own(this.#data.links, sessionId);
    if (list === undefined) return false;
    let changed = false;
    for (const ref of refs) {
      const link = list.find((l) => l.ext === ext && l.ref === ref.ref);
      if (link !== undefined && link.label !== ref.label) {
        link.label = ref.label;
        changed = true;
      }
    }
    if (changed) {
      this.#rev++;
      this.#writer.persist().catch(() => {});
    }
    return changed;
  }

  /** 会话被永久删除：清掉它的全部关联（失败不回滚，置脏后补写） */
  forget(sessionId: string): void {
    if (own(this.#data.links, sessionId) === undefined) return;
    delete this.#data.links[sessionId];
    this.#rev++;
    this.#writer.persist().catch(() => {});
  }

  async flush(): Promise<void> {
    await this.#updates.catch(() => {});
    await this.#writer.flush();
  }

  #set(sessionId: string, list: SessionLink[] | undefined): void {
    if (list === undefined || list.length === 0) delete this.#data.links[sessionId];
    else put(this.#data.links, sessionId, list);
  }
}
