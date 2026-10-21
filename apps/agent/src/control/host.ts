/** AgentApp → ControlHost 适配（控制通道只依赖这层窄接口，便于单测） */
import type { AgentApp } from '../app/app.ts';
import type { PairingSession } from '../net/pairing.ts';
import { toListItem } from '../ext/commands.ts';
import { ControlServer, type ControlHost } from './server.ts';

export function agentControlHost(app: AgentApp): ControlHost {
  return {
    status: () => ({
      machineId: app.node.machineId,
      name: app.node.identity.name,
      online: app.node.online,
      devices: app.node.recipients.size,
    }),
    listDevices: () =>
      app.node.recipients.list().map((r) => ({ deviceId: r.deviceId, pairedAt: r.pairedAt })),
    revokeDevice: (deviceId) => app.revokeDevice(deviceId),
    startPairing: () => app.node.startPairing(),
    // 走 app 而不是 app.node：app 那层会顺带给新设备补一份 machine.info
    confirmPairing: (token, expected) => app.confirmPairing(token, expected),
    abortPairing: (token, reason) => {
      app.node.abortPairing(token, reason);
    },
    extensions: {
      list: () => app.extensionRegistry.list().map(toListItem),
      add: async (path) => toListItem(await app.extensionRegistry.add(path)),
      remove: (id) => app.extensionRegistry.remove(id),
      reload: async (id) => {
        await app.extensionRegistry.reload(id);
        return app.extensionRegistry.list().map(toListItem);
      },
    },
  };
}

export interface AttachControlOptions {
  log?: (line: string) => void;
  /** 不是控制通道发起的配对请求（本进程 `--pair` 打的码）交给它 */
  onOtherPairingRequest?: (session: PairingSession) => void;
}

/**
 * 给运行中的 agent 接上控制通道：接管配对回调并开始监听。
 * 监听失败会抛出，但回调已接好——调用方可以只记日志、让 agent 照常工作。
 */
export async function attachControlServer(
  app: AgentApp,
  socketPath: string,
  options: AttachControlOptions = {},
): Promise<ControlServer> {
  const log = options.log ?? (() => {});
  const control = new ControlServer(agentControlHost(app), { log });
  app.onPairingRequest = (session) => {
    if (!control.onPairingRequest(session)) options.onOtherPairingRequest?.(session);
  };
  app.onPairingAborted = (token) => {
    if (!control.onPairingAborted(token)) log('[pair] 对端取消了配对');
  };
  await control.listen(socketPath);
  return control;
}
