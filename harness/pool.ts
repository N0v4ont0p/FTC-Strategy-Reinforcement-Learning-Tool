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
  up: boolean; // ready for jobs
  /** exited or failed to start: never handed another job */
  dead: boolean;
}
/** what the submitter hears while its job runs: when a worker takes it, and what it reports on
 * its way (harness/progress.ts) */
export interface JobHooks {
  onStart?: () => void;
  onProgress?: (p: unknown) => void;
}
interface Queued {
  job: Job;
  pri: number;
  hooks?: JobHooks;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class WorkerPool {
  private slots: Slot[] = [];
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (p: unknown) => void }>();
  /** jobs waiting for a free worker: highest priority first, then first come */
  private queue: Queued[] = [];
  private nextId = 0;
  private closed = false;

  constructor(readonly size = 8) {
    for (let i = 0; i < size; i++) this.slots.push(this.start());
  }

  private start(): Slot {
    const p = spawn(TSX, [join(here, 'worker.ts')], { stdio: ['pipe', 'pipe', 'inherit'] });
    let markReady!: () => void;
    const slot: Slot = { p, ready: new Promise<void>((r) => (markReady = r)), busy: false, up: false, dead: false };
    // A worker's failure must end the batch, never the process that owns the pool: every event
    // below is one that, unhandled, would throw out of a stream callback and kill the studio.
    const fail = (why: string): void => {
      slot.dead = true;
      markReady(); // a worker lost before it was ready must not leave map() waiting forever
      if (this.closed) return;
      for (const [, w] of this.waiting) w.reject(new Error(why));
      this.waiting.clear();
      for (const q of this.queue.splice(0)) q.reject(new Error(why));
    };
    p.on('error', (e) => fail(`worker could not run: ${e.message}`));
    p.stdin!.on('error', (e) => fail(`worker stopped taking jobs: ${e.message}`)); // EPIPE: it died
    createInterface({ input: p.stdout! }).on('line', (line) => {
      let msg: { ready?: boolean; id: number; ok: boolean; result?: unknown; error?: string; progress?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        process.stderr.write(`[worker] ${line.slice(0, 500)}\n`); // stray output, not a result
        return;
      }
      if (msg.ready) {
        slot.up = true;
        markReady();
        return this.pump();
      }
      const w = this.waiting.get(msg.id);
      if ('progress' in msg) {
        // a report on the way, not the result: the job goes on
        try {
          w?.onProgress?.(msg.progress);
        } catch (e) {
          process.stderr.write(`[pool] progress hook: ${(e as Error).message}\n`);
        }
        return;
      }
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

  private run<T>(slot: Slot, job: Job, hooks?: JobHooks): Promise<T> {
    const id = this.nextId++;
    slot.busy = true;
    return new Promise<T>((resolve, reject) => {
      if (slot.dead) return reject(new Error('worker exited'));
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress: hooks?.onProgress });
      try {
        hooks?.onStart?.();
      } catch (e) {
        process.stderr.write(`[pool] start hook: ${(e as Error).message}\n`);
      }
      slot.p.stdin!.write(JSON.stringify({ id, ...job }) + '\n');
    });
  }

  /** one job, run by the next free worker; higher `priority` jumps the queue (the continuous engine's
   * evaluator and learner ahead of its actors). Several callers can share the pool at once */
  submit<T>(job: Job, priority = 0, hooks?: JobHooks): Promise<T> {
    if (this.closed) return Promise.reject(new Error('aborted'));
    return new Promise<T>((resolve, reject) => {
      let i = this.queue.length;
      while (i > 0 && this.queue[i - 1].pri < priority) i--;
      this.queue.splice(i, 0, { job, pri: priority, hooks, resolve: resolve as (v: unknown) => void, reject });
      this.pump();
    });
  }
  private pump(): void {
    for (const slot of this.slots) {
      if (!this.queue.length || this.closed) return;
      if (slot.busy || slot.dead || !slot.up) continue;
      const q = this.queue.shift()!;
      this.run(slot, q.job, q.hooks).then(q.resolve, q.reject).finally(() => this.pump());
    }
  }
  /** jobs running and waiting (the continuous engine's CPU gauge) */
  get load(): { busy: number; queued: number; size: number } {
    return { busy: this.slots.filter((s) => s.busy && !s.dead).length, queued: this.queue.length, size: this.slots.filter((s) => !s.dead).length };
  }

  /** run every job; results in job order. `onDone` fires per finished job (progress bars). */
  async map<T>(jobs: Job[], onDone?: (done: number, total: number, result: T, index: number) => void): Promise<T[]> {
    await Promise.all(this.slots.map((s) => s.ready));
    if (this.closed) throw new Error('aborted');
    let done = 0;
    return Promise.all(
      jobs.map((j, i) =>
        this.submit<T>(j).then((r) => {
          onDone?.(++done, jobs.length, r, i);
          return r;
        }),
      ),
    );
  }

  /** kill every worker; anything still running is rejected with 'aborted' (never left hanging) */
  close(): void {
    this.closed = true;
    for (const s of this.slots) s.p.kill();
    for (const [, w] of this.waiting) w.reject(new Error('aborted'));
    this.waiting.clear();
    for (const q of this.queue.splice(0)) q.reject(new Error('aborted'));
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
