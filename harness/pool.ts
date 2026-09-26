// Worker processes (harness/worker.ts) that stay alive across batches. 8 workers measured best on
// the M5 (4 performance + 6 efficiency cores, S-1 step h). A job names a harness module + function.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const TSX = join(here, '..', 'dsim-main', 'node_modules', '.bin', 'tsx');

export interface Job {
  module: string; // path under harness/, e.g. 'jobs.ts' or '../train/episode.ts'
  fn: string;
  args: unknown;
}

interface Slot {
  p: ChildProcess;
  ready: Promise<void>;
  busy: boolean;
  /** exited or failed to start: never handed another job */
  dead: boolean;
}

export class WorkerPool {
  private slots: Slot[] = [];
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 0;
  private closed = false;

  constructor(readonly size = 8) {
    for (let i = 0; i < size; i++) this.slots.push(this.start());
  }

  private start(): Slot {
    const p = spawn(TSX, [join(here, 'worker.ts')], { stdio: ['pipe', 'pipe', 'inherit'] });
    let markReady!: () => void;
    const slot: Slot = { p, ready: new Promise<void>((r) => (markReady = r)), busy: false, dead: false };
    // A worker's failure must end the batch, never the process that owns the pool: every event
    // below is one that, unhandled, would throw out of a stream callback and kill the studio.
    const fail = (why: string): void => {
      slot.dead = true;
      markReady(); // a worker lost before it was ready must not leave map() waiting forever
      if (this.closed) return;
      for (const [, w] of this.waiting) w.reject(new Error(why));
      this.waiting.clear();
    };
    p.on('error', (e) => fail(`worker could not run: ${e.message}`));
    p.stdin!.on('error', (e) => fail(`worker stopped taking jobs: ${e.message}`)); // EPIPE: it died
    createInterface({ input: p.stdout! }).on('line', (line) => {
      let msg: { ready?: boolean; id: number; ok: boolean; result?: unknown; error?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        process.stderr.write(`[worker] ${line.slice(0, 500)}\n`); // stray output, not a result
        return;
      }
      if (msg.ready) return markReady();
      const w = this.waiting.get(msg.id);
      this.waiting.delete(msg.id);
      slot.busy = false;
      if (!w) return;
      if (msg.ok) w.resolve(msg.result);
      else w.reject(new Error(`job ${msg.id} failed: ${msg.error}`));
    });
    // a worker must never vanish silently: fail everything in flight
    p.on('exit', (code, signal) => fail(`worker exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    return slot;
  }

  private run<T>(slot: Slot, job: Job): Promise<T> {
    const id = this.nextId++;
    slot.busy = true;
    return new Promise<T>((resolve, reject) => {
      if (slot.dead) return reject(new Error('worker exited'));
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      slot.p.stdin!.write(JSON.stringify({ id, ...job }) + '\n');
    });
  }

  /** run every job; results in job order. `onDone` fires per finished job (progress bars). */
  async map<T>(jobs: Job[], onDone?: (done: number, total: number, result: T, index: number) => void): Promise<T[]> {
    await Promise.all(this.slots.map((s) => s.ready));
    if (this.closed) throw new Error('aborted');
    const out = new Array<T>(jobs.length);
    let next = 0;
    let done = 0;
    await Promise.all(
      this.slots.map(async (slot) => {
        while (next < jobs.length && !this.closed) {
          const i = next++;
          out[i] = await this.run<T>(slot, jobs[i]);
          onDone?.(++done, jobs.length, out[i], i);
        }
      }),
    );
    return out;
  }

  /** kill every worker; anything still running is rejected with 'aborted' (never left hanging) */
  close(): void {
    this.closed = true;
    for (const s of this.slots) s.p.kill();
    for (const [, w] of this.waiting) w.reject(new Error('aborted'));
    this.waiting.clear();
  }
}

/** one-shot convenience: a pool for this batch only */
export async function runPool<T>(jobs: Job[], workers = 8, onDone?: (done: number, total: number) => void): Promise<T[]> {
  const pool = new WorkerPool(Math.min(workers, Math.max(1, jobs.length)));
  try {
    return await pool.map<T>(jobs, onDone ? (d, t) => onDone(d, t) : undefined);
  } finally {
    pool.close();
  }
}
