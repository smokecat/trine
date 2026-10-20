/**
 * 输入框的待发附件：加进来就开始（压缩 →）加密上传，发送时只带引用。
 *
 * 状态放在 store（按会话 key），上传的 AbortController 与图片预览 URL 放模块级
 * Map——切走会话再回来，进行中的上传不中断、预览还在。移除时中止上传并回收预览。
 */
import { useCallback } from 'react';
import { toast } from 'sonner';
import { store, useClient, useTrine } from '@/app/runtime.ts';
import {
  attachmentKind,
  checkAdd,
  draftRefs,
  draftsReady,
  effectiveLimits,
  type DraftAttachment,
} from '@/lib/attachment-model.ts';
import type { AttachmentRef } from '@trine/core';

const MB = 1024 * 1024;
const EMPTY: DraftAttachment[] = [];
const controllers = new Map<string, AbortController>();

let seq = 0;
function nextId(): string {
  seq += 1;
  return `att-${Date.now().toString(36)}-${seq}`;
}

export interface AttachmentDrafts {
  drafts: DraftAttachment[];
  /** 全部传完且没有失败的（可以发送） */
  ready: boolean;
  add: (files: readonly File[]) => void;
  remove: (id: string) => void;
  retry: (id: string) => void;
  /** 发送：返回引用并清空（预览 URL 交给 client 缓存，这里不回收） */
  take: () => AttachmentRef[];
}

export function useAttachmentDrafts(key: string): AttachmentDrafts {
  const client = useClient();
  const drafts = useTrine((s) => s.attachmentDrafts[key]) ?? EMPTY;
  const prefs = useTrine((s) => s.prefs);

  const update = useCallback(
    (id: string, patch: Partial<DraftAttachment>) =>
      store.getState().updateAttachmentDrafts(key, (list) => list.map((d) => (d.id === id ? { ...d, ...patch } : d))),
    [key],
  );

  const start = useCallback(
    (draft: DraftAttachment) => {
      if (client === null) return;
      const controller = new AbortController();
      controllers.set(draft.id, controller);
      update(draft.id, { status: 'uploading', progress: 0 });
      client
        .uploadAttachment(draft.file, {
          signal: controller.signal,
          compressAboveBytes: prefs.imageCompressMb * MB,
          onProgress: (progress) => update(draft.id, { progress }),
        })
        .then(
          (ref) => update(draft.id, { status: 'done', progress: 1, ref }),
          (err: unknown) => {
            if (controller.signal.aborted) return;
            update(draft.id, { status: 'error', error: err instanceof Error ? err.message : String(err) });
          },
        )
        .finally(() => {
          if (controllers.get(draft.id) === controller) controllers.delete(draft.id);
        });
    },
    [client, prefs.imageCompressMb, update],
  );

  const add = useCallback(
    (files: readonly File[]) => {
      if (client === null || files.length === 0) return;
      void (async () => {
        // relay 的单 blob 上限：拿不到（离线 / 旧服务端）就只按设置校验，超限时服务端会回 413
        const relayMax = await client.blobConfig().then(
          (c) => c.maxBytes,
          () => undefined,
        );
        const existing = store.getState().attachmentDrafts[key] ?? [];
        const { accepted, errors } = checkAdd(existing, files, effectiveLimits(prefs, relayMax));
        for (const message of errors) toast.error(message);
        const added: DraftAttachment[] = accepted.map((file) => {
          const kind = attachmentKind(file.type);
          return {
            id: nextId(),
            file,
            name: file.name === '' ? 'file' : file.name,
            size: file.size,
            kind,
            status: 'uploading',
            progress: 0,
            ...(kind === 'image' ? { previewUrl: URL.createObjectURL(file) } : {}),
          };
        });
        store.getState().updateAttachmentDrafts(key, (list) => [...list, ...added]);
        for (const draft of added) start(draft);
      })();
    },
    [client, key, prefs, start],
  );

  const remove = useCallback(
    (id: string) => {
      controllers.get(id)?.abort();
      controllers.delete(id);
      store.getState().updateAttachmentDrafts(key, (list) => {
        const gone = list.find((d) => d.id === id);
        if (gone?.previewUrl !== undefined) URL.revokeObjectURL(gone.previewUrl);
        return list.filter((d) => d.id !== id);
      });
    },
    [key],
  );

  const retry = useCallback(
    (id: string) => {
      const draft = (store.getState().attachmentDrafts[key] ?? []).find((d) => d.id === id);
      if (draft !== undefined) start(draft);
    },
    [key, start],
  );

  const take = useCallback(() => {
    const list = store.getState().attachmentDrafts[key] ?? [];
    const refs = draftRefs(list);
    for (const d of list) if (d.previewUrl !== undefined) URL.revokeObjectURL(d.previewUrl);
    store.getState().updateAttachmentDrafts(key, () => []);
    return refs;
  }, [key]);

  return { drafts, ready: draftsReady(drafts), add, remove, retry, take };
}
