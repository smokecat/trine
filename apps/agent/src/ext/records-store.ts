/**
 * 时间线记录卡：`<home>/session-ext-records.json`，`{ v:1, records: { [sid]: ExtRecord[] } }`。
 *
 * 记录是给人看的旁注（「已关联 X」「归档 · X」），不是状态：每会话只留最近
 * EXT_RECORDS_PER_SESSION 条，写盘失败只记日志、不回滚（下次改动时补写）。
 * 不进 Claude 转录，也不进 session.history（HistoryItem 是判别联合，新 kind 会让旧 web 整帧解析失败）。
 */
import { randomUUID } from 'node:crypto';
import { EXT_RECORDS_PER_SESSION, ExtRecordSchema, type ExtRecord } from '@trine/core';
import { z } from 'zod';
import { loadJsonFile, own, put, SerialWriter } from './json-file.ts';
import type { SessionLinksStore } from './links-store.ts';

const RecordsFileSchema = z.object({
  v: z.literal(1),
  records: z.record(z.string(), z.array(ExtRecordSchema)),
});
type RecordsFile = z.infer<typeof RecordsFileSchema>;

export type ExtRecordInput = Omit<ExtRecord, 'id' | 'at'>;

export class SessionRecordsStore {
  readonly #data: RecordsFile;
  readonly #writer: SerialWriter;
  readonly #now: () => number;
  readonly #uuid: () => string;
  readonly #listeners = new Set<(sessionId: string, record: ExtRecord) => void>();

  private constructor(path: string, data: RecordsFile, options: { log: (line: string) => void; now: () => number; uuid: () => string }) {
    this.#data = data;
    this.#now = options.now;
    this.#uuid = options.uuid;
    this.#writer = new SerialWriter(path, () => JSON.stringify(this.#data, null, 2), options.log);
  }

  static async load(
    path: string,
    options: { log?: (line: string) => void; now?: () => number; uuid?: () => string } = {},
  ): Promise<SessionRecordsStore> {
    const log = options.log ?? (() => {});
    const now = options.now ?? (() => Date.now());
    const data = await loadJsonFile(path, RecordsFileSchema, () => ({ v: 1 as const, records: {} }), { log, now, tag: 'records' });
    return new SessionRecordsStore(path, data, { log, now, uuid: options.uuid ?? (() => randomUUID()) });
  }

  /** 新增一条记录后通知（app 接到广播 ext.record） */
  onAppend(listener: (sessionId: string, record: ExtRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 该会话的记录，按时间正序 */
  of(sessionId: string): ExtRecord[] {
    return (own(this.#data.records, sessionId) ?? []).map((r) => ({ ...r }));
  }

  append(sessionId: string, input: ExtRecordInput): ExtRecord {
    const record = ExtRecordSchema.parse({ ...input, id: this.#uuid(), at: this.#now() });
    const list = [...(own(this.#data.records, sessionId) ?? []), record].slice(-EXT_RECORDS_PER_SESSION);
    put(this.#data.records, sessionId, list);
    this.#writer.persist().catch(() => {});
    for (const listener of this.#listeners) listener(sessionId, { ...record });
    return record;
  }

  /** 会话被永久删除：清掉它的记录 */
  forget(sessionId: string): void {
    if (own(this.#data.records, sessionId) === undefined) return;
    delete this.#data.records[sessionId];
    this.#writer.persist().catch(() => {});
  }

  async flush(): Promise<void> {
    await this.#writer.flush();
  }
}

/**
 * 关联的增删（不论来源：手动「关联…」、扩展的 links.* 效果、新会话带的关联）都在该会话留一条记录。
 * extName 在记录时取，扩展移除后旧记录照样显示原名。
 */
export function recordLinkChanges(
  links: Pick<SessionLinksStore, 'onChange'>,
  records: Pick<SessionRecordsStore, 'append'>,
  extName: (ext: string) => string,
): () => void {
  return links.onChange(({ sessionId, ext, added, removed }) => {
    const name = extName(ext);
    for (const link of added) records.append(sessionId, { ext, extName: name, kind: 'linked', label: link.label || link.ref });
    for (const link of removed) records.append(sessionId, { ext, extName: name, kind: 'unlinked', label: link.label || link.ref });
  });
}
