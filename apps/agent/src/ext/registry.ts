/**
 * 扩展注册表：`<home>/extensions.json` + 各扩展目录下的 `trine-extension.json`。
 *
 * 安装 = 信任这段代码（以本用户身份运行），所以只能在本机经 `trine-agent ext add` 注册；
 * 浏览器只能启用 / 停用、改权限（ext.config.set）。
 *
 * ## 入口解析
 *
 * manifest.entry 是 argv：`entry[0]` 是相对路径（含 `/` 或以 `.` 开头）时按**扩展目录**解析，
 * 是裸命令名时在可信 PATH（去掉空段与 `.`）里找；其后以 `./`、`../` 开头的参数同样按扩展目录
 * 解析。绝不按会话 cwd 解析——否则会执行到工作项目里的同名脚本。不经过 shell。
 *
 * ## rev
 *
 * 目录有任何变化（增删、启停、权限、reload）rev 都变；machine.info.extensions.rev 带它，
 * client 据此重新拉 ext.catalog。rev 带进程启动时的随机前缀，重启后不会和旧值撞上。
 */
import { randomBytes } from 'node:crypto';
import { access, constants, readFile, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import {
  DEFAULT_EXT_CAPABILITY_POLICY,
  EXT_API_VERSION,
  ExtIdSchema,
  ExtManifestSchema,
  ExtPolicySchema,
  type ExtCapability,
  type ExtCatalogItem,
  type ExtManifest,
  type ExtPolicy,
  type ExtPolicyValue,
  type MachineExtensionsSummary,
} from '@trine/core';
import { z } from 'zod';
import { loadJsonFile, SerialWriter } from './json-file.ts';

export const MANIFEST_FILE = 'trine-extension.json';
/** 最多注册多少个扩展（catalog 帧上限 64） */
export const MAX_EXTENSIONS = 32;
const MANIFEST_MAX_BYTES = 64 * 1024;

const RegistryItemSchema = z.object({
  id: ExtIdSchema,
  path: z.string().min(1),
  enabled: z.boolean(),
  policy: ExtPolicySchema,
});
const RegistryFileSchema = z.object({ v: z.literal(1), items: z.array(RegistryItemSchema) });
type RegistryItem = z.infer<typeof RegistryItemSchema>;

export const DEFAULT_POLICY: ExtPolicy = { trust: 'custom', capabilities: {} };

/** 一个已注册扩展的运行时视图 */
export interface LoadedExtension {
  id: string;
  dir: string;
  enabled: boolean;
  policy: ExtPolicy;
  /** manifest 读不到 / 不合法时为 undefined，status 为 error */
  manifest: ExtManifest | undefined;
  /** 解析好的 argv（绝对路径）；manifest 不可用时为 undefined */
  argv: string[] | undefined;
  lastError: string | undefined;
  /** 本扩展的 reload 代次：缓存键、token 作废用 */
  generation: number;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** 可信 PATH：去掉空段、`.` 和相对路径段 */
export function trustedPath(path: string | undefined): string {
  return (path ?? '')
    .split(delimiter)
    .filter((p) => p !== '' && p !== '.' && isAbsolute(p))
    .join(delimiter);
}

export interface RegistryOptions {
  log?: (line: string) => void;
  now?: () => number;
  /** 查找裸命令（测试注入）；默认 Bun.which(cmd, { PATH: trustedPath(env.PATH) }) */
  which?: (cmd: string) => string | null;
}

/**
 * 读并校验一个扩展目录：manifest + 入口。失败抛 ManifestError（消息给人看）。
 * `trine-agent ext validate` 与注册、reload 共用。
 */
export async function inspectExtensionDir(
  dir: string,
  which: (cmd: string) => string | null = defaultWhich,
): Promise<{ dir: string; manifest: ExtManifest; argv: string[] }> {
  let real: string;
  try {
    real = await realpath(dir);
  } catch (err) {
    throw new ManifestError(`找不到扩展目录 ${dir}：${(err as Error).message}`);
  }
  if (!(await stat(real)).isDirectory()) throw new ManifestError(`${real} 不是目录`);
  const file = join(real, MANIFEST_FILE);
  let raw: string;
  try {
    const info = await stat(file);
    if (info.size > MANIFEST_MAX_BYTES) throw new ManifestError(`${MANIFEST_FILE} 过大（上限 64KB）`);
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err instanceof ManifestError) throw err;
    throw new ManifestError(`读不到 ${file}：${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ManifestError(`${MANIFEST_FILE} 不是合法 JSON：${(err as Error).message}`);
  }
  const parsed = ExtManifestSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((i) => `  ${i.path.join('.') || '(根)'}：${i.message}`)
      .join('\n');
    throw new ManifestError(`${MANIFEST_FILE} 不符合契约：\n${issues}`);
  }
  const manifest = parsed.data;
  if (manifest.apiVersion !== EXT_API_VERSION) {
    throw new ManifestError(`apiVersion ${manifest.apiVersion} 不受支持（这个 agent 支持 ${EXT_API_VERSION}）`);
  }
  const argv = await resolveEntry(real, manifest.entry, which);
  return { dir: real, manifest, argv };
}

async function resolveEntry(dir: string, entry: readonly string[], which: (cmd: string) => string | null): Promise<string[]> {
  const [head, ...rest] = entry;
  if (head === undefined) throw new ManifestError('entry 为空');
  let program: string;
  if (isAbsolute(head)) program = head;
  else if (head.includes('/') || head.startsWith('.')) program = resolve(dir, head);
  else {
    const found = which(head);
    if (found === null) throw new ManifestError(`entry 的命令 ${head} 不在 PATH 上`);
    program = found;
  }
  try {
    await access(program, constants.X_OK);
  } catch {
    throw new ManifestError(`entry ${program} 不存在或不可执行`);
  }
  // 参数里指向扩展目录内文件的相对路径（`bash bin/run`、`python3 ./main.py`）一律按扩展目录解析：
  // 留成相对路径的话，进程在会话目录里启动，会执行到工作项目里的同名文件
  const args = await Promise.all(
    rest.map(async (arg) => {
      if (arg.startsWith('./') || arg.startsWith('../')) return resolve(dir, arg);
      if (arg.startsWith('-') || isAbsolute(arg)) return arg;
      const candidate = resolve(dir, arg);
      return (await exists(candidate)) ? candidate : arg;
    }),
  );
  return [program, ...args];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultWhich(cmd: string): string | null {
  return Bun.which(cmd, { PATH: trustedPath(process.env.PATH) });
}

export class ExtensionRegistry {
  readonly #items: RegistryItem[];
  readonly #loaded = new Map<string, LoadedExtension>();
  readonly #writer: SerialWriter;
  readonly #log: (line: string) => void;
  readonly #which: (cmd: string) => string | null;
  readonly #bootId = randomBytes(4).toString('hex');
  #rev = 0;
  #generation = 0;
  /** 目录变化（增删、启停、权限、reload）时调；app 接到广播 machine.info 与作废 token */
  onChange: ((ext: string) => void) | undefined = undefined;

  private constructor(path: string, items: RegistryItem[], options: RegistryOptions) {
    this.#items = items;
    this.#log = options.log ?? (() => {});
    this.#which = options.which ?? defaultWhich;
    this.#writer = new SerialWriter(path, () => JSON.stringify({ v: 1, items: this.#items }, null, 2), this.#log);
  }

  static async load(path: string, options: RegistryOptions = {}): Promise<ExtensionRegistry> {
    const log = options.log ?? (() => {});
    const file = await loadJsonFile(path, RegistryFileSchema, () => ({ v: 1 as const, items: [] }), {
      log,
      now: options.now ?? (() => Date.now()),
      tag: 'ext',
    });
    // 同 id 重复只认第一条
    const seen = new Set<string>();
    const items = file.items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
    const registry = new ExtensionRegistry(path, items, options);
    for (const item of items) await registry.#loadOne(item);
    return registry;
  }

  get rev(): string {
    return `${this.#bootId}-${this.#rev}`;
  }

  summary(): MachineExtensionsSummary {
    return { api: EXT_API_VERSION, rev: this.rev, count: this.#items.length };
  }

  list(): LoadedExtension[] {
    return this.#items.map((i) => this.#loaded.get(i.id)).filter((e): e is LoadedExtension => e !== undefined);
  }

  get(id: string): LoadedExtension | undefined {
    return this.#loaded.get(id);
  }

  /** 可以运行：已启用且 manifest 可用 */
  usable(id: string): LoadedExtension | undefined {
    const ext = this.#loaded.get(id);
    return ext !== undefined && ext.enabled && ext.manifest !== undefined && ext.argv !== undefined ? ext : undefined;
  }

  catalog(): ExtCatalogItem[] {
    return this.list().map((e) => ({
      id: e.id,
      name: e.manifest?.name ?? e.id,
      version: e.manifest?.version ?? '',
      ...(e.manifest?.description === undefined ? {} : { description: e.manifest.description }),
      apiVersion: e.manifest?.apiVersion ?? 0,
      contributes: e.manifest?.contributes ?? {},
      capabilities: e.manifest?.capabilities ?? [],
      enabled: e.enabled,
      policy: e.policy,
      status: e.manifest === undefined ? 'error' : e.enabled ? 'ok' : 'disabled',
      ...(e.lastError === undefined ? {} : { lastError: e.lastError.slice(0, 1_000) }),
    }));
  }

  /**
   * 能力判定。未声明的能力一律 deny；全托管下声明过的一律 allow；
   * 自定义权限下按设置，缺省见 DEFAULT_EXT_CAPABILITY_POLICY。
   */
  decide(id: string, capability: ExtCapability): ExtPolicyValue {
    const ext = this.#loaded.get(id);
    if (ext?.manifest === undefined || !ext.manifest.capabilities.includes(capability)) return 'deny';
    if (ext.policy.trust === 'full') return 'allow';
    return ext.policy.capabilities[capability] ?? DEFAULT_EXT_CAPABILITY_POLICY[capability];
  }

  /** 全托管：扩展声明为 destructive / 带 confirm 的动作也不确认 */
  fullTrust(id: string): boolean {
    return this.#loaded.get(id)?.policy.trust === 'full';
  }

  /** 注册（或用新路径覆盖同 id 的旧注册）。返回 manifest 里的 id */
  async add(dir: string): Promise<LoadedExtension> {
    const inspected = await inspectExtensionDir(dir, this.#which);
    const id = inspected.manifest.id;
    const existing = this.#items.find((i) => i.id === id);
    if (existing === undefined && this.#items.length >= MAX_EXTENSIONS) {
      throw new ManifestError(`最多注册 ${MAX_EXTENSIONS} 个扩展`);
    }
    if (existing !== undefined) existing.path = inspected.dir;
    else this.#items.push({ id, path: inspected.dir, enabled: true, policy: DEFAULT_POLICY });
    await this.#writer.persist();
    const item = this.#items.find((i) => i.id === id)!;
    this.#setLoaded(item, inspected.manifest, inspected.argv, undefined);
    this.#changed(id);
    return this.#loaded.get(id)!;
  }

  async remove(id: string): Promise<boolean> {
    const index = this.#items.findIndex((i) => i.id === id);
    if (index === -1) return false;
    const [removed] = this.#items.splice(index, 1);
    try {
      await this.#writer.persist();
    } catch (err) {
      this.#items.splice(index, 0, removed!);
      throw err;
    }
    this.#loaded.delete(id);
    this.#changed(id);
    return true;
  }

  /** 重读 manifest（扩展升级后）。不给 id = 全部 */
  async reload(id?: string): Promise<void> {
    for (const item of this.#items) {
      if (id !== undefined && item.id !== id) continue;
      await this.#loadOne(item);
      this.#changed(item.id);
    }
  }

  async setConfig(id: string, patch: { enabled?: boolean; policy?: ExtPolicy }): Promise<void> {
    const item = this.#items.find((i) => i.id === id);
    if (item === undefined) throw new ManifestError(`没有扩展 ${id}`);
    const before = { enabled: item.enabled, policy: item.policy };
    if (patch.enabled !== undefined) item.enabled = patch.enabled;
    if (patch.policy !== undefined) item.policy = sanitizePolicy(patch.policy);
    try {
      await this.#writer.persist();
    } catch (err) {
      item.enabled = before.enabled;
      item.policy = before.policy;
      throw err;
    }
    const loaded = this.#loaded.get(id);
    if (loaded !== undefined) {
      loaded.enabled = item.enabled;
      loaded.policy = item.policy;
      loaded.generation = ++this.#generation;
    }
    this.#changed(id);
  }

  /** 记一次运行失败（设置页显示） */
  noteError(id: string, message: string | undefined): void {
    const loaded = this.#loaded.get(id);
    if (loaded === undefined || loaded.lastError === message) return;
    loaded.lastError = message;
    this.#rev++;
    this.onChange?.(id);
  }

  flush(): Promise<void> {
    return this.#writer.flush();
  }

  async #loadOne(item: RegistryItem): Promise<void> {
    try {
      const inspected = await inspectExtensionDir(item.path, this.#which);
      if (inspected.manifest.id !== item.id) {
        throw new ManifestError(`manifest 里的 id（${inspected.manifest.id}）与注册的 id（${item.id}）不一致`);
      }
      this.#setLoaded(item, inspected.manifest, inspected.argv, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log(`[ext] 加载扩展 ${item.id} 失败：${message}`);
      this.#setLoaded(item, undefined, undefined, message);
    }
  }

  #setLoaded(item: RegistryItem, manifest: ExtManifest | undefined, argv: string[] | undefined, error: string | undefined): void {
    this.#loaded.set(item.id, {
      id: item.id,
      dir: item.path,
      enabled: item.enabled,
      policy: item.policy,
      manifest,
      argv,
      lastError: error,
      generation: ++this.#generation,
    });
  }

  #changed(id: string): void {
    this.#rev++;
    this.onChange?.(id);
  }
}

/** 只保留已知能力名（浏览器发来的，别把任意键写进文件） */
function sanitizePolicy(policy: ExtPolicy): ExtPolicy {
  const capabilities: Record<string, ExtPolicyValue> = {};
  for (const key of Object.keys(DEFAULT_EXT_CAPABILITY_POLICY)) {
    const value = Object.hasOwn(policy.capabilities, key) ? policy.capabilities[key] : undefined;
    if (value !== undefined) capabilities[key] = value;
  }
  return { trust: policy.trust, capabilities };
}
