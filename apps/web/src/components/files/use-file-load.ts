/**
 * 文件视图共用的加载与错误文案（抽屉与工作区 tab 都用）。
 */
import { useCallback, useEffect, useState } from 'react';
import { FsRequestError, RequestTimeoutError } from '@/lib/client.ts';

export type Load<T> = { state: 'loading' } | { state: 'ok'; value: T } | { state: 'error'; message: string; error: unknown };

/** 范围外（可以去信任）：新 agent 带 reason，旧 agent 的 denied 只能看 message 猜，按范围外处理 */
export function isOutOfScope(err: unknown): boolean {
  if (!(err instanceof FsRequestError) || err.code !== 'denied') return false;
  return err.reason === undefined ? err.message.includes('范围') : err.reason === 'out_of_scope';
}

/** 错误给人看的话：agent 的原话已经是中文，补上该怎么办 */
export function fileErrorText(err: unknown): string {
  if (err instanceof FsRequestError) {
    if (err.code === 'unavailable') return `${err.message}（agent 设置了 TRINE_FILES=off，或还没连上 relay）`;
    return err.message;
  }
  if (err instanceof RequestTimeoutError) return 'agent 没有应答（可能离线或版本过旧）';
  return err instanceof Error ? err.message : String(err);
}

/** 按 deps 加载；reload() 强制再跑一次（「刷新」由调用方在 fn 里决定要不要绕过缓存） */
export function useLoad<T>(fn: (() => Promise<T>) | null, deps: readonly unknown[]): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (fn === null) return;
    let alive = true;
    setLoad({ state: 'loading' });
    fn().then(
      (value) => alive && setLoad({ state: 'ok', value }),
      (err: unknown) => alive && setLoad({ state: 'error', message: fileErrorText(err), error: err }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fn 每次渲染都是新的，按 deps 与 tick 触发
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return [load, reload];
}
