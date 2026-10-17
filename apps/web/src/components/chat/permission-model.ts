/**
 * 权限卡的纯逻辑：参数呈现形态、「记住」文案、改参数的解析、已响应态文案。
 *
 * ## 「记住」文案的红线（方案 §5 + 评审 B3）
 *
 * 复选框只在 `suggestRememberPattern(toolName, input)` 返回非 null 时出现——
 * 那个函数与 agent 的 `matchesPattern` 是**同一份真相**（core/permission），
 * 所以「给了选项就一定生效」。文案严格是事实描述：
 *
 *     本会话内不再询问 `Bash(git commit*)`
 *
 * **不得**出现「安全」「仅允许」「可信」这类词：这条规则放行的是「按程序
 * 前缀匹配的调用」，core 的注释写得很清楚它挡不住被放行程序自身的代码执行面
 * （`git -c core.editor=… rebase`）。UI 说「安全」就是替一个做不到的承诺背书。
 * 这条有单测钉住。
 */
import { suggestRememberPattern } from '@trine/core/permission';
import type { PermissionEntry } from '@/lib/reducer.ts';

/** 参数区怎么画：Bash 给一块可编辑命令，Edit/Write 给路径 + 内容，其余给 JSON */
export type PermissionParamView =
  | { kind: 'command'; label: string; command: string }
  | { kind: 'file'; label: string; filePath: string; content?: string }
  | { kind: 'json'; label: string; json: string };

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function permissionParamView(toolName: string, input: unknown): PermissionParamView {
  const rec = asRecord(input);
  if (toolName === 'Bash') {
    const command = str(rec.command);
    if (command !== undefined) return { kind: 'command', label: 'Bash', command };
  }
  if (toolName === 'Edit' || toolName === 'Write') {
    const filePath = str(rec.file_path);
    if (filePath !== undefined) {
      // Write 给 content、Edit 给 new_string，都只作摘要展示（完整内容看 JSON 折叠）
      const content = str(rec.content) ?? str(rec.new_string);
      return { kind: 'file', label: toolName, filePath, ...(content === undefined ? {} : { content }) };
    }
  }
  return { kind: 'json', label: toolName, json: JSON.stringify(input ?? {}, null, 2) };
}

/**
 * 「记住」复选框的文案；null = 该工具/该次调用不提供记住（不显示复选框）。
 * pattern 直接来自 core，勾选后原样回填 `remember.pattern`。
 */
export function rememberOption(toolName: string, input: unknown): { pattern: string; label: string } | null {
  const pattern = suggestRememberPattern(toolName, asRecord(input));
  if (pattern === null) return null;
  // 纯事实描述：这条规则做什么，不评价它安不安全
  return { pattern, label: `本会话内不再询问 ${pattern}` };
}

/**
 * 改参数态下的「记住」选项——**必须按编辑后的参数重算**。
 *
 * 早先这里是个越权 bug：pattern 在卡片挂载时按**原始** input 算好就不再变，
 * 用户把 `rm -rf x` 改成 `ls -la` 再勾「记住」，登记进会话的却是 `Bash(rm*)`
 * ——放行的是他刚刚亲手改掉的那条命令，而且此后整个会话静默放行。
 *
 * 三种情况都不给选项（返回 null，复选框消失）：
 * - 编辑内容解析不出来（parse 失败）：没有可靠的 input 可算 pattern；
 * - 改后的调用本身不支持记住（core 返回 null，例如加了元字符）；
 * - **改后的 pattern 与原始不同**：复选框的语义是「记住我正在批准的这一类
 *   调用」，主参数变了就是另一类。此时让它消失、要求用户重新勾，比默默
 *   改掉 pattern 更符合他看到的东西——UI 上一个没被重新确认过的勾选，
 *   不该悄悄换掉它背后登记的规则。
 */
export function effectiveRememberOption(
  toolName: string,
  original: unknown,
  edited: EditedInput | null,
): { pattern: string; label: string } | null {
  const base = rememberOption(toolName, original);
  if (edited === null) return base; // 未进入编辑态
  if (!edited.ok) return null;
  const next = rememberOption(toolName, edited.value);
  if (next === null || base === null) return null;
  return next.pattern === base.pattern ? next : null;
}

/**
 * 「改参数后批准」的提交值。
 * - Bash：只换 command，其余字段（description 之类）保持原样；
 * - 其他工具：整个 JSON 替换，解析失败则不可提交。
 */
export type EditedInput =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function parseEditedInput(
  view: PermissionParamView,
  original: unknown,
  draft: string,
): EditedInput {
  if (view.kind === 'command') {
    const command = draft.trim();
    if (command === '') return { ok: false, error: '命令不能为空' };
    return { ok: true, value: { ...asRecord(original), command } };
  }
  try {
    const parsed: unknown = JSON.parse(draft);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: '参数必须是 JSON 对象' };
    }
    return { ok: true, value: parsed };
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 改参数编辑框的初值 */
export function editorSeed(view: PermissionParamView, original: unknown): string {
  return view.kind === 'command' ? view.command : JSON.stringify(original ?? {}, null, 2);
}

/**
 * 已响应 / 已失效态的一行文案。
 * `deviceId` 是本设备 id，与 `resolvedBy` 比对区分「本设备」和别的设备。
 */
export function permissionResultText(
  entry: PermissionEntry,
  deviceId: string | null,
): { text: string; tone: 'green' | 'red' | 'muted' } {
  if (entry.state === 'invalidated') {
    const why = entry.reason === undefined || entry.reason === '' ? '' : `（${entry.reason}）`;
    return {
      text: `⌀ 请求已失效${why}——如需继续，直接发消息让 Claude 重试`,
      tone: 'muted',
    };
  }
  if (entry.state !== 'resolved') return { text: '', tone: 'muted' };
  const by =
    entry.resolvedBy === undefined
      ? ''
      : entry.resolvedBy === deviceId
        ? '（本设备）'
        : `（${entry.resolvedBy}）`;
  return entry.verdict === 'allow'
    ? { text: `✓ 已批准${by}`, tone: 'green' }
    : { text: `✗ 已拒绝${by}`, tone: 'red' };
}
