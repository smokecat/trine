import { describe, expect, test } from 'bun:test';
import type { MachineStats } from '@trine/core';
import {
  cpuPercent,
  cpuTotals,
  descendantsUsage,
  MachineStatsSampler,
  MachineStatsWatcher,
  parseMeminfo,
  parseNetstatIbn,
  parseProcNetDev,
  parseSwapUsage,
  parseVmStatAvailable,
  PRIME_MS,
  rate,
} from './machine-stats.ts';

// 合成的命令输出（格式照真实输出，数值为虚构）

const MEMINFO = `MemTotal:        8000000 kB
MemFree:         1000000 kB
MemAvailable:    5000000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
`;

const PROC_NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999 1 0 0 0 0 0 0 9999 1 0 0 0 0 0 0
  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0
docker0: 500 5 0 0 0 0 0 0 500 5 0 0 0 0 0 0
vethab12: 300 3 0 0 0 0 0 0 300 3 0 0 0 0 0 0
  wlan0: 10 1 0 0 0 0 0 0 20 2 0 0 0 0 0 0
`;

const NETSTAT = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                      100     0       9999      100     0       9999     0
lo0        16384 127           127.0.0.1       100     -       9999      100     -       9999     -
en0        1500  <Link#11>   02:00:00:00:00:01  50     0       4000       60     0       3000     0
en0        1500  192.168.1     192.168.1.2      50     -       4000       60     -       3000     -
en1        1500  <Link#12>   02:00:00:00:00:02  5      0        100        6     0         50     0
utun0      1380  <Link#20>                      7      0        777        7     0        777     0
`;

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    1000.
Pages active:                                  5000.
Pages inactive:                                2000.
Pages speculative:                              100.
Pages wired down:                              3000.
`;

describe('解析', () => {
  test('cpuTotals / cpuPercent：差值算占用；计数没前进返回 undefined', () => {
    const a = cpuTotals([{ times: { user: 10, sys: 10, idle: 80, nice: 0, irq: 0 } }]);
    const b = cpuTotals([{ times: { user: 30, sys: 20, idle: 150, nice: 0, irq: 0 } }]);
    expect(cpuPercent(a, b)).toBeCloseTo(30);
    expect(cpuPercent(a, a)).toBeUndefined();
  });

  test('parseMeminfo：MemAvailable 算已用，带 swap；缺字段 → undefined', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({
      totalBytes: 8000000 * 1024,
      usedBytes: 3000000 * 1024,
      swapTotalBytes: 2000000 * 1024,
      swapUsedBytes: 500000 * 1024,
    });
    expect(parseMeminfo('garbage')).toBeUndefined();
  });

  test('parseVmStatAvailable / parseSwapUsage（macOS）', () => {
    expect(parseVmStatAvailable(VM_STAT)).toBe((1000 + 2000 + 100) * 16384);
    expect(parseVmStatAvailable('nope')).toBeUndefined();
    expect(parseSwapUsage('total = 2048.00M  used = 512.50M  free = 1535.50M  (encrypted)')).toEqual({
      totalBytes: 2048 * 1024 ** 2,
      usedBytes: Math.round(512.5 * 1024 ** 2),
    });
    expect(parseSwapUsage('total = 0.00M  used = 0.00M  free = 0.00M')).toEqual({ totalBytes: 0, usedBytes: 0 });
  });

  test('parseProcNetDev：排除回环与容器虚拟网卡', () => {
    expect(parseProcNetDev(PROC_NET_DEV)).toEqual({ rx: 1010, tx: 2020 });
    expect(parseProcNetDev('Inter-|\n face |\n    lo: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0\n')).toBeUndefined();
  });

  test('parseNetstatIbn：只算 en* 的 <Link#> 行，地址列缺失也能解析', () => {
    expect(parseNetstatIbn(NETSTAT)).toEqual({ rx: 4100, tx: 3050 });
  });

  test('descendantsUsage：只算子孙，环与无关进程不算', () => {
    const ps = ['1 0 100', '10 1 200', '11 10 300', '12 11 400', '20 1 999', '30 99 1'].join('\n');
    expect(descendantsUsage(ps, 10)).toEqual({ processes: 2, rssBytes: (300 + 400) * 1024 });
    expect(descendantsUsage(ps, 12)).toEqual({ processes: 0, rssBytes: 0 });
  });

  test('descendantsUsage：采样器自己起的命令（root 的直接子进程）不算，带路径的也认', () => {
    const ps = ['10 1 200 agent', '11 10 300 claude', '12 10 50 ps', '13 10 60 /usr/sbin/sysctl', '14 11 70 ps'].join('\n');
    // 14 是 claude 起的 ps，不是采样器的，照算
    expect(descendantsUsage(ps, 10)).toEqual({ processes: 2, rssBytes: (300 + 70) * 1024 });
  });

  test('rate：计数回绕按 0', () => {
    expect(rate({ rx: 0, tx: 100 }, { rx: 2000, tx: 50 }, 2000)).toEqual({ rxBytesPerSec: 1000, txBytesPerSec: 0 });
  });
});

function fakeSampler(platform: NodeJS.Platform = 'linux') {
  let now = 1_000_000;
  let idle = 0;
  let busy = 0;
  let rx = 0;
  const sleeps: number[] = [];
  const sampler = new MachineStatsSampler({
    platform,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
      busy += 25;
      idle += 75;
      rx += 1000;
    },
    cpus: () => [{ times: { user: busy, idle } }],
    loadavg: () => [1, 2, 3],
    uptime: () => 42.7,
    readText: async (path) => {
      if (path === '/proc/meminfo') return MEMINFO;
      if (path === '/proc/net/dev') return `eth0: ${rx} 0 0 0 0 0 0 0 ${rx} 0 0 0 0 0 0 0\n`;
      throw new Error(`unexpected ${path}`);
    },
    run: async () => '1 0 0\n5 1 100\n6 5 50\n',
    pid: 1,
    homedir: '/home/u',
    statfs: async () => ({ type: 1, bsize: 4096, blocks: 100, bfree: 40, bavail: 30 }),
  });
  return {
    sampler,
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('MachineStatsSampler', () => {
  test('首次先打底再读，各块齐全；home 与 / 同一文件系统只报一次', async () => {
    const h = fakeSampler();
    const stats = await h.sampler.sample();
    expect(h.sleeps).toEqual([PRIME_MS]);
    expect(stats).toEqual({
      at: 1_000_000 + PRIME_MS,
      cpu: { percent: 25, cores: 1, load: [1, 2, 3] },
      memory: parseMeminfo(MEMINFO)!,
      disks: [{ label: '/', totalBytes: 100 * 4096, usedBytes: 60 * 4096, availBytes: 30 * 4096 }],
      network: { rxBytesPerSec: 1000, txBytesPerSec: 1000 },
      uptimeSec: 42,
      claude: { processes: 2, rssBytes: 150 * 1024 },
    });
  });

  test('缓存窗口内复用、并发合并；之后用上次读数作底，不再等', async () => {
    const h = fakeSampler();
    const [a, b] = await Promise.all([h.sampler.sample(), h.sampler.sample()]);
    expect(a).toBe(b);
    expect(await h.sampler.sample()).toBe(a);
    h.advance(10_000);
    const c = await h.sampler.sample();
    expect(c).not.toBe(a);
    expect(h.sleeps).toHaveLength(1);
  });

  test('home 与 / 同一文件系统：两次 statfs 之间 bavail 变了也只报一次', async () => {
    let bavail = 30;
    const h = new MachineStatsSampler({
      platform: 'win32',
      sleep: async () => {},
      cpus: () => [{ times: { user: 1, idle: 1 } }],
      statfs: async () => ({ type: 1, bsize: 4096, blocks: 100, bfree: 40, bavail: bavail-- }),
    });
    expect((await h.sample()).disks).toHaveLength(1);
  });

  test('不支持的平台：只有 cpu / 磁盘 / uptime', async () => {
    const stats: MachineStats = await fakeSampler('win32').sampler.sample();
    expect(Object.keys(stats).sort()).toEqual(['at', 'cpu', 'disks', 'uptimeSec']);
  });
});

function fakeWatcher() {
  let now = 0;
  let n = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextId = 1;
  const sent: { to: string; at: number; reqId?: string }[] = [];
  const watcher = new MachineStatsWatcher({
    sampler: { sample: async () => ({ at: ++n }) },
    emit: (to, stats, reqId) => sent.push({ to, at: stats.at, ...(reqId === undefined ? {} : { reqId }) }),
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id as number),
  });
  /** 时钟推进到 t，按时序触发到期定时器 */
  const advanceTo = async (t: number): Promise<void> => {
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= t).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    }
    now = t;
  };
  return { watcher, sent, timers, advanceTo };
}

describe('MachineStatsWatcher', () => {
  test('不带 watch：只回一次（带 reqId），不留租约', async () => {
    const h = fakeWatcher();
    await h.watcher.request('phone', 'q1');
    expect(h.sent).toEqual([{ to: 'phone', at: 1, reqId: 'q1' }]);
    expect(h.watcher.watcherCount).toBe(0);
  });

  test('watch：按间隔推给该设备，到期停止', async () => {
    const h = fakeWatcher();
    await h.watcher.request('phone', 'q1', { intervalMs: 1000, ttlMs: 3500 });
    await h.advanceTo(10_000);
    expect(h.sent.map((s) => s.reqId ?? 'push')).toEqual(['q1', 'push', 'push', 'push']);
    expect(h.sent.every((s) => s.to === 'phone')).toBe(true);
    expect(h.watcher.watcherCount).toBe(0);
  });

  test('订阅后紧接着退订（首次采样还没回来）：退订生效，不留租约', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sent: string[] = [];
    const watcher = new MachineStatsWatcher({
      sampler: { sample: async () => (await gate, { at: 1 }) },
      emit: (_to, _s, reqId) => sent.push(reqId ?? 'push'),
      setTimer: () => 1,
      clearTimer: () => {},
    });
    const sub = watcher.request('phone', 'q1', { intervalMs: 5000, ttlMs: 120_000 });
    const unsub = watcher.request('phone', 'q2', { intervalMs: 5000, ttlMs: 0 });
    release();
    await Promise.all([sub, unsub]);
    expect(sent).toEqual(['q1', 'q2']);
    expect(watcher.watcherCount).toBe(0);
  });

  test('同一设备新 watch 覆盖旧的；ttlMs 0 退订；设备之间互不影响', async () => {
    const h = fakeWatcher();
    await h.watcher.request('phone', 'q1', { intervalMs: 1000, ttlMs: 60_000 });
    await h.watcher.request('pc', 'q2', { intervalMs: 5000, ttlMs: 60_000 });
    await h.watcher.request('phone', 'q3', { intervalMs: 2000, ttlMs: 60_000 });
    await h.advanceTo(4000);
    expect(h.sent.filter((s) => s.to === 'phone' && s.reqId === undefined)).toHaveLength(2);
    await h.watcher.request('phone', 'q4', { intervalMs: 2000, ttlMs: 0 });
    expect(h.watcher.watcherCount).toBe(1);
    await h.advanceTo(20_000);
    expect(h.sent.filter((s) => s.to === 'phone' && s.reqId === undefined)).toHaveLength(2);
    expect(h.sent.filter((s) => s.to === 'pc' && s.reqId === undefined)).toHaveLength(4);
    h.watcher.dispose();
    expect(h.timers.size).toBe(0);
  });
});
