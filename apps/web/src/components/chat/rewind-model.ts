/**
 * 回退对话框的纯逻辑：三种模式能不能选、默认选哪个、成功后的提示语。
 * 抽出来是为了单测——可用性由预览结果的两部分组合而成，塞在 JSX 里测不了。
 */
import type { RewindMode } from '@trine/core';
import type { RewindPreviewResult, RewindResult } from '@/lib/client.ts';

export interface RewindChoice {
  mode: RewindMode;
  label: string;
  hint: string;
  available: boolean;
  /** 不可选时的原因（来自 agent） */
  reason?: string;
}

/** 预览 → 三个选项（顺序即界面顺序，与 Claude Code `/rewind` 一致） */
export function rewindChoices(preview: RewindPreviewResult): RewindChoice[] {
  const conversation = preview.conversation ?? { available: false, reason: 'agent 没有给出对话部分的结果' };
  const files = preview.files ?? { available: false, reason: 'agent 没有给出文件部分的结果' };
  const both = conversation.available && files.available;
  return [
    {
      mode: 'both',
      label: '还原代码和对话',
      hint: '文件与对话都回到这条消息发出之前',
      available: both,
      ...(both ? {} : { reason: (conversation.available ? files.reason : conversation.reason) ?? '不可用' }),
    },
    {
      mode: 'conversation',
      label: '只回退对话',
      hint: '文件保持现状，Claude 忘掉这条消息及之后的内容',
      available: conversation.available,
      ...(conversation.available ? {} : { reason: conversation.reason ?? '不可用' }),
    },
    {
      mode: 'code',
      label: '只还原代码',
      hint: '对话保持现状，文件回到这条消息发出之前',
      available: files.available,
      ...(files.available ? {} : { reason: files.reason ?? '不可用' }),
    },
  ];
}

/** 默认选第一个可用的；都不可用 → undefined（确认按钮禁用） */
export function defaultRewindMode(choices: readonly RewindChoice[]): RewindMode | undefined {
  return choices.find((c) => c.available)?.mode;
}

/** 是否会改动文件（确认按钮用警示色） */
export function rewindTouchesFiles(mode: RewindMode): boolean {
  return mode !== 'conversation';
}

/** 预览里的文件改动概述 */
export function filesSummary(files: RewindPreviewResult['files']): string | undefined {
  if (files === undefined || !files.available) return undefined;
  const count = files.filesChanged?.length ?? 0;
  if (count === 0) return '这条消息之后没有记录到文件改动';
  return `将还原 ${count} 个文件（+${files.insertions ?? 0} −${files.deletions ?? 0}）`;
}

/** 回退成功的提示语；`prefilled` = 原消息填回了输入框（输入框里本来有字就不覆盖） */
export function rewindDoneMessage(result: RewindResult, mode: RewindMode, prefilled: boolean): string {
  const parts: string[] = [];
  if (mode !== 'conversation') {
    const count = result.files?.filesChanged.length ?? 0;
    parts.push(count === 0 ? '没有需要还原的文件' : `已还原 ${count} 个文件`);
    const skipped = result.files?.skippedLinks ?? 0;
    if (skipped > 0) parts.push(`${skipped} 个文件因符号链接等原因未还原`);
  }
  if (mode !== 'code') parts.push(prefilled ? '对话已回退，原消息已填回输入框' : '对话已回退');
  return parts.join('；');
}
