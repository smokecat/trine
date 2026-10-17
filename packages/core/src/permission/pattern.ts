/**
 * 权限 remember 模式串：匹配判定、安全校验、以及给 UI 的建议生成。
 *
 * 放在 core 而不是 agent：判定跑在 agent（决定放不放行），而**建议**跑在
 * client（用户勾「记住」时 UI 要填一个 pattern 进去）。两边必须用同一套
 * 语法理解，否则 client 生成的 pattern 在 agent 侧要么不命中（勾了等于没勾）、
 * 要么命中范围比用户以为的大——后者是直接的安全问题。共用一份实现，
 * 加上 `suggestRememberPattern` 与 `matchesPattern` 的往返测试，
 * 这种漂移才没有存在的空间。
 */

/**
 * shell 元字符：命中任一即说明这条命令不是「单一命令」，而是能串接、改向、
 * 嵌套执行别的命令的复合命令。
 *
 * remember 的前缀匹配一旦遇上它们就彻底失去意义——`Bash(git *)` 本意是
 * 「放行 git 命令」，而 `git push && rm -rf /` 同样以 `git ` 开头。
 */
const SHELL_METACHARACTERS = /[;&|`\n\r$(){}<>]/;

/**
 * 判断工具调用是否命中 remember 模式串。
 *
 * pattern 语法沿用 Claude Code 权限规则的写法：
 * - `Bash(git diff *)` — 工具 + 参数前缀通配（`*` 只在结尾生效）
 * - `Read(/repo/src/*)` — 路径前缀
 *
 * ## 这是「少打扰」的便利功能，但它确实在放行工具调用
 *
 * 所以宽松匹配的代价不是「多问一次」，而是**未经批准就执行**。三层防护：
 *
 * 1. **Bash 复合命令一律不命中**：subject 含 shell 元字符就回落到挂起询问。
 *    否则 `Bash(git *)` 会放行 `git push && rm -rf /`。
 * 2. **通配前缀强制词边界**：`Bash(git diff*)` 不得命中 `git difftool`；
 *    前缀必须终止在空白或字符串末尾（路径类则允许 `/` 边界）。
 * 3. **路径先规范化再比**：`Write(/home/u/proj*)` 不得被
 *    `/home/u/proj/../../../etc/passwd` 逃逸。
 *
 * 另见 `isSafeRememberPattern()`——登记入口还会拒掉裸 `*` 与无参数约束的
 * 裸工具名，那类 pattern 等于「本会话放行该工具的一切调用」。
 *
 * ## 已知边界：按程序前缀放行 ≠ 安全保证
 *
 * 上面三层堵的是「用 remember 规则**之外**的手段执行别的东西」。它们堵不住
 * **被放行的程序自身**提供的代码执行面——`Bash(git *)` 依旧放行
 * `git config core.pager evil`、`git -c core.editor=... rebase` 之类：
 * 这些没有 shell 元字符、确实是 git 命令，但 git 会替你执行任意代码。
 * 其他程序也各有这类开关（`find -exec`、`awk 'system()'`、`ssh` 的
 * ProxyCommand…）。
 *
 * 这是「按程序前缀放行」这一模型的**固有边界**，不是本实现的疏漏：要真正
 * 封死就得为每个程序维护子命令/参数黑名单，那既做不全（黑名单必漏），
 * 也会把功能复杂度推到不成比例。所以这里不做 git 子命令黑名单。
 *
 * **对 client 的要求**：remember 的 UI 措辞不得暗示任何安全保证。
 * 「本会话不再询问 `git *`」是准确的；「仅允许安全的 git 命令」是错的。
 * 真正的安全边界始终是「每次都问」，remember 只是用户自愿让渡的便利。
 */
export function matchesPattern(
  pattern: string,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  const open = pattern.indexOf('(');
  // 裸工具名（无参数约束）不再匹配任何调用：它等于无条件放行整个工具，
  // 风险与收益完全不成比例。登记入口也会拒绝这种 pattern。
  if (open === -1) return false;
  if (!pattern.endsWith(')')) return false;

  const patternTool = pattern.slice(0, open);
  if (patternTool !== toolName) return false;

  const arg = pattern.slice(open + 1, -1).trim();
  // 空参数与裸 * 同样是「放行一切」，不予匹配
  if (arg === '' || arg === '*') return false;

  const subject = patternSubject(toolName, input);
  if (subject === undefined) return false;

  // 防护 1：Bash 复合命令直接不命中，回落挂起询问
  if (toolName === 'Bash' && SHELL_METACHARACTERS.test(subject)) return false;

  const pathLike = isPathTool(toolName);
  const normalizedSubject = pathLike ? normalizePath(subject) : subject;

  if (arg.endsWith('*')) {
    const prefix = arg.slice(0, -1);
    const normalizedPrefix = pathLike ? normalizePath(prefix) : prefix;
    // 防护 3：路径逃逸——规范化后仍须落在前缀之下
    if (pathLike) return isUnderPathPrefix(normalizedSubject, normalizedPrefix, prefix);
    // URL 类：按 URL 分隔符定边界（不做路径 resolve——URL 不是文件路径）
    if (isUrlTool(toolName)) return matchesUrlPrefix(normalizedSubject, normalizedPrefix);
    // 防护 2：词边界——`git diff*` 不得命中 `git difftool`
    return matchesWordBoundaryPrefix(normalizedSubject, normalizedPrefix);
  }

  const normalizedArg = pathLike ? normalizePath(arg) : arg;
  return normalizedSubject === normalizedArg;
}

/** 参数是文件路径的工具 */
function isPathTool(toolName: string): boolean {
  return toolName === 'Read' || toolName === 'Write' || toolName === 'Edit';
}

/** 参数是 URL 的工具 */
function isUrlTool(toolName: string): boolean {
  return toolName === 'WebFetch' || toolName === 'WebSearch';
}

/**
 * URL 前缀匹配，按 URL 分隔符定边界。
 *
 * 不能套用命令的「空白边界」——URL 里没有空白，那条规则会让所有 URL pattern
 * 永远匹配不上（`WebFetch(https://ok.com/*)` 连 `https://ok.com/a` 都不命中，
 * 等于 WebFetch 的 remember 整个失效）。也不能套路径规范化——URL 不是文件路径，
 * `..` 在这里没有文件系统语义。
 *
 * 规则：前缀之后必须是 URL 的结构分隔符（`/` `?` `#`）或恰好到此结束。
 * 这样 `https://ok.com/` 不会命中 `https://ok.com.evil.io/`（`.` 不是分隔符），
 * 也不会命中 `https://ok.commit/`。
 */
function matchesUrlPrefix(subject: string, prefix: string): boolean {
  if (prefix === '') return false;
  // 前缀本身以分隔符结尾时，边界已经明确
  if (/[/?#]$/.test(prefix)) return subject.startsWith(prefix);
  if (!subject.startsWith(prefix)) return false;
  const rest = subject.slice(prefix.length);
  return rest === '' || /^[/?#]/.test(rest);
}

/**
 * 前缀匹配 + 词边界。
 *
 * 前缀本身以空白结尾时（`git diff `）直接前缀比即可——空白已是边界；
 * 否则要求 subject 恰好等于前缀，或前缀之后紧跟空白。
 */
function matchesWordBoundaryPrefix(subject: string, prefix: string): boolean {
  if (!subject.startsWith(prefix)) return false;
  if (prefix === '') return false;
  if (/\s$/.test(prefix)) return true;
  const rest = subject.slice(prefix.length);
  return rest === '' || /^\s/.test(rest);
}

/**
 * 路径规范化：解析 `.`/`..`、压缩重复分隔符，不碰文件系统（纯字符串运算，
 * 保持 matchesPattern 可测且无 I/O）。相对路径原样保留其相对性。
 */
function normalizePath(value: string): string {
  const absolute = value.startsWith('/');
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // 绝对路径在根部吃掉多余的 ..；相对路径保留，避免把 ../x 误判成 x
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop();
      } else if (!absolute) {
        segments.push('..');
      }
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join('/');
  return absolute ? `/${joined}` : joined;
}

/**
 * 规范化后的路径是否落在前缀之下。
 *
 * 前缀以 `/` 结尾表示「该目录内」；否则既允许精确相等，也允许它作为目录前缀
 * （`/repo/src` 命中 `/repo/src/a.ts`），但不允许 `/repo/srcx` 这种同名前缀。
 */
function isUnderPathPrefix(
  subject: string,
  normalizedPrefix: string,
  rawPrefix: string,
): boolean {
  if (normalizedPrefix === '') return false;
  if (rawPrefix.endsWith('/')) {
    return subject.startsWith(`${normalizedPrefix}/`);
  }
  if (subject === normalizedPrefix) return true;
  return subject.startsWith(`${normalizedPrefix}/`);
}

/**
 * 登记入口的 pattern 校验：拒绝「等于放行一切」的模式串。
 *
 * client 可以发任意 pattern 上来，不能假定它合理——一个 `*` 就会让本会话
 * 后续所有工具调用静默放行。
 *
 * @returns 可安全登记为 remember 规则则 true
 */
export function isSafeRememberPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed === '') return false;
  // 裸 * / 纯通配
  if (/^\*+$/.test(trimmed)) return false;

  const open = trimmed.indexOf('(');
  // 无参数约束的裸工具名 = 放行该工具的一切调用
  if (open === -1) return false;
  if (!trimmed.endsWith(')')) return false;
  if (open === 0) return false;

  const arg = trimmed.slice(open + 1, -1).trim();
  // 空参数或裸 * 同样是放行一切
  if (arg === '' || /^\*+$/.test(arg)) return false;
  return true;
}

/** 取用于匹配的「主参数」：Bash 是命令，文件类工具是路径 */
function patternSubject(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  const pick = (key: string): string | undefined => {
    const value = input[key];
    return typeof value === 'string' ? value : undefined;
  };
  switch (toolName) {
    case 'Bash':
      return pick('command');
    case 'Read':
    case 'Write':
    case 'Edit':
      return pick('file_path');
    case 'WebFetch':
      return pick('url');
    default:
      // 未知工具（MCP 等）不猜主参数：早先取「第一个字符串字段」依赖对象键序，
      // 同一个 pattern 在不同调用上可能匹配到不同字段，等于不可预测地放行。
      // 返回 undefined 后，未知工具的 remember 一律不命中——宁可多问一次，
      // 不可误放行。
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// 建议生成（client 侧：用户勾「记住」时填进去的 pattern）
// ---------------------------------------------------------------------------

/**
 * 为一次工具调用生成建议的 remember pattern；不适合记住则返回 `null`。
 *
 * ## 设计取向：宁可不给建议，也不给一个比用户以为的更宽的建议
 *
 * 返回 null 的地方（未知工具、Bash 复合命令）不是「还没做」，而是刻意不做：
 * - **未知工具（MCP 等）**：`patternSubject` 认不出主参数，生成什么都是猜；
 *   猜错要么不命中，要么命中到别的字段上。
 * - **Bash 复合命令**：`matchesPattern` 的防护 1 本就让它永不命中，给一个
 *   注定失效的建议只会让用户以为自己记住了。
 *
 * 生成的每个 pattern 都保证 `matchesPattern(建议, toolName, input) === true`
 * ——建议至少要能命中它自己那一次调用，否则就是个 bug（有往返测试盯着）。
 *
 * ## Bash 的取词规则
 *
 * 取首词，次词存在且不以 `-` 开头时并入：`git commit -m x` → `Bash(git commit*)`。
 * 次词以 `-` 开头的说明它是**参数**而非子命令（`ls -la` → `Bash(ls*)`），
 * 并进去会把建议收得过窄到没有实用价值。
 *
 * 输出用**无尾空格**的 `git commit*` 而不是 `git commit *`：后者要求命令
 * 之后必须还有东西，裸 `git commit` 反而不命中。而 `matchesPattern` 的
 * 词边界防护（防护 2）保证 `git commit*` 同时命中裸 `git commit` 与
 * `git commit -m x`，且**不**命中 `git committer`——既不过窄也不过宽。
 *
 * @param toolName 工具名（与 permission.request 里的一致）
 * @param input 工具入参
 */
export function suggestRememberPattern(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  const subject = patternSubject(toolName, input);
  if (subject === undefined) return null;

  if (toolName === 'Bash') {
    // 复合命令永不命中（防护 1），给建议等于给一个失效的承诺
    if (SHELL_METACHARACTERS.test(subject)) return null;
    const words = subject.trim().split(/\s+/).filter((w) => w !== '');
    const first = words[0];
    if (first === undefined || first === '') return null;
    const second = words[1];
    // 次词以 `-` 开头 = 参数不是子命令，并进去会窄到没用
    const stem =
      second !== undefined && !second.startsWith('-') ? `${first} ${second}` : first;
    return `Bash(${stem}*)`;
  }

  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') {
    const dir = dirnameOf(subject);
    if (dir === null) return null;
    return `${toolName}(${dir}/*)`;
  }

  if (toolName === 'WebFetch') {
    let origin: string;
    try {
      origin = new URL(subject).origin;
    } catch {
      return null;
    }
    // URL 解析不出 origin 的（file: 等）不给建议
    if (origin === 'null' || origin === '') return null;
    return `WebFetch(${origin}/*)`;
  }

  return null;
}

/**
 * 取文件路径的目录部分（纯字符串运算，不碰文件系统）。
 *
 * 无目录成分（`a.ts`）或目录就是根（`/a.ts`）时返回 null：前者生成不出有
 * 意义的前缀，后者的建议会是 `Read(/*)`——放行整个文件系统，比不给建议糟得多。
 */
function dirnameOf(filePath: string): string | null {
  const normalized = normalizePath(filePath);
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return null;
  return normalized.slice(0, idx);
}
