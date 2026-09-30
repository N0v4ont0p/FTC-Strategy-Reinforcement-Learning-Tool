// A persistent worker: physics initialized once, then JSON-line jobs on stdin →
// JSON-line results on stdout. A job names a harness module and an exported function.
import { createInterface } from 'node:readline';
import { init } from './dsim';
import { setProgressSink } from './progress';

// the pool is gone (studio quit or crashed): leave quietly instead of dying on EPIPE
process.stdout.on('error', () => process.exit(0));
// BLOCKING writes: a job runs synchronously, and on macOS a pipe write the pipe buffer cannot take
// at once is queued until the event loop runs — after the job. A match streamed to the studio (its
// frames, harness/progress.ts) then arrived in one lump at its end. Blocking, it goes as it is played.
(process.stdout as unknown as { _handle?: { setBlocking?: (b: boolean) => void } })._handle?.setBlocking?.(true);
await init();
const mods = new Map<string, Record<string, (a: unknown) => unknown>>();
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const job = JSON.parse(line) as { id: number; module: string; fn: string; args: unknown };
  // what the job reports on its way (harness/progress.ts) goes to the pool as its own line
  setProgressSink((p) => process.stdout.write(JSON.stringify({ id: job.id, progress: p }) + '\n'));
  try {
    let m = mods.get(job.module);
    if (!m) mods.set(job.module, (m = (await import(`./${job.module}`)) as Record<string, (a: unknown) => unknown>));
    const result = await m[job.fn](job.args);
    process.stdout.write(JSON.stringify({ id: job.id, ok: true, result }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ id: job.id, ok: false, error: String((e as Error)?.stack ?? e) }) + '\n');
  } finally {
    setProgressSink(null);
  }
});
process.stdout.write(JSON.stringify({ ready: true }) + '\n');
