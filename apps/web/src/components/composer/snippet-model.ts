/**
 * prompt 片段插入输入框的规则（纯函数，有单测）。
 *
 * - 插在光标处；有选区就替换选区——和粘贴一样，符合直觉。
 * - 光标在已有文字的末尾、且末尾不是空白：先换一行再插。最常见的用法是
 *   「先打几句，再补一段固定要求」，直接粘在句尾会糊成一句话。
 *   光标在文字中间时原样插入：用户特意点到那里，就是要插在那里。
 */
export function insertSnippet(
  value: string,
  selection: { start: number; end: number } | null,
  snippet: string,
): { text: string; caret: number } {
  // 没记到光标（从没聚焦过输入框）就当在末尾
  const start = Math.min(selection?.start ?? value.length, value.length);
  const end = Math.max(start, Math.min(selection?.end ?? start, value.length));
  const before = value.slice(0, start);
  const after = value.slice(end);
  const sep = after === '' && before !== '' && !/\s$/.test(before) ? '\n' : '';
  const text = before + sep + snippet + after;
  return { text, caret: before.length + sep.length + snippet.length };
}
