// The DSIM pin: one content hash of dsim-main's source. Skips node_modules (installed by `npm ci`),
// .DS_Store, .impeccable/ (a design-tool hook writes its cache there) and symlinks (as `find
// -type f` does). Run with --write to (re)create harness/dsim-pin.json.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.DS_Store', '.impeccable']);

export function treeHash(dir = join(root, 'dsim-main')): { files: number; treeSha256: string } {
  const files: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const n of readdirSync(d)) {
      if (SKIP.has(n)) continue;
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p, `${rel}/${n}`);
      else files.push(`${rel}/${n}`);
    }
  };
  walk(dir, '.');
  files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const lines = files.map((f) => `${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}  ${f}\n`).join('');
  return { files: files.length, treeSha256: createHash('sha256').update(lines).digest('hex') };
}

export const readPin = (): { files: number; treeSha256: string } => JSON.parse(readFileSync(join(root, 'harness/dsim-pin.json'), 'utf8'));

if (process.argv.includes('--write')) {
  const h = treeHash();
  const pin = {
    pinnedAt: new Date().toISOString().slice(0, 10),
    source: 'dsim-main (zip snapshot, alpha, BIOBUZZ scored)',
    ...h,
    excludes: [...SKIP, 'symlinks'],
    rule: 'never edit dsim-main source; node_modules only via npm ci',
  };
  writeFileSync(join(root, 'harness/dsim-pin.json'), JSON.stringify(pin, null, 2) + '\n');
  console.log(pin);
}
