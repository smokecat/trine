/**
 * 会话主题标题的生成（trine 自用，不写进转录）。
 *
 * ## 为什么 trine 要自己生成
 *
 * Claude Code 的自动标题（转录里的 `ai-title` 记录）只在**交互式**会话里生成；
 * `claude -p` / SDK（trine 起的会话）不会写。SDK 在没有标题时给的 `summary`
 * 是**最后一条用户消息**，于是列表标题会跟着每个问题变。
 *
 * 这里用与 CC 相同的思路：拿首条用户消息，让小模型起一个 4–12 字的主题标题。
 * 生成结果存进 trine 自己的 flags（`<home>/sessions.json` 的 autoTitles），
 * **不改会话转录**——用户在本机 `/rename` 的名字仍然是最高优先级的正式标题。
 *
 * ## 凭据
 *
 * agent 进程自己不带 ANTHROPIC_* 环境变量（那是会话子进程的设置），所以从
 * `~/.claude/settings.json` 的 env 块读 base URL / token / haiku 型号。请求走
 * 本机设置的同一端点（通常是 8787 网关）。key 只在进程内用，不进日志与输出。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 第三方端点（GLM/DeepSeek）默认开 thinking，预算太小会让思考吃光 token、正文为空；
// 这里给足空间，超时也给到能覆盖一轮思考的量级。
const TIMEOUT_MS = 15000;
const MAX_TOKENS = 800;
const MAX_PROMPT_CHARS = 1200;
const MAX_TITLE_CHARS = 24;

interface Endpoint {
  baseUrl: string;
  token: string;
  model: string;
}

function readEndpoint(): Endpoint | undefined {
  let env: Record<string, string | undefined> = {};
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')) as {
      env?: Record<string, string>;
    };
    env = settings.env ?? {};
  } catch {
    return undefined;
  }
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim();
  const token = env.ANTHROPIC_AUTH_TOKEN?.trim() ?? env.ANTHROPIC_API_KEY?.trim();
  if (baseUrl === undefined || baseUrl === '' || token === undefined || token === '') return undefined;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    token,
    model: env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim() || 'claude-haiku-5-5',
  };
}

/** 模型输出 → 干净标题：去引号/句号、压空白、截断 */
export function cleanTitle(raw: string): string | undefined {
  const text = raw
    .replace(/^[\s"'“”‘’「」《》]+|[\s"'“”‘’「」《》。.，,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return undefined;
  const chars = [...text];
  return chars.length > MAX_TITLE_CHARS ? chars.slice(0, MAX_TITLE_CHARS).join('') : text;
}

/**
 * 根据首条用户消息生成会话标题；任何失败（没配置、超时、模型异常）返回 undefined，
 * 调用方回退到首条消息本身。不抛错——起名失败不该影响会话。
 */
export async function generateSessionTitle(firstPrompt: string): Promise<string | undefined> {
  const endpoint = readEndpoint();
  if (endpoint === undefined) return undefined;
  const prompt = firstPrompt.trim().slice(0, MAX_PROMPT_CHARS);
  if (prompt === '') return undefined;

  try {
    const response = await fetch(`${endpoint.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': endpoint.token,
        authorization: `Bearer ${endpoint.token}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: endpoint.model,
        max_tokens: MAX_TOKENS,
        system:
          '你在给 Claude Code 的会话起标题。根据用户的第一条消息，写一个简短的中文主题标题' +
          `（4-${MAX_TITLE_CHARS} 个字以内），概括这段对话要解决的问题。` +
          '只输出标题本身：不要引号、不要标点、不要解释。',
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { content?: { type?: string; text?: string }[] };
    const text = (body.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join(' ');
    return cleanTitle(text);
  } catch {
    return undefined;
  }
}
