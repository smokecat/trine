/**
 * 写剪贴板。优先 Clipboard API（要求安全上下文：https / localhost）；不可用时
 * 退回隐藏 textarea + `execCommand('copy')`——局域网 http 访问时只有这条路。
 * 两条都不行就抛错，由调用方提示。
 */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.select();
    if (!document.execCommand('copy')) throw new Error('浏览器不允许写剪贴板');
  } finally {
    area.remove();
  }
}
