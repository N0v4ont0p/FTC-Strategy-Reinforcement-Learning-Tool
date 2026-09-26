// A persistent worker: physics initialized once, then JSON-line jobs on stdin →
// JSON-line results on stdout. A job names a harness module and an exported function.
import { createInterface } from 'node:readline';
import { init } from './dsim';

// the pool is gone (studio quit or crashed): leave quietly instead of dying on EPIPE
process.stdout.on('error', () => process.exit(0));
await init();
const mods = new Map<string, Record<string, (a: unknown) => unknown>>();
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const job = JSON.parse(line) as { id: number; module: string; fn: string; args: unknown };
  try {
    let m = mods.get(job.module);
    if (!m) mods.set(job.module, (m = (await import(`./${job.module}`)) as Record<string, (a: unknown) => unknown>));
    const result = await m[job.fn](job.args);
    process.stdout.write(JSON.stringify({ id: job.id, ok: true, result }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ id: job.id, ok: false, error: String((e as Error)?.stack ?? e) }) + '\n');
  }
});
process.stdout.write(JSON.stringify({ ready: true }) + '\n');
