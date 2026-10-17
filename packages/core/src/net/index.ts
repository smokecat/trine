/**
 * 三端共用的网络接入原语：认证客户端 + 服务端地址推导。
 *
 * 单独开一个 `@trine/core/net` 子路径而不是并进根导出：这里的东西依赖
 * `fetch` 与 `URL`（运行时的，不是纯数据），与 protocol/crypto 那种零依赖的
 * 纯函数层性质不同，分开便于日后按需裁剪。
 *
 * **不含** WS 长连与重连——那牵扯各端的 socket 实现与生命周期策略
 * （agent 是 Bun.WebSocket + 指数退避，web 还要处理 visibilitychange），
 * 共用抽象的收益抵不上抽象本身的复杂度。
 */
export {
  AuthClient,
  AuthClientError,
  assertEnrollmentUrl,
  type AuthClientOptions,
  type AuthRequestOptions,
  type AuthToken,
} from './auth-client.ts';
export { httpBase, wsEndpoint } from './url.ts';
