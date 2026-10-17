// @trine/server 入口：Bun + Hono 零知识密文中转
// 装配见 ./server.ts，配置见 ./config.ts，部署见 ./deploy/
import { startServer } from './server.ts';

const server = await startServer();
if (server.config.allowOpenRegistration) {
  console.warn('[trine-server] TRINE_OPEN_REGISTRATION is deprecated and ignored; new agents require invitations.');
}
console.info(
  `[trine-server] 监听 ${server.config.hostname}:${server.port} · db=${server.config.dbPath}`,
);
console.info(
  `[trine-server] parked TTL=${server.config.parkedTtlMs / 3600_000}h · relay 留存=${
    server.config.relayRetentionMs / 3600_000
  }h`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.info(`[trine-server] 收到 ${signal}，正在退出`);
    server.stop().then(() => process.exit(0));
  });
}
