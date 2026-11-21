/**
 * trine Web Push service worker（PWA 通知）。
 *
 * 刻意不缓存任何应用资源——中转架构下离线页面也没数据可显示
 * （DECISIONS：没有离线聊天承诺），SW 存在的理由是接收 Web Push 和
 * 消费启动链接。
 *
 * - push：payload 是服务端用 RFC 8291 加密、只有本设备解得开的 JSON
 *   { title, body, tag, machineId?, sessionId? }。relay 是零知识的，给的
 *   只有「机器标识 + 事件类型」；**会话标题在这里补**——从本机 IndexedDB
 *   （trine 库 docs store，key `machine:<id>`，与页面同一份数据）查
 *   sessionId 的标题，查到就以标题为主文案，查不到退回机器标识。
 * - notificationclick：聚焦已开的窗口并导航到对应会话（深链复用 /s/:m/:s），
 *   没有窗口就新开（iOS 主屏 Web App 从通知唤起走的就是这条路）。
 */

// 不缓存任何资源，skipWaiting/claim 是安全的：新 SW 即刻接管，
// 改动（如通知标题逻辑）不用等用户关掉所有窗口
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** 读 `machine:<machineId>` 文档里某个会话的标题（idb-keyval 的裸 IndexedDB 版） */
async function sessionTitle(machineId, sessionId) {
  if (!machineId || !sessionId) return null;
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('trine');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onupgradeneeded = () => req.transaction.abort(); // 没建过库=没有数据
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('docs', 'readonly');
        const req = tx.objectStore('docs').get('machine:' + machineId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })?.sessions?.[sessionId]?.title ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null; // 没数据 / 结构变了：退回机器标识，别让通知发不出来
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const d = data && typeof data === 'object' ? data : {};
  event.waitUntil((async () => {
    const title = await sessionTitle(d.machineId, d.sessionId);
    await self.registration.showNotification(title || d.title || 'trine', {
      // 有会话标题时把机器标识挪进正文，保持「这是哪台机器」的线索
      body: title ? `${d.title ? d.title + ' · ' : ''}${d.body || ''}` : (d.body || ''),
      // tag 让同一机器的连续提醒合并成一条,不在通知中心堆楼
      tag: d.tag || 'trine',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { machineId: d.machineId, sessionId: d.sessionId },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const url =
    d.machineId && d.sessionId
      ? `/s/${d.machineId}/${d.sessionId}`
      : d.machineId
        ? `/m/${d.machineId}`
        : '/';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const win of wins) {
        try {
          await win.focus();
          if ('navigate' in win) await win.navigate(url);
          return;
        } catch {
          // 跨源/未受控的窗口导航不了:换下一个,实在不行新开
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
