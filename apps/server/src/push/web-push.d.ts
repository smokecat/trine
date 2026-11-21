// web-push@4 无官方类型，这里只声明用到的三个函数（完整 API 见其 README）。
// 注意：apps/web/src/lib/web-push.d.ts 有一份副本（e2e 测试会把本文件拉进
// web 的编译计划），改 API 时两份同步改。
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

  export function setVapidDetails(
    subject: string,
    publicKey: string,
    privateKey: string,
  ): void;

  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };

  export function generateRequestDetails(
    subscription: PushSubscriptionLike,
    payload: string | null,
    options?: RequestOptions,
  ): {
    endpoint: string;
    headers: Record<string, string>;
    body?: Buffer;
    timeout?: number;
  };

  export class WebPushError extends Error {
    statusCode?: number;
  }
}
