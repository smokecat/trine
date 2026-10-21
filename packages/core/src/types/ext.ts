/**
 * 扩展（extensions）的领域类型：manifest、扩展输出的视图词汇、发给 client 的视图、执行计划。
 * 契约说明见 docs/EXTENSIONS.md。
 *
 * ## 两种视图形状
 *
 * - **Raw**（扩展进程 stdout → agent）：动作里直接写 effects。只在 agent 内部校验与使用，
 *   不过 E2E。
 * - **Wire**（agent → client）：agent 把每个动作改写成 client 能执行的样子——只含本地效果
 *   （插入、复制、刷新）的动作把效果原样带上，由点击的设备自己执行；含有需要 agent 执行的
 *   效果（发送、新建会话、改关联、回调扩展）的动作只带一个一次性 `token`。client 无法改写
 *   token 背后的效果，agent 也不会因为读取 / 刷新 / 推送而执行任何效果（EXTENSIONS.md §安全）。
 *
 * 这里不 import types/index.ts（它反过来要用 SessionLinkSchema），时间戳就地定义。
 */
import { z } from 'zod';

const Ts = z.number().int().nonnegative();

/** 契约版本：manifest.apiVersion 与扩展进程输入里的 apiVersion */
export const EXT_API_VERSION = 1;

/** 扩展 id：小写字母数字与连字符 */
export const ExtIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/);

// ---------------------------------------------------------------------------
// 限额（扩展输出不可信：总字节之外还要限结构，见 EXTENSIONS.md §限额）
// ---------------------------------------------------------------------------

export const EXT_LIMITS = {
  sections: 20,
  itemsPerSection: 200,
  actionsPerItem: 8,
  toolbarActions: 8,
  effectsPerAction: 4,
  badgesPerItem: 4,
  sessionsPerItem: 20,
  pickItems: 500,
  /** 普通文本字段 */
  text: 2_000,
  detail: 16_000,
  prompt: 32_000,
  ref: 256,
  label: 120,
  linksPerSession: 32,
  /** 一次 links.add / remove 带的条数 */
  linksPerUpdate: 32,
} as const;

const text = (max: number = EXT_LIMITS.text) => z.string().max(max);
const id = z.string().min(1).max(128);

// ---------------------------------------------------------------------------
// manifest（trine-extension.json）
// ---------------------------------------------------------------------------

/** 宿主能力：扩展可能请求、需要在 manifest 声明的（copy / refresh 无副作用，不用声明） */
export const ExtCapabilitySchema = z.enum(['prompt.insert', 'prompt.send', 'session.create', 'links.write', 'invoke']);
export type ExtCapability = z.infer<typeof ExtCapabilitySchema>;

/** 贡献点：扩展把内容放到界面的哪里 */
export const ExtPointSchema = z.enum(['sessionPanel', 'workspacePanel', 'sessionBadge', 'linkPicker', 'composerAction', 'newSession']);
export type ExtPoint = z.infer<typeof ExtPointSchema>;

const PanelContribution = z.object({ title: text(40), icon: text(40).optional() });

export const ExtContributesSchema = z.object({
  sessionPanel: PanelContribution.optional(),
  workspacePanel: PanelContribution.optional(),
  sessionBadge: z.boolean().optional(),
  linkPicker: z.object({ title: text(40), multiple: z.boolean().optional() }).optional(),
  composerAction: z.object({ label: text(40), icon: text(40).optional() }).optional(),
  /** 新建会话 sheet 的「从…开始」：选一项预填首条消息、建好后自动关联（agent ≥ 0.17.0） */
  newSession: z.object({ title: text(40), icon: text(40).optional() }).optional(),
});
export type ExtContributes = z.infer<typeof ExtContributesSchema>;

export const ExtManifestSchema = z.object({
  apiVersion: z.number().int().positive(),
  id: ExtIdSchema,
  name: text(60).min(1),
  version: text(40).min(1),
  description: text(300).optional(),
  /** argv；相对路径按扩展目录解析，不按会话 cwd、不经过 shell */
  entry: z.array(z.string().min(1).max(1024)).min(1).max(16),
  contributes: ExtContributesSchema,
  capabilities: z.array(ExtCapabilitySchema).max(16).default([]),
});
export type ExtManifest = z.infer<typeof ExtManifestSchema>;

// ---------------------------------------------------------------------------
// 视图词汇（Raw：扩展输出）
// ---------------------------------------------------------------------------

export const ExtToneSchema = z.enum(['neutral', 'info', 'success', 'warning', 'danger']);

export const ExtBadgeSchema = z.object({
  text: text(60).min(1),
  tone: ExtToneSchema.default('neutral'),
  title: text(300).optional(),
});
export type ExtBadge = z.infer<typeof ExtBadgeSchema>;

/** 一条会话关联的引用：ref 是扩展自定义的不透明字符串，label 是给人看的 */
export const ExtLinkRefSchema = z.object({
  ref: z.string().min(1).max(EXT_LIMITS.ref),
  label: text(EXT_LIMITS.label).min(1),
});
export type ExtLinkRef = z.infer<typeof ExtLinkRefSchema>;

/** 由点击的设备自己执行的效果 */
export const ExtLocalEffectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prompt.insert'), text: text(EXT_LIMITS.prompt).min(1) }),
  z.object({ type: z.literal('copy'), text: text(EXT_LIMITS.prompt).min(1) }),
  z.object({ type: z.literal('refresh') }),
]);
export type ExtLocalEffect = z.infer<typeof ExtLocalEffectSchema>;

/** 由 agent 执行的效果 */
export const ExtRemoteEffectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prompt.send'), text: text(EXT_LIMITS.prompt).min(1) }),
  z.object({
    type: z.literal('session.create'),
    prompt: text(EXT_LIMITS.prompt).min(1),
    cwd: z.string().min(1).max(4096).optional(),
    title: text(200).optional(),
    links: z.array(ExtLinkRefSchema).max(EXT_LIMITS.linksPerUpdate).optional(),
  }),
  z.object({ type: z.literal('links.add'), links: z.array(ExtLinkRefSchema).min(1).max(EXT_LIMITS.linksPerUpdate) }),
  z.object({ type: z.literal('links.remove'), refs: z.array(z.string().min(1).max(EXT_LIMITS.ref)).min(1).max(EXT_LIMITS.linksPerUpdate) }),
]);
export type ExtRemoteEffect = z.infer<typeof ExtRemoteEffectSchema>;

export const ExtEffectSchema = z.union([ExtLocalEffectSchema, ExtRemoteEffectSchema]);
export type ExtEffect = z.infer<typeof ExtEffectSchema>;

export const LOCAL_EFFECT_TYPES: ReadonlySet<string> = new Set(['prompt.insert', 'copy', 'refresh']);

export function isLocalEffect(effect: ExtEffect): effect is ExtLocalEffect {
  return LOCAL_EFFECT_TYPES.has(effect.type);
}

const ActionCommon = {
  id,
  label: text(60).min(1),
  primary: z.boolean().optional(),
  destructive: z.boolean().optional(),
  /** 扩展给的确认说明（自定义权限下会弹确认；全托管下不弹） */
  confirm: text(500).optional(),
};

/** effects 与 invoke 二选一 */
export const ExtRawActionSchema = z
  .object({
    ...ActionCommon,
    effects: z.array(ExtEffectSchema).min(1).max(EXT_LIMITS.effectsPerAction).optional(),
    invoke: z.object({ params: z.record(z.string(), z.unknown()).optional() }).optional(),
  })
  .refine((a) => (a.effects === undefined) !== (a.invoke === undefined), { message: 'effects 与 invoke 必须二选一' });
export type ExtRawAction = z.infer<typeof ExtRawActionSchema>;

export const ExtRawItemSchema = z.object({
  id,
  title: text(300).min(1),
  subtitle: text(500).optional(),
  badges: z.array(ExtBadgeSchema).max(EXT_LIMITS.badgesPerItem).optional(),
  meta: text(300).optional(),
  /** 受限 Markdown：无图片、无 raw HTML，链接只允许 https */
  detail: text(EXT_LIMITS.detail).optional(),
  /** 有它才显示关联开关 */
  link: ExtLinkRefSchema.optional(),
  /** 会话 ID：宿主渲染成可跳转的会话引用 */
  sessions: z.array(z.string().min(1).max(128)).max(EXT_LIMITS.sessionsPerItem).optional(),
  actions: z.array(ExtRawActionSchema).max(EXT_LIMITS.actionsPerItem).optional(),
});
export type ExtRawItem = z.infer<typeof ExtRawItemSchema>;

export const ExtRawSectionSchema = z.object({
  id,
  title: text(100).optional(),
  collapsed: z.boolean().optional(),
  items: z.array(ExtRawItemSchema).max(EXT_LIMITS.itemsPerSection),
  empty: text(300).optional(),
});

export const ExtRawViewSchema = z.object({
  title: text(100).optional(),
  sections: z.array(ExtRawSectionSchema).max(EXT_LIMITS.sections),
  toolbar: z.array(ExtRawActionSchema).max(EXT_LIMITS.toolbarActions).optional(),
  empty: text(300).optional(),
});
export type ExtRawView = z.infer<typeof ExtRawViewSchema>;

export const ExtRawPickItemSchema = z.object({
  id,
  title: text(300).min(1),
  subtitle: text(500).optional(),
  badges: z.array(ExtBadgeSchema).max(EXT_LIMITS.badgesPerItem).optional(),
  link: ExtLinkRefSchema.optional(),
  effects: z.array(ExtEffectSchema).min(1).max(EXT_LIMITS.effectsPerAction).optional(),
});
export type ExtRawPickItem = z.infer<typeof ExtRawPickItemSchema>;

/** 扩展进程各 op 的输出（agent 侧校验；未知字段 strip，未知 effect / 超限整份判非法） */
export const ExtErrorOutputSchema = z.object({
  error: z.object({ code: text(64).min(1), message: text(500) }),
});
export const ExtViewOutputSchema = z.object({ view: ExtRawViewSchema });
export const ExtBadgeOutputSchema = z.object({ badge: ExtBadgeSchema.nullable(), links: z.array(ExtLinkRefSchema).max(EXT_LIMITS.linksPerSession).optional() });
export const ExtPickOutputSchema = z.object({ items: z.array(ExtRawPickItemSchema).max(EXT_LIMITS.pickItems) });
export const ExtActionOutputSchema = z.object({
  ok: z.boolean().default(true),
  message: text(500).optional(),
  effects: z.array(ExtEffectSchema).max(EXT_LIMITS.effectsPerAction).optional(),
  view: ExtRawViewSchema.optional(),
});

// ---------------------------------------------------------------------------
// 视图（Wire：agent → client）
// ---------------------------------------------------------------------------

export const ExtWireActionSchema = z.object({
  ...ActionCommon,
  /** 全部是本地效果：点击的设备直接执行 */
  local: z.array(ExtLocalEffectSchema).max(EXT_LIMITS.effectsPerAction).optional(),
  /** 有需要 agent 执行的效果：点击时凭它 prepare（一次性、只对本设备有效） */
  token: z.string().min(1).max(128).optional(),
});
export type ExtWireAction = z.infer<typeof ExtWireActionSchema>;

export const ExtWireItemSchema = ExtRawItemSchema.omit({ actions: true }).extend({
  actions: z.array(ExtWireActionSchema).max(EXT_LIMITS.actionsPerItem).optional(),
});
export type ExtWireItem = z.infer<typeof ExtWireItemSchema>;

export const ExtWireSectionSchema = ExtRawSectionSchema.omit({ items: true }).extend({
  items: z.array(ExtWireItemSchema).max(EXT_LIMITS.itemsPerSection),
});
export type ExtWireSection = z.infer<typeof ExtWireSectionSchema>;

export const ExtWireViewSchema = ExtRawViewSchema.omit({ sections: true, toolbar: true }).extend({
  sections: z.array(ExtWireSectionSchema).max(EXT_LIMITS.sections),
  toolbar: z.array(ExtWireActionSchema).max(EXT_LIMITS.toolbarActions).optional(),
});
export type ExtWireView = z.infer<typeof ExtWireViewSchema>;

export const ExtWirePickItemSchema = ExtRawPickItemSchema.omit({ effects: true }).extend({
  local: z.array(ExtLocalEffectSchema).max(EXT_LIMITS.effectsPerAction).optional(),
  token: z.string().min(1).max(128).optional(),
});
export type ExtWirePickItem = z.infer<typeof ExtWirePickItemSchema>;

// ---------------------------------------------------------------------------
// 目录、权限、会话关联
// ---------------------------------------------------------------------------

export const ExtPolicyValueSchema = z.enum(['allow', 'confirm', 'deny']);
export type ExtPolicyValue = z.infer<typeof ExtPolicyValueSchema>;

/**
 * 权限：`full` = 全托管（已声明的能力全部允许、不弹任何确认，含升级后新声明的能力）；
 * `custom` = 按能力设置，缺省值见 DEFAULT_EXT_POLICY。
 */
export const ExtPolicySchema = z.object({
  trust: z.enum(['full', 'custom']),
  capabilities: z.record(z.string(), ExtPolicyValueSchema).default({}),
});
export type ExtPolicy = z.infer<typeof ExtPolicySchema>;

export const DEFAULT_EXT_CAPABILITY_POLICY: Readonly<Record<ExtCapability, ExtPolicyValue>> = {
  'prompt.insert': 'allow',
  'links.write': 'allow',
  invoke: 'allow',
  'prompt.send': 'confirm',
  'session.create': 'confirm',
};

export const ExtStatusSchema = z.enum(['ok', 'disabled', 'error']);

export const ExtCatalogItemSchema = z.object({
  id: ExtIdSchema,
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  apiVersion: z.number().int(),
  contributes: ExtContributesSchema,
  capabilities: z.array(ExtCapabilitySchema),
  enabled: z.boolean(),
  policy: ExtPolicySchema,
  status: ExtStatusSchema,
  /** 最近一次失败（manifest 无效、进程出错等），已截断 */
  lastError: z.string().max(1_000).optional(),
});
export type ExtCatalogItem = z.infer<typeof ExtCatalogItemSchema>;

/** machine.info 上的扩展摘要：缺失 = agent 不支持扩展 */
export const MachineExtensionsSummarySchema = z.object({
  api: z.number().int().positive(),
  /** 目录版本：变化时 client 重新拉 ext.catalog */
  rev: z.string().min(1).max(64),
  count: z.number().int().nonnegative(),
  /** 支持时间线记录卡（ext.records.request，agent ≥ 0.17.0） */
  records: z.boolean().optional(),
});
export type MachineExtensionsSummary = z.infer<typeof MachineExtensionsSummarySchema>;

/** SessionMeta.links 的一条 */
export const SessionLinkSchema = z.object({
  ext: ExtIdSchema,
  ref: z.string().min(1).max(EXT_LIMITS.ref),
  label: z.string().max(EXT_LIMITS.label),
  at: Ts,
});
export type SessionLink = z.infer<typeof SessionLinkSchema>;

/**
 * 时间线记录卡：扩展相关的操作在会话时间线留的一条记录，由 agent 产生（扩展不用写）。
 * 单独存在 agent 上，不进 Claude 转录。kind 用宽松字符串：将来新增的种类旧 client 按通用样式显示。
 *
 * - `linked` / `unlinked`：会话的关联变了，label 是关联的显示名
 * - `action`：会话面板里扩展的操作成功了，label 是动作名，subject 是条目标题，message 是扩展给的说明
 */
export const ExtRecordSchema = z.object({
  id: z.string().min(1).max(64),
  at: Ts,
  ext: ExtIdSchema,
  /** 记录时的扩展名（扩展移除后照样能显示） */
  extName: z.string().max(60),
  kind: z.string().min(1).max(32),
  label: z.string().max(300),
  subject: z.string().max(300).optional(),
  message: z.string().max(500).optional(),
});
export type ExtRecord = z.infer<typeof ExtRecordSchema>;

/** 每会话保留的记录条数 */
export const EXT_RECORDS_PER_SESSION = 50;

// ---------------------------------------------------------------------------
// 执行计划（ext.action.plan：需要确认时给用户看的、agent 已固定下来的内容）
// ---------------------------------------------------------------------------

export const ExtPlanStepSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.create'),
    cwd: z.string(),
    title: z.string().optional(),
    prompt: z.string(),
    model: z.string(),
    permissionMode: z.string(),
    links: z.array(ExtLinkRefSchema),
  }),
  z.object({
    type: z.literal('prompt.send'),
    targetSessionId: z.string(),
    sessionTitle: z.string(),
    cwd: z.string(),
    permissionMode: z.string(),
    /** 会话正忙：消息会排队 */
    busy: z.boolean(),
    text: z.string(),
  }),
  z.object({ type: z.literal('links.add'), targetSessionId: z.string(), links: z.array(ExtLinkRefSchema) }),
  z.object({ type: z.literal('links.remove'), targetSessionId: z.string(), refs: z.array(z.string()) }),
  z.object({ type: z.literal('invoke'), actionLabel: z.string(), destructive: z.boolean(), confirm: z.string().optional() }),
]);
export type ExtPlanStep = z.infer<typeof ExtPlanStepSchema>;

export const ExtPlanSchema = z.object({
  ext: ExtIdSchema,
  extName: z.string(),
  extVersion: z.string(),
  actionLabel: z.string(),
  steps: z.array(ExtPlanStepSchema).min(1).max(EXT_LIMITS.effectsPerAction + 1),
});
export type ExtPlan = z.infer<typeof ExtPlanSchema>;

export const ExtErrorCodeSchema = z.enum([
  'unsupported',
  'disabled',
  'denied',
  'stale',
  'not_found',
  'busy',
  'timeout',
  'invalid_output',
  'output_limit',
  'io',
  'unknown_outcome',
  'extension_error',
]);
export type ExtErrorCode = z.infer<typeof ExtErrorCodeSchema>;

export const ExtErrorSchema = z.object({ code: ExtErrorCodeSchema, message: z.string().max(1_000) });
export type ExtError = z.infer<typeof ExtErrorSchema>;

/** 逐条解析 ext.catalog.response 的 items：不认识的条目跳过（见该帧注释） */
export function parseExtCatalog(items: readonly unknown[]): ExtCatalogItem[] {
  const out: ExtCatalogItem[] = [];
  for (const raw of items) {
    const parsed = ExtCatalogItemSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
