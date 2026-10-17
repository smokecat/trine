/**
 * 代理端网络层：身份持久化 / 认证 / WS 长连 / 配对 / E2E 封套。
 *
 * 分层（自下而上）：
 * - `identity.ts` — `~/.trine/identity.json`（Ed25519 + X25519 + machineId）
 * - `recipients.ts` — 已配对 client 名册（deviceId → X25519 公钥）
 * - 认证（注册 / 挑战 / 应答换 token）与地址推导已下沉 `@trine/core/net`
 * - `ws-client.ts` — 建连 + hello + 指数退避重连
 * - `envelope.ts` — 明文事件 ↔ relay 密文（逐收件人 seal / 入站三步校验）
 * - `pairing.ts` — 配对发起、SAS、三路径核销
 * - `qr.ts` — 终端二维码（带纯文本 fallback）
 * - `node.ts` — 以上的装配，与 bridge 层的接缝
 */
export {
  CURSOR_SEP,
  openInbound,
  sealForAll,
  sealForRecipient,
  SeqCursors,
  type OpenFailure,
  type OpenResult,
  type SealedForRecipient,
  type SealOptions,
} from './envelope.ts';
export {
  AgentIdentitySchema,
  assertIdentityUsable,
  defaultIdentityPath,
  loadOrCreateIdentity,
  readIdentity,
  writeIdentity,
  type AgentIdentity,
  type LoadIdentityOptions,
} from './identity.ts';
export { AgentNode, type AgentNodeOptions } from './node.ts';
export {
  PAIRING_TOKEN_TTL_MS,
  PairingManager,
  type BeginOutcome,
  type ConfirmResult,
  type PairingManagerOptions,
  type PairingSession,
  type PendingPeer,
} from './pairing.ts';
export { formatPairingPrompt, renderPairingPayload, type RenderedPairing } from './qr.ts';
export {
  defaultRecipientsPath,
  RecipientBookSchema,
  RecipientBookStore,
  type Recipient,
  type RecipientBook,
} from './recipients.ts';
export {
  backoffDelay,
  CLOSE_UNAUTHENTICATED,
  DEFAULT_BACKOFF,
  WsClient,
  type BackoffOptions,
  type ConnectionState,
  type SocketLike,
  type WsClientOptions,
} from './ws-client.ts';
