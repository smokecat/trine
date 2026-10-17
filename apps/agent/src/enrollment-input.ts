/** Secret input stays in memory; no argv/env, echo, history or saved config. */
export async function readInvitation(): Promise<string> {
  const input = process.stdin;
  process.stderr.write('Agent invitation / 注册邀请（隐藏输入）: ');
  const wasRaw = input.isRaw;
  const tty = Boolean(input.isTTY);
  if (tty) input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = '';
      const finish = (error?: Error) => {
        input.off('data', onData);
        input.off('end', onEnd);
        input.off('error', onError);
        if (error) reject(error);
        else if (/^[A-Za-z0-9_-]{43}$/.test(value)) resolve(value);
        else reject(new Error('邀请格式错误；请重新签发或复制完整邀请，不要传入命令行参数。'));
        value = '';
      };
      const onError = () => finish(new Error('无法读取邀请'));
      const onEnd = () => finish();
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\u0003' || char === '\u0004') return finish(new Error('已取消注册'));
          if (char === '\r' || char === '\n') return finish();
          if (tty && (char === '\u007f' || char === '\b')) value = value.slice(0, -1);
          else value += char;
          if (value.length > 43) return finish(new Error('邀请格式错误；请只粘贴邀请本身'));
        }
      };
      input.on('data', onData);
      input.once('end', onEnd);
      input.once('error', onError);
    });
  } finally {
    if (tty) input.setRawMode(wasRaw ?? false);
    input.pause();
    process.stderr.write('\n');
  }
}
