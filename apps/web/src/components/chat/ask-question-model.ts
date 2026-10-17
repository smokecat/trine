/**
 * AskUserQuestion 提问卡的纯逻辑：解析工具 input、选择状态 → answers、
 * 提交条件、从已批准参数读回答案。
 *
 * ## 回答怎么送回 Claude（已用真 claude 实测）
 *
 * AskUserQuestion 走 canUseTool，agent 把它当作一次普通权限请求转过来。
 * web 回答 = 发 `verdict:'allow'`，`updatedInput = { ...原 input, answers }`，
 * 其中 `answers` 形如 `{ [问题原文]: 答案 }`：
 * - 单选：答案 = 选中项的 label；选「其他」时 = 用户输入的文本；
 * - 多选：多个答案用逗号拼接（SDK 注释原话 "multi-select answers are
 *   comma-separated"）。
 *
 * 「跳过」= 发 deny，Claude 收到拒绝后通常改口在对话里问，用户用输入框回答。
 *
 * ## 为什么解析要防御式
 *
 * input 是 agent 从模型那里原样转来的 `unknown`。结构对不上（模型造了坏参数、
 * 未来 SDK 改了形状）时返回 null，调用方回落到通用 JSON 权限卡——那张卡至少
 * 能看全参数、能拒绝，比渲染一张缺胳膊少腿的提问卡安全。
 */

export interface AskOption {
  label: string;
  description: string;
  /** 选中后展示的预览内容（mockup / 代码片段），**纯文本**展示，不当 HTML */
  preview?: string;
}

export interface AskQuestion {
  question: string;
  /** 很短的 chip 标签（SDK 约定 ≤12 字）；缺失时按空串处理，不算坏输入 */
  header: string;
  multiSelect: boolean;
  options: AskOption[];
}

export interface AskQuestionInput {
  questions: AskQuestion[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOption(raw: unknown): AskOption | null {
  if (!isRecord(raw)) return null;
  const { label, description, preview } = raw;
  if (typeof label !== 'string' || label === '') return null;
  const option: AskOption = { label, description: typeof description === 'string' ? description : '' };
  if (typeof preview === 'string' && preview !== '') option.preview = preview;
  return option;
}

function parseQuestion(raw: unknown): AskQuestion | null {
  if (!isRecord(raw)) return null;
  const { question, header, multiSelect, options } = raw;
  if (typeof question !== 'string' || question.trim() === '') return null;
  if (!Array.isArray(options) || options.length === 0) return null;
  const parsed: AskOption[] = [];
  for (const o of options) {
    const opt = parseOption(o);
    if (opt === null) return null;
    parsed.push(opt);
  }
  // 同题 label 重复时「选的是哪一个」无法从答案里区分，按坏输入处理
  if (new Set(parsed.map((o) => o.label)).size !== parsed.length) return null;
  return {
    question,
    header: typeof header === 'string' ? header : '',
    multiSelect: multiSelect === true,
    options: parsed,
  };
}

/**
 * 解析 AskUserQuestion 的 input；结构不对返回 null（调用方回落普通权限卡）。
 *
 * 只校验渲染与回答**必需**的部分：questions 非空数组、每题有非空 question 与
 * 非空 options、每个 option 有非空 label。数量上限（1-4 题、2-4 项）不卡——
 * 多一题少一项照样画得出来、答得回去，没必要因此退回 JSON 卡。
 *
 * 问题原文重复也算坏输入：answers 以问题原文为键，两题同文就无法分别作答。
 */
export function parseAskQuestionInput(input: unknown): AskQuestionInput | null {
  if (!isRecord(input)) return null;
  const { questions } = input;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const parsed: AskQuestion[] = [];
  for (const q of questions) {
    const question = parseQuestion(q);
    if (question === null) return null;
    parsed.push(question);
  }
  if (new Set(parsed.map((q) => q.question)).size !== parsed.length) return null;
  return { questions: parsed };
}

/** 时间线里这条权限请求要不要画成提问卡（否则画普通权限卡） */
export function isAskQuestionRequest(toolName: string, input: unknown): boolean {
  return toolName === 'AskUserQuestion' && parseAskQuestionInput(input) !== null;
}

/**
 * 一道题的选择状态。
 * - `selected`：已选的选项 label（单选时至多一个）；
 * - `otherOn`：「其他」是否被选上（单选时与 selected 互斥）；
 * - `otherText`：「其他」输入框里的文本（未选上时保留草稿，但不计入答案）。
 */
export interface QuestionSelection {
  selected: string[];
  otherOn: boolean;
  otherText: string;
}

export function emptySelection(): QuestionSelection {
  return { selected: [], otherOn: false, otherText: '' };
}

/** 点了某个选项之后的新状态：单选=换选（并取消「其他」），多选=切换勾选 */
export function toggleOption(q: AskQuestion, sel: QuestionSelection, label: string): QuestionSelection {
  if (!q.multiSelect) return { ...sel, selected: [label], otherOn: false };
  const has = sel.selected.includes(label);
  return { ...sel, selected: has ? sel.selected.filter((l) => l !== label) : [...sel.selected, label] };
}

/** 点了「其他」之后的新状态：单选=选上其他（清掉选项），多选=切换 */
export function toggleOther(q: AskQuestion, sel: QuestionSelection): QuestionSelection {
  if (!q.multiSelect) return { ...sel, selected: [], otherOn: true };
  return { ...sel, otherOn: !sel.otherOn };
}

/**
 * 在「其他」输入框里打字：自动选上「其他」（单选时同时清掉选项）——
 * 用户开始输入就是在作答，不该还要再点一下「其他」。
 */
export function editOther(q: AskQuestion, sel: QuestionSelection, text: string): QuestionSelection {
  if (!q.multiSelect) return { selected: [], otherOn: true, otherText: text };
  return { ...sel, otherOn: true, otherText: text };
}

/**
 * 一道题的答案；未作答返回 null。
 *
 * 多选的拼接顺序：**按选项在题目里的顺序**，不按点击先后。答案因此与用户
 * 眼前看到的列表顺序一致、与点击历史无关（反复勾掉再勾上不会改变结果）；
 * 「其他」文本放最后。分隔符用 `", "`（与 SDK 注释「comma-separated」一致，
 * 加空格便于 Claude 与人阅读）。
 */
export function answerFor(q: AskQuestion, sel: QuestionSelection): string | null {
  const other = sel.otherOn ? sel.otherText.trim() : '';
  if (!q.multiSelect) {
    if (sel.otherOn) return other === '' ? null : other;
    const label = sel.selected[0];
    return label !== undefined && q.options.some((o) => o.label === label) ? label : null;
  }
  const parts = q.options.filter((o) => sel.selected.includes(o.label)).map((o) => o.label);
  if (other !== '') parts.push(other);
  return parts.length === 0 ? null : parts.join(', ');
}

/** 由各题选择状态生成 answers；有任何一题未作答返回 null（= 不可提交） */
export function buildAnswers(
  input: AskQuestionInput,
  selections: readonly QuestionSelection[],
): Record<string, string> | null {
  const answers: Record<string, string> = {};
  for (const [i, q] of input.questions.entries()) {
    const answer = answerFor(q, selections[i] ?? emptySelection());
    if (answer === null) return null;
    answers[q.question] = answer;
  }
  return answers;
}

/** 提交条件：每一题都有答案 */
export function canSubmit(input: AskQuestionInput, selections: readonly QuestionSelection[]): boolean {
  return buildAnswers(input, selections) !== null;
}

/** 提交用的 updatedInput：原 input 的其余字段原样保留，只加 answers */
export function answeredInput(original: unknown, answers: Record<string, string>): Record<string, unknown> {
  return { ...(isRecord(original) ? original : {}), answers };
}

/**
 * 从 `approvedInput`（agent 回报的实际放行参数）读回 answers，供已回答态展示。
 * approvedInput 缺失 / 不是对象 / 没有 answers 对象 → null；answers 里非字符串
 * 的值丢弃（只展示读得懂的）。
 */
export function readAnswers(approvedInput: unknown): Record<string, string> | null {
  if (!isRecord(approvedInput)) return null;
  const { answers } = approvedInput;
  if (!isRecord(answers)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(answers)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
