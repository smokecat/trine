/**
 * 文件查看的访问控制（fs.list / fs.read，协议 §1.10）。
 *
 * ## 范围
 *
 * 根目录 = 会话 cwd + `TRINE_FILES_ALLOW` 白名单 + 信任目录（`files.json`，可远程增删，见 trust-store.ts）。请求路径（绝对 / `~` / 相对 cwd）先做
 * **字面**判断：不在任何根之内直接 `denied`，不碰文件系统——否则 not_found 与 denied 的
 * 区别就泄露了范围外文件存不存在。字面通过后再 `realpath`，按真实路径**再判一次**：
 * 指向范围外的符号链接（`ln -s ~/.ssh keys`）在这里被挡下。
 *
 * 「在根之内」按路径段比较（`/a/bc` 不在 `/a/b` 之内），根本身也算。
 *
 * ## 密钥类文件
 *
 * 不可配置覆盖，按真实路径的**每一段**匹配（见 `isSensitivePath`）。trine 自己的 home
 * （身份私钥、名册）整个拒绝，即使它就在会话 cwd 里。`/proc`、`/sys`、`/dev` 也整个拒绝：
 * `/proc/<pid>/environ` 是同用户可读的进程环境变量（token 常在里面），会话 cwd 设成 `/` 时
 * 原本能读到。
 */
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { FsDeniedReason, FsErrorCode } from '@trine/core';

const OUT_OF_SCOPE = '不在可浏览的范围内（会话目录或信任目录）';
const SENSITIVE = '密钥类文件不提供查看';

export class FileAccessError extends Error {
  readonly code: FsErrorCode;
  readonly reason: FsDeniedReason | undefined;
  constructor(code: FsErrorCode, message: string, reason?: FsDeniedReason) {
    super(message);
    this.name = 'FileAccessError';
    this.code = code;
    this.reason = reason;
  }
}

function outOfScope(): FileAccessError {
  return new FileAccessError('denied', OUT_OF_SCOPE, 'out_of_scope');
}

function sensitive(): FileAccessError {
  return new FileAccessError('denied', SENSITIVE, 'sensitive');
}

/** 目录段：这些目录里的东西一律不给看 */
const SENSITIVE_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.git', '.docker', '.kube']);
/** `.env` 家族里放行的模板文件 */
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist']);
const SENSITIVE_NAMES = new Set(['.netrc', '.npmrc', '.pypirc', '.pgpass', '.git-credentials']);
const SENSITIVE_EXT = /\.(pem|key|p12|pfx|jks|keystore)$/i;
const SSH_KEY = /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/;
/** 系统伪文件系统：进程环境变量、设备节点，整个不给看 */
const SYSTEM_DIRS = ['/proc', '/sys', '/dev'];

/** 文件名本身是否密钥类 */
export function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === '.env' || (lower.startsWith('.env.') && !ENV_TEMPLATES.has(lower))) return true;
  if (SENSITIVE_NAMES.has(lower)) return true;
  if (SENSITIVE_EXT.test(lower)) return true;
  if (SSH_KEY.test(lower)) return true;
  if (/^credentials.*\.json$/.test(lower)) return true;
  return false;
}

export function isWithin(path: string, root: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return path.startsWith(prefix);
}

export interface Root {
  /** 字面路径（resolve 过） */
  path: string;
  /** realpath；不存在的根不进集合 */
  real: string;
}

export interface Resolved {
  /** 字面绝对路径（展示用，保留用户看到的符号链接名） */
  path: string;
  real: string;
  root: Root;
}

export class FileAccess {
  readonly #allow: readonly string[];
  readonly #trusted: () => readonly string[];
  readonly #osHome: string;
  readonly #protected: readonly string[];
  #protectedReal: string[] | undefined;

  constructor(options: {
    allow: readonly string[];
    /** 信任目录（每次请求现取：增删立即生效） */
    trusted?: () => readonly string[];
    osHome: string;
    trineHome: string;
  }) {
    this.#allow = options.allow.map((p) => resolve(p));
    this.#trusted = options.trusted ?? (() => []);
    this.#osHome = options.osHome;
    this.#protected = [resolve(options.trineHome)];
  }

  /** TRINE_FILES_ALLOW 的目录（resolve 过） */
  get allow(): readonly string[] {
    return this.#allow;
  }

  /** 请求路径转绝对路径：`~` 展开，相对路径相对 base（没有 base 返回 undefined） */
  absolute(input: string, base: string | undefined): string | undefined {
    if (input === '~' || input.startsWith('~/')) return join(this.#osHome, input.slice(1));
    if (isAbsolute(input)) return resolve(input);
    return base === undefined ? undefined : resolve(base, input);
  }

  get osHome(): string {
    return this.#osHome;
  }

  /**
   * 会话的根目录集合：cwd 在前（相对路径相对它），不存在的跳过。
   *
   * 信任目录每次按**当前**真实路径复查：加入时校验过，但存的是字面路径，之后它（或某级祖先）
   * 可能被换成指向 `/` 或密钥类目录的链接——这时不当根用，免得「不能信任 /」被绕过。
   */
  async roots(cwd: string | undefined): Promise<Root[]> {
    const fixed = [...(cwd === undefined || cwd === '' ? [] : [resolve(cwd)]), ...this.#allow];
    const trusted = this.#trusted().map((p) => resolve(p));
    const out: Root[] = [];
    const seen = new Set<string>();
    for (const [path, isTrusted] of [...fixed.map((p) => [p, false] as const), ...trusted.map((p) => [p, true] as const)]) {
      if (seen.has(path)) continue;
      seen.add(path);
      const real = await realpath(path).catch(() => undefined);
      if (real === undefined) continue;
      if (isTrusted && (real === '/' || (await this.isSensitivePath(real)))) continue;
      out.push({ path, real });
    }
    return out;
  }

  /** 真实路径是否密钥类：任一段命中目录黑名单、末段命中文件名黑名单，或在 trine home / 系统伪文件系统里 */
  async isSensitivePath(real: string): Promise<boolean> {
    if (SYSTEM_DIRS.some((d) => isWithin(real, d))) return true;
    // 目录段不分大小写：macOS 默认文件系统里 `.SSH` 就是 `.ssh`
    const parts = real.split(sep);
    if (parts.some((p) => SENSITIVE_DIRS.has(p.toLowerCase()))) return true;
    if (isSensitiveName(basename(real))) return true;
    this.#protectedReal ??= await Promise.all(this.#protected.map((p) => realpath(p).catch(() => p)));
    return [...this.#protected, ...this.#protectedReal].some((p) => isWithin(real, p));
  }

  /**
   * 把请求路径解析成范围内的真实路径，不在范围内 / 密钥类 → `denied`，不存在 → `not_found`。
   * `input` 省略 = 第一个根（会话 cwd）。
   *
   * 密钥类判断对**字面路径和真实路径都做**：`.env → config/live` 这种链接，真实路径看着无害，
   * 但用户请求的就是 `.env`。不存在的路径要先确认它最深的已存在祖先在范围内才回 not_found，
   * 否则经由指向范围外的符号链接（`out/x`）就能探测范围外文件存不存在。
   */
  async resolve(input: string | undefined, roots: readonly Root[]): Promise<Resolved> {
    if (roots.length === 0) throw new FileAccessError('denied', '这个会话没有可查看的目录', 'out_of_scope');
    const path = input === undefined ? roots[0]!.path : this.absolute(input, roots[0]!.path)!;

    if (path.includes('\0')) throw new FileAccessError('denied', '路径不合法');
    // 字面密钥类判断放在范围判断之前：只看路径字符串、不碰文件系统，不泄露什么；
    // 范围外的 `.ssh`、`/proc` 回 sensitive，client 就不会给出注定失败的「信任」入口
    if (await this.isSensitivePath(path)) throw sensitive();
    const lexical = roots.find((r) => isWithin(path, r.path) || isWithin(path, r.real));
    if (lexical === undefined) throw outOfScope();

    let real: string;
    try {
      real = await realpath(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        await this.#assertAncestorInScope(path, roots);
        throw new FileAccessError('not_found', '文件不存在');
      }
      if (code === 'EACCES' || code === 'EPERM') throw new FileAccessError('denied', '没有读取权限');
      throw new FileAccessError('io', `读取失败：${(err as Error).message}`);
    }
    // 字面上命中的根优先（同一路径可能同时落在 cwd 与白名单里）
    const root = isWithin(real, lexical.real) ? lexical : roots.find((r) => isWithin(real, r.real));
    if (root === undefined) throw outOfScope();
    if (await this.isSensitivePath(real)) throw sensitive();
    return { path, real, root };
  }

  /**
   * 不存在的路径：最深的已存在祖先解析后不在范围内就当范围外，是密钥类就当密钥类——
   * 与该位置真有文件时回的一样，不泄露存在性。
   *
   * 「已存在」按 lstat 算：断掉的符号链接（`link → /outside/missing`）自身存在但解析不了，
   * 目标在不在范围内无从判断，按范围外处理；否则会退到链接所在目录回 not_found，而目标存在时
   * 回 denied，两者一比就能探测范围外的文件。
   */
  async #assertAncestorInScope(path: string, roots: readonly Root[]): Promise<void> {
    let cur = path;
    for (;;) {
      const real = await realpath(cur).catch(() => undefined);
      if (real !== undefined) {
        if (!roots.some((r) => isWithin(real, r.real))) throw outOfScope();
        if (await this.isSensitivePath(real)) throw sensitive();
        return;
      }
      if (await lstat(cur).then(() => true, () => false)) throw outOfScope();
      const up = dirname(cur);
      if (up === cur) throw outOfScope();
      cur = up;
    }
  }
}
