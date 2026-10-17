import { expect, test } from 'bun:test';

async function logTimeUnder(tz: string, iso: string) {
  const source = `
    import { logTime } from ${JSON.stringify(new URL('./log-time.ts', import.meta.url).pathname)};
    console.log(logTime(new Date(${JSON.stringify(iso)})));
  `;
  const child = Bun.spawn([process.execPath, '-e', source], { env: { ...process.env, TZ: tz }, stdout: 'pipe' });
  const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return stdout.trim();
}

test('log timestamps follow TZ instead of always printing UTC', async () => {
  expect(await logTimeUnder('UTC', '2026-01-02T17:09:28Z')).toBe('17:09:28');
  expect(await logTimeUnder('Asia/Singapore', '2026-01-02T17:09:28Z')).toBe('01:09:28');
  expect(await logTimeUnder('America/New_York', '2026-01-02T05:04:03Z')).toBe('00:04:03');
});
