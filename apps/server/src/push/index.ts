/**
 * 推送模块出口（D6：事件 → 渠道适配器）。
 *
 * - `types.ts`：渠道无关的事件/消息/渠道接口，脱敏边界由类型结构保证
 * - `text.ts`：机器标识 + 事件类型 → 固定中文文案（脱敏的唯一出口）
 * - `dispatcher.ts`：在线抑制、去抖、fire-and-forget 投递
 * - `bark.ts`：Bark 渠道（HTTP 直推，5s 超时 + 两次退避重试）
 *
 * 未配置任何渠道时 dispatcher 静默禁用——推送是可选功能，不配就没有，
 * 不该因此拒绝启动或刷警告日志。
 */
import type { ServerConfig } from '../config.ts';
import { BarkChannel } from './bark.ts';
import { PushDispatcher } from './dispatcher.ts';
import { parseAliases } from './text.ts';

export {
  BarkChannel,
  BARK_DEFAULTS,
  NonRetryableError,
  type BarkOptions,
} from './bark.ts';
export {
  PushDispatcher,
  type DispatchOutcome,
  type DispatcherOptions,
} from './dispatcher.ts';
export {
  machineLabel,
  parseAliases,
  renderPushMessage,
  MACHINE_LABEL_LENGTH,
} from './text.ts';
export type { PushChannel, PushEvent, PushMessage } from './types.ts';

export interface PushSetupDeps {
  config: ServerConfig;
  /** 该机器是否有在线 client（在线抑制判据） */
  hasOnlineClient: (machineId: string) => boolean;
  log?: (line: string) => void;
}

/**
 * 按配置装配推送分发器。
 *
 * Bark 的 serverUrl 与 deviceKey 缺任一项即不注册渠道——此时 dispatcher
 * 的 `enabled` 为 false，`dispatch()` 直接返回 skipped。
 */
export function createPushDispatcher(deps: PushSetupDeps): PushDispatcher {
  const { config } = deps;
  const log = deps.log ?? ((line: string) => console.info(line));

  const aliases = parseAliases(config.pushAliases);
  const aliasKeys = Object.keys(aliases);
  if (aliasKeys.length > 0) {
    // 打出 key 列表让用户能对照发现拼错的 machineId——拼错的 key 不会
    // 报错，只会安静地退回短前缀，不打出来就无从察觉。
    // machineId 是服务端可见的明文路由字段，记日志不泄密
    log(`[push] 已加载 ${aliasKeys.length} 条机器别名：${aliasKeys.join(', ')}`);
  }

  const dispatcher = new PushDispatcher({
    suppressWhenOnline: config.pushSuppressWhenOnline,
    hasOnlineClient: deps.hasOnlineClient,
    dedupeWindowMs: config.pushDedupeWindowMs,
    aliases,
    onError: (channel, err) =>
      // 只记渠道名与错误消息：错误对象里可能带请求体（含 device key）
      log(
        `[push] ${channel} 投递最终失败（已丢弃）：${
          err instanceof Error ? err.message : '未知错误'
        }`,
      ),
    log,
  });

  if (config.barkServerUrl && config.barkDeviceKey) {
    dispatcher.register(
      new BarkChannel({
        serverUrl: config.barkServerUrl,
        deviceKey: config.barkDeviceKey,
        timeoutMs: config.pushTimeoutMs,
        log,
      }),
    );
  }
  return dispatcher;
}
