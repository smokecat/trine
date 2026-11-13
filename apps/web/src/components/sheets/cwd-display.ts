/**
 * 工作目录的展示形式（只影响显示，选中 / 提交的仍是完整路径）。
 *
 * 同一台机器的常用目录前缀大多相同，能区分它们的是末段，所以拆成
 * 「目录名」（主行）+「上级路径」（次行）；agent 的 home 显示成 `~`。
 */

/** home 前缀换成 `~`；不知道 home（旧 agent / 没开文件查看）就原样返回 */
export function tildify(path: string, home: string | undefined): string {
  if (home === undefined || home === '' || home === '/') return path;
  const base = home.endsWith('/') ? home.slice(0, -1) : home;
  if (path === base || path === `${base}/`) return '~';
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}

/** 拆成目录名与上级路径；根目录、`~` 本身没有上级（parent 为空串） */
export function splitCwd(path: string, home: string | undefined): { name: string; parent: string } {
  let shown = tildify(path, home);
  if (shown.length > 1 && shown.endsWith('/')) shown = shown.replace(/\/+$/, '') || '/';
  const cut = shown.lastIndexOf('/');
  if (shown === '/' || shown === '~' || cut === -1) return { name: shown, parent: '' };
  return { name: shown.slice(cut + 1), parent: cut === 0 ? '/' : shown.slice(0, cut) };
}
