/** 日志行首的 HH:MM:SS，按进程时区（TZ）显示本地时间，而不是 UTC */
export function logTime(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
