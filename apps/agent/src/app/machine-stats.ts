/**
 * 机器资源数据（machine-stats）：采样器 + 按设备的订阅租约。
 *
 * ## 采样（`MachineStatsSampler`）
 *
 * - CPU：`os.cpus()` 各核 times 之和，两次读数的差算总体占用——Linux / macOS 同一套；
 *   负载 `os.loadavg()`。
 * - 内存：Linux 读 `/proc/meminfo`（MemAvailable，含可回收的页缓存，比 MemFree 贴近
 *   「还能用多少」）；macOS 用 `vm_stat`（free + inactive + speculative 页）+
 *   `sysctl hw.memsize vm.swapusage`——`os.freemem()` 在 macOS 上只算 free 页，偏小很多。
 * - 磁盘：`statfs` home 与 `/`，同一个文件系统只报一次，标签只给 `/`、`~`。
 * - 网络：物理网卡收发字节的差 / 时间差。Linux 读 `/proc/net/dev`，排除回环与容器、
 *   VPN 等虚拟网卡（否则同一份流量会算两遍）；macOS 只算 `en*`（`netstat -ibn`）。
 * - claude：agent 全部子孙进程的个数与 RSS（`ps -axo pid=,ppid=,rss=,comm=`），即 claude CLI
 *   及其拉起的 MCP server 等；采样器自己起的命令不算。
 *
 * 每一块独立 try：采不到就省略那一块。CPU / 网速要两次读数：距上次读数太久（或从没读过）
 * 时先读一次、等 `PRIME_MS` 再读。结果缓存 `CACHE_MS`，并发请求合并成一次采样。
 *
 * ## 订阅（`MachineStatsWatcher`）
 *
 * 每台 client 设备一份租约 `{ intervalMs, expiresAt }`：`request` 先采样回一次（带 reqId，
 * 只发给请求设备），带 watch 时再按 interval 定时推给它，到期即停；同一设备的新 watch
 * 覆盖旧的，`ttlMs: 0` 退订。没有任何租约时不采样。
 */
import { readFile, statfs as statfsDefault } from 'node:fs/promises';
import os from 'node:os';
import type { MachineDisk, MachineStats } from '@trine/core';

/** 两次读数之间至少隔多久才算得出 CPU / 网速 */
export const PRIME_MS = 1_000;
/** 上次读数比这更旧就重新打底（太久的平均值没有意义） */
export const STALE_BASELINE_MS = 5 * 60_000;
/** 采样结果的复用窗口：几台设备同时到点时只采一次 */
export const CACHE_MS = 1_500;
/** 外部命令超时 */
export const COMMAND_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// 解析（纯函数，测试用合成输入）
// ---------------------------------------------------------------------------

export interface CpuTotals {
  idle: number;
  total: number;
}

export function cpuTotals(cpus: readonly { times: Record<string, number> }[]): CpuTotals {
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times['idle'] ?? 0;
  }
  return { idle, total };
}

/** 两次 CPU 读数 → 占用百分比；计数没前进（或回绕）返回 undefined */
export function cpuPercent(prev: CpuTotals, next: CpuTotals): number | undefined {
  const total = next.total - prev.total;
  const idle = next.idle - prev.idle;
  if (total <= 0 || idle < 0) return undefined;
  return Math.min(100, Math.max(0, ((total - idle) / total) * 100));
}

/** `/proc/meminfo`（kB）→ 字节 */
export function parseMeminfo(text: string): MachineStats['memory'] {
  const kb = (key: string): number | undefined => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m === null ? undefined : Number(m[1]) * 1024;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable') ?? kb('MemFree');
  if (total === undefined || available === undefined) return undefined;
  const swapTotal = kb('SwapTotal');
  const swapFree = kb('SwapFree');
  return {
    totalBytes: total,
    usedBytes: Math.max(0, total - available),
    ...(swapTotal === undefined || swapFree === undefined
      ? {}
      : { swapTotalBytes: swapTotal, swapUsedBytes: Math.max(0, swapTotal - swapFree) }),
  };
}

/** macOS `vm_stat` → 可用字节（free + inactive + speculative 页） */
export function parseVmStatAvailable(text: string): number | undefined {
  const page = /page size of (\d+) bytes/.exec(text);
  if (page === null) return undefined;
  const pages = (label: string): number => {
    const m = new RegExp(`^Pages ${label}:\\s+(\\d+)`, 'm').exec(text);
    return m === null ? 0 : Number(m[1]);
  };
  if (!/^Pages free:/m.test(text)) return undefined;
  return (pages('free') + pages('inactive') + pages('speculative')) * Number(page[1]);
}

/** macOS `sysctl -n vm.swapusage`：`total = 5120.00M  used = 3412.56M  free = …` */
export function parseSwapUsage(text: string): { totalBytes: number; usedBytes: number } | undefined {
  const unit = (n: string, u: string): number =>
    Number(n) * ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[u.toUpperCase()] ?? 1);
  const total = /total\s*=\s*([\d.]+)([KMGT])/i.exec(text);
  const used = /used\s*=\s*([\d.]+)([KMGT])/i.exec(text);
  if (total === null || used === null) return undefined;
  return { totalBytes: Math.round(unit(total[1]!, total[2]!)), usedBytes: Math.round(unit(used[1]!, used[2]!)) };
}

/** Linux 上不计入的网卡：回环、容器 / 虚拟机网桥、VPN 隧道（流量会在物理网卡上再算一遍） */
const LINUX_VIRTUAL_IFACE = /^(lo|veth|docker|br-|virbr|vnet|cni|flannel|cali|vxlan|kube|lxc|lxd|tailscale|tun|tap|wg|zt|ifb|dummy|bond_slave)/;

export interface NetCounters {
  rx: number;
  tx: number;
}

/** `/proc/net/dev` → 物理网卡收发字节合计 */
export function parseProcNetDev(text: string): NetCounters | undefined {
  let rx = 0;
  let tx = 0;
  let found = false;
  for (const line of text.split('\n')) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (m === null) continue;
    const name = m[1]!;
    if (LINUX_VIRTUAL_IFACE.test(name)) continue;
    const cols = m[2]!.trim().split(/\s+/).map(Number);
    if (cols.length < 9 || cols.some((n) => !Number.isFinite(n))) continue;
    rx += cols[0]!;
    tx += cols[8]!;
    found = true;
  }
  return found ? { rx, tx } : undefined;
}

/**
 * macOS `netstat -ibn` → `en*` 网卡收发字节合计。每块网卡取 `<Link#n>` 那一行；
 * 地址列可能为空，所以从行尾数列：… Ibytes Opkts Oerrs Obytes Coll。
 */
export function parseNetstatIbn(text: string): NetCounters | undefined {
  let rx = 0;
  let tx = 0;
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.includes('<Link#')) continue;
    const cols = line.trim().split(/\s+/);
    const name = cols[0] ?? '';
    if (!/^en\d+$/.test(name) || seen.has(name) || cols.length < 8) continue;
    const ibytes = Number(cols[cols.length - 5]);
    const obytes = Number(cols[cols.length - 2]);
    if (!Number.isFinite(ibytes) || !Number.isFinite(obytes)) continue;
    seen.add(name);
    rx += ibytes;
    tx += obytes;
  }
  return seen.size > 0 ? { rx, tx } : undefined;
}

/** 采样器自己起的命令：它们也是 agent 的子进程，不算进 claude 占用 */
const SAMPLER_COMMANDS = new Set(['ps', 'sysctl', 'vm_stat', 'netstat']);

/**
 * `ps -axo pid=,ppid=,rss=,comm=`（rss 单位 KB）→ root 的全部子孙进程个数与 RSS 合计。
 * root 的直接子进程里，采样器自己起的命令（SAMPLER_COMMANDS）不算。
 */
export function descendantsUsage(psText: string, rootPid: number): { processes: number; rssBytes: number } {
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const line of psText.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)(?:\s+(.*))?$/.exec(line);
    if (m === null) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const kb = Number(m[3]);
    const comm = (m[4] ?? '').trim();
    if (ppid === rootPid && SAMPLER_COMMANDS.has(comm.slice(comm.lastIndexOf('/') + 1))) continue;
    rss.set(pid, Number.isFinite(kb) ? kb * 1024 : 0);
    const list = children.get(ppid);
    if (list === undefined) children.set(ppid, [pid]);
    else list.push(pid);
  }
  let processes = 0;
  let rssBytes = 0;
  const stack = [...(children.get(rootPid) ?? [])];
  const visited = new Set<number>([rootPid]);
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    processes += 1;
    rssBytes += rss.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return { processes, rssBytes };
}

/** 网速：计数回绕 / 网卡重置时按 0 算，不报负数 */
export function rate(prev: NetCounters, next: NetCounters, elapsedMs: number): MachineStats['network'] {
  if (elapsedMs <= 0) return undefined;
  const per = (d: number): number => Math.max(0, Math.round((d * 1000) / elapsedMs));
  return { rxBytesPerSec: per(next.rx - prev.rx), txBytesPerSec: per(next.tx - prev.tx) };
}

// ---------------------------------------------------------------------------
// 采样器
// ---------------------------------------------------------------------------

interface StatFsLike {
  type: number | bigint;
  bsize: number | bigint;
  blocks: number | bigint;
  bfree: number | bigint;
  bavail: number | bigint;
}

export interface MachineStatsSamplerOptions {
  platform?: NodeJS.Platform;
  /** 读文本文件（/proc/*） */
  readText?: (path: string) => Promise<string>;
  /** 跑命令取 stdout；失败 / 超时 reject */
  run?: (cmd: string[]) => Promise<string>;
  cpus?: () => readonly { times: Record<string, number> }[];
  loadavg?: () => number[];
  uptime?: () => number;
  statfs?: (path: string) => Promise<StatFsLike>;
  homedir?: string;
  /** 子孙进程的根，默认本进程 */
  pid?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Baseline {
  at: number;
  cpu: CpuTotals;
  net: NetCounters | undefined;
}

export class MachineStatsSampler {
  readonly #platform: NodeJS.Platform;
  readonly #readText: (path: string) => Promise<string>;
  readonly #run: (cmd: string[]) => Promise<string>;
  readonly #cpus: () => readonly { times: Record<string, number> }[];
  readonly #loadavg: () => number[];
  readonly #uptime: () => number;
  readonly #statfs: (path: string) => Promise<StatFsLike>;
  readonly #homedir: string;
  readonly #pid: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #baseline: Baseline | undefined;
  #cached: MachineStats | undefined;
  #inflight: Promise<MachineStats> | undefined;

  constructor(options: MachineStatsSamplerOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#readText = options.readText ?? ((path) => readFile(path, 'utf8'));
    this.#run = options.run ?? runCommand;
    this.#cpus = options.cpus ?? (() => os.cpus());
    this.#loadavg = options.loadavg ?? (() => os.loadavg());
    this.#uptime = options.uptime ?? (() => os.uptime());
    this.#statfs = options.statfs ?? ((path) => statfsDefault(path));
    this.#homedir = options.homedir ?? os.homedir();
    this.#pid = options.pid ?? process.pid;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** 采一次（`CACHE_MS` 内复用上次结果，并发调用共用一次采样）。不抛 */
  sample(): Promise<MachineStats> {
    const cached = this.#cached;
    if (cached !== undefined && this.#now() - cached.at < CACHE_MS) return Promise.resolve(cached);
    this.#inflight ??= this.#sample().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  async #sample(): Promise<MachineStats> {
    let base = this.#baseline;
    if (base === undefined || this.#now() - base.at > STALE_BASELINE_MS) {
      base = await this.#readBaseline();
      await this.#sleep(PRIME_MS);
    }
    const next = await this.#readBaseline();
    this.#baseline = next;
    const elapsed = next.at - base.at;

    const [memory, disks, claude] = await Promise.all([
      this.#memory().catch(() => undefined),
      this.#disks().catch(() => undefined),
      this.#claude().catch(() => undefined),
    ]);
    const percent = cpuPercent(base.cpu, next.cpu);
    const cores = this.#cpus().length;
    const load = this.#loadavg();
    const network = base.net !== undefined && next.net !== undefined ? rate(base.net, next.net, elapsed) : undefined;
    const uptime = Math.floor(this.#uptime());

    const stats: MachineStats = {
      at: next.at,
      ...(percent === undefined || cores === 0
        ? {}
        : {
            cpu: {
              percent: Math.round(percent * 10) / 10,
              cores,
              ...(load.length === 3 ? { load: [load[0]!, load[1]!, load[2]!] as [number, number, number] } : {}),
            },
          }),
      ...(memory === undefined ? {} : { memory }),
      ...(disks === undefined || disks.length === 0 ? {} : { disks }),
      ...(network === undefined ? {} : { network }),
      ...(Number.isFinite(uptime) && uptime >= 0 ? { uptimeSec: uptime } : {}),
      ...(claude === undefined ? {} : { claude }),
    };
    this.#cached = stats;
    return stats;
  }

  async #readBaseline(): Promise<Baseline> {
    const net = await this.#net().catch(() => undefined);
    return { at: this.#now(), cpu: cpuTotals(this.#cpus()), net };
  }

  async #net(): Promise<NetCounters | undefined> {
    if (this.#platform === 'linux') return parseProcNetDev(await this.#readText('/proc/net/dev'));
    if (this.#platform === 'darwin') return parseNetstatIbn(await this.#run(['netstat', '-ibn']));
    return undefined;
  }

  async #memory(): Promise<MachineStats['memory']> {
    if (this.#platform === 'linux') return parseMeminfo(await this.#readText('/proc/meminfo'));
    if (this.#platform !== 'darwin') return undefined;
    const [sysctl, vmStat] = await Promise.all([
      this.#run(['sysctl', '-n', 'hw.memsize', 'vm.swapusage']),
      this.#run(['vm_stat']),
    ]);
    const [memsize, ...rest] = sysctl.split('\n');
    const total = Number(memsize?.trim());
    const available = parseVmStatAvailable(vmStat);
    if (!Number.isFinite(total) || total <= 0 || available === undefined) return undefined;
    const swap = parseSwapUsage(rest.join('\n'));
    return {
      totalBytes: total,
      usedBytes: Math.max(0, total - available),
      ...(swap === undefined ? {} : { swapTotalBytes: swap.totalBytes, swapUsedBytes: swap.usedBytes }),
    };
  }

  async #disks(): Promise<MachineDisk[]> {
    const out: MachineDisk[] = [];
    const seen = new Set<string>();
    for (const [label, path] of [
      ['/', '/'],
      ['~', this.#homedir],
    ] as const) {
      let fs: StatFsLike;
      try {
        fs = await this.#statfs(path);
      } catch {
        continue;
      }
      const n = (v: number | bigint): number => Number(v);
      // 同一个文件系统（home 就在根分区上；macOS 的 / 与数据卷共享 APFS 容器）只报一次。
      // 只用不变的字段：bavail 在两次 statfs 之间可能因写入而变
      const key = `${n(fs.type)}:${n(fs.blocks)}:${n(fs.bsize)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const bsize = n(fs.bsize);
      out.push({
        label,
        totalBytes: n(fs.blocks) * bsize,
        usedBytes: Math.max(0, n(fs.blocks) - n(fs.bfree)) * bsize,
        availBytes: n(fs.bavail) * bsize,
      });
    }
    return out;
  }

  async #claude(): Promise<MachineStats['claude']> {
    if (this.#platform !== 'linux' && this.#platform !== 'darwin') return undefined;
    return descendantsUsage(await this.#run(['ps', '-axo', 'pid=,ppid=,rss=,comm=']), this.#pid);
  }
}

/** 跑命令取 stdout：非 0 退出 / 超时 reject */
async function runCommand(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
  const timer = setTimeout(() => proc.kill(), COMMAND_TIMEOUT_MS);
  try {
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) throw new Error(`${cmd[0]} 退出码 ${code}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 订阅
// ---------------------------------------------------------------------------

export interface MachineStatsWatcherOptions {
  sampler: Pick<MachineStatsSampler, 'sample'>;
  /** 发给某台设备；reqId 有值 = 应答 */
  emit: (deviceId: string, stats: MachineStats, reqId?: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (line: string) => void;
}

interface Lease {
  intervalMs: number;
  expiresAt: number;
  timer: unknown;
}

export class MachineStatsWatcher {
  readonly #sampler: Pick<MachineStatsSampler, 'sample'>;
  readonly #emit: (deviceId: string, stats: MachineStats, reqId?: string) => void;
  readonly #now: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #log: (line: string) => void;
  readonly #leases = new Map<string, Lease>();
  /** 每台设备带 watch 的请求代次：采样期间来了更新的请求，旧请求就不再装租约 */
  readonly #generation = new Map<string, number>();

  constructor(options: MachineStatsWatcherOptions) {
    this.#sampler = options.sampler;
    this.#emit = options.emit;
    this.#now = options.now ?? (() => Date.now());
    this.#setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        (t as { unref?: () => void }).unref?.();
        return t;
      });
    this.#clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.#log = options.log ?? (() => {});
  }

  /** 当前有租约的设备数（测试用） */
  get watcherCount(): number {
    return this.#leases.size;
  }

  /** 采一次回给请求设备；带 watch 则建立 / 覆盖 / 取消（ttlMs 0）该设备的租约 */
  async request(deviceId: string, reqId: string, watch?: { intervalMs: number; ttlMs: number }): Promise<void> {
    let generation: number | undefined;
    if (watch !== undefined) {
      this.#cancel(deviceId);
      generation = (this.#generation.get(deviceId) ?? 0) + 1;
      this.#generation.set(deviceId, generation);
    }
    const stats = await this.#sampler.sample();
    this.#emit(deviceId, stats, reqId);
    if (watch === undefined || watch.ttlMs === 0) return;
    // 采样期间同一设备又来了新的 watch（含退订）：以后来的为准，这次不装租约
    if (this.#generation.get(deviceId) !== generation) return;
    const lease: Lease = { intervalMs: watch.intervalMs, expiresAt: this.#now() + watch.ttlMs, timer: undefined };
    this.#leases.set(deviceId, lease);
    this.#schedule(deviceId, lease);
  }

  dispose(): void {
    for (const id of [...this.#leases.keys()]) this.#cancel(id);
  }

  #cancel(deviceId: string): void {
    const lease = this.#leases.get(deviceId);
    if (lease === undefined) return;
    this.#clearTimer(lease.timer);
    this.#leases.delete(deviceId);
  }

  #schedule(deviceId: string, lease: Lease): void {
    lease.timer = this.#setTimer(() => {
      if (this.#leases.get(deviceId) !== lease) return;
      if (this.#now() >= lease.expiresAt) {
        this.#leases.delete(deviceId);
        return;
      }
      void this.#sampler
        .sample()
        .then(
          (stats) => {
            if (this.#leases.get(deviceId) === lease) this.#emit(deviceId, stats);
          },
          (err: unknown) => this.#log(`[stats] 采样失败：${err instanceof Error ? err.message : String(err)}`),
        )
        .finally(() => {
          if (this.#leases.get(deviceId) === lease) this.#schedule(deviceId, lease);
        });
    }, lease.intervalMs);
  }
}
