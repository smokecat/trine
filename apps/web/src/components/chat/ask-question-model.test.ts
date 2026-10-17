import { describe, expect, test } from 'bun:test';
import {
  answerFor,
  answeredInput,
  buildAnswers,
  canSubmit,
  editOther,
  emptySelection,
  isAskQuestionRequest,
  parseAskQuestionInput,
  readAnswers,
  toggleOption,
  toggleOther,
  type AskQuestion,
  type AskQuestionInput,
  type QuestionSelection,
} from './ask-question-model.ts';

const COLOR = {
  question: '你喜欢哪种颜色？',
  header: '颜色',
  multiSelect: false,
  options: [
    { label: '红色', description: '热烈' },
    { label: '蓝色', description: '冷静', preview: '<b>blue</b>' },
  ],
};
const FEATURES = {
  question: '要启用哪些功能？',
  header: '功能',
  multiSelect: true,
  options: [
    { label: 'A', description: 'a' },
    { label: 'B', description: 'b' },
    { label: 'C', description: 'c' },
  ],
};

function parsed(input: unknown): AskQuestionInput {
  const p = parseAskQuestionInput(input);
  if (p === null) throw new Error('parse failed');
  return p;
}

const single = parsed({ questions: [COLOR] }).questions[0] as AskQuestion;
const multi = parsed({ questions: [FEATURES] }).questions[0] as AskQuestion;

describe('parseAskQuestionInput', () => {
  test('合法输入：保留 header / multiSelect / preview', () => {
    const p = parsed({ questions: [COLOR, FEATURES], metadata: { source: 'x' } });
    expect(p.questions).toHaveLength(2);
    expect(p.questions[0]).toEqual({
      question: '你喜欢哪种颜色？',
      header: '颜色',
      multiSelect: false,
      options: [
        { label: '红色', description: '热烈' },
        { label: '蓝色', description: '冷静', preview: '<b>blue</b>' },
      ],
    });
    expect(p.questions[1]?.multiSelect).toBe(true);
  });

  test('缺 header / description / multiSelect 时宽容补默认值', () => {
    const p = parsed({ questions: [{ question: 'Q?', options: [{ label: 'x' }, { label: 'y' }] }] });
    expect(p.questions[0]).toEqual({
      question: 'Q?',
      header: '',
      multiSelect: false,
      options: [
        { label: 'x', description: '' },
        { label: 'y', description: '' },
      ],
    });
  });

  test.each([
    ['null', null],
    ['字符串', 'hi'],
    ['数组', [COLOR]],
    ['缺 questions', {}],
    ['questions 不是数组', { questions: COLOR }],
    ['questions 空数组', { questions: [] }],
    ['某题不是对象', { questions: [COLOR, 'x'] }],
    ['某题缺 question', { questions: [{ ...COLOR, question: undefined }] }],
    ['question 空白', { questions: [{ ...COLOR, question: '  ' }] }],
    ['某题缺 options', { questions: [{ ...COLOR, options: undefined }] }],
    ['options 空数组', { questions: [{ ...COLOR, options: [] }] }],
    ['option 不是对象', { questions: [{ ...COLOR, options: ['红色'] }] }],
    ['option 缺 label', { questions: [{ ...COLOR, options: [{ description: 'x' }] }] }],
    ['option label 空串', { questions: [{ ...COLOR, options: [{ label: '', description: 'x' }] }] }],
    ['同题 label 重复', { questions: [{ ...COLOR, options: [{ label: 'x' }, { label: 'x' }] }] }],
    ['两题问题原文相同', { questions: [COLOR, { ...FEATURES, question: COLOR.question }] }],
  ])('坏输入返回 null：%s', (_name, input) => {
    expect(parseAskQuestionInput(input)).toBeNull();
  });

  test('isAskQuestionRequest：工具名与结构都要对', () => {
    expect(isAskQuestionRequest('AskUserQuestion', { questions: [COLOR] })).toBe(true);
    expect(isAskQuestionRequest('AskUserQuestion', { questions: [] })).toBe(false);
    expect(isAskQuestionRequest('Bash', { questions: [COLOR] })).toBe(false);
  });
});

describe('选择状态迁移', () => {
  test('单选：换选只保留一个，并取消「其他」', () => {
    let s = toggleOther(single, emptySelection());
    expect(s.otherOn).toBe(true);
    s = toggleOption(single, s, '红色');
    expect(s).toEqual({ selected: ['红色'], otherOn: false, otherText: '' });
    s = toggleOption(single, s, '蓝色');
    expect(s.selected).toEqual(['蓝色']);
  });

  test('单选：选「其他」清掉选项；在其他框打字自动选上其他', () => {
    const s0 = toggleOption(single, emptySelection(), '红色');
    expect(toggleOther(single, s0)).toEqual({ selected: [], otherOn: true, otherText: '' });
    expect(editOther(single, s0, '绿')).toEqual({ selected: [], otherOn: true, otherText: '绿' });
  });

  test('多选：切换勾选；其他可与选项并存', () => {
    let s = toggleOption(multi, emptySelection(), 'C');
    s = toggleOption(multi, s, 'A');
    expect(s.selected).toEqual(['C', 'A']);
    s = toggleOption(multi, s, 'C');
    expect(s.selected).toEqual(['A']);
    s = editOther(multi, s, 'D');
    expect(s).toEqual({ selected: ['A'], otherOn: true, otherText: 'D' });
    s = toggleOther(multi, s);
    expect(s.otherOn).toBe(false);
    expect(s.otherText).toBe('D'); // 草稿保留
  });
});

describe('answerFor / buildAnswers', () => {
  const sel = (over: Partial<QuestionSelection>): QuestionSelection => ({ ...emptySelection(), ...over });

  test('单选：答案 = label', () => {
    expect(answerFor(single, sel({ selected: ['蓝色'] }))).toBe('蓝色');
  });

  test('单选选「其他」：答案 = trim 后的其他文本；空白算未答', () => {
    expect(answerFor(single, sel({ otherOn: true, otherText: '  绿色 ' }))).toBe('绿色');
    expect(answerFor(single, sel({ otherOn: true, otherText: '   ' }))).toBeNull();
  });

  test('未选：null；未选上的「其他」草稿不算答案', () => {
    expect(answerFor(single, emptySelection())).toBeNull();
    expect(answerFor(multi, sel({ otherText: 'D' }))).toBeNull();
  });

  test('单选的 selected 里是不存在的 label：不算答案', () => {
    expect(answerFor(single, sel({ selected: ['紫色'] }))).toBeNull();
  });

  test('多选：按选项顺序拼接（与点击先后无关），其他放最后', () => {
    expect(answerFor(multi, sel({ selected: ['C', 'A'] }))).toBe('A, C');
    expect(answerFor(multi, sel({ selected: ['B'], otherOn: true, otherText: ' D ' }))).toBe('B, D');
    expect(answerFor(multi, sel({ otherOn: true, otherText: 'D' }))).toBe('D');
    expect(answerFor(multi, sel({ selected: ['A'], otherOn: true, otherText: '  ' }))).toBe('A');
  });

  test('buildAnswers：以问题原文为键；任一题未答整体 null', () => {
    const input = parsed({ questions: [COLOR, FEATURES] });
    const ok = [sel({ selected: ['蓝色'] }), sel({ selected: ['B', 'A'] })];
    expect(buildAnswers(input, ok)).toEqual({ '你喜欢哪种颜色？': '蓝色', '要启用哪些功能？': 'A, B' });
    expect(canSubmit(input, ok)).toBe(true);
    const partial = [sel({ selected: ['蓝色'] }), emptySelection()];
    expect(buildAnswers(input, partial)).toBeNull();
    expect(canSubmit(input, partial)).toBe(false);
    expect(canSubmit(input, [sel({ selected: ['蓝色'] })])).toBe(false); // 缺一题的状态
  });

  test('answeredInput：保留原 input 其余字段，只加 answers', () => {
    const original = { questions: [COLOR], metadata: { source: 'x' } };
    expect(answeredInput(original, { q: 'a' })).toEqual({ ...original, answers: { q: 'a' } });
  });
});

describe('readAnswers', () => {
  test('读回 answers；丢弃非字符串值', () => {
    expect(readAnswers({ questions: [], answers: { a: '1', b: 2 } })).toEqual({ a: '1' });
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['没有 answers', { questions: [COLOR] }],
    ['answers 不是对象', { answers: 'x' }],
    ['answers 是数组', { answers: ['x'] }],
  ])('读不到时 null：%s', (_name, v) => {
    expect(readAnswers(v)).toBeNull();
  });
});
