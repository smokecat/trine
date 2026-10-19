/**
 * 永不 yield 的输入流：next() 挂起直到 signal abort，然后正常结束。
 * 让 CLI 以流式输入模式起来（控制请求需要它），却一条用户消息也收不到。
 * 斜杠命令探测（commands-probe.ts）与读文件快照的临时 query（session.ts）共用。
 */
export function idleInput(signal: AbortSignal): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<never> {
      const done = (): IteratorResult<never> => ({ value: undefined as never, done: true });
      return {
        next(): Promise<IteratorResult<never>> {
          if (signal.aborted) return Promise.resolve(done());
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve(done()), { once: true });
          });
        },
        return(): Promise<IteratorResult<never>> {
          return Promise.resolve(done());
        },
      };
    },
  };
}
