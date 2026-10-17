/**
 * 服务端根地址 → 具体端点的推导。
 *
 * 「服务端地址」在配置（agent CLI 参数）与带外 QR（`PairingPayload.serverUrl`）
 * 里只出现一次、写成根地址，具体端点由这两个函数派生——省得每个调用方各自
 * 拼一遍字符串，也省得 `wss:` 与 `https:` 的互转规则散落三端各写一份。
 */

/** `wss://host/x` → `https://host/x`；已是 http(s) 则原样 */
export function httpBase(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  return url.toString().replace(/\/+$/, '');
}

/** 服务端根地址 → WS 端点 `.../ws` */
export function wsEndpoint(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws`;
  return url.toString();
}
