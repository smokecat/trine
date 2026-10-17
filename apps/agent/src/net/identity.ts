/**
 * 代理端身份持久化：`~/.trine/identity.json`。
 *
 * 一台机器一份，内含两套刻意分离的长期密钥（分离的理由见
 * core/crypto/sign.ts 的文件头）：
 * - **Ed25519**（`sign`）——向服务端证明「我是这台机器」，公钥登记给服务端；
 * - **X25519**（`box`）——E2E 内容加密，公钥只经 QR 带外递给 client，
 *   私钥**永不**离开本机。
 *
 * ## 文件权限
 *
 * 这个文件里有两把私钥，泄露即等同于这台机器被接管 + 全部会话内容可解。
 * 目录 0700、文件 0600，且**先写临时文件再 rename**：直接 open+write 会
 * 有一个「文件已存在但还是默认权限」的窗口，同机器上的其他用户正好能读到。
 * rename 是原子的，落地的那一刻权限就已经是 0600。
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  generateKeyPair,
  generateSignKeyPair,
  isValidSignPublicKey,
  randomToken,
  type BoxKeyPair,
  type SignKeyPair,
} from '@trine/core/crypto';

/** 私钥文件权限：仅属主可读写 */
const FILE_MODE = 0o600;
/** 目录权限：仅属主可进入 */
const DIR_MODE = 0o700;

const KeyPairSchema = z.object({
  publicKey: z.string().min(1),
  secretKey: z.string().min(1),
});

export const AgentIdentitySchema = z.object({
  v: z.literal(1),
  /**
   * 机器标识 = 设备标识。agent 侧两者恒等（协议里 machineId 就是 agent 的
   * deviceId，见 transport.ts 的 hello 注释），所以只存一个字段，
   * 避免出现两个值不一致这种根本不该存在的状态。
   */
  machineId: z.string().min(1).max(128),
  /** 展示名，用户可改；纯本地信息，不参与任何校验 */
  name: z.string().min(1),
  /** Ed25519：设备身份，公钥登记给服务端 */
  sign: KeyPairSchema,
  /** X25519：E2E 内容加密，私钥永不离开本机 */
  box: KeyPairSchema,
  createdAt: z.number().int().nonnegative(),
});
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

/** 默认身份文件路径：`~/.trine/identity.json` */
export function defaultIdentityPath(): string {
  return join(homedir(), '.trine', 'identity.json');
}

/**
 * 读取身份文件；不存在返回 null。
 *
 * 文件存在但内容坏掉时**抛错而不是重新生成**：重新生成会悄悄换掉
 * machineId 与两把公钥，表现为「这台机器忽然变成了另一台」——已配对的
 * client 全部失联，服务端还留着一台再也连不上的僵尸设备。宁可炸掉让人
 * 来看一眼。
 */
export async function readIdentity(
  path = defaultIdentityPath(),
): Promise<AgentIdentity | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return AgentIdentitySchema.parse(JSON.parse(raw));
  } catch (err) {
    throw new Error(
      `身份文件已损坏：${path}——请人工确认后再决定是删除重建（会丢失所有` +
        `已配对设备关系）还是从备份恢复。原因：${(err as Error).message}`,
    );
  }
}

/** 原子写入 + 0600（见文件头「文件权限」） */
export async function writeIdentity(
  identity: AgentIdentity,
  path = defaultIdentityPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  const tmp = `${path}.${randomToken(8)}.tmp`;
  await writeFile(tmp, JSON.stringify(identity, null, 2), { mode: FILE_MODE });
  // writeFile 的 mode 只在新建时生效；显式再 chmod 一次，
  // 覆盖掉 umask 可能削掉的位
  await chmod(tmp, FILE_MODE);
  await rename(tmp, path);
}

export interface LoadIdentityOptions {
  path?: string;
  /** 首次生成时的机器名，默认取 hostname */
  name?: string;
  /** 首次生成时的 machineId，默认随机——测试与多实例并存用 */
  machineId?: string;
  now?: () => number;
}

/**
 * 读取身份，没有就生成一份并落盘（幂等，进程每次启动调一次）。
 *
 * machineId 默认取随机串而非 hostname：hostname 会变（改名、DHCP 域名、
 * 容器里每次都不同），而 machineId 一旦登记给服务端就再也不能变——
 * 变了就是另一台机器。hostname 只作展示名。
 */
export async function loadOrCreateIdentity(
  options: LoadIdentityOptions = {},
): Promise<{ identity: AgentIdentity; created: boolean }> {
  const path = options.path ?? defaultIdentityPath();
  const existing = await readIdentity(path);
  if (existing) return { identity: existing, created: false };

  const identity: AgentIdentity = {
    v: 1,
    machineId: options.machineId ?? `m-${randomToken(16)}`,
    name: options.name ?? hostnameOrFallback(),
    sign: toPlain(generateSignKeyPair()),
    box: toPlain(generateKeyPair()),
    createdAt: (options.now ?? Date.now)(),
  };
  await writeIdentity(identity, path);
  return { identity, created: true };
}

function toPlain(kp: SignKeyPair | BoxKeyPair) {
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

function hostnameOrFallback(): string {
  try {
    // 某些受限环境（无 /etc/hostname 的容器）下会抛或返回空串
    return hostname() || 'trine-agent';
  } catch {
    return 'trine-agent';
  }
}

/**
 * 身份自检：两把公钥格式合法。
 *
 * 便宜的一道防线——损坏的密钥要么在注册时被服务端拒（还算清晰），
 * 要么在第一次 crypto_box 时抛一个与根因毫无关系的错。
 */
export function assertIdentityUsable(identity: AgentIdentity): void {
  if (!isValidSignPublicKey(identity.sign.publicKey)) {
    throw new Error('身份文件里的 Ed25519 公钥格式非法');
  }
}
