/**
 * 新会话工作目录的检查与创建（cwd-create，`cwd.prepare.request`）。
 *
 * client 在「开始会话」前先问一次：目录在不在。不在 → 用户在确认框里看过要新建的各级目录后，
 * 再带 `create: true` 问一次，这里 `mkdir -p`。session.create 本身不变。
 *
 * ## 规则
 *
 * - 路径必须是绝对路径或 `~` 开头（没有会话，相对路径无所谓相对谁）；不能含 NUL。
 * - **已存在的目录**一律回 `exists`，不做密钥类判断：这里不写任何东西，session.create 本来就能用
 *   任意已存在的 cwd，不能因为多了预检就把原来能开的目录拦下。
 * - **要新建时**才判：字面路径，以及「最深已存在祖先的真实路径 + 其余段」，都不能是密钥类 / trine home /
 *   系统伪文件系统（同文件查看的 `isSensitivePath`）——后者挡住经由符号链接把目录建进 `~/.ssh` 之类。
 * - 路径或某级祖先是文件、失效的符号链接 → `not_dir`。一次最多新建 CWD_CREATE_MAX_DEPTH 级。
 * - 建完按真实路径复查：还得是目录、仍不在密钥类路径里（检查与创建之间祖先被换成链接）。
 *
 * 不提权（没有 sudo）；权限、只读、磁盘满等系统错误翻成中文。
 */
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { CWD_CREATE_MAX_DEPTH, type CwdPrepareErrorCode, type CwdPrepareStatus } from '@trine/core';
import { FileAccess } from '../files/access.ts';

export class CwdPrepareError extends Error {
  readonly code: CwdPrepareErrorCode;
  constructor(code: CwdPrepareErrorCode, message: string) {
    super(message);
    this.name = 'CwdPrepareError';
    this.code = code;
  }
}

export interface CwdPrepareResult {
  /** 解析后的绝对路径 */
  path: string;
  status: CwdPrepareStatus;
  /** missing / created：要新建（已新建）的各级目录，从浅到深 */
  missing: string[];
}

const DENIED = '密钥类目录、trine 自己的目录和系统目录下不能新建目录';

export class CwdPreparer {
  readonly #access: FileAccess;
  readonly #log: (line: string) => void;

  constructor(options: { osHome: string; trineHome: string; log?: (line: string) => void }) {
    // 只借用路径展开与密钥类判断，不涉及浏览范围
    this.#access = new FileAccess({ allow: [], osHome: options.osHome, trineHome: options.trineHome });
    this.#log = options.log ?? (() => {});
  }

  async prepare(input: string, create: boolean): Promise<CwdPrepareResult> {
    const trimmed = input.trim();
    if (trimmed === '' || trimmed.includes('\0')) throw new CwdPrepareError('invalid', '路径不合法');
    const path = this.#access.absolute(trimmed, undefined);
    if (path === undefined) throw new CwdPrepareError('invalid', '必须是绝对路径或以 ~ 开头');

    const { ancestor, missing } = await this.#walk(path);
    if (missing.length === 0) return { path, status: 'exists', missing };
    if (missing.length > CWD_CREATE_MAX_DEPTH) {
      throw new CwdPrepareError('invalid', `一次最多新建 ${CWD_CREATE_MAX_DEPTH} 级目录，请检查路径是否写错`);
    }
    await this.#assertCreatable(path, ancestor);
    if (!create) return { path, status: 'missing', missing };

    try {
      await mkdir(path, { recursive: true });
    } catch (err) {
      throw mkdirError(err, ancestor);
    }
    // 检查与创建之间祖先被换成符号链接：按真实路径复查
    const real = await realpath(path).catch(() => undefined);
    const st = real === undefined ? undefined : await stat(real).catch(() => undefined);
    if (real === undefined || st === undefined || !st.isDirectory()) {
      throw new CwdPrepareError('failed', '目录在创建过程中被替换，请重试');
    }
    if (await this.#access.isSensitivePath(real)) throw new CwdPrepareError('denied', DENIED);
    this.#log(`[cwd] 新建目录 ${path}（${missing.length} 级）`);
    return { path, status: 'created', missing };
  }

  /**
   * 从目标往上找最深的已存在祖先（stat 跟随链接）。`missing` 是其下要新建的各级，从浅到深；
   * 目标本身存在时为空。存在但不是目录 → not_dir。
   */
  async #walk(path: string): Promise<{ ancestor: string; missing: string[] }> {
    const missing: string[] = [];
    let cur = path;
    for (;;) {
      let st;
      try {
        st = await stat(cur);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') throw new CwdPrepareError('failed', `没有权限访问 ${dirname(cur)}`);
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new CwdPrepareError('failed', `检查目录失败：${(err as Error).message}`);
        // 自身在（lstat 得到）却解析不了 = 失效的符号链接，mkdir 会撞上 EEXIST
        if (code === 'ENOENT' && (await lstat(cur).then(() => true, () => false))) {
          throw new CwdPrepareError('not_dir', `${cur} 是失效的符号链接`);
        }
        missing.unshift(cur);
        const up = dirname(cur);
        // 根目录总是存在，走到这里说明 stat('/') 也失败了
        if (up === cur) throw new CwdPrepareError('failed', '检查目录失败');
        cur = up;
        continue;
      }
      if (!st.isDirectory()) {
        throw new CwdPrepareError('not_dir', cur === path ? '这个路径是文件，不是目录' : `${cur} 是文件，不能在它下面新建目录`);
      }
      return { ancestor: cur, missing };
    }
  }

  async #assertCreatable(path: string, ancestor: string): Promise<void> {
    if (await this.#access.isSensitivePath(path)) throw new CwdPrepareError('denied', DENIED);
    const ancestorReal = await realpath(ancestor).catch(() => undefined);
    if (ancestorReal === undefined) throw new CwdPrepareError('failed', `无法解析 ${ancestor}`);
    const target = join(ancestorReal, relative(ancestor, path));
    if ((await this.#access.isSensitivePath(ancestorReal)) || (await this.#access.isSensitivePath(target))) {
      throw new CwdPrepareError('denied', DENIED);
    }
  }
}

function mkdirError(err: unknown, ancestor: string): CwdPrepareError {
  const code = (err as NodeJS.ErrnoException).code;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return new CwdPrepareError('failed', `没有权限在 ${ancestor} 下新建目录`);
    case 'EROFS':
      return new CwdPrepareError('failed', '文件系统是只读的，不能新建目录');
    case 'ENOSPC':
      return new CwdPrepareError('failed', '磁盘空间不足');
    case 'EEXIST':
    case 'ENOTDIR':
      return new CwdPrepareError('not_dir', '路径上有同名文件，不能新建目录');
    case 'ENAMETOOLONG':
      return new CwdPrepareError('invalid', '路径太长');
    default:
      return new CwdPrepareError('failed', `新建目录失败：${err instanceof Error ? err.message : String(err)}`);
  }
}
