/**
 * 文件预览正文：按 agent 报的 kind 渲染。
 *
 * - markdown：复用聊天的 Markdown（图片外连拦截不变）；相对链接 / 图片相对本文件解析；可切源码
 * - text：≤ HIGHLIGHT_MAX_BYTES 走 shiki 高亮（包成代码围栏交给 Markdown），更大的纯 `<pre>`，
 *   超过 TEXT_SHOW_MAX 只显示开头
 * - pdf：`<iframe>` 浏览器内置阅读器（Blob 强制 application/pdf）；另给「新标签打开」
 *   （iOS Safari 在 iframe 里常常只显示第一页）
 * - image：`<img>`（svg 也只走 img，不内联，脚本不会执行）
 * - binary：只给文件信息与下载
 *
 * html 是 text：只显示源码，绝不渲染。
 */
import { useEffect, useMemo, useState } from 'react';
import { ExternalLinkIcon, FileIcon } from 'lucide-react';
import type { OpenedFile } from '@/lib/client.ts';
import { formatBytes } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { Markdown } from '@/components/chat/Markdown.tsx';
import { Button } from '@/components/ui/button.tsx';
import { fenceCode, HIGHLIGHT_MAX_BYTES, languageOf } from './file-model.ts';

/** 纯文本最多显示这么多字符（更大的请下载） */
export const TEXT_SHOW_MAX = 2 * 1024 * 1024;

export function FileBody({
  opened,
  mode,
  wrap,
}: {
  opened: OpenedFile;
  /** markdown 的显示方式 */
  mode: 'rendered' | 'source';
  /** 文本自动换行 */
  wrap: boolean;
}): React.JSX.Element {
  const { file } = opened;
  if (file.kind === 'markdown' || file.kind === 'text') return <TextBody opened={opened} mode={mode} wrap={wrap} />;
  if (file.kind === 'image') {
    return (
      <div className="flex justify-center p-4">
        <img data-testid="file-image" src={opened.url} alt={file.name} className="max-w-full object-contain" />
      </div>
    );
  }
  if (file.kind === 'pdf') return <PdfBody opened={opened} />;
  return (
    <div data-testid="file-binary" className="text-text-2 flex flex-col items-center gap-3 p-10 text-center text-[13px]">
      <FileIcon className="text-text-3 size-10" />
      <div>这个文件不是文本，无法预览（{formatBytes(file.size)}）</div>
      <Button asChild size="sm" variant="outline">
        <a href={opened.url} download={file.name}>
          下载
        </a>
      </Button>
    </div>
  );
}

function useText(blob: Blob): string | undefined {
  const [text, setText] = useState<string | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setText(undefined);
    void blob.text().then((t) => {
      if (alive) setText(t);
    });
    return () => {
      alive = false;
    };
  }, [blob]);
  return text;
}

function TextBody({ opened, mode, wrap }: { opened: OpenedFile; mode: 'rendered' | 'source'; wrap: boolean }): React.JSX.Element {
  const { file } = opened;
  const text = useText(opened.blob);
  const small = file.size <= HIGHLIGHT_MAX_BYTES;
  const fenced = useMemo(
    () => (text === undefined || file.kind !== 'text' || !small ? undefined : fenceCode(text, languageOf(file.name))),
    [text, file.kind, file.name, small],
  );
  if (text === undefined) return <div className="text-text-3 p-4 text-[13px]">正在解码…</div>;
  if (text === '') return <div className="text-text-3 p-4 text-[13px]">（空文件）</div>;
  if (file.kind === 'markdown' && mode === 'rendered' && small) {
    return (
      <div data-testid="file-markdown" className="px-4 py-3 sm:px-6">
        <Markdown text={text} streaming={false} fileBase={file.path} />
      </div>
    );
  }
  if (fenced !== undefined && !wrap) {
    return (
      <div data-testid="file-code" className="[&_pre]:!my-0 [&_pre]:!rounded-none [&_pre]:!border-0 px-0 py-0">
        <Markdown text={fenced} streaming={false} />
      </div>
    );
  }
  const shown = text.length > TEXT_SHOW_MAX ? text.slice(0, TEXT_SHOW_MAX) : text;
  return (
    <>
      {shown.length < text.length && (
        <div className="text-text-3 border-border border-b px-4 py-1.5 text-[12px]">只显示前 {formatBytes(TEXT_SHOW_MAX)}，完整内容请下载</div>
      )}
      <pre
        data-testid="file-text"
        className={cn('text-text px-4 py-3 font-mono text-[12.5px] leading-[1.5]', wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre')}
      >
        {shown}
      </pre>
    </>
  );
}

function PdfBody({ opened }: { opened: OpenedFile }): React.JSX.Element {
  // 不信 mime：frame 里只放强制成 application/pdf 的 Blob，任何内容都不会被当 html 解释
  const url = useMemo(() => URL.createObjectURL(new Blob([opened.blob], { type: 'application/pdf' })), [opened.blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="flex h-full min-h-[60dvh] flex-col">
      <div className="border-border flex items-center justify-end border-b px-3 py-1">
        <Button asChild size="sm" variant="ghost" className="h-7 text-[12px]">
          <a href={url} target="_blank" rel="noopener noreferrer" data-testid="file-pdf-tab">
            <ExternalLinkIcon className="size-3.5" />
            新标签打开
          </a>
        </Button>
      </div>
      <iframe data-testid="file-pdf" src={url} title={opened.file.name} className="min-h-0 w-full flex-1 border-0" />
    </div>
  );
}
