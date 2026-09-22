// Run many jobs across persistent worker processes (harness/worker.ts). 8 workers measured best
// on the M5 (4 performance + 6 efficiency cores, S-1 step h).
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const TSX = join(here, '..', 'dsim-main', 'node_modules', '.bin', 'tsx');

export interface Job {
  module: string; // file in harness/, e.g. 'jobs.ts'
  fn: string;
  args: unknown;
}

export async function runPool<T>(jobs: Job[], workers = 8, onDone?: (done: number, total: number) => void): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;
  let done = 0;
  const procs: ChildProcess[] = [];
  await Promise.all(
    Array.from({ length: Math.min(workers, jobs.length) }, () =>
      new Promise<void>((resolveW, rejectW) => {
        const p = spawn(TSX, [join(here, 'worker.ts')], { stdio: ['pipe', 'pipe', 'inherit'] });
        procs.push(p);
        let current = -1;
        const feed = (): void => {
          if (next >= jobs.length) {
            p.stdin!.end();
            resolveW();
            return;
          }
          current = next++;
          p.stdin!.write(JSON.stringify({ id: current, ...jobs[current] }) + '\n');
        };
        createInterface({ input: p.stdout! }).on('line', (line) => {
          const msg = JSON.parse(line) as { ready?: boolean; id: number; ok: boolean; result?: T; error?: string };
          if (msg.ready) return feed();
          if (!msg.ok) return rejectW(new Error(`job ${msg.id} failed: ${msg.error}`));
          results[msg.id] = msg.result as T;
          onDone?.(++done, jobs.length);
          feed();
        });
        p.on('exit', (code) => {
          if (code && next <= jobs.length && current >= 0 && results[current] === undefined) rejectW(new Error(`worker exited ${code}`));
        });
      }),
    ),
  ).finally(() => procs.forEach((p) => p.kill()));
  return results;
}
