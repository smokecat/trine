// web-push@4 无官方类型。本文件是给 **web 包编译计划**用的副本：
// e2e.test.ts 直接 import 真 server（@trine/server/src/server.ts），server 的
// push/webpush.ts 因而被拉进本程序。正本在 apps/server/src/push/web-push.d.ts，
// 改 API 时两份同步改。
declare module 'web-push' {
  export interface PushSubscriptionLike {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }
  export interface RequestOptions {
    TTL?: number;
    urgency?: 'very-low' | 'low' | 'normal' | 'high';
    timeout?: number;
    [key: string]: unknown;
  }
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
  export function generateRequestDetails(
    subscription: PushSubscriptionLike,
    payload: string | null,
    options?: RequestOptions,
  ): { endpoint: string; headers: Record<string, string>; body?: Buffer; timeout?: number };
  export class WebPushError extends Error {
    statusCode?: number;
  }
}
