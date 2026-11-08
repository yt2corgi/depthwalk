import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const stamp = process.argv[2] || Date.now().toString(36);

async function rewrite(file, pattern, replacement) {
  const before = await readFile(file, 'utf8');
  const after = before.replace(pattern, replacement);
  if (after !== before) await writeFile(file, after);
  return after !== before;
}

const changed = [];
for (const name of await readdir(join(root, 'js'))) {
  if (!name.endsWith('.js')) continue;
  const file = join(root, 'js', name);
  if (await rewrite(file, /(from\s+'\.\/[\w-]+\.js)(?:\?v=[\w-]*)?'/g, `$1?v=${stamp}'`)) changed.push(`js/${name}`);
}
const html = join(root, 'index.html');
if (await rewrite(html, /((?:src|href)="(?:js\/app\.js|css\/app\.css))(?:\?v=[\w-]*)?"/g, `$1?v=${stamp}"`)) changed.push('index.html');
console.log(`stamp ${stamp} · ${changed.join(' ') || 'nothing changed'}`);
