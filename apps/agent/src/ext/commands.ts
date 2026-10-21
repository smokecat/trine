/**
 * `trine-agent ext …` 子命令的执行体：注册表操作（在线走控制通道、离线直接改文件）、
 * validate（只看目录）、test（用合成上下文直接跑一次扩展进程，不经过 agent）。
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { EXT_API_VERSION, ExtActionOutputSchema, ExtBadgeOutputSchema, ExtErrorOutputSchema, ExtPickOutputSchema, ExtViewOutputSchema } from '@trine/core';
import type { ExtListItem } from '../control/protocol.ts';
import { ExtensionRegistry, inspectExtensionDir, type LoadedExtension } from './registry.ts';
import { ACTION_TIMEOUT_MS, READ_TIMEOUT_MS, runProcess } from './runner.ts';

export type ExtSubcommand =
  | { name: 'ext.list' }
  | { name: 'ext.add'; path: string }
  | { name: 'ext.remove'; id: string }
  | { name: 'ext.reload'; id?: string }
  | { name: 'ext.validate'; path: string }
  | {
      name: 'ext.test';
      id: string;
      op: string;
      point?: string;
      cwd?: string;
      session?: string;
      args?: string;
      allowWrite: boolean;
    };

export function toListItem(e: LoadedExtension): ExtListItem {
  return {
    id: e.id,
    name: e.manifest?.name ?? e.id,
    version: e.manifest?.version ?? '',
    dir: e.dir,
    enabled: e.enabled,
    trust: e.policy.trust,
    status: e.manifest === undefined ? 'error' : e.enabled ? 'ok' : 'disabled',
    ...(e.lastError === undefined ? {} : { lastError: e.lastError }),
  };
}

export function printExtList(items: readonly ExtListItem[], print: (line: string) => void): void {
  if (items.length === 0) {
    print('还没有注册扩展。用 ext add <目录> 注册。');
    return;
  }
  for (const item of items) {
    const state = item.status === 'ok' ? '已启用' : item.status === 'disabled' ? '已停用' : '出错';
    print(`${item.id}  ${item.name} ${item.version}  ${state}  权限：${item.trust === 'full' ? '全托管' : '自定义'}\n  ${item.dir}`);
    if (item.lastError !== undefined) print(`  最近错误：${item.lastError}`);
  }
}

/** 离线：直接改注册表文件（调用方持有单实例锁） */
export async function runExtOffline(command: ExtSubcommand, path: string, print: (line: string) => void): Promise<number> {
  const registry = await ExtensionRegistry.load(path, { log: print });
  switch (command.name) {
    case 'ext.list':
      printExtList(registry.list().map(toListItem), print);
      return 0;
    case 'ext.add': {
      const added = await registry.add(command.path);
      await registry.flush();
      print(`已注册扩展 ${added.id}（${added.manifest?.name} ${added.manifest?.version}）。agent 下次启动时生效。`);
      return 0;
    }
    case 'ext.remove': {
      const removed = await registry.remove(command.id);
      await registry.flush();
      print(removed ? `已移除扩展 ${command.id}。` : `没有扩展 ${command.id}。`);
      return removed ? 0 : 1;
    }
    case 'ext.reload':
      print('agent 没有在运行，下次启动时会重新读取全部 manifest。');
      return 0;
    default:
      return runExtLocal(command, path, print);
  }
}

/** validate / test：不需要 agent 在运行 */
export async function runExtLocal(command: ExtSubcommand, registryPath: string, print: (line: string) => void): Promise<number> {
  if (command.name === 'ext.validate') {
    try {
      const inspected = await inspectExtensionDir(command.path);
      print(`manifest 有效：${inspected.manifest.id}（${inspected.manifest.name} ${inspected.manifest.version}）`);
      print(`入口：${inspected.argv.join(' ')}`);
      print(`贡献点：${Object.keys(inspected.manifest.contributes).join(', ') || '（无）'}`);
      print(`能力：${inspected.manifest.capabilities.join(', ') || '（无）'}`);
      return 0;
    } catch (err) {
      print((err as Error).message);
      return 1;
    }
  }
  if (command.name !== 'ext.test') return 2;
  const registry = await ExtensionRegistry.load(registryPath, { log: () => {} });
  const ext = registry.get(command.id);
  if (ext?.manifest === undefined || ext.argv === undefined) {
    print(ext === undefined ? `没有扩展 ${command.id}。用 ext list 查看。` : `扩展不可用：${ext.lastError ?? '未知原因'}`);
    return 1;
  }
  if (command.op === 'action' && !command.allowWrite) {
    print('action 可能修改数据：确认要跑请加 --allow-write。');
    return 2;
  }
  const schema =
    command.op === 'view'
      ? ExtViewOutputSchema
      : command.op === 'badge'
        ? ExtBadgeOutputSchema
        : command.op === 'pick'
          ? ExtPickOutputSchema
          : command.op === 'action'
            ? ExtActionOutputSchema
            : undefined;
  if (schema === undefined) {
    print(`op 只能是 view / badge / pick / action，不是 ${command.op}`);
    return 2;
  }
  let args: unknown = {};
  if (command.args !== undefined) {
    try {
      args = JSON.parse(command.args);
    } catch {
      print('--args 不是合法 JSON');
      return 2;
    }
  }
  const cwd = resolve(command.cwd ?? process.cwd());
  const point =
    command.point ?? (command.op === 'view' ? 'sessionPanel' : command.op === 'badge' ? 'sessionBadge' : command.op === 'pick' ? 'linkPicker' : 'sessionPanel');
  const sessionId = command.session ?? 'test-session';
  const input = {
    apiVersion: EXT_API_VERSION,
    op: command.op,
    point,
    locale: 'zh-CN',
    context: {
      machine: { id: 'test-machine', name: 'test' },
      cwd,
      session: { id: sessionId, title: '测试会话', state: 'idle', cwd, archived: false, links: [] },
      linkedSessions: [],
    },
    args: command.op === 'action' ? { invocationId: randomUUID(), ...(args as object) } : args,
  };
  const result = await runProcess({
    argv: ext.argv,
    dir: ext.dir,
    cwd,
    op: command.op,
    input,
    timeoutMs: command.op === 'action' ? ACTION_TIMEOUT_MS : READ_TIMEOUT_MS,
  });
  print(`耗时 ${result.durationMs}ms`);
  if (result.stderr !== '') print(`stderr（末尾）：\n${result.stderr}`);
  if (!result.ok) {
    print(`失败（${result.code}）：${result.message}`);
    return 1;
  }
  const asError = ExtErrorOutputSchema.safeParse(result.output);
  if (asError.success) {
    print(`扩展返回错误：${asError.data.error.code} ${asError.data.error.message}`);
    return 1;
  }
  const parsed = schema.safeParse(result.output);
  if (!parsed.success) {
    print('输出不符合契约：');
    for (const issue of parsed.error.issues.slice(0, 12)) print(`  ${issue.path.join('.') || '(根)'}：${issue.message}`);
    return 1;
  }
  print(JSON.stringify(parsed.data, null, 2));
  return 0;
}
