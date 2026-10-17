/**
 * 进程级兜底：未处理的 Promise rejection / 未捕获异常只记日志，**不退出**。
 *
 * ## 为什么不按 Node/Bun 默认行为退出
 *
 * agent 是常驻进程，一个进程里跑着所有会话（每个会话一个 claude 子进程）和它们
 * 的后台任务。Bun 1.3.11 对未处理 rejection 的默认处理是打印后 `exit 1`——
 * 任何一条没被 catch 到的异步错误（评审 B2：一条畸形 / 新形状的 SDK system 消息
 * 让读取循环带 rejection 退出）就把所有会话、所有后台任务一起带走，代价远大于
 * 「某个会话的某一帧处理失败」。读取循环等热点已经各自 try/catch，这里是最后
 * 一道网：记下堆栈方便排查，让进程活着，受影响的会话由用户下一条消息 / stop
 * 自愈（session.ts 的不变量保证死 query 不会留在 #query 上）。
 *
 * 只在 cli 入口安装（测试环境不装，免得吞掉测试自己的断言错误）。
 */

/** 只用到 `on` 的最小 process 形状，便于测试注入 */
export interface GuardableProcess {
  on(event: 'unhandledRejection', listener: (reason: unknown, promise: Promise<unknown>) => void): unknown;
  on(event: 'uncaughtException', listener: (err: Error, origin: string) => void): unknown;
}

export function describeReason(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? `${reason.name}: ${reason.message}`;
  return typeof reason === 'string' ? reason : JSON.stringify(reason) ?? String(reason);
}

export function installProcessGuards(proc: GuardableProcess, log: (line: string) => void): void {
  proc.on('unhandledRejection', (reason) => {
    log(`[process] 未处理的 Promise rejection（已忽略，进程继续）：${describeReason(reason)}`);
  });
  proc.on('uncaughtException', (err, origin) => {
    log(`[process] 未捕获异常（${origin}，已忽略，进程继续）：${describeReason(err)}`);
  });
}
