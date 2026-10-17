import { expect, test } from 'bun:test';

async function readFromPipe(input: string) {
  const source = `
    import { readInvitation } from ${JSON.stringify(new URL('./enrollment-input.ts', import.meta.url).pathname)};
    try { const value = await readInvitation(); console.log(JSON.stringify({ length: value.length })); }
    catch { console.error('input rejected'); process.exitCode = 1; }
  `;
  const child = Bun.spawn([process.execPath, '-e', source], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  child.stdin.write(input);
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

test('stdin invitation is read once without being echoed to output', async () => {
  const synthetic = 'a'.repeat(43);
  const result = await readFromPipe(`${synthetic}\n`);
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ length: 43 });
  expect(result.stdout + result.stderr).not.toContain(synthetic);
});

test('empty, malformed and oversized secret input fails without reflecting it', async () => {
  for (const input of ['', 'invalid!\n', 'b'.repeat(5000)]) {
    const result = await readFromPipe(input);
    expect(result.exit).toBe(1);
    expect(result.stdout).toBe('');
    if (input) expect(result.stderr).not.toContain(input.trim());
  }
});
