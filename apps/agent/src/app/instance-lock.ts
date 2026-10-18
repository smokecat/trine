/**
 * 单实例锁：同一个 `--home`（= 同一个 agent 身份）只允许一个进程。
 *
 * ## 为什么必须有
 *
 * 两个进程拿同一份 identity.json 接入服务端，服务端按 machineId 只留一条
 * agent 连接，新的进来就以 4005 踢掉旧的——于是两边约每秒互踢一次，各自的
 * 出站 seq 计数器又和服务端的共享高水位打架，日志里只看得到一串「seq 失配
 * 自愈」和「重连（第 1 次）」，很难联想到是有两个进程。典型触发：systemd 里
 * 常驻着一个，又在终端里用同一 `--home` 跑 `--pair`。
 *
 * ## 实现
 *
 * `<home>/agent.lock`，O_EXCL 创建并写入 pid。已存在时读出 pid：进程还活着
 * 就拒绝启动；已经不在（崩溃、kill -9 留下的残骸）就接管。
 *
 * 已知边界：
 * - pid 被系统复用给了无关进程时会误判「仍在运行」——报错信息里给出锁文件
 *   路径和 pid，由用户确认后手工删除。宁可多拦一次也不放两个进程进来。
 * - 两个进程**同时**接管同一份陈旧锁存在极小的竞态窗口（都删、都建）。
 *   正常启动路径（锁不存在）走 O_EXCL，没有这个问题。
 */
import { mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_FILE = 'agent.lock';

export class InstanceLockError extends Error {
  constructor(
    readonly lockPath: string,
    readonly pid: number,
  ) {
    super(
      `已有 agent 在使用这个身份目录（PID ${pid}，锁文件 ${lockPath}）。` +
        '同一身份同时只能运行一个 agent，否则两边会在服务端互相顶替。',
    );
    this.name = 'InstanceLockError';
  }
}

export interface InstanceLock {
  readonly path: string;
  /** 释放锁（幂等；只删仍属于本进程的锁文件） */
  release(): void;
}

export interface InstanceLockOptions {
  pid?: number;
  /** 注入存活探测（测试） */
  isAlive?: (pid: number) => boolean;
}

/** `kill(pid, 0)`：不发信号，只问进程在不在。EPERM = 在，但属于别的用户 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 读锁文件里的 pid；文件不存在返回 null，内容坏了返回 NaN（视为陈旧） */
export function readLockPid(home: string): number | null {
  try {
    return Number.parseInt(readFileSync(join(home, LOCK_FILE), 'utf8').trim(), 10);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * 当前持锁且存活的 pid；没有（无锁、陈旧锁）返回 null。只读，不接管。
 * 给子命令判断「daemon 在跑但连不上控制通道」用。
 */
export function lockHolder(home: string, isAlive = isProcessAlive): number | null {
  const pid = readLockPid(home);
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return null;
  return isAlive(pid) ? pid : null;
}

export function acquireInstanceLock(home: string, options: InstanceLockOptions = {}): InstanceLock {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? isProcessAlive;
  const path = join(home, LOCK_FILE);
  mkdirSync(home, { recursive: true, mode: 0o700 });

  // 两轮：第一轮撞上陈旧锁就删掉重来，第二轮还撞上说明有人刚抢到
  for (let round = 0; round < 2; round++) {
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = readLockPid(home);
      if (holder !== null && Number.isInteger(holder) && holder > 0 && isAlive(holder)) {
        throw new InstanceLockError(path, holder);
      }
      try {
        unlinkSync(path);
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
      }
      continue;
    }
    try {
      writeSync(fd, `${pid}\n`);
    } finally {
      closeSync(fd);
    }
    let released = false;
    return {
      path,
      release() {
        if (released) return;
        released = true;
        // 只删自己的：锁若已被别人接管（本进程曾被误判为陈旧），不能把对方的删掉
        if (readLockPid(home) === pid) {
          try {
            unlinkSync(path);
          } catch {
            // 已经不在了也无妨
          }
        }
      },
    };
  }
  const holder = readLockPid(home);
  throw new InstanceLockError(path, holder ?? Number.NaN);
}
