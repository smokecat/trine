/**
 * 「/」命令菜单的数据模型：两组来源、前缀过滤、键盘导航的扁平索引。
 *
 * 两组（原型 NOTES.chat 第 7 条）：
 *
 * 1. **会话控制**——`/model` `/cwd` `/permission` `/status` `/mcp` `/rename`，走协议帧
 *    （`session.setModel` 等）而不是把文本丢给 Claude：本地即时、零 token。
 * 2. **项目命令**——会话 `capabilities.slashCommands`（agent 从 SDK
 *    system/init 下发），选中后**填入输入框**（`/name `）让用户补参数，再由用户
 *    发送给 Claude 解析；只有命令名已完整打出且带了参数时才直接发送。
 *
 * 常用 prompt 片段早先是第 3 组，现在走输入区工具栏的 prompt 按钮
 * （SnippetPicker），「/」菜单只放命令。
 *
 * 过滤只看**命令名**（不看描述），按匹配强弱分档排序（`matchSlashName`）：
 * 前缀 > 词首（`-` `_` `:` 等分隔符之后，`/dep` → `/local-deploy`）> 子串 >
 * 词首起头的子序列（`/lcd` → `/local-deploy`）。前缀仍排最前：用户打 `/mo`
 * 第一个看到的是 `/model`。
 *
 * 纯数据 + 纯函数，零 React：菜单的分组/过滤/选中下标推进都能单测。
 */
import type { SlashCommand } from '@trine/core';

/** 选中一项后做什么 */
export type SlashAction =
  /** 打开会话设置 sheet 的某一段（model / cwd / permission） */
  | { kind: 'sheet'; section: 'model' | 'cwd' | 'permission' }
  /** 发 `session.status.request` 并渲染信息卡 */
  | { kind: 'status' }
  /** 发 `mcp.status.request` 并渲染信息卡 */
  | { kind: 'mcp' }
  /** 重命名会话：title 为空 → 打开重命名对话框；非空 → 直接改（`/rename 新标题`） */
  | { kind: 'rename'; title: string }
  /** 直接按协议帧设值（命令带参数时，如 `/model opus`） */
  | { kind: 'apply'; command: 'model' | 'cwd' | 'permission'; arg: string }
  /** 把文本原样发给 Claude */
  | { kind: 'send'; text: string }
  /** 填入输入框，不发送 */
  | { kind: 'fill'; text: string };

export interface SlashItem {
  /** 列表左侧的主文案（`/xxx`） */
  label: string;
  description?: string;
  /** 右上角来源标签（项目命令才有） */
  source?: SlashCommand['source'];
  action: SlashAction;
}

export interface SlashGroup {
  title: string;
  items: SlashItem[];
}

export const SESSION_COMMANDS = ['model', 'cwd', 'permission', 'status', 'mcp', 'rename'] as const;
export type SessionCommand = (typeof SESSION_COMMANDS)[number];

const SESSION_COMMAND_DESC: Record<SessionCommand, string> = {
  model: '切换模型',
  cwd: '切换 / 管理工作目录',
  permission: '权限模式',
  status: '会话状态与用量',
  mcp: 'MCP 服务器状态',
  rename: '重命名会话（与 CLI /rename 同一份标题）',
};

/** 命令名里的分隔符：其后的字符算「词首」 */
const SEPARATOR = /[-_:./\s]/;

/** 名字里每个词首的下标（含 0） */
function wordStarts(name: string): number[] {
  const starts = [0];
  for (let i = 1; i < name.length; i++) {
    if (SEPARATOR.test(name[i - 1] ?? '') && !SEPARATOR.test(name[i] ?? '')) starts.push(i);
  }
  return starts;
}

/** 从 `from` 起能否按顺序找齐 `query` 的每个字符 */
function isSubsequenceFrom(name: string, query: string, from: number): boolean {
  let at = from;
  for (const ch of query) {
    at = name.indexOf(ch, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

/**
 * 命令名与输入的匹配档位，越小越靠前；不匹配返回 null。两边都应已小写。
 *
 * 0 前缀 · 1 词首前缀 · 2 子串 · 3 子序列（首字符须落在词首，免得 `/st` 这种
 * 短输入把满屏不相干的命令都捞出来）。
 */
export function matchSlashName(name: string, query: string): number | null {
  if (query === '' || name.startsWith(query)) return 0;
  const starts = wordStarts(name);
  if (starts.some((i) => name.startsWith(query, i))) return 1;
  if (name.includes(query)) return 2;
  if (starts.some((i) => name[i] === query[0] && isSubsequenceFrom(name, query, i))) return 3;
  return null;
}

/** 按档位稳定排序（同档保持来源顺序），丢掉不匹配的 */
function rankByMatch<T>(items: readonly T[], nameOf: (item: T) => string, query: string): { item: T; rank: number }[] {
  return items
    .map((item, index) => ({ item, index, rank: matchSlashName(nameOf(item).toLowerCase(), query) }))
    .filter((r): r is { item: T; index: number; rank: number } => r.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item, rank }) => ({ item, rank }));
}

function isSessionCommand(name: string): name is SessionCommand {
  return (SESSION_COMMANDS as readonly string[]).includes(name);
}

/**
 * 把输入框文本解析成「命令 + 参数」。只在整串以 `/` 开头时有意义。
 * `/model  claude-opus-5 ` → `{ name: 'model', arg: 'claude-opus-5' }`
 */
export function parseSlashInput(text: string): { name: string; arg: string } | null {
  if (!text.startsWith('/')) return null;
  const rest = text.slice(1);
  const spaceAt = rest.search(/\s/);
  if (spaceAt < 0) return { name: rest.toLowerCase(), arg: '' };
  return { name: rest.slice(0, spaceAt).toLowerCase(), arg: rest.slice(spaceAt).trim() };
}

/** 会话控制命令 + 参数 → 该执行的动作（`/model` 无参数时弹 sheet） */
export function sessionCommandAction(name: SessionCommand, arg: string): SlashAction {
  if (name === 'status') return { kind: 'status' };
  if (name === 'mcp') return { kind: 'mcp' };
  if (name === 'rename') return { kind: 'rename', title: arg };
  if (arg === '') return { kind: 'sheet', section: name };
  return { kind: 'apply', command: name, arg };
}

/**
 * 项目命令选中后的动作。用**规范命令名**，不是用户打了一半的前缀：`/co` 选中
 * `/code-review` 得到 `/code-review`（早先原样透传输入串，发出 Claude 不认识的 `/co`）。
 *
 * - 默认**填入**输入框：skill/command 多半要带参数，点选即发会让人没机会补
 *   （`/code-review high`）。没打参数时带尾随空格，光标直接落在参数位。
 * - 命令名已完整打出且带了参数（`/commit 只提交 web` + 回车）→ 直接**发送**：
 *   这时输入框里就是最终文本，再填一遍只会逼人多按一次回车。
 */
function projectCommandAction(cmd: string, typed: string, arg: string, hasArg: boolean): SlashAction {
  if (hasArg && cmd.toLowerCase() === typed) {
    return { kind: 'send', text: arg === '' ? `/${cmd}` : `/${cmd} ${arg}` };
  }
  return { kind: 'fill', text: arg === '' ? `/${cmd} ` : `/${cmd} ${arg}` };
}

export interface SlashSources {
  slashCommands: SlashCommand[];
  /** 当前不可用的会话控制命令（如 agent 不支持重命名时的 `rename`），不出现在菜单里 */
  unavailable?: readonly SessionCommand[];
}

/**
 * 按当前输入文本生成菜单。`text` 必须以 `/` 开头（调用方保证），
 * 返回空数组表示没有任何候选——此时菜单应当整体隐藏。
 */
export function buildSlashMenu(text: string, sources: SlashSources): SlashGroup[] {
  const parsed = parseSlashInput(text);
  if (parsed === null) return [];
  const { name, arg } = parsed;
  const hasArg = arg !== '' || /\s/.test(text.slice(1));

  const unavailable = sources.unavailable ?? [];
  const sessionRanked = rankByMatch(
    SESSION_COMMANDS.filter((c) => !unavailable.includes(c)),
    (c) => c,
    name,
  );
  const sessionItems: SlashItem[] = sessionRanked.map(({ item: c }) => ({
    label: `/${c}`,
    description: SESSION_COMMAND_DESC[c],
    action: sessionCommandAction(c, arg),
  }));

  // agent 下发的同名命令（如 claude 自带的 `/rename`）过滤掉：会话控制组已有
  // 协议级实现，两个同名项并列只会让人猜哪个是哪个（评审 S5）。
  // 即便该会话控制命令此刻不可用也照样过滤——SDK 下发的 `/rename` 当文本发给
  // Claude 并不会走 custom-title 通道。
  const projectRanked = rankByMatch(
    sources.slashCommands.filter((c) => !isSessionCommand(c.name.toLowerCase())),
    (c) => c.name,
    name,
  );
  const projectItems: SlashItem[] = projectRanked.map(({ item: c }) => ({
    label: `/${c.name}`,
    ...(c.description === undefined ? {} : { description: c.description }),
    source: c.source,
    action: projectCommandAction(c.name, name, arg, hasArg),
  }));

  const groups: { group: SlashGroup; best: number }[] = [];
  if (sessionItems.length > 0) {
    groups.push({ group: { title: '会话控制 · 协议级', items: sessionItems }, best: sessionRanked[0]?.rank ?? 0 });
  }
  if (projectItems.length > 0) {
    groups.push({ group: { title: '项目命令 · agent 下发', items: projectItems }, best: projectRanked[0]?.rank ?? 0 });
  }
  // 组按最佳档位排：`/dep` 时项目命令里的词首命中排在会话控制的模糊命中前面，
  // 回车选中的是最像的那个。同档会话控制在前（sort 稳定）。
  groups.sort((a, b) => a.best - b.best);
  return groups.map((g) => g.group);
}

/** 键盘导航要的扁平序列（分组标题不可选中） */
export function flattenSlashGroups(groups: SlashGroup[]): SlashItem[] {
  return groups.flatMap((g) => g.items);
}

/** 上下键推进选中下标，两端循环；空列表恒为 0 */
export function moveSlashIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((current + delta) % count) + count) % count;
}
