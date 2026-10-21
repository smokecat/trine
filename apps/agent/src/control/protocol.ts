/**
 * 本地控制通道协议：`<home>/control.sock` 上的换行分隔 JSON。
 *
 * 用途是让 `trine-agent pair` / `devices` / `status` 这些子命令驱动**正在运行**
 * 的 agent，而不必停掉常驻服务、再用同一身份另起一个进程（那会在服务端互相
 * 顶替，见 instance-lock.ts）。
 *
 * ## 信任边界
 *
 * 能连上这个 socket 的就能发起配对、撤销设备——权限等同于读得到 identity.json
 * 私钥的人。所以 socket 放在 0700 的 home 里、自身 0600，只对本机同一用户开放；
 * 不走 TCP 回环端口（多租户机器上任何用户都连得上）。配对仍然必须由人在终端里
 * 比对 SAS 后确认，控制通道只是把这一步从 daemon 进程挪到了子命令的终端里。
 */
import { z } from 'zod';

export const CONTROL_SOCKET = 'control.sock';

/** 单行上限：协议里最大的是配对 payload（几百字节），留足余量即可 */
export const MAX_LINE_BYTES = 64 * 1024;

const PeerSchema = z.object({
  clientDeviceId: z.string().min(1).max(128),
  digits: z.string(),
  emoji: z.array(z.string()),
});

export const ControlRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('status') }),
  z.object({ op: z.literal('devices.list') }),
  z.object({ op: z.literal('devices.revoke'), deviceId: z.string().min(1).max(128) }),
  /** 发起（或重新发起）一次配对；同一连接上同时只有一次，旧的会被中止 */
  z.object({ op: z.literal('pair.start') }),
  /**
   * 对某一条 pair.request 的回答。`requestId` 绑定的是用户**看到**的那组校验码：
   * 回答到达前若又来了新请求，旧 requestId 的确认会被拒。
   */
  z.object({ op: z.literal('pair.answer'), requestId: z.number().int().positive(), confirm: z.boolean() }),
  /** 扩展（见 ext/registry.ts）：path 由子命令解析成绝对路径再发 */
  z.object({ op: z.literal('ext.list') }),
  z.object({ op: z.literal('ext.add'), path: z.string().min(1).max(4096) }),
  z.object({ op: z.literal('ext.remove'), id: z.string().min(1).max(64) }),
  z.object({ op: z.literal('ext.reload'), id: z.string().min(1).max(64).optional() }),
  /**
   * 重启 agent（见 app/restart.ts）：预检结束后回 restart.result。sessionId 是发起会话，
   * 重启后在它的时间线留记录、带 continuePrompt 的发一条消息进去
   */
  z.object({
    op: z.literal('restart'),
    now: z.boolean(),
    sessionId: z.string().min(1).max(128).optional(),
    note: z.string().max(300).optional(),
    continuePrompt: z.string().max(4000).optional(),
  }),
  z.object({ op: z.literal('restart.cancel') }),
]);
export type ControlRequest = z.infer<typeof ControlRequestSchema>;

export const DeviceInfoSchema = z.object({
  deviceId: z.string(),
  pairedAt: z.number(),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

export const ExtListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  dir: z.string(),
  enabled: z.boolean(),
  trust: z.string(),
  status: z.string(),
  lastError: z.string().optional(),
});
export type ExtListItem = z.infer<typeof ExtListItemSchema>;

export const ControlEventSchema = z.discriminatedUnion('ev', [
  z.object({
    ev: z.literal('status'),
    pid: z.number(),
    machineId: z.string(),
    name: z.string(),
    online: z.boolean(),
    devices: z.number(),
  }),
  z.object({ ev: z.literal('devices'), devices: z.array(DeviceInfoSchema) }),
  z.object({ ev: z.literal('revoked'), deviceId: z.string(), removed: z.boolean() }),
  z.object({ ev: z.literal('pair.started'), payload: z.string(), expiresAt: z.number() }),
  z.object({ ev: z.literal('pair.request'), requestId: z.number(), peer: PeerSchema }),
  z.object({ ev: z.literal('pair.done'), clientDeviceId: z.string(), sent: z.boolean() }),
  /** 用户拒绝、对端放弃或 SAS 不符：这一轮配对码已作废 */
  z.object({ ev: z.literal('pair.aborted'), reason: z.string() }),
  z.object({ ev: z.literal('pair.expired') }),
  z.object({ ev: z.literal('ext.list'), items: z.array(ExtListItemSchema) }),
  z.object({ ev: z.literal('ext.added'), item: ExtListItemSchema }),
  z.object({ ev: z.literal('ext.removed'), id: z.string(), removed: z.boolean() }),
  z.object({ ev: z.literal('ext.reloaded'), items: z.array(ExtListItemSchema) }),
  z.object({
    ev: z.literal('restart.result'),
    ok: z.boolean(),
    phase: z.enum(['draining', 'restarting', 'cancelled']).optional(),
    toVersion: z.string().optional(),
    /** 排空时还在忙的会话数 */
    busySessions: z.number().optional(),
    deadline: z.number().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
    output: z.string().optional(),
  }),
  /** 请求出错；`fatal` 时 daemon 随后关闭连接 */
  z.object({ ev: z.literal('error'), message: z.string(), fatal: z.boolean().optional() }),
]);
export type ControlEvent = z.infer<typeof ControlEventSchema>;

/**
 * 按行切分的增量解码器。超长行视为协议错误（返回 error），由调用方断开——
 * 本机同用户才连得上，主要防的是自己写错的客户端把 daemon 内存撑爆。
 */
export class LineDecoder {
  #buffer = '';

  push(chunk: string): { lines: string[]; overflow: boolean } {
    this.#buffer += chunk;
    const lines: string[] = [];
    let nl: number;
    while ((nl = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, nl).trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (line !== '') lines.push(line);
    }
    return { lines, overflow: this.#buffer.length > MAX_LINE_BYTES };
  }
}

export function encodeLine(message: ControlRequest | ControlEvent): string {
  return `${JSON.stringify(message)}\n`;
}
