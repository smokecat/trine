/**
 * 文件查看的访问控制（fs.list / fs.read，协议 §1.10）。
 *
 * ## 范围
 *
 * 根目录 = 会话 cwd + `TRINE_FILES_ALLOW` 白名单。请求路径（绝对 / `~` / 相对 cwd）先做
 * **字面**判断：不在任何根之内直接 `denied`，不碰文件系统——否则 not_found 与 denied 的
 * 区别就泄露了范围外文件存不存在。字面通过后再 `realpath`，按真实路径**再判一次**：
 * 指向范围外的符号链接（`ln -s ~/.ssh keys`）在这里被挡下。
 *
 * 「在根之内」按路径段比较（`/a/bc` 不在 `/a/b` 之内），根本身也算。
 *
 * ## 密钥类文件
 *
 * 不可配置覆盖，按真实路径的**每一段**匹配（见 `isSensitivePath`）。trine 自己的 home
 * （身份私钥、名册）整个拒绝，即使它就在会话 cwd 里。
 */
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { FsErrorCode } from '@trine/core';

export class FileAccessError extends Error {
  readonly code: FsErrorCode;
  constructor(code: FsErrorCode, message: string) {
    super(message);
    this.name = 'FileAccessError';
    this.code = code;
  }
}

/** 目录段：这些目录里的东西一律不给看 */
const SENSITIVE_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.git', '.docker', '.kube']);
/** `.env` 家族里放行的模板文件 */
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist']);
const SENSITIVE_NAMES = new Set(['.netrc', '.npmrc', '.pypirc', '.pgpass', '.git-credentials']);
const SENSITIVE_EXT = /\.(pem|key|p12|pfx|jks|keystore)$/i;
const SSH_KEY = /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/;

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
  readonly #osHome: string;
  readonly #protected: readonly string[];
  #protectedReal: string[] | undefined;

  constructor(options: { allow: readonly string[]; osHome: string; trineHome: string }) {
    this.#allow = options.allow.map((p) => resolve(p));
    this.#osHome = options.osHome;
    this.#protected = [resolve(options.trineHome)];
  }

  /** 会话的根目录集合：cwd 在前（相对路径相对它），不存在的跳过 */
  async roots(cwd: string | undefined): Promise<Root[]> {
    const candidates = [...(cwd === undefined || cwd === '' ? [] : [resolve(cwd)]), ...this.#allow];
    const out: Root[] = [];
    for (const path of new Set(candidates)) {
      const real = await realpath(path).catch(() => undefined);
      if (real !== undefined) out.push({ path, real });
    }
    return out;
  }

  /** 真实路径是否密钥类：任一段命中目录黑名单、末段命中文件名黑名单，或在 trine home 里 */
  async isSensitivePath(real: string): Promise<boolean> {
    const parts = real.split(sep);
    if (parts.some((p) => SENSITIVE_DIRS.has(p))) return true;
    if (isSensitiveName(basename(real))) return true;
    this.#protectedReal ??= await Promise.all(this.#protected.map((p) => realpath(p).catch(() => p)));
    return [...this.#protected, ...this.#protectedReal].some((p) => isWithin(real, p));
  }

  /**
   * 把请求路径解析成范围内的真实路径，不在范围内 / 密钥类 → `denied`，不存在 → `not_found`。
   * `input` 省略 = 第一个根（会话 cwd）。
   */
  async resolve(input: string | undefined, roots: readonly Root[]): Promise<Resolved> {
    if (roots.length === 0) throw new FileAccessError('denied', '这个会话没有可查看的目录');
    let path: string;
    if (input === undefined) path = roots[0]!.path;
    else if (input === '~' || input.startsWith('~/')) path = join(this.#osHome, input.slice(1));
    else if (isAbsolute(input)) path = resolve(input);
    else path = resolve(roots[0]!.path, input);

    if (path.includes('\0')) throw new FileAccessError('denied', '路径不合法');
    const lexical = roots.find((r) => isWithin(path, r.path) || isWithin(path, r.real));
    if (lexical === undefined) throw new FileAccessError('denied', '不在可查看的范围内（会话目录或 TRINE_FILES_ALLOW）');

    let real: string;
    try {
      real = await realpath(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new FileAccessError('not_found', '文件不存在');
      if (code === 'EACCES' || code === 'EPERM') throw new FileAccessError('denied', '没有读取权限');
      throw new FileAccessError('io', `读取失败：${(err as Error).message}`);
    }
    // 字面上命中的根优先（同一路径可能同时落在 cwd 与白名单里）
    const root = isWithin(real, lexical.real) ? lexical : roots.find((r) => isWithin(real, r.real));
    if (root === undefined) throw new FileAccessError('denied', '符号链接指向了可查看范围之外');
    if (await this.isSensitivePath(real)) throw new FileAccessError('denied', '密钥类文件不提供查看');
    return { path, real, root };
  }
}
