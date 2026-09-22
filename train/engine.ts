// THE TRAINING ENGINE — one run: generation after generation with no built-in end, checkpointed
// atomically every generation (resume is bit-exact, train/check.ts), plus the controls of a real
// training stack: pause / resume / stop / abort a generation / step N generations; named and
// automatic CHECKPOINTS you can pin, REWIND to, FORK into a new run or delete; hyperparameters
// changed between generations (logged, and part of the checkpoint); EVALUATIONS of any policy on
// held-out seeds; exact frames of every generation's best robot for the viewer.
import { EventEmitter } from 'node:events';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { availableParallelism } from 'node:os';
import { WorkerPool, type Job } from '../harness/pool';
import { seedOf } from '../harness/rng';
import { exportReplay } from '../harness/export';
import type { Replay } from '../harness/dsim';
import { DEFAULTS, TUNABLE, makeAlgo, validate, type Algo, type AlgoConfig, type AlgoName, type Lineage } from './algos';
import { fromB64, toB64 } from './net';
import { SHAPE } from './policy';
import { imitationGenome } from './imitate';
import { DEFAULT_PENALTY, DEFAULT_SHAPING, type Death, type EpisodeArgs, type EpisodeResult, type Parts, type Penalty, type Shaping, type Stage } from './episode';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RUNS = join(ROOT, 'runs');
export const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,47}$/;

export interface RunConfig extends AlgoConfig {
  name: string;
  profile: string;
  sampleProfile: boolean;
  driver: 'human' | 'oracle';
  episodes: number; // matches per individual per generation (common seeds across the population)
  /** 'curriculum' = AUTO-only episodes until mastered, then full matches */
  stage: Stage | 'curriculum';
  curriculum: { autoScore: number; holdGens: number; minGens: number; maxGens: number };
  annealGens: number; // shaping falls linearly to 0 over this many generations
  shaping: Shaping;
  penalty: Penalty;
  init: 'random' | 'imitation'; // generation 0: random networks, or mutants of the network fitted to "Training data/"
  workers: number;
  keepGens: number; // generation files kept on disk (every 100th is kept forever)
  ckEvery: number; // automatic checkpoint every N generations (0 = off)
  ckKeep: number; // automatic checkpoints kept (pinned and named ones are never pruned)
  maxGens: number; // 0 = no limit
}

/** settings that can change mid-run (everything else defines the run) */
export const LIVE_KEYS = [...TUNABLE, 'episodes', 'annealGens', 'shaping', 'penalty', 'workers', 'keepGens', 'ckEvery', 'ckKeep', 'maxGens', 'stage', 'driver', 'sampleProfile'] as const;

export function defaultConfig(name: string, algo: AlgoName = 'ga'): RunConfig {
  return {
    name,
    ...DEFAULTS[algo],
    algo,
    pop: 128,
    seed: 1,
    profile: 'profiles/real-v0.json',
    sampleProfile: true,
    driver: 'oracle',
    episodes: 1,
    stage: 'full',
    curriculum: { autoScore: 60, holdGens: 20, minGens: 30, maxGens: 3000 },
    annealGens: 1000,
    shaping: { ...DEFAULT_SHAPING },
    penalty: { ...DEFAULT_PENALTY },
    init: 'imitation',
    workers: Math.max(1, availableParallelism() - 1), // as fast as this machine goes, one core left for the UI
    keepGens: 300,
    ckEvery: 10,
    ckKeep: 30,
    maxGens: 0,
  };
}

export interface GenSummary {
  gen: number;
  stage: Stage;
  shaping: number;
  best: number;
  mean: number;
  median: number;
  p90: number;
  bestScore: number;
  meanScore: number;
  deaths: Record<Death, number>;
  meanLifeS: number;
  spawnedTotal: number;
  matchesTotal: number;
  simHoursTotal: number;
  wallS: number;
  robotsPerMin: number;
  bestEver: number;
  bestEverScore: number;
  newBest: boolean;
  /** how this generation's robots were made */
  ops: Record<string, number>;
  meanMuts: number;
  bestOp: string;
  /** mean share of decisions per option kind across the population */
  choices: Record<string, number>;
  meanTips: number;
}

export interface Best {
  fitness: number;
  score: number;
  gen: number;
  genome: string;
  parts: Parts;
  id: number;
}

/** checkpoint format; version 1 runs (raw joystick policy) cannot continue with the skill policy */
export const CK_VERSION = 2;
const LEGACY = 'made by the first training version (a raw joystick policy — the one that never learned to shoot); it cannot continue with the skill-based robot. Its files are untouched; start a new run';

interface Checkpoint {
  version: number;
  config: RunConfig;
  algoState: object;
  stage: Stage;
  autoHeld: number; // consecutive gens at/above the curriculum AUTO score
  totals: { spawned: number; matches: number; simSeconds: number; wallSeconds: number; deaths: Record<Death, number> };
  bestEver: Best | null;
}

export interface CheckpointMeta {
  id: string;
  gen: number;
  label: string;
  auto: boolean;
  pinned: boolean;
  time: string;
  bestFitness: number | null;
  bestScore: number | null;
  config: Pick<RunConfig, 'algo' | 'pop' | 'sigma' | 'lr' | 'elite' | 'crossRate' | 'mutProb'>;
}

export interface EvalResult {
  id: string;
  target: string;
  gen: number;
  n: number;
  scores: number[];
  mean: number;
  sd: number;
  ci95: number;
  min: number;
  max: number;
  tips: number;
  deaths: Record<Death, number>;
  time: string;
}

const EVAL_SEED = 777_000;
const now = (): string => new Date().toISOString();

function atomicWrite(p: string, data: string | Buffer): void {
  writeFileSync(p + '.tmp', data);
  renameSync(p + '.tmp', p); // a crash never leaves a half-written file
}

export class Engine extends EventEmitter {
  readonly dir: string;
  private algo: Algo;
  private ck: Checkpoint;
  private pool: WorkerPool | null = null;
  private stopFlag = false;
  private abortFlag = false;
  private stepsLeft = -1; // -1 = run on; n = run n more generations, then pause
  private evalQueue: { target: string; n: number; resolve: (r: EvalResult) => void; reject: (e: Error) => void }[] = [];
  private loop: Promise<void> | null = null;
  private busy = false; // inside a generation
  private pendingCk: string[] = []; // named checkpoints asked for mid-generation
  paused = false;
  running = false;
  private _phase: 'idle' | 'generation' | 'evaluating' | 'paused' = 'idle';
  get phase(): 'idle' | 'generation' | 'evaluating' | 'paused' {
    return this._phase;
  }
  /** every phase change reaches the viewer (its buttons depend on it) */
  set phase(p: 'idle' | 'generation' | 'evaluating' | 'paused') {
    if (p === this._phase) return;
    this._phase = p;
    this.emit('state');
  }

  /** open an existing run */
  static open(name: string): Engine {
    const dir = join(RUNS, name);
    if (!existsSync(join(dir, 'checkpoint.json'))) throw new Error(`no run called "${name}"`);
    const ck = JSON.parse(readFileSync(join(dir, 'checkpoint.json'), 'utf8')) as Checkpoint;
    if (ck.version !== CK_VERSION) throw new Error(`"${name}" was ${LEGACY}`);
    return new Engine(dir, ck);
  }

  /** create a new run (never overwrites one) */
  static create(cfg: RunConfig, log: (s: string) => void = () => {}): Engine {
    if (!NAME_RE.test(cfg.name)) throw new Error('run names use letters, digits, - and _ (up to 48)');
    const err = validate(cfg);
    if (err) throw new Error(err);
    const dir = join(RUNS, cfg.name);
    if (existsSync(join(dir, 'checkpoint.json'))) throw new Error(`run "${cfg.name}" already exists`);
    let init: Float32Array | undefined;
    // fitting reads "Training data/" through DSIM's ReplayPlayer (~16 s the first time, then cached
    // in outputs/imitation/); the process must have run harness/dsim init() first
    if (cfg.init === 'imitation') init = fromB64(imitationGenome(log));
    const ck: Checkpoint = {
      version: CK_VERSION,
      config: cfg,
      algoState: makeAlgo({ ...cfg }, SHAPE, undefined, init).state(),
      stage: cfg.stage === 'auto' || cfg.stage === 'curriculum' ? 'auto' : 'full',
      autoHeld: 0,
      totals: { spawned: 0, matches: 0, simSeconds: 0, wallSeconds: 0, deaths: { survived: 0, crash: 0, stall: 0 } },
      bestEver: null,
    };
    mkdirSync(join(dir, 'gens'), { recursive: true });
    mkdirSync(join(dir, 'checkpoints'), { recursive: true });
    const e = new Engine(dir, ck);
    e.save();
    e.event(`created: ${cfg.algo.toUpperCase()}, population ${cfg.pop}, ${cfg.init === 'imitation' ? 'generation 0 = mutants of the network fitted to your replays' : 'random generation 0'}`);
    e.saveCheckpoint('start', false, true);
    return e;
  }

  private constructor(dir: string, ck: Checkpoint) {
    super();
    this.dir = dir;
    this.ck = ck;
    mkdirSync(join(dir, 'gens'), { recursive: true });
    mkdirSync(join(dir, 'checkpoints'), { recursive: true });
    this.algo = makeAlgo({ ...ck.config }, SHAPE, ck.algoState);
  }

  get name(): string {
    return this.ck.config.name;
  }
  get config(): RunConfig {
    return this.ck.config;
  }
  get gen(): number {
    return this.algo.gen;
  }
  get totals(): Checkpoint['totals'] {
    return this.ck.totals;
  }
  get bestEver(): Best | null {
    return this.ck.bestEver;
  }
  get stage(): Stage {
    return this.ck.stage;
  }

  history(): GenSummary[] {
    const p = join(this.dir, 'metrics.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as GenSummary);
  }
  events(): { time: string; gen: number; text: string }[] {
    const p = join(this.dir, 'events.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { time: string; gen: number; text: string });
  }
  evals(): EvalResult[] {
    const p = join(this.dir, 'evals.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as EvalResult);
  }

  /** a line in the run's event log (also shown live) */
  event(text: string): void {
    const e = { time: now(), gen: this.gen, text };
    appendFileSync(join(this.dir, 'events.jsonl'), JSON.stringify(e) + '\n');
    this.emit('log', text);
  }

  // ─────────────────────────────── control ───────────────────────────────
  /** start (or continue) training in the background */
  start(steps = -1): void {
    this.stepsLeft = steps;
    this.paused = false;
    this.stopFlag = false;
    if (this.loop) {
      this.emit('state');
      return;
    }
    this.running = true;
    this.loop = this.runLoop().finally(() => {
      this.loop = null;
      this.running = false;
      this.phase = 'idle';
      this.emit('stopped');
      this.emit('state');
    });
    this.emit('state');
  }
  pause(): void {
    this.paused = true;
    this.emit('log', 'pausing after this generation');
    this.emit('state');
  }
  resume(): void {
    this.stepsLeft = -1;
    this.paused = false;
    this.emit('state');
  }
  /** finish this generation, checkpoint, stop */
  stop(): void {
    this.stopFlag = true;
    this.paused = false;
    this.emit('log', 'stop requested — finishing this generation, then checkpointing');
    this.emit('state');
  }
  /** throw away the generation in progress (nothing of it is kept) and stop */
  abort(): void {
    this.stopFlag = true;
    this.paused = false;
    if (this.busy) {
      this.abortFlag = true;
      this.pool?.close();
      this.emit('log', 'generation aborted — its robots are discarded; the run is exactly as it was before it started');
    }
    this.emit('state');
  }
  /** resolves when the training loop has fully stopped */
  async halt(abort = false): Promise<void> {
    if (!this.loop) return;
    if (abort) this.abort();
    else this.stop();
    await this.loop;
  }

  private shaping(): number {
    return Math.max(0, 1 - this.algo.gen / Math.max(1, this.ck.config.annealGens));
  }

  private job(genome: string | null, seed: number, o: { stage?: Stage; track?: boolean; frames?: boolean; record?: boolean; shaping?: number } = {}): Job {
    const c = this.ck.config;
    const args: EpisodeArgs = {
      genome,
      profile: c.profile,
      sampleProfile: c.sampleProfile,
      seed,
      stage: o.stage ?? this.ck.stage,
      shaping: o.shaping ?? this.shaping(),
      weights: { shaping: c.shaping, penalty: c.penalty },
      driver: c.driver,
      track: o.track ?? false,
      frames: o.frames ?? false,
      record: o.record ?? false,
    };
    return { module: '../train/episode.ts', fn: 'runEpisode', args };
  }
  private genSeed(gen: number, e: number): number {
    return seedOf(this.ck.config.seed, 'episode', gen, e) % 1_000_000_007; // common random numbers across the generation
  }

  private ensurePool(): WorkerPool {
    if (!this.pool || this.pool.size !== this.ck.config.workers) {
      this.pool?.close();
      this.pool = new WorkerPool(this.ck.config.workers);
    }
    return this.pool;
  }

  private async runLoop(): Promise<void> {
    try {
      for (;;) {
        await this.drainEvals();
        if (this.stopFlag) break;
        const c = this.ck.config;
        if (c.maxGens > 0 && this.gen >= c.maxGens) {
          this.event(`reached the generation limit (${c.maxGens}) — stopped`);
          break;
        }
        if (this.stepsLeft === 0) {
          this.paused = true;
          this.stepsLeft = -1;
          this.emit('log', 'step finished — paused');
          this.emit('state');
        }
        if (this.paused) {
          this.phase = 'paused';
          await new Promise((r) => setTimeout(r, 150));
          continue;
        }
        this.phase = 'generation';
        this.busy = true;
        try {
          await this.generation();
        } catch (e) {
          if (!this.abortFlag) throw e;
        } finally {
          this.busy = false;
          if (this.abortFlag) {
            this.abortFlag = false;
            this.pool = null; // closed by abort(); a fresh one next time
          }
        }
        if (this.stepsLeft > 0) this.stepsLeft--;
      }
    } finally {
      this.pool?.close();
      this.pool = null;
    }
  }

  private async generation(): Promise<void> {
    const c = this.ck.config;
    const gen = this.algo.gen;
    const t0 = performance.now();
    const cand = this.algo.ask();
    const lin: Lineage[] = this.algo.lineage();
    const genomes = cand.map(toB64);
    const jobs: Job[] = [];
    for (let i = 0; i < cand.length; i++) for (let e = 0; e < c.episodes; e++) jobs.push(this.job(genomes[i], this.genSeed(gen, e), { track: e === 0 }));
    this.emit('progress', { gen, done: 0, total: jobs.length });
    const pool = this.ensurePool();
    const res = await pool.map<EpisodeResult>(jobs, (done, total) => this.emit('progress', { gen, done, total }));
    if (this.abortFlag || res.length !== jobs.length || res.some((r) => !r)) throw new Error('aborted');
    const fit: number[] = [];
    const score: number[] = [];
    for (let i = 0; i < cand.length; i++) {
      const rs = res.slice(i * c.episodes, (i + 1) * c.episodes);
      fit.push(rs.reduce((t, r) => t + r.fitness, 0) / rs.length);
      score.push(rs.reduce((t, r) => t + r.score, 0) / rs.length);
    }
    const order = fit.map((f, i) => [f, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    const [bf, bi] = order[0];

    // the generation's best, re-lived with exact frames for the viewer (deterministic: same life)
    const [focus] = await pool.map<EpisodeResult>([this.job(genomes[bi], this.genSeed(gen, 0), { frames: true })]);
    if (this.abortFlag) throw new Error('aborted');
    atomicWrite(join(this.dir, 'gens', `${gen}.frames.json.gz`), gzipSync(JSON.stringify({ gen, fitness: focus.fitness, score: focus.score, death: focus.death, parts: focus.parts, lineage: lin[bi], frames: focus.frames, events: focus.events })));

    const T = this.ck.totals;
    const deaths: Record<Death, number> = { survived: 0, crash: 0, stall: 0 };
    let life = 0;
    let tips = 0;
    const choices: Record<string, number> = {};
    for (const r of res) {
      deaths[r.death]++;
      T.deaths[r.death]++;
      life += r.deathTick;
      tips += r.parts.tips;
      T.simSeconds += r.ticks / 60;
      const d = r.decisions ?? [];
      for (const q of d) choices[q[1]] = (choices[q[1]] ?? 0) + 1 / Math.max(1, d.length) / res.length;
    }
    const wall = (performance.now() - t0) / 1000;
    T.spawned += res.length;
    T.matches += res.length;
    T.wallSeconds += wall;

    let newBest = false;
    if (!this.ck.bestEver || bf > this.ck.bestEver.fitness) {
      newBest = true;
      const first = res[bi * c.episodes];
      this.ck.bestEver = { fitness: bf, score: score[bi], gen, genome: genomes[bi], parts: first.parts, id: lin[bi].id };
      const [rec] = await pool.map<EpisodeResult>([this.job(genomes[bi], this.genSeed(gen, 0), { record: true })]);
      if (this.abortFlag) throw new Error('aborted');
      if (rec.replay) {
        exportReplay(join(this.dir, 'best'), rec.replay as Replay, {
          title: `${c.name} best ever (gen ${gen})`,
          profile: `${c.profile}${c.sampleProfile ? ' (sampled robot)' : ''}, ${c.driver} driver`,
          score: rec.score,
          replayExact: rec.replayExact ?? false,
        });
      }
      copyFileSync(join(this.dir, 'gens', `${gen}.frames.json.gz`), join(this.dir, 'best.frames.json.gz'));
      this.emit('best', this.ck.bestEver);
    }

    // generation file for the viewer: every robot's path and choices, best first, with lineage
    const indiv = order.map(([f, i]) => {
      const r = res[i * c.episodes];
      return { i, ...lin[i], fitness: f, score: score[i], death: r.death, deathTick: r.deathTick, track: r.track, events: r.events, decisions: r.decisions, point: r.point, parts: r.parts };
    });
    atomicWrite(join(this.dir, 'gens', `${gen}.json`), JSON.stringify({ gen, stage: this.ck.stage, individuals: indiv }));
    this.pruneGens(gen);

    const sorted = [...fit].sort((a, b) => a - b);
    const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    const ops: Record<string, number> = {};
    let muts = 0;
    for (const l of lin) {
      ops[l.op] = (ops[l.op] ?? 0) + 1;
      muts += l.muts;
    }
    const summary: GenSummary = {
      gen,
      stage: this.ck.stage,
      shaping: this.shaping(),
      best: bf,
      mean: fit.reduce((t, f) => t + f, 0) / fit.length,
      median: q(0.5),
      p90: q(0.9),
      bestScore: Math.max(...score),
      meanScore: score.reduce((t, s) => t + s, 0) / score.length,
      deaths,
      meanLifeS: life / res.length / 60,
      spawnedTotal: T.spawned,
      matchesTotal: T.matches,
      simHoursTotal: T.simSeconds / 3600,
      wallS: wall,
      robotsPerMin: (res.length / wall) * 60,
      bestEver: this.ck.bestEver!.fitness,
      bestEverScore: this.ck.bestEver!.score,
      newBest,
      ops,
      meanMuts: muts / lin.length,
      bestOp: lin[bi].op,
      choices,
      meanTips: tips / res.length,
    };

    // advance the algorithm, then the curriculum
    this.algo.tell(fit);
    if (this.ck.stage === 'auto' && c.stage === 'curriculum') {
      this.ck.autoHeld = summary.bestScore >= c.curriculum.autoScore ? this.ck.autoHeld + 1 : 0;
      const g = this.algo.gen;
      if ((g >= c.curriculum.minGens && this.ck.autoHeld >= c.curriculum.holdGens) || g >= c.curriculum.maxGens) {
        this.ck.stage = 'full';
        this.event(`curriculum: AUTO mastered (best AUTO score ≥ ${c.curriculum.autoScore} for ${this.ck.autoHeld} generations) — full matches from now on`);
      }
    }
    this.ck.algoState = this.algo.state();
    appendFileSync(join(this.dir, 'metrics.jsonl'), JSON.stringify(summary) + '\n');
    this.save();
    this.emit('generation', summary);
    if (c.ckEvery > 0 && this.algo.gen % c.ckEvery === 0) this.saveCheckpoint(`auto · gen ${this.algo.gen}`, true);
    for (const l of this.pendingCk.splice(0)) this.saveCheckpoint(l);
  }

  private save(): void {
    atomicWrite(join(this.dir, 'checkpoint.json'), JSON.stringify(this.ck));
    const b = this.ck.bestEver;
    atomicWrite(
      join(this.dir, 'summary.json'),
      JSON.stringify({ name: this.name, gen: this.gen, algo: this.ck.config.algo, pop: this.ck.config.pop, bestFitness: b?.fitness ?? null, bestScore: b?.score ?? null, updated: now() }),
    );
  }

  private pruneGens(gen: number): void {
    const keep = this.ck.config.keepGens;
    for (const f of readdirSync(join(this.dir, 'gens'))) {
      const g = Number(f.split('.')[0]);
      if (Number.isFinite(g) && g < gen - keep && g % 100 !== 0) rmSync(join(this.dir, 'gens', f));
    }
  }

  // ─────────────────────────────── checkpoints ───────────────────────────────
  listCheckpoints(): CheckpointMeta[] {
    const d = join(this.dir, 'checkpoints');
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith('.meta.json'))
      .map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')) as CheckpointMeta)
      .sort((a, b) => b.gen - a.gen || b.time.localeCompare(a.time));
  }
  private ckPath(id: string, part: 'meta' | 'state' | 'metrics'): string {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error('bad checkpoint id');
    return join(this.dir, 'checkpoints', `${id}.${part === 'meta' ? 'meta.json' : part === 'state' ? 'state.json.gz' : 'metrics.jsonl.gz'}`);
  }
  /** a named checkpoint now — or, mid-generation, right after it (a checkpoint is always between
   * generations, so it restores exactly) */
  checkpoint(label: string): CheckpointMeta | null {
    if (!this.busy) return this.saveCheckpoint(label);
    this.pendingCk.push(label);
    this.emit('log', `checkpoint "${label}" will be saved when this generation finishes`);
    return null;
  }
  /** snapshot the run as it is now (between generations) */
  saveCheckpoint(label: string, auto = false, pinned = false): CheckpointMeta {
    const id = `g${this.gen}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const c = this.ck.config;
    const meta: CheckpointMeta = {
      id,
      gen: this.gen,
      label: label.slice(0, 80) || `gen ${this.gen}`,
      auto,
      pinned,
      time: now(),
      bestFitness: this.ck.bestEver?.fitness ?? null,
      bestScore: this.ck.bestEver?.score ?? null,
      config: { algo: c.algo, pop: c.pop, sigma: c.sigma, lr: c.lr, elite: c.elite, crossRate: c.crossRate, mutProb: c.mutProb },
    };
    const m = join(this.dir, 'metrics.jsonl');
    atomicWrite(this.ckPath(id, 'state'), gzipSync(JSON.stringify(this.ck)));
    atomicWrite(this.ckPath(id, 'metrics'), gzipSync(existsSync(m) ? readFileSync(m) : Buffer.alloc(0)));
    const bestFrames = join(this.dir, 'best.frames.json.gz');
    if (existsSync(bestFrames)) copyFileSync(bestFrames, join(this.dir, 'checkpoints', `${id}.best.frames.json.gz`));
    atomicWrite(this.ckPath(id, 'meta'), JSON.stringify(meta));
    if (auto) this.pruneCheckpoints();
    this.emit('checkpoints');
    if (!auto) this.event(`checkpoint saved: "${meta.label}" at generation ${meta.gen}`);
    return meta;
  }
  private pruneCheckpoints(): void {
    const autos = this.listCheckpoints().filter((m) => m.auto && !m.pinned);
    for (const m of autos.slice(this.ck.config.ckKeep)) this.deleteCheckpoint(m.id, true);
  }
  deleteCheckpoint(id: string, quiet = false): void {
    const m = this.listCheckpoints().find((q) => q.id === id);
    if (!m) throw new Error('no such checkpoint');
    for (const f of readdirSync(join(this.dir, 'checkpoints'))) if (f.startsWith(`${id}.`)) rmSync(join(this.dir, 'checkpoints', f));
    this.emit('checkpoints');
    if (!quiet) this.event(`checkpoint deleted: "${m.label}"`);
  }
  pinCheckpoint(id: string, pinned: boolean): void {
    const p = this.ckPath(id, 'meta');
    if (!existsSync(p)) throw new Error('no such checkpoint');
    const m = JSON.parse(readFileSync(p, 'utf8')) as CheckpointMeta;
    m.pinned = pinned;
    atomicWrite(p, JSON.stringify(m));
    this.emit('checkpoints');
  }
  private loadCheckpoint(id: string): { ck: Checkpoint; metrics: Buffer; meta: CheckpointMeta } {
    const mp = this.ckPath(id, 'meta');
    if (!existsSync(mp)) throw new Error('no such checkpoint');
    return {
      meta: JSON.parse(readFileSync(mp, 'utf8')) as CheckpointMeta,
      ck: JSON.parse(gunzipSync(readFileSync(this.ckPath(id, 'state'))).toString('utf8')) as Checkpoint,
      metrics: gunzipSync(readFileSync(this.ckPath(id, 'metrics'))),
    };
  }

  /** go back to a checkpoint. The present is saved first as a checkpoint ("before rewind"), so a
   * rewind can itself be undone. Generations after the checkpoint are removed from this run. */
  async rewind(id: string): Promise<CheckpointMeta> {
    await this.halt(true); // a generation in progress belongs to the timeline being left
    const { ck, metrics, meta } = this.loadCheckpoint(id);
    const undo = this.saveCheckpoint(`before rewind to gen ${meta.gen}`, false, true);
    this.ck = ck;
    this.algo = makeAlgo({ ...ck.config }, SHAPE, ck.algoState);
    atomicWrite(join(this.dir, 'metrics.jsonl'), metrics);
    for (const f of readdirSync(join(this.dir, 'gens'))) {
      const g = Number(f.split('.')[0]);
      if (Number.isFinite(g) && g >= meta.gen) rmSync(join(this.dir, 'gens', f));
    }
    const bf = join(this.dir, 'checkpoints', `${id}.best.frames.json.gz`);
    if (existsSync(bf)) copyFileSync(bf, join(this.dir, 'best.frames.json.gz'));
    else rmSync(join(this.dir, 'best.frames.json.gz'), { force: true });
    this.save();
    this.event(`rewound to "${meta.label}" (generation ${meta.gen}); the present was kept as checkpoint "${undo.label}"`);
    this.emit('reset');
    this.emit('state');
    return meta;
  }

  /** a NEW run that starts from a checkpoint (or from now), optionally with changed settings */
  fork(id: string | 'now', name: string, overrides: Partial<RunConfig> = {}): string {
    if (!NAME_RE.test(name)) throw new Error('run names use letters, digits, - and _ (up to 48)');
    const dir = join(RUNS, name);
    if (existsSync(dir)) throw new Error(`run "${name}" already exists`);
    const src = id === 'now' ? { ck: structuredClone(this.ck), metrics: existsSync(join(this.dir, 'metrics.jsonl')) ? readFileSync(join(this.dir, 'metrics.jsonl')) : Buffer.alloc(0) } : this.loadCheckpoint(id);
    const ck = src.ck;
    const cfg = { ...ck.config, ...pickLive(overrides), name };
    const err = validate(cfg);
    if (err) throw new Error(err);
    if (cfg.algo !== ck.config.algo) throw new Error('a fork keeps its algorithm (start a new run to change it)');
    ck.config = cfg;
    mkdirSync(join(dir, 'gens'), { recursive: true });
    mkdirSync(join(dir, 'checkpoints'), { recursive: true });
    atomicWrite(join(dir, 'checkpoint.json'), JSON.stringify(ck));
    atomicWrite(join(dir, 'metrics.jsonl'), src.metrics);
    const e = Engine.open(name);
    e.event(`forked from "${this.name}" at generation ${e.gen}${Object.keys(overrides).length ? ` with ${JSON.stringify(pickLive(overrides))}` : ''}`);
    e.save();
    e.saveCheckpoint('fork start', false, true);
    return name;
  }

  // ─────────────────────────────── hyperparameters ───────────────────────────────
  /** change settings between generations; returns the applied change */
  setConfig(change: Partial<RunConfig>): Partial<RunConfig> {
    const fixed = Object.keys(change).filter((k) => !(LIVE_KEYS as readonly string[]).includes(k) && JSON.stringify((change as Record<string, unknown>)[k]) !== JSON.stringify((this.ck.config as unknown as Record<string, unknown>)[k]));
    if (fixed.length) throw new Error(`${fixed.join(', ')} ${fixed.length > 1 ? 'define' : 'defines'} the run and cannot change mid-run — fork it or start a new run`);
    const live = pickLive(change);
    const next = { ...this.ck.config, ...live };
    const err = validate(next) ?? checkRun(next);
    if (err) throw new Error(err);
    const diff: Partial<RunConfig> = {};
    for (const [k, v] of Object.entries(live)) if (JSON.stringify((this.ck.config as unknown as Record<string, unknown>)[k]) !== JSON.stringify(v)) (diff as Record<string, unknown>)[k] = v;
    if (!Object.keys(diff).length) return diff;
    this.ck.config = next;
    this.algo.setConfig(next);
    if (diff.stage && diff.stage !== 'curriculum') this.ck.stage = diff.stage;
    this.ck.algoState = this.algo.state();
    if (!this.busy) this.save(); // mid-generation the next checkpoint write carries it
    this.event(`settings changed: ${Object.entries(diff).map(([k, v]) => `${k} → ${JSON.stringify(v)}`).join(', ')}`);
    this.emit('state');
    return diff;
  }

  // ─────────────────────────────── evaluation ───────────────────────────────
  /** score a policy on n held-out seeds (full matches, no shaping). target: 'champion' |
   * 'current' | 'greedy' | 'imitation' | a checkpoint id (its champion). Runs between generations. */
  evaluate(target: string, n: number): Promise<EvalResult> {
    if (!(Number.isInteger(n) && n >= 1 && n <= 2000)) return Promise.reject(new Error('evaluate 1 to 2000 matches'));
    return new Promise((resolve, reject) => {
      this.evalQueue.push({ target, n, resolve, reject });
      this.emit('log', `evaluation queued: ${target} on ${n} held-out matches`);
      if (!this.loop) void this.drainEvals().finally(() => this.emit('state'));
    });
  }
  private genomeOf(target: string): { genome: string | null; label: string } {
    if (target === 'greedy') return { genome: null, label: 'greedy baseline (no learning)' };
    if (target === 'champion') {
      if (!this.ck.bestEver) throw new Error('no champion yet');
      return { genome: this.ck.bestEver.genome, label: `champion (gen ${this.ck.bestEver.gen})` };
    }
    if (target === 'current') return { genome: toB64(this.algo.current()), label: `current policy (gen ${this.gen})` };
    if (target === 'imitation') return { genome: imitationGenome(), label: 'imitation of your replays (no evolution)' };
    const { ck, meta } = this.loadCheckpoint(target);
    if (!ck.bestEver) throw new Error('that checkpoint has no champion yet');
    return { genome: ck.bestEver.genome, label: `champion at checkpoint "${meta.label}"` };
  }
  private async drainEvals(): Promise<void> {
    while (this.evalQueue.length) {
      const q = this.evalQueue.shift()!;
      try {
        const { genome, label } = this.genomeOf(q.target);
        this.phase = 'evaluating';
        this.emit('state');
        const jobs = Array.from({ length: q.n }, (_, k) => this.job(genome, seedOf(EVAL_SEED, 'eval', k) % 1_000_000_007, { stage: 'full', shaping: 0 }));
        const pool = this.ensurePool();
        const res = await pool.map<EpisodeResult>(jobs, (done, total) => this.emit('progress', { gen: this.gen, done, total, eval: label }));
        const s = res.map((r) => r.score);
        const mean = s.reduce((a, b) => a + b, 0) / s.length;
        const sd = s.length > 1 ? Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / (s.length - 1)) : 0;
        const deaths: Record<Death, number> = { survived: 0, crash: 0, stall: 0 };
        for (const r of res) deaths[r.death]++;
        const out: EvalResult = {
          id: `e${Date.now().toString(36)}`,
          target: label,
          gen: this.gen,
          n: s.length,
          scores: s,
          mean,
          sd,
          ci95: s.length > 1 ? (1.96 * sd) / Math.sqrt(s.length) : 0,
          min: Math.min(...s),
          max: Math.max(...s),
          tips: res.reduce((a, r) => a + r.parts.tips, 0) / res.length,
          deaths,
          time: now(),
        };
        appendFileSync(join(this.dir, 'evals.jsonl'), JSON.stringify(out) + '\n');
        this.event(`evaluated ${label}: mean ${mean.toFixed(1)} ± ${out.ci95.toFixed(1)} (95% CI) over ${s.length} matches, ${out.tips.toFixed(1)} tips`);
        this.emit('eval', out);
        q.resolve(out);
      } catch (e) {
        q.reject(e as Error);
        this.emit('log', `evaluation failed: ${(e as Error).message}`);
      } finally {
        this.phase = this.loop ? 'generation' : 'idle';
        if (!this.loop) {
          this.pool?.close();
          this.pool = null;
        }
      }
    }
  }

  /** the population's current genomes (for export) */
  currentGenome(): string {
    return toB64(this.algo.current());
  }
}

function pickLive(c: Partial<RunConfig>): Partial<RunConfig> {
  const out: Partial<RunConfig> = {};
  for (const k of LIVE_KEYS) if (k in c) (out as Record<string, unknown>)[k] = (c as Record<string, unknown>)[k];
  return out;
}
function checkRun(c: RunConfig): string | null {
  if (!Number.isInteger(c.workers) || c.workers < 1 || c.workers > 64) return 'workers must be 1–64';
  if (!Number.isInteger(c.episodes) || c.episodes < 1 || c.episodes > 32) return 'matches per robot must be 1–32';
  if (!['auto', 'full', 'curriculum'].includes(c.stage)) return 'stage must be auto, full or curriculum';
  if (!['human', 'oracle'].includes(c.driver)) return 'driver must be human or oracle';
  if (!(c.annealGens >= 1)) return 'shaping fade must be ≥ 1 generation';
  for (const [k, v] of Object.entries({ ...c.shaping, ...c.penalty })) if (!(typeof v === 'number' && v >= 0 && v <= 1000)) return `${k} must be 0–1000`;
  if (!Number.isInteger(c.ckEvery) || c.ckEvery < 0) return 'checkpoint interval must be a whole number ≥ 0';
  if (!Number.isInteger(c.ckKeep) || c.ckKeep < 1) return 'automatic checkpoints kept must be ≥ 1';
  if (!Number.isInteger(c.keepGens) || c.keepGens < 10) return 'generations kept must be ≥ 10';
  if (!Number.isInteger(c.maxGens) || c.maxGens < 0) return 'generation limit must be a whole number ≥ 0';
  return null;
}

/** every run on disk (small summaries, newest first) */
export function listRuns(): { name: string; gen: number; algo: string; pop: number; bestFitness: number | null; bestScore: number | null; updated: string; legacy?: boolean }[] {
  if (!existsSync(RUNS)) return [];
  return readdirSync(RUNS)
    .filter((n) => NAME_RE.test(n) && existsSync(join(RUNS, n, 'checkpoint.json')))
    .map((n) => {
      const s = join(RUNS, n, 'summary.json');
      if (existsSync(s)) return JSON.parse(readFileSync(s, 'utf8'));
      const ck = JSON.parse(readFileSync(join(RUNS, n, 'checkpoint.json'), 'utf8')) as Checkpoint;
      return { name: n, gen: (ck.algoState as { gen?: number }).gen ?? 0, algo: ck.config.algo, pop: ck.config.pop, bestFitness: ck.bestEver?.fitness ?? null, bestScore: ck.bestEver?.score ?? null, updated: '', legacy: ck.version !== CK_VERSION };
    })
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

/** delete a whole run (the viewer asks for the name typed back) */
export function deleteRun(name: string): void {
  if (!NAME_RE.test(name) || !existsSync(join(RUNS, name, 'checkpoint.json'))) throw new Error(`no run called "${name}"`);
  rmSync(join(RUNS, name), { recursive: true, force: true });
}
