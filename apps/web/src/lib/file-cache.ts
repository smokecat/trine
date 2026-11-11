/**
 * 文件预览缓存（client.openFile 用）：按「机器#会话#请求路径」存已下载解密的文件与它的对象 URL。
 *
 * - LRU：Map 的插入顺序即新旧顺序，命中挪到最新；超出条数 / 总字节时从最旧的淘汰并释放 URL。
 * - 引用计数：正在显示的视图（抽屉、工作区里**可见**的 tab）`retain(url)` 占住它的 URL，
 *   卸载时释放。被占用的条目不参与淘汰；刷新替换掉的旧条目如果还被占用，先挂成「退役」，
 *   最后一个使用者释放时才 revoke —— 否则另一处还开着的图片 / PDF 会突然失效。
 * - 隐藏的 tab 已卸载重内容（见 workspace/WorkspaceDock.tsx），不占引用，照常可被淘汰；
 *   切回时从缓存重读，缓存没了就重新下载。
 */
export interface FileCacheOptions<T> {
  maxEntries: number;
  maxBytes: number;
  /** 条目的字节数（淘汰按总字节算） */
  sizeOf: (value: T) => number;
  revoke: (url: string) => void;
}

export class FileCache<T extends { url: string }> {
  readonly #entries = new Map<string, T>();
  /** url → 使用者个数 */
  readonly #refs = new Map<string, number>();
  /** 已经不在缓存里、但还有人在用的 URL：引用归零时 revoke */
  readonly #retired = new Set<string>();
  readonly #options: FileCacheOptions<T>;

  constructor(options: FileCacheOptions<T>) {
    this.#options = options;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** 取缓存（命中即挪到最新） */
  get(key: string): T | undefined {
    const hit = this.#entries.get(key);
    if (hit === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, hit);
    return hit;
  }

  /** 放入（同键的旧条目被替换：没人用就立即释放，有人用就退役） */
  set(key: string, value: T): void {
    const old = this.#entries.get(key);
    this.#entries.delete(key);
    if (old !== undefined && old.url !== value.url) this.#drop(old.url);
    this.#entries.set(key, value);
    this.#trim();
  }

  /**
   * 占住一个 URL（可见消费者挂载时调用），返回释放函数（幂等）。
   * 不在缓存里的 URL 也可以占：释放时如果它已退役才 revoke。
   */
  retain(url: string): () => void {
    this.#refs.set(url, (this.#refs.get(url) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.#refs.get(url) ?? 1) - 1;
      if (n > 0) {
        this.#refs.set(url, n);
        return;
      }
      this.#refs.delete(url);
      if (this.#retired.delete(url)) this.#options.revoke(url);
      // 释放后缓存可能仍超额（之前因占用没法淘汰）：现在补上
      this.#trim();
    };
  }

  /** 当前占用数（测试 / 调试用） */
  refCount(url: string): number {
    return this.#refs.get(url) ?? 0;
  }

  #drop(url: string): void {
    if ((this.#refs.get(url) ?? 0) > 0) this.#retired.add(url);
    else this.#options.revoke(url);
  }

  /** 按条数与总字节淘汰最旧、且没人占用的（最新那个即使超额也留着：它正要显示） */
  #trim(): void {
    const { maxEntries, maxBytes, sizeOf, revoke } = this.#options;
    let total = 0;
    for (const f of this.#entries.values()) total += sizeOf(f);
    const newest = [...this.#entries.keys()].at(-1);
    for (const [key, f] of this.#entries) {
      if (this.#entries.size <= maxEntries && total <= maxBytes) break;
      if (key === newest) break;
      if ((this.#refs.get(f.url) ?? 0) > 0) continue;
      revoke(f.url);
      this.#entries.delete(key);
      total -= sizeOf(f);
    }
  }
}
