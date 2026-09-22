// THE TRAINING ENGINE — generation after generation, with no built-in end: it runs until someone
// stops it, checkpoints atomically every generation, and resumes bit-exactly (train/check.ts).
// It emits events for the dashboard and the viewer; it never needs Claude to run.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerPool, type Job } from '../harness/pool';
import { seedOf } from '../harness/rng';
import { exportReplay } from '../harness/export';
import type { Replay } from '../harness/dsim';
import { DEFAULTS, makeAlgo, type Algo, type AlgoName } from './algos';
import { toB64 } from './net';
import { SHAPE } from './policy';
import type { Death, EpisodeArgs, EpisodeResult, Stage } from './episode';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface RunConfig {
  name: string;
  algo: AlgoName;
  pop: number;
  seed: number;
  sigma: number;
  lr: number;
  elite: number;
  truncation: number;
  weightDecay: number;
  profile: string;
  sampleProfile: boolean;
  driver: 'human' | 'oracle';
  episodes: number; // matches per individual per generation (common seeds across the population)
  /** 'curriculum' = AUTO-only episodes until mastered, then full matches */
  stage: Stage | 'curriculum';
  curriculum: { autoScore: number; holdGens: number; minGens: number; maxGens: number };
  annealGens: number; // shaping falls linearly to 0 over this many generations
  workers: number;
  keepGens: number; // generation files kept on disk (every 100th is kept forever)
  maxGens: number; // 0 = no limit
}

export function defaultConfig(name: string, algo: AlgoName = 'es'): RunConfig {
  return {
    name,
    ...DEFAULTS[algo],
    algo,
    pop: algo === 'es' ? 256 : 256,
    seed: 1,
    profile: 'profiles/real-v0.json',
    sampleProfile: true,
    driver: 'human',
    episodes: 1,
    stage: 'curriculum',
    curriculum: { autoScore: 28, holdGens: 20, minGens: 30, maxGens: 3000 },
    annealGens: 3000,
    workers: 8,
    keepGens: 300,
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
}

interface Checkpoint {
  config: RunConfig;
  algoState: object;
  stage: Stage;
  autoHeld: number; // consecutive gens at/above the curriculum AUTO score
  totals: { spawned: number; matches: number; simSeconds: number; wallSeconds: number; deaths: Record<Death, number> };
  bestEver: { fitness: number; score: number; gen: number; genome: string; parts: EpisodeResult['parts'] } | null;
}

export class Engine extends EventEmitter {
  readonly dir: string;
  private algo: Algo;
  private ck: Checkpoint;
  private pool: WorkerPool | null = null;
  private stopFlag = false;
  paused = false;
  running = false;

  constructor(readonly cfg: RunConfig, resume = true) {
    super();
    this.dir = join(ROOT, 'runs', cfg.name);
    mkdirSync(join(this.dir, 'gens'), { recursive: true });
    const ckPath = join(this.dir, 'checkpoint.json');
    if (resume && existsSync(ckPath)) {
      this.ck = JSON.parse(readFileSync(ckPath, 'utf8')) as Checkpoint;
      // the run's defining settings come from the checkpoint; only workers/maxGens may change
      this.ck.config = { ...this.ck.config, workers: cfg.workers, maxGens: cfg.maxGens };
      this.algo = makeAlgo({ ...this.ck.config }, SHAPE, this.ck.algoState);
    } else {
      this.ck = {
        config: cfg,
        algoState: {},
        stage: cfg.stage === 'full' ? 'full' : 'auto',
        autoHeld: 0,
        totals: { spawned: 0, matches: 0, simSeconds: 0, wallSeconds: 0, deaths: { survived: 0, crash: 0, stall: 0 } },
        bestEver: null,
      };
      this.algo = makeAlgo(cfg, SHAPE);
      this.ck.algoState = this.algo.state();
    }
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
  get bestEver(): Checkpoint['bestEver'] {
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

  stop(): void {
    this.stopFlag = true;
    this.emit('log', 'stop requested — finishing this generation, then checkpointing');
  }

  private shaping(): number {
    return Math.max(0, 1 - this.algo.gen / Math.max(1, this.ck.config.annealGens));
  }

  private episodeArgs(genome: Float32Array, gen: number, e: number, track: boolean, record = false): Job {
    const c = this.ck.config;
    const args: EpisodeArgs = {
      genome: toB64(genome),
      profile: c.profile,
      sampleProfile: c.sampleProfile,
      seed: seedOf(c.seed, 'episode', gen, e) % 1_000_000_007, // common random numbers across the generation
      stage: this.ck.stage,
      shaping: this.shaping(),
      driver: c.driver,
      track,
      record,
    };
    return { module: '../train/episode.ts', fn: 'runEpisode', args };
  }

  /** run until stopped (or maxGens); resolves after the final checkpoint */
  async run(): Promise<void> {
    const c = this.ck.config;
    this.running = true;
    this.pool = new WorkerPool(c.workers);
    try {
      while (!this.stopFlag && (c.maxGens === 0 || this.algo.gen < c.maxGens)) {
        while (this.paused && !this.stopFlag) await new Promise((r) => setTimeout(r, 200));
        if (this.stopFlag) break;
        await this.generation();
      }
    } finally {
      this.pool.close();
      this.pool = null;
      this.running = false;
      this.emit('stopped');
    }
  }

  private async generation(): Promise<void> {
    const c = this.ck.config;
    const gen = this.algo.gen;
    const t0 = performance.now();
    const cand = this.algo.ask();
    const jobs: Job[] = [];
    for (let i = 0; i < cand.length; i++) for (let e = 0; e < c.episodes; e++) jobs.push(this.episodeArgs(cand[i], gen, e, e === 0));
    this.emit('progress', { gen, done: 0, total: jobs.length });
    const res = await this.pool!.map<EpisodeResult>(jobs, (done, total) => this.emit('progress', { gen, done, total }));
    const fit: number[] = [];
    const score: number[] = [];
    for (let i = 0; i < cand.length; i++) {
      const rs = res.slice(i * c.episodes, (i + 1) * c.episodes);
      fit.push(rs.reduce((t, r) => t + r.fitness, 0) / rs.length);
      score.push(rs.reduce((t, r) => t + r.score, 0) / rs.length);
    }
    const wall = (performance.now() - t0) / 1000;

    // totals — every episode is one robot's life
    const T = this.ck.totals;
    const deaths: Record<Death, number> = { survived: 0, crash: 0, stall: 0 };
    let life = 0;
    for (const r of res) {
      deaths[r.death]++;
      T.deaths[r.death]++;
      life += r.deathTick;
      T.simSeconds += r.ticks / 60;
    }
    T.spawned += res.length;
    T.matches += res.length;
    T.wallSeconds += wall;

    // best ever (re-recorded as a DSIM replay for the showcase)
    const order = fit.map((f, i) => [f, i] as const).sort((a, b) => b[0] - a[0]);
    const [bf, bi] = order[0];
    let newBest = false;
    if (!this.ck.bestEver || bf > this.ck.bestEver.fitness) {
      newBest = true;
      const first = res[bi * c.episodes];
      this.ck.bestEver = { fitness: bf, score: score[bi], gen, genome: toB64(cand[bi]), parts: first.parts };
      const [rec] = await this.pool!.map<EpisodeResult>([this.episodeArgs(cand[bi], gen, 0, false, true)]);
      if (rec.replay) {
        exportReplay(join(this.dir, 'best'), rec.replay as Replay, {
          title: `${c.name} best ever (gen ${gen})`,
          profile: `${c.profile}${c.sampleProfile ? ' (sampled robot)' : ''}, ${c.driver} driver`,
          score: rec.score,
          replayExact: rec.replayExact ?? false,
        });
      }
      this.emit('best', this.ck.bestEver);
    }

    // generation file for the viewer: every robot's path, sorted best-first
    const indiv = order.map(([f, i]) => {
      const r = res[i * c.episodes];
      return { i, fitness: f, score: score[i], death: r.death, deathTick: r.deathTick, track: r.track, events: r.events, point: r.point };
    });
    writeFileSync(join(this.dir, 'gens', `${gen}.json`), JSON.stringify({ gen, stage: this.ck.stage, individuals: indiv }));
    this.pruneGens(gen);

    const sorted = [...fit].sort((a, b) => a - b);
    const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
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
    };

    // advance the algorithm, then the curriculum
    this.algo.tell(fit);
    if (this.ck.stage === 'auto' && c.stage === 'curriculum') {
      this.ck.autoHeld = summary.bestScore >= c.curriculum.autoScore ? this.ck.autoHeld + 1 : 0;
      const g = this.algo.gen;
      if ((g >= c.curriculum.minGens && this.ck.autoHeld >= c.curriculum.holdGens) || g >= c.curriculum.maxGens) {
        this.ck.stage = 'full';
        this.emit('log', `curriculum: AUTO mastered (best AUTO score ≥ ${c.curriculum.autoScore} for ${this.ck.autoHeld} generations) — full matches from generation ${g}`);
      }
    }
    this.ck.algoState = this.algo.state();
    this.save();
    appendFileSync(join(this.dir, 'metrics.jsonl'), JSON.stringify(summary) + '\n');
    this.emit('generation', summary);
  }

  private save(): void {
    const p = join(this.dir, 'checkpoint.json');
    writeFileSync(p + '.tmp', JSON.stringify(this.ck));
    renameSync(p + '.tmp', p); // atomic: a crash never leaves a half-written checkpoint
  }

  private pruneGens(gen: number): void {
    const keep = this.ck.config.keepGens;
    for (const f of readdirSync(join(this.dir, 'gens'))) {
      const g = Number(f.replace('.json', ''));
      if (Number.isFinite(g) && g < gen - keep && g % 100 !== 0) rmSync(join(this.dir, 'gens', f));
    }
  }
}
