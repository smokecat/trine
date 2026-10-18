/** 脚本化终端：驱动 control/commands.ts 的子命令（测试用） */
import type { ControlClient } from '../control/client.ts';
import type { CommandIO } from '../control/commands.ts';

/**
 * 脚本化终端：`answers` 按提问顺序给出回答；回答可以是函数（先做点事再回答），
 * `undefined` 表示一直挂着不回答（直到被中止）。
 */
export class ScriptIO implements CommandIO {
  readonly lines: string[] = [];
  readonly prompts: string[] = [];
  interactive = true;
  client: ControlClient | null = null;
  #waiters: { text: string; resolve: () => void }[] = [];

  constructor(private readonly answers: (string | null | undefined | (() => Promise<string | null | undefined>))[]) {}

  print(line: string): void {
    this.lines.push(line);
    for (const w of [...this.#waiters]) {
      if (line.includes(w.text)) {
        this.#waiters.splice(this.#waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  }

  onConnected = (client: ControlClient): void => {
    this.client = client;
  };

  async ask(prompt: string, signal?: AbortSignal): Promise<string | null> {
    this.prompts.push(prompt);
    let answer = this.answers.shift();
    if (typeof answer === 'function') answer = await answer();
    if (answer !== undefined) return answer;
    return new Promise((resolve) => signal?.addEventListener('abort', () => resolve(null)));
  }

  /** 等到打印出含 text 的一行 */
  waitFor(text: string): Promise<void> {
    if (this.lines.some((l) => l.includes(text))) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push({ text, resolve }));
  }

  get output(): string {
    return this.lines.join('\n');
  }
}
