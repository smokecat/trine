/** Include upstream runtime dependency licenses in every production web build. */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

interface Manifest {
  name: string;
  version?: string;
  license?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const root = resolve(import.meta.dir, '..');
const web = join(root, 'apps/web');
const seen = new Set<string>();
const notices: string[] = [
  readFileSync(join(root, 'LICENSE'), 'utf8'),
  readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
];

function locate(name: string, from: string): string | undefined {
  let dir = from;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function visit(dir: string): void {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
  const key = `${manifest.name}@${manifest.version ?? 'workspace'}`;
  if (seen.has(key)) return;
  seen.add(key);

  if (!manifest.name.startsWith('@trine/')) {
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice)([.\-_]|$)/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    notices.push(`\n${'='.repeat(72)}\n${key}\nDeclared license: ${manifest.license ?? 'see package'}\n`);
    for (const file of files) notices.push(`${file}\n${readFileSync(join(dir, file), 'utf8')}`);
    if (files.length === 0) {
      // Some packages carry the license only in their README. Include it when available.
      const readme = readdirSync(dir).find((file) => /^readme([.]|$)/i.test(file));
      if (readme) notices.push(readFileSync(join(dir, readme), 'utf8'));
    }
  }

  const optional = manifest.optionalDependencies ?? {};
  for (const name of Object.keys({ ...manifest.dependencies, ...optional }).sort()) {
    const dependency = locate(name, dir);
    if (dependency) visit(dependency);
    else if (!(name in optional)) throw new Error(`Missing dependency ${name} of ${key}`);
  }
}

visit(web);
// Adapted source and font notices must be present even if their generating CLI is removed.
for (const file of readdirSync(join(root, 'LICENSES')).sort()) {
  notices.push(`\n${file}\n${readFileSync(join(root, 'LICENSES', file), 'utf8')}`);
}
const output = join(web, 'dist', 'THIRD_PARTY_NOTICES.txt');
if (!existsSync(join(web, 'dist/index.html'))) throw new Error('Run the Vite build first');
await Bun.write(output, notices.join('\n'));
console.log(`Wrote web notices for ${seen.size} installed runtime/workspace packages.`);
