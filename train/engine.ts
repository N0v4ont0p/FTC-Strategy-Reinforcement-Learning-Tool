// THE TRAINING ENGINE — one run: generation after generation with no built-in end, checkpointed
// atomically every generation, with the controls of a real training stack: pause / resume / stop /
// abort a generation / step N generations; named and automatic CHECKPOINTS you can pin, rename,
// REWIND to, FORK into a new run or delete; settings changed between generations or all at once
// from a PRESET; EVALUATIONS of any policy on held-out matches.
//
// HOW THE ROBOT LEARNS — every generation:
//   1. COLLECT: the champion plays `collect` matches. At its decisions (every job start, a share
//      of the quarter-second re-thinks) the match is copied and EVERY option is played out on the
//      copies with the same fresh luck: the points each one made are a lesson (train/episode.ts).
//      Its matches also record what it scored from each moment on, for the rest-of-match predictor.
//   2. LEARN: a candidate network is trained on the lessons of the last `window` generations to
//      prefer options by their what-if points (train/learn.ts), the predictor is refitted
//      (train/value.ts), and CMA-ES proposes skill settings, each measured on matches against the
//      champion with identical luck (train/cma.ts).
//   3. RACE: the candidates race the champion on brand-new matches, both on the same ones. A
//      candidate takes over only when its lead passes a group-sequential test (Pocock) AND it is
//      not worse in its bad matches (the worst fifth). Nothing is ever crowned by luck.
//   4. EXAM: every new champion takes the same 64-match exam (fixed matches, the same for every
//      run) — alone and thinking ahead during the match (search) — next to the no-learning robot
//      on the same matches. That is the learning curve. The exam also re-checks determinism,
//      DSIM-verifies a replay, and measures the gap to the team's replays (train/gap.ts).
//
// THE REWARD everywhere is one number: DSIM's score minus the foul points of the rules DSIM does
// not enforce (train/episode.ts FOUL). No hints, no shaping.
import { EventEmitter } from 'node:events';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { availableParallelism } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { WorkerPool, type Job } from '../harness/pool';
import { seedOf } from '../harness/rng';
import { loadProfile, profileProblems } from '../harness/profiles';
import { exportReplay } from '../harness/export';
import type { Replay } from '../harness/dsim';
import { fromB64, styleOffset, toB64 } from './net';
import { SHAPE, STYLE } from './policy';
import { cmaAsk, cmaInit, cmaRecenter, cmaTell, type CmaState } from './cma';
import { DATA_DIR, currentKey, dataFiles, ensureData, ensureGreedy, ensureValue, hasSet } from './imitate';
import { gapRow, type GapRow, type Played } from './gap';
import type { Death, EpisodeArgs, EpisodeResult, Inspected, Mistakes, Parts } from './episode';
import type { FitJobArgs, FitJobResult, FitReport, LessonFile } from './learn';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RUNS = join(ROOT, 'runs');
export const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,47}$/;
const CORES = availableParallelism();

export interface RunConfig {
  name: string;
  seed: number;
  profile: string;
  sampleProfile: boolean; // a new robot from the profile's range every match
  driver: 'human' | 'oracle';
  workers: number;
  // 1. collect
  collect: number; // champion matches with lessons per generation
  thinkRate: number; // share of the quarter-second re-thinks that become lessons (every job start does)
  horizon: number; // seconds each option is played out (then the predictor counts the rest)
  rounds: number; // luck draws per lesson (successive halving: each round keeps the better half)
  // 2. learn
  window: number; // generations of lessons trained on
  epochs: number;
  lr: number;
  anchor: number; // pull toward the champion's weights
  demoWeight: number; // weight of your replays' decisions at generation 0 …
  demoFade: number; // … falling to 0 over this many generations
  cmaPop: number; // skill settings tried per generation (0 = skills are not tuned)
  cmaMatches: number; // matches each is measured on
  cmaSigma: number; // first step size (gene units)
  // 3. race
  raceMatches: number; // fresh matches per contender per generation
  // 4. exam
  examMatches: number;
  examEvery: number; // an exam at least every this many generations (0 = only for a new champion)
  searchExam: boolean; // also examine the champion thinking ahead during the match
  // housekeeping
  keepGens: number;
  ckEvery: number;
  ckKeep: number;
  maxGens: number;
  preset: string;
}
/** what defines a run (fixed); everything else can change between generations */
const FIXED_KEYS = ['name', 'seed', 'profile', 'sampleProfile'] as const;
export const LIVE_KEYS = ['driver', 'workers', 'collect', 'thinkRate', 'horizon', 'rounds', 'window', 'epochs', 'lr', 'anchor', 'demoWeight', 'demoFade', 'cmaPop', 'cmaMatches', 'cmaSigma', 'raceMatches', 'examMatches', 'examEvery', 'searchExam', 'keepGens', 'ckEvery', 'ckKeep', 'maxGens', 'preset'] as const;

/** look-ahead during a match (the champion as a player): at each job start its network's best 3
 * options are played 10 s ahead under 2 luck draws, and it switches only for more than 3 points.
 * Measured on the no-learning robot over 18 paired matches: +40 ± 19 points (every option 15 s
 * ahead: +46 ± 25 at 2.3× the cost; searching every quarter-second re-think made it WORSE, −26:
 * noisy estimates flipped jobs back and forth) */
export const SEARCH = { k: 3, horizon: 600, rounds: 2, thinkEvery: 1_000_000, margin: 3 };
/** the exam: the same matches for every run */
const EXAM_SEED = 424_242;
/** a lesson's what-if play-outs */
const RETURNS_EVERY = 30;
const TRACKED = 16; // collected matches with a swarm track
/** Pocock boundary (one-sided α = 0.05 over ~10 looks, rounded up): a contender is promoted only
 * when its accumulated paired lead crosses it; looking every generation keeps a false promotion
 * near 5 % per contender */
export const Z_PROMOTE = 2.3;
export const Z_DROP = 1.645;
export const RACE_MAX = 96;
export const ARENA = 3;
/** reliability: the contender's worst fifth of matches may be at most this much below the
 * champion's worst fifth on the same matches */
const TAIL_TOL = 5;
/** IPOP-CMA-ES (Auger & Hansen 2005): when the skill search's step size has collapsed it is stuck —
 * restart it from the champion's settings with twice the population */
const CMA_STUCK_SIGMA = 0.03;
const LESSON_KEEP = 20;

// ─────────────────────────────── presets ───────────────────────────────
const BALANCED = {
  workers: Math.max(1, CORES - 1),
  collect: 20,
  thinkRate: 0.05,
  horizon: 15,
  rounds: 2,
  window: 4,
  epochs: 60,
  lr: 0.002,
  anchor: 0.001,
  demoWeight: 0, // measured: the network fitted to the replays raced the no-learning network at −12.5 ± 20.7 (their build is not REAL-v0); on demand: preset "Lean on my replays"
  demoFade: 10,
  cmaPop: 12,
  cmaMatches: 6,
  cmaSigma: 0.5,
  raceMatches: 12,
  examMatches: 64,
  examEvery: 10,
  searchExam: true,
};
export interface Preset {
  id: string;
  label: string;
  blurb: string;
  change: Partial<RunConfig>;
}
export const PRESETS: Preset[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    blurb: 'The default. 20 matches of lessons per generation (every option played out 15 s at every job start, 2 luck draws), 12 skill settings tried, a new champion must win over fresh matches, a 64-match exam for every new champion. All cores but one.',
    change: { ...BALANCED },
  },
  {
    id: 'full-push',
    label: 'Full push',
    blurb: 'The most learning per hour, the Mac fully busy. 40 matches of lessons per generation, 6 generations of lessons remembered, 16 skill settings on 8 matches each, 24 fresh race matches. Every core.',
    change: { ...BALANCED, workers: CORES, collect: 40, window: 6, cmaPop: 16, cmaMatches: 8, raceMatches: 24 },
  },
  {
    id: 'replays',
    label: 'Lean on my replays',
    blurb: 'Your replays\' decisions are mixed into what every candidate learns, as much as the robot\'s own lessons at first, fading out over 30 generations. Off by default: your replays drove a different robot, and a network fitted to them alone lost to the no-learning robot (−12.5 over 24 matches). The race still decides.',
    change: { ...BALANCED, demoWeight: 1, demoFade: 30 },
  },
  {
    id: 'quick',
    label: 'Quick look',
    blurb: '6 matches of lessons, 8 s play-outs, a 16-match exam without look-ahead. For watching and testing settings; not for real results.',
    change: { ...BALANCED, collect: 6, horizon: 8, rounds: 1, window: 2, cmaPop: 6, cmaMatches: 3, raceMatches: 6, examMatches: 16, examEvery: 5, searchExam: false },
  },
  {
    id: 'background',
    label: 'Background',
    blurb: 'Keeps the Mac usable: half the cores, 10 matches of lessons per generation.',
    change: { ...BALANCED, workers: Math.max(1, Math.floor(CORES / 2)), collect: 10, cmaPop: 8 },
  },
];

export function defaultConfig(name: string): RunConfig {
  const c: RunConfig = { name, seed: 1, profile: 'profiles/real-v0.json', sampleProfile: true, driver: 'oracle', ...BALANCED, keepGens: 60, ckEvery: 5, ckKeep: 30, maxGens: 0, preset: '' };
  c.preset = presetOf(c);
  return c;
}

// ─────────────────────────────── records ───────────────────────────────
/** where a robot came from */
export interface Lineage {
  id: number;
  op: 'baseline' | 'replays' | 'lessons' | 'skills' | 'champion';
  parents: number[];
  muts: number;
  born: number;
}
/** running sums of rewards on fresh matches */
export interface Conf {
  n: number;
  sum: number;
  sumSq: number;
}
export function confStats(c: Conf): { score: number; ci95: number; n: number } {
  const m = c.sum / Math.max(1, c.n);
  const v = c.n > 1 ? Math.max(0, (c.sumSq - c.n * m * m) / (c.n - 1)) : 0;
  return { score: m, ci95: c.n > 1 ? (1.96 * Math.sqrt(v)) / Math.sqrt(c.n) : 0, n: c.n };
}
const addConf = (c: Conf | null, rs: number[]): Conf => {
  const o = c ? { ...c } : { n: 0, sum: 0, sumSq: 0 };
  for (const r of rs) {
    o.n++;
    o.sum += r;
    o.sumSq += r * r;
  }
  return o;
};
export interface MeanCi {
  mean: number;
  ci95: number;
  n: number;
}
export const meanCi = (v: number[]): MeanCi => {
  const n = v.length;
  const mean = v.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { mean, ci95: n > 1 ? (1.96 * sd) / Math.sqrt(n) : 0, n };
};
/** mean of the worst fifth */
const tail = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const k = Math.max(1, Math.floor(s.length / 5));
  return s.slice(0, k).reduce((a, b) => a + b, 0) / k;
};

export interface ExamResult {
  gen: number;
  time: string;
  hours: number; // training hours when it was taken
  champ: number;
  champOp: string;
  net: MeanCi & { tips: number }; // the champion's network alone
  vsBase: MeanCi; // paired, against the no-learning robot on the same matches
  search: (MeanCi & { vsNet: MeanCi; vsBase: MeanCi; changed: number }) | null; // thinking ahead during the match
  mistakes: Mistakes; // per match, the network alone
  gap: GapRow[]; // you on your replays · the champion on your build, same matches · the champion on REAL-v0
  checks: { deterministic: boolean; dsim: { ok: boolean; exact: boolean; detail: string } | null };
}

export interface ArenaEntry {
  id: number;
  genome: string;
  lineage: Lineage;
  since: number;
  pairs: [number, number][]; // (its reward, the champion's) on the same fresh matches
  fit?: FitReport;
}
export interface Champ {
  id: number;
  genome: string;
  lineage: Lineage;
  born: number;
  conf: Conf | null; // its rewards on fresh race matches
  exam: ExamResult | null;
  parts: Parts | null; // its showcase match
}

export interface GenSummary {
  gen: number;
  time: string;
  hours: number;
  wallS: number;
  phases: { collect: number; learn: number; race: number; exam: number };
  matchesTotal: number;
  simHoursTotal: number;
  lessonsTotal: number;
  // the champion's own play this generation (the collected matches)
  meanScore: number;
  bestScore: number;
  meanReward: number;
  deaths: Record<Death, number>;
  meanTips: number;
  mistakes: Mistakes; // per match
  choices: Record<string, number>; // share of job decisions per option kind
  lessons: number;
  regret: number; // points the champion's choice lost to the best what-if, per lesson decision
  fit: FitReport | null;
  value: { rmse: number; startRmse: number; samples: number } | null;
  cma: { gen: number; sigma: number; best: number; mean: number; entered: boolean } | null;
  arena: { id: number; op: string; n: number; diff: number; se: number; z: number }[];
  confirm: { id: number; op: string; diff: number; se: number; n: number; promoted: boolean } | null;
  champId: number;
  champOp: string;
  champScore: number; // running mean reward on fresh race matches
  champCi: number;
  champN: number;
  newChamp: boolean;
  exam: ExamResult | null;
  matchesPerMin: number;
}

export interface CheckpointMeta {
  id: string;
  gen: number;
  label: string;
  auto: boolean;
  pinned: boolean;
  time: string;
  champScore: number | null;
  exam: number | null; // the champion's exam score then
  config: { preset?: string; collect: number; horizon: number };
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

/** 6 = the alliance skills (partners, the Box Tube's place option: a network sees one more option
 * kind); 5 = learning from every decision (what-if lessons, predictor, CMA-ES skills, racing, exam) */
export const CK_VERSION = 6;
const LEGACY: Record<number, string> = {
  1: 'made by the first training version (a raw joystick policy)',
  2: 'made before the group-intake skills',
  3: 'made before the robots learned to think on the go',
  4: 'made by the evolution trainer (replaced by learning from every decision)',
  5: 'made before the alliance skills (its network was built for a shorter list of options)',
};

interface Checkpoint {
  version: number;
  config: RunConfig;
  gen: number;
  nextId: number;
  champion: Champ;
  value: string | null;
  arena: ArenaEntry[];
  cma: CmaState | null;
  cmaRestarts?: number; // IPOP: each restart doubles the skill settings tried
  totals: { matches: number; simSeconds: number; wallSeconds: number; lessons: number; deaths: Record<Death, number> };
  demoKey: string;
  baseExam: number[] | null; // the no-learning robot's exam rewards, match by match
  lastGenAt: string | null;
}

const EVAL_SEED = 777_000;
const now = (): string => new Date().toISOString();
const seed7 = (...p: (number | string)[]): number => seedOf(...p) % 1_000_000_007;
function atomicWrite(p: string, data: string | Buffer): void {
  writeFileSync(p + '.tmp', data);
  renameSync(p + '.tmp', p); // a crash never leaves a half-written file
}
const STYLE_AT = styleOffset(SHAPE);
const styleOf = (genome: string): number[] => Array.from(fromB64(genome).subarray(STYLE_AT, STYLE_AT + STYLE.length));
const withStyle = (genome: string, genes: number[]): string => {
  const p = fromB64(genome);
  p.set(genes, STYLE_AT);
  return toB64(p);
};
function diffStats(a: ArenaEntry): { mean: number; se: number } {
  const n = a.pairs.length;
  if (n < 2) return { mean: n ? a.pairs[0][0] - a.pairs[0][1] : 0, se: Infinity };
  const d = a.pairs.map(([x, y]) => x - y);
  const mean = d.reduce((s, v) => s + v, 0) / n;
  const v = d.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return { mean, se: Math.sqrt(v / n) };
}
export function zOf(a: ArenaEntry): number {
  const { mean, se } = diffStats(a);
  return se > 0 && Number.isFinite(se) ? mean / se : 0;
}
const emptyMistakes = (): Mistakes => ({ missedShots: 0, emptyTrips: 0, emptyTripS: 0, blockedShots: 0, blockedShotS: 0, idleS: 0, fouls: 0, regret: 0, regretN: 0, stalls: 0 });
function meanMistakes(rs: EpisodeResult[]): Mistakes {
  const m = emptyMistakes();
  for (const r of rs) for (const k of Object.keys(m) as (keyof Mistakes)[]) m[k] += r.mistakes[k] / Math.max(1, rs.length);
  return m;
}
const played = (r: EpisodeResult): Played => ({ points: r.score, parts: r.parts, activity: r.activity, loads: r.loads });

export class Engine extends EventEmitter {
  readonly dir: string;
  private ck: Checkpoint;
  private pool: WorkerPool | null = null;
  private stopFlag = false;
  private abortFlag = false;
  private keepFlag = false;
  private stepsLeft = -1;
  private evalQueue: { target: string; n: number; resolve: (r: EvalResult) => void; reject: (e: Error) => void }[] = [];
  private loop: Promise<void> | null = null;
  private busy = false;
  private pendingCk: string[] = [];
  private awake: ChildProcess | null = null;
  paused = false;
  running = false;
  private _phase: 'idle' | 'generation' | 'evaluating' | 'paused' = 'idle';
  get phase(): 'idle' | 'generation' | 'evaluating' | 'paused' {
    return this._phase;
  }
  set phase(p: 'idle' | 'generation' | 'evaluating' | 'paused') {
    if (p === this._phase) return;
    this._phase = p;
    this.emit('state');
  }

  static open(name: string): Engine {
    const dir = join(RUNS, name);
    if (!existsSync(join(dir, 'checkpoint.json'))) throw new Error(`no run called "${name}"`);
    const ck = JSON.parse(readFileSync(join(dir, 'checkpoint.json'), 'utf8')) as Checkpoint;
    const v = ck.version ?? 1;
    if (v !== CK_VERSION) throw new Error(`"${name}" was ${LEGACY[v] ?? `made by another version (${v})`}; it cannot continue. Its files are untouched; start a new run`);
    return new Engine(dir, ck);
  }

  /** create a new run (never overwrites one). The replays, the distilled no-learning network and
   * the starting predictor must be built (the studio does that in a worker) or are built here. */
  static create(cfg: RunConfig, log: (s: string) => void = () => {}): Engine {
    if (!NAME_RE.test(cfg.name)) throw new Error('run names use letters, digits, - and _ (up to 48)');
    const err = checkRun(cfg);
    if (err) throw new Error(err);
    const dir = join(RUNS, cfg.name);
    if (existsSync(join(dir, 'checkpoint.json'))) throw new Error(`run "${cfg.name}" already exists`);
    const data = ensureData(log);
    const greedy = ensureGreedy(log).genome;
    const value = ensureValue(log);
    const ck: Checkpoint = {
      version: CK_VERSION,
      config: cfg,
      gen: 0,
      nextId: 2,
      // the starting champion is the no-learning robot as a network (the bar); the network fitted
      // to your replays starts in the race against it
      champion: { id: 0, genome: greedy, lineage: { id: 0, op: 'baseline', parents: [], muts: 0, born: 0 }, born: 0, conf: null, exam: null, parts: null },
      value: value.genome,
      arena: data ? [{ id: 1, genome: data.report.genome, lineage: { id: 1, op: 'replays', parents: [], muts: 0, born: 0 }, since: 0, pairs: [] }] : [],
      cma: null,
      totals: { matches: 0, simSeconds: 0, wallSeconds: 0, lessons: 0, deaths: { survived: 0, crash: 0, stall: 0 } },
      demoKey: data?.key ?? '',
      baseExam: null,
      lastGenAt: null,
    };
    mkdirSync(join(dir, 'gens'), { recursive: true });
    mkdirSync(join(dir, 'checkpoints'), { recursive: true });
    mkdirSync(join(dir, 'lessons'), { recursive: true });
    const e = new Engine(dir, ck);
    e.save();
    e.event(`created: the champion starts as the no-learning robot (a network); ${data ? `the network fitted to your ${data.report.files.filter((f) => f.samples > 0).length} replays races it from generation 0` : 'no replays to race it'}; the rest-of-match predictor starts off by ${value.rmse.toFixed(0)} points`);
    e.saveCheckpoint('start', false, true);
    return e;
  }

  private constructor(dir: string, ck: Checkpoint) {
    super();
    this.dir = dir;
    this.ck = ck;
    for (const d of ['gens', 'checkpoints', 'lessons']) mkdirSync(join(dir, d), { recursive: true });
  }

  get name(): string {
    return this.ck.config.name;
  }
  get config(): RunConfig {
    return this.ck.config;
  }
  get gen(): number {
    return this.ck.gen;
  }
  get totals(): Checkpoint['totals'] {
    return this.ck.totals;
  }
  get champion(): Champ {
    return this.ck.champion;
  }
  get arena(): ArenaEntry[] {
    return this.ck.arena;
  }
  get lastGenAt(): string | null {
    return this.ck.lastGenAt;
  }
  get data(): { key: string; onDisk: boolean; latest: string } {
    return { key: this.ck.demoKey, onDisk: hasSet(this.ck.demoKey), latest: currentKey() };
  }

  private readLines<T>(f: string): T[] {
    const p = join(this.dir, f);
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
  }
  history(): GenSummary[] {
    return this.readLines<GenSummary>('metrics.jsonl');
  }
  events(): { time: string; gen: number; text: string }[] {
    return this.readLines('events.jsonl');
  }
  evals(): EvalResult[] {
    return this.readLines<EvalResult>('evals.jsonl');
  }
  exams(): ExamResult[] {
    return this.readLines<ExamResult>('exams.jsonl');
  }
  event(text: string): void {
    appendFileSync(join(this.dir, 'events.jsonl'), JSON.stringify({ time: now(), gen: this.gen, text }) + '\n');
    this.emit('log', text);
  }

  /** switch the replays used as demonstrations (the latest set by default) */
  useData(key = currentKey()): void {
    if (key && !hasSet(key)) throw new Error('that data set is not built yet — refresh the training data first');
    if (this.busy) {
      this.pendingData = key;
      this.emit('log', 'the refreshed training data is used from the next generation');
      return;
    }
    this.pendingData = null;
    if (key === this.ck.demoKey) return;
    this.ck.demoKey = key;
    this.save();
    this.event(key ? `your replays (the refreshed set) are used as demonstrations from generation ${this.gen}` : 'your replays are no longer used');
    this.emit('state');
  }
  private pendingData: string | null = null;

  // ─────────────────────────────── control ───────────────────────────────
  private flagPath(): string {
    return join(this.dir, '.training');
  }
  /** true when this run was training (not paused) when the studio last closed */
  get wasTraining(): boolean {
    return existsSync(this.flagPath());
  }
  private setFlag(on: boolean): void {
    if (on) writeFileSync(this.flagPath(), now());
    else rmSync(this.flagPath(), { force: true });
  }
  /** macOS: no idle or system sleep while training (released when training stops) */
  private stayAwake(on: boolean): void {
    if (process.platform !== 'darwin') return;
    if (on && !this.awake) {
      this.awake = spawn('caffeinate', ['-ims', '-w', String(process.pid)], { stdio: 'ignore' });
      this.awake.on('error', () => (this.awake = null));
    } else if (!on && this.awake) {
      this.awake.kill();
      this.awake = null;
    }
  }

  start(steps = -1): void {
    if (!this.loop) {
      const err = checkRun(this.ck.config);
      if (err) throw new Error(`cannot start training: ${err}`);
    }
    this.stepsLeft = steps;
    this.paused = false;
    this.stopFlag = false;
    this.keepFlag = false;
    this.setFlag(steps < 0);
    this.stayAwake(true);
    if (this.loop) {
      this.emit('state');
      return;
    }
    this.running = true;
    // an error ends the run, never the studio: without this catch the rejection is unhandled
    // and Node exits the whole process (the page just shows "reconnecting")
    this.loop = this.runLoop().catch((e: unknown) => {
      console.error(e);
      this.event(`training stopped by an error: ${e instanceof Error ? e.message : String(e)}`);
    }).finally(() => {
      this.loop = null;
      this.running = false;
      this.phase = 'idle';
      if (!this.keepFlag) this.setFlag(false);
      this.stayAwake(false);
      this.emit('stopped');
      this.emit('state');
    });
    this.emit('state');
  }
  pause(): void {
    this.paused = true;
    this.setFlag(false);
    this.stayAwake(false);
    this.emit('log', 'pausing after this generation');
    this.emit('state');
  }
  resume(): void {
    this.stepsLeft = -1;
    this.paused = false;
    this.setFlag(true);
    this.stayAwake(true);
    this.emit('state');
  }
  stop(): void {
    this.stopFlag = true;
    this.paused = false;
    this.emit('log', 'stop requested — finishing this generation, then checkpointing');
    this.emit('state');
  }
  abort(): void {
    this.stopFlag = true;
    this.paused = false;
    if (this.busy) {
      this.abortFlag = true;
      this.pool?.close();
      this.emit('log', 'generation aborted — nothing of it is kept; the run is exactly as it was before it started');
    }
    this.emit('state');
  }
  /** stop the loop. `keep`: the studio is closing, not the user stopping — training resumes by
   * itself the next time the studio starts */
  async halt(abort = false, keep = false): Promise<void> {
    if (!this.loop) return;
    this.keepFlag = keep && this.wasTraining;
    if (abort) this.abort();
    else this.stop();
    await this.loop;
  }

  private job(genome: string | null, seed: number, o: Partial<EpisodeArgs> = {}): Job {
    const c = this.ck.config;
    const args: EpisodeArgs = { genome, profile: c.profile, sampleProfile: c.sampleProfile, seed, stage: 'full', driver: c.driver, track: false, record: false, ...o };
    return { module: '../train/episode.ts', fn: 'runEpisode', args };
  }
  private ensurePool(): WorkerPool {
    if (!this.pool || this.pool.size !== this.ck.config.workers) {
      this.pool?.close();
      this.pool = new WorkerPool(this.ck.config.workers);
    }
    return this.pool;
  }
  private check(): void {
    if (this.abortFlag) throw new Error('aborted');
  }
  /** the latest progress (a page opened mid-phase shows it at once) */
  progress: { gen: number; done: number; total: number; stage?: string; eval?: string } | null = null;
  private async map<T>(jobs: Job[], stage: string): Promise<T[]> {
    const gen = this.gen;
    const tell = (done: number, total: number): void => {
      this.progress = { gen, done, total, stage };
      this.emit('progress', this.progress);
    };
    tell(0, jobs.length);
    const res = await this.ensurePool().map<T>(jobs, (done, total) => tell(done, total));
    if (this.abortFlag || res.length !== jobs.length || res.some((r) => !r)) throw new Error('aborted');
    return res;
  }
  private count(rs: EpisodeResult[]): void {
    const T = this.ck.totals;
    T.matches += rs.length;
    for (const r of rs) T.simSeconds += r.ticks / 60;
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
          this.setFlag(false);
          this.stayAwake(false);
          this.emit('log', 'step finished — paused');
          this.emit('state');
        }
        if (this.paused) {
          this.phase = 'paused';
          await new Promise((r) => setTimeout(r, 150));
          continue;
        }
        if (this.pendingData !== null) this.useData(this.pendingData);
        this.phase = 'generation';
        this.busy = true;
        const saved = JSON.stringify(this.ck);
        try {
          await this.generation();
        } catch (e) {
          if (!this.abortFlag) throw e;
          const { config } = this.ck;
          this.ck = JSON.parse(saved) as Checkpoint;
          this.ck.config = config;
        } finally {
          this.busy = false;
          if (this.abortFlag) {
            this.abortFlag = false;
            this.pool = null;
          }
        }
        if (this.stepsLeft > 0) this.stepsLeft--;
      }
    } finally {
      this.pool?.close();
      this.pool = null;
    }
  }

  // ─────────────────────────────── one generation ───────────────────────────────
  private async generation(): Promise<void> {
    const c = this.ck.config;
    const gen = this.ck.gen;
    const t0 = performance.now();
    const T = this.ck.totals;
    let ch = this.ck.champion;
    const phases = { collect: 0, learn: 0, race: 0, exam: 0 };
    let tp = performance.now();
    const lap = (k: keyof typeof phases): void => {
      phases[k] += (performance.now() - tp) / 1000;
      tp = performance.now();
    };

    // 0. the first generation: the no-learning robot's exam (the bar on the exam matches) and the
    //    starting champion's showcase
    if (!this.ck.baseExam || this.ck.baseExam.length !== c.examMatches) {
      const ex = Array.from({ length: c.examMatches }, (_, k) => this.job(null, seed7(EXAM_SEED, 'exam', k)));
      const rs = await this.map<EpisodeResult>(ex, 'exam');
      this.check();
      this.count(rs);
      this.ck.baseExam = rs.map((r) => r.reward);
      const s = meanCi(this.ck.baseExam);
      this.event(`exam: the no-learning robot scores ${s.mean.toFixed(1)} ± ${s.ci95.toFixed(1)} on the ${rs.length} exam matches — the bar`);
      lap('exam');
    }

    // 1. COLLECT — the champion's matches, with lessons at its decisions
    const L = { thinkRate: c.thinkRate, horizon: Math.round(60 * c.horizon), rounds: c.rounds };
    const cjobs = Array.from({ length: c.collect }, (_, k) => this.job(ch.genome, seed7(c.seed, 'collect', gen, k), { value: this.ck.value, lessons: L, returns: RETURNS_EVERY, track: k < TRACKED }));
    const col = await this.map<EpisodeResult>(cjobs, 'collecting lessons');
    this.check();
    this.count(col);
    const file: LessonFile = { gen, champ: ch.id, matches: col.map((r) => ({ lessons: r.lessons ?? null, values: r.values ?? null })) };
    atomicWrite(join(this.dir, 'lessons', `${gen}.json.gz`), gzipSync(JSON.stringify(file)));
    const nLessons = col.reduce((a, r) => a + (r.lessons?.n ?? 0), 0);
    T.lessons += nLessons;
    lap('collect');

    // 2. LEARN — the candidate network + predictor (one worker) while CMA-ES measures skill settings
    const fade = c.demoFade > 0 ? Math.max(0, 1 - gen / c.demoFade) : 0;
    const gens = this.lessonGens(gen);
    const fitArgs: FitJobArgs = { dir: this.dir, gens, start: ch.genome, value: this.ck.value, demoKey: this.ck.demoKey, opts: { epochs: c.epochs, lr: c.lr, anchor: c.anchor, demoWeight: c.demoWeight * fade, seed: seedOf(c.seed, 'fit', gen) }, valueEpochs: 30 };
    const learnJobs: Job[] = [{ module: '../train/learn.ts', fn: 'fitJob', args: fitArgs }];
    let cmaX: number[][] = [];
    const cmaSeeds = Array.from({ length: c.cmaMatches }, (_, k) => seed7(c.seed, 'cma', gen, k));
    if (c.cmaPop > 0) {
      const base = styleOf(ch.genome);
      if (!this.ck.cma || this.ck.cma.n !== base.length) this.ck.cma = cmaInit(base, c.cmaSigma, seedOf(c.seed, 'cma'));
      cmaX = cmaAsk(this.ck.cma, Math.min(64, Math.max(4, c.cmaPop) * 2 ** (this.ck.cmaRestarts ?? 0))).x;
      for (const s of cmaSeeds) learnJobs.push(this.job(ch.genome, s));
      for (const x of cmaX) for (const s of cmaSeeds) learnJobs.push(this.job(withStyle(ch.genome, x), s));
    }
    const lres = await this.map<unknown>(learnJobs, 'learning');
    this.check();
    const fit = lres[0] as FitJobResult;
    const cres = lres.slice(1) as EpisodeResult[];
    this.count(cres);
    this.ck.value = fit.value;
    const newId = (): number => this.ck.nextId++;
    const arena = this.ck.arena;
    const enter = (a: ArenaEntry): void => {
      if (arena.length >= ARENA) arena.splice(arena.reduce((w, q, k) => (zOf(q) < zOf(arena[w]) ? k : w), 0), 1);
      arena.push(a);
    };
    // a candidate network enters the race only if it picks better than the champion on lessons it never saw
    if (fit.report.regret < fit.report.startRegret) {
      const id = newId();
      enter({ id, genome: fit.genome, lineage: { id, op: 'lessons', parents: [ch.id], muts: 0, born: gen }, since: gen, pairs: [], fit: fit.report });
    }
    let cmaSum: GenSummary['cma'] = null;
    if (c.cmaPop > 0 && this.ck.cma) {
      const m = c.cmaMatches;
      const champR = cres.slice(0, m).map((r) => r.reward);
      const fitness = cmaX.map((_, i) => cres.slice(m * (i + 1), m * (i + 2)).reduce((a, r, k) => a + r.reward - champR[k], 0) / m);
      this.ck.cma = cmaTell(this.ck.cma, cmaX, fitness);
      if (this.ck.cma.sigma < CMA_STUCK_SIGMA) {
        this.ck.cmaRestarts = (this.ck.cmaRestarts ?? 0) + 1;
        this.ck.cma = cmaInit(styleOf(ch.genome), c.cmaSigma, seedOf(c.seed, 'cma', this.ck.cmaRestarts));
        this.event(`skill search restarted (IPOP): it had narrowed to nothing; ${Math.min(64, Math.max(4, c.cmaPop) * 2 ** this.ck.cmaRestarts)} settings per generation from now on`);
      }
      const mean = this.ck.cma.mean;
      const base = styleOf(ch.genome);
      const moved = mean.some((v, i) => Math.abs(v - base[i]) > 0.02);
      if (moved) {
        const id = newId();
        enter({ id, genome: withStyle(ch.genome, mean), lineage: { id, op: 'skills', parents: [ch.id], muts: 0, born: gen }, since: gen, pairs: [] });
      }
      cmaSum = { gen: this.ck.cma.gen, sigma: this.ck.cma.sigma, best: Math.max(...fitness), mean: fitness.reduce((a, b) => a + b, 0) / fitness.length, entered: moved };
    }
    lap('learn');

    // 3. RACE — the champion and every contender on the same brand-new matches
    const K = c.raceMatches;
    const fresh = Array.from({ length: K }, (_, k) => seed7(c.seed, 'race', gen, k));
    const who = [ch.genome, ...arena.map((a) => a.genome)];
    const tracked = col.map((r, i) => ({ r, i })).filter((q) => q.i < TRACKED);
    const best = tracked.reduce((b, q) => (q.r.reward > b.r.reward ? q : b), tracked[0]);
    const focusJob = this.job(ch.genome, seed7(c.seed, 'collect', gen, best.i), { frames: true });
    const [focus, ...rres] = await this.map<EpisodeResult>([focusJob, ...who.flatMap((g) => fresh.map((s) => this.job(g, s)))], 'racing');
    this.check();
    this.count([focus, ...rres]);
    const champR = rres.slice(0, K).map((r) => r.reward);
    ch.conf = addConf(ch.conf, champR);
    arena.forEach((a, j) => {
      const rs = rres.slice((j + 1) * K, (j + 2) * K);
      rs.forEach((r, k) => a.pairs.push([r.reward, champR[k]]));
    });
    let confirm: GenSummary['confirm'] = null;
    let winner: ArenaEntry | null = null;
    const top = arena.reduce<ArenaEntry | null>((b, a) => (!b || zOf(a) > zOf(b) ? a : b), null);
    if (top) {
      const { mean, se } = diffStats(top);
      const z = zOf(top);
      const reliable = tail(top.pairs.map((p) => p[0])) >= tail(top.pairs.map((p) => p[1])) - TAIL_TOL;
      const promoted = z >= Z_PROMOTE && reliable;
      confirm = { id: top.id, op: top.lineage.op, diff: mean, se, n: top.pairs.length, promoted };
      this.emit('log', `race: #${top.id} (${top.lineage.op}) vs champion over ${top.pairs.length} fresh matches ${mean >= 0 ? '+' : ''}${mean.toFixed(1)} ± ${(1.96 * se).toFixed(1)} (z ${z.toFixed(2)}, promote at ${Z_PROMOTE})${z >= Z_PROMOTE && !reliable ? ' — ahead on average but worse in its bad matches: not promoted' : ''}${promoted ? ' — NEW CHAMPION' : ''}`);
      if (promoted) winner = top;
    }
    for (let k = arena.length - 1; k >= 0; k--) {
      const a = arena[k];
      if (a === winner) continue;
      if (a.pairs.length >= 2 * K && (zOf(a) <= -Z_DROP || a.pairs.length >= RACE_MAX)) arena.splice(k, 1);
    }
    lap('race');

    // 4. A NEW CHAMPION — its showcase and its exam
    let exam: ExamResult | null = null;
    if (winner) {
      arena.splice(arena.indexOf(winner), 1);
      for (const a of arena) a.pairs = []; // their evidence was against the old champion
      const q = confStats({ n: winner.pairs.length, sum: winner.pairs.reduce((s, p) => s + p[0], 0), sumSq: winner.pairs.reduce((s, p) => s + p[0] * p[0], 0) });
      ch = this.ck.champion = { id: winner.id, genome: winner.genome, lineage: winner.lineage, born: gen, conf: addConf(null, winner.pairs.map((p) => p[0])), exam: null, parts: null };
      if (this.ck.cma) this.ck.cma = cmaRecenter(this.ck.cma, styleOf(ch.genome));
      this.event(`NEW CHAMPION #${ch.id} (${ch.lineage.op === 'lessons' ? 'learned from what-if lessons' : ch.lineage.op === 'skills' ? 'tuned skill settings' : ch.lineage.op === 'replays' ? 'fitted to your replays' : ch.lineage.op}): ${q.score.toFixed(1)} over ${q.n} fresh matches`);
    }
    if (winner || !ch.exam || (c.examEvery > 0 && gen - ch.exam.gen >= c.examEvery)) {
      exam = await this.exam(gen);
      ch.exam = exam;
      lap('exam');
    }
    if (winner || !existsSync(join(this.dir, 'best.frames.json.gz'))) {
      await this.showcase(gen);
      lap('exam');
    }
    if (winner) this.emit('best', ch);

    // the generation file (LIVE: the champion's collected matches) and its best match, exactly
    const wall = (performance.now() - t0) / 1000;
    T.wallSeconds += wall;
    const deaths: Record<Death, number> = { survived: 0, crash: 0, stall: 0 };
    const choices: Record<string, number> = {};
    let decN = 0;
    for (const r of col) {
      deaths[r.death]++;
      T.deaths[r.death]++;
      for (const d of r.decisions ?? []) {
        choices[d[1]] = (choices[d[1]] ?? 0) + 1;
        decN++;
      }
    }
    for (const k of Object.keys(choices)) choices[k] /= Math.max(1, decN);
    const indiv = tracked
      .map(({ r, i }) => ({ i, id: i, op: 'champion', parents: [ch.id], muts: 0, born: gen, fitness: r.reward, score: r.score, death: r.death, deathTick: r.deathTick, track: r.track, events: r.events, decisions: r.decisions, point: r.point, parts: r.parts }))
      .sort((a, b) => b.fitness - a.fitness || a.i - b.i);
    atomicWrite(join(this.dir, 'gens', `${gen}.json`), JSON.stringify({ gen, stage: 'full', individuals: indiv }));
    atomicWrite(join(this.dir, 'gens', `${gen}.frames.json.gz`), gzipSync(JSON.stringify({ gen, fitness: focus.reward, score: focus.score, death: focus.death, parts: focus.parts, lineage: { id: ch.id, op: 'champion', parents: [], muts: 0, born: gen }, frames: focus.frames, events: focus.events })));
    this.prune(gen);

    const cs = confStats(ch.conf ?? { n: 0, sum: 0, sumSq: 0 });
    const regretN = col.reduce((a, r) => a + r.mistakes.regretN, 0);
    const summary: GenSummary = {
      gen,
      time: now(),
      hours: T.wallSeconds / 3600,
      wallS: wall,
      phases,
      matchesTotal: T.matches,
      simHoursTotal: T.simSeconds / 3600,
      lessonsTotal: T.lessons,
      meanScore: col.reduce((a, r) => a + r.score, 0) / col.length,
      bestScore: Math.max(...col.map((r) => r.score)),
      meanReward: col.reduce((a, r) => a + r.reward, 0) / col.length,
      deaths,
      meanTips: col.reduce((a, r) => a + r.parts.tips, 0) / col.length,
      mistakes: meanMistakes(col),
      choices,
      lessons: nLessons,
      regret: regretN ? col.reduce((a, r) => a + r.mistakes.regret, 0) / regretN : 0,
      fit: fit.report,
      value: { rmse: fit.valueRmse, startRmse: fit.valueStartRmse, samples: fit.valueSamples },
      cma: cmaSum,
      arena: arena.map((a) => {
        const d = diffStats(a);
        return { id: a.id, op: a.lineage.op, n: a.pairs.length, diff: d.mean, se: d.se, z: zOf(a) };
      }),
      confirm,
      champId: ch.id,
      champOp: ch.lineage.op,
      champScore: cs.score,
      champCi: cs.ci95,
      champN: cs.n,
      newChamp: !!winner,
      exam,
      matchesPerMin: 0,
    };
    summary.matchesPerMin = ((T.matches - (this.history().at(-1)?.matchesTotal ?? 0)) / wall) * 60;
    this.ck.gen = gen + 1;
    this.ck.lastGenAt = summary.time;
    appendFileSync(join(this.dir, 'metrics.jsonl'), JSON.stringify(summary) + '\n');
    this.save();
    this.emit('generation', summary);
    if (c.ckEvery > 0 && this.ck.gen % c.ckEvery === 0) this.saveCheckpoint(`auto · gen ${this.ck.gen}`, true);
    for (const l of this.pendingCk.splice(0)) this.saveCheckpoint(l);
  }

  /** lesson files in the window ending at `gen` */
  private lessonGens(gen: number): number[] {
    const out: number[] = [];
    for (let g = gen; g > gen - this.ck.config.window && g >= 0; g--) if (existsSync(join(this.dir, 'lessons', `${g}.json.gz`))) out.push(g);
    return out;
  }

  /** THE EXAM: the champion on the fixed exam matches — alone, and thinking ahead (search) — paired
   * with the no-learning robot on the same matches; a determinism re-run; the champion on your
   * replays' build and match seeds (one of them re-simulated by DSIM itself); the gap report */
  private async exam(gen: number): Promise<ExamResult> {
    const c = this.ck.config;
    const ch = this.ck.champion;
    const seeds = Array.from({ length: c.examMatches }, (_, k) => seed7(EXAM_SEED, 'exam', k));
    const reps = dataFiles().filter((f) => f.included);
    const searchN = Math.max(4, Math.floor(seeds.length / 2)); // look-ahead is ~20× the cost of a plain match: half the exam
    const player = c.searchExam ? { value: this.ck.value, search: SEARCH } : {};
    const jobs: Job[] = [
      ...seeds.map((s) => this.job(ch.genome, s)),
      ...(c.searchExam ? seeds.slice(0, searchN).map((s) => this.job(ch.genome, s, { value: this.ck.value, search: SEARCH })) : []),
      this.job(ch.genome, seeds[0]), // determinism: the same match again
      ...reps.map((f) => ({ module: '../train/gap.ts', fn: 'replayJob', args: { dir: DATA_DIR, file: f.name } })),
    ];
    const res = await this.map<unknown>(jobs, 'exam');
    this.check();
    const N = seeds.length;
    const net = res.slice(0, N) as EpisodeResult[];
    const srch = (c.searchExam ? res.slice(N, N + searchN) : []) as EpisodeResult[];
    const again = res[N + srch.length] as EpisodeResult;
    const human = res.slice(N + srch.length + 1) as (Played & { seed: number; file: string })[];
    this.count([...net, ...srch, again]);
    // the champion on each replay's own build and match seed (the build check); the first one recorded and DSIM-verified
    const bjobs = human.map((h, i) => this.job(ch.genome, h.seed, { profile: `replay:${h.file}`, sampleProfile: false, record: i === 0, verify: i === 0, ...player }));
    const built = bjobs.length ? await this.map<EpisodeResult>(bjobs, 'exam') : [];
    this.check();
    this.count(built);
    const base = this.ck.baseExam ?? [];
    const rw = net.map((r) => r.reward);
    const paired = (a: number[], b: number[]): MeanCi => meanCi(a.map((x, i) => x - b[i]));
    const hours = this.ck.totals.wallSeconds / 3600;
    const ex: ExamResult = {
      gen,
      time: now(),
      hours,
      champ: ch.id,
      champOp: ch.lineage.op,
      net: { ...meanCi(rw), tips: net.reduce((a, r) => a + r.parts.tips, 0) / N },
      vsBase: paired(rw, base),
      search: srch.length
        ? { ...meanCi(srch.map((r) => r.reward)), vsNet: paired(srch.map((r) => r.reward), rw.slice(0, srch.length)), vsBase: paired(srch.map((r) => r.reward), base.slice(0, srch.length)), changed: srch.reduce((a, r) => a + (r.searched?.changed ?? 0), 0) / Math.max(1, srch.reduce((a, r) => a + (r.searched?.n ?? 0), 0)) }
        : null,
      mistakes: meanMistakes(net),
      gap: [
        ...(human.length ? [gapRow('you', 'your build', human)] : []),
        ...(built.length ? [gapRow(c.searchExam ? 'champion (thinking ahead)' : 'champion', 'your build, your matches', built.map(played))] : []),
        gapRow('champion', c.profile.replace('profiles/', '').replace('.json', ''), net.map(played)),
      ],
      checks: { deterministic: again.reward === net[0].reward && again.ticks === net[0].ticks, dsim: built[0]?.verified ?? null },
    };
    appendFileSync(join(this.dir, 'exams.jsonl'), JSON.stringify(ex) + '\n');
    const s = ex.search;
    this.event(
      `exam (champion #${ch.id}): ${ex.net.mean.toFixed(1)} ± ${ex.net.ci95.toFixed(1)} on ${N} matches, ${ex.vsBase.mean >= 0 ? '+' : ''}${ex.vsBase.mean.toFixed(1)} ± ${ex.vsBase.ci95.toFixed(1)} over the no-learning robot` +
        (s ? `; thinking ahead ${s.mean.toFixed(1)} (${s.vsBase.mean >= 0 ? '+' : ''}${s.vsBase.mean.toFixed(1)} ± ${s.vsBase.ci95.toFixed(1)})` : '') +
        `${ex.checks.deterministic ? '' : ' — ⚠ NOT DETERMINISTIC'}${ex.checks.dsim && !ex.checks.dsim.ok ? ' — ⚠ DSIM replay mismatch' : ''}`,
    );
    this.emit('exam', ex);
    return ex;
  }

  /** the champion's showcase match (exam match 0, thinking ahead when the exam does): exact frames,
   * the what-if values at its decisions, a DSIM replay and paste snippet */
  private async showcase(gen: number): Promise<void> {
    const c = this.ck.config;
    const ch = this.ck.champion;
    const [rec] = await this.map<EpisodeResult>(
      [this.job(ch.genome, seed7(EXAM_SEED, 'exam', 0), { frames: true, record: true, inspect: true, value: this.ck.value, ...(c.searchExam ? { search: SEARCH } : { lessons: { thinkRate: 0, horizon: 600, rounds: 1 } }) })],
      'showcase',
    );
    this.check();
    this.count([rec]);
    ch.parts = rec.parts;
    if (rec.replay) {
      exportReplay(join(this.dir, 'best'), rec.replay as Replay, {
        title: `${c.name} champion #${ch.id} (gen ${gen})`,
        profile: `${c.profile}${c.sampleProfile ? ' (sampled robot)' : ''}, ${c.driver} driver`,
        score: rec.score,
        replayExact: rec.replayExact ?? false,
      });
    }
    atomicWrite(
      join(this.dir, 'best.frames.json.gz'),
      gzipSync(JSON.stringify({ gen, fitness: rec.reward, score: rec.score, death: rec.death, parts: rec.parts, lineage: ch.lineage, frames: rec.frames, events: rec.events, inspect: rec.inspect as Inspected[], search: c.searchExam })),
    );
  }

  private save(): void {
    atomicWrite(join(this.dir, 'checkpoint.json'), JSON.stringify(this.ck));
    const ch = this.ck.champion;
    atomicWrite(
      join(this.dir, 'summary.json'),
      JSON.stringify({ name: this.name, gen: this.gen, champion: ch.id, champOp: ch.lineage.op, exam: ch.exam ? ch.exam.net.mean : null, search: ch.exam?.search?.mean ?? null, vsBase: ch.exam ? ch.exam.vsBase.mean : null, updated: now(), version: CK_VERSION }),
    );
  }
  /** generation files: the last keepGens and every 100th. Lessons (~70 KB per match): the last
   * LESSON_KEEP generations (or the window, if longer) — a rewind further back than that trains on
   * the lessons still on disk, so it is exact only within them */
  private prune(gen: number): void {
    const c = this.ck.config;
    const rm = (d: string, keep: (g: number) => boolean): void => {
      for (const f of readdirSync(join(this.dir, d))) {
        const g = Number(f.split('.')[0]);
        if (Number.isFinite(g) && !keep(g)) rmSync(join(this.dir, d, f));
      }
    };
    rm('gens', (g) => g >= gen - c.keepGens || g % 100 === 0);
    rm('lessons', (g) => g > gen - Math.max(LESSON_KEEP, c.window));
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
  checkpoint(label: string): CheckpointMeta | null {
    if (!this.busy) return this.saveCheckpoint(label);
    this.pendingCk.push(label);
    this.emit('log', `checkpoint "${label}" will be saved when this generation finishes`);
    return null;
  }
  saveCheckpoint(label: string, auto = false, pinned = false): CheckpointMeta {
    const id = `g${this.gen}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const c = this.ck.config;
    const ch = this.ck.champion;
    const meta: CheckpointMeta = {
      id,
      gen: this.gen,
      label: label.slice(0, 80) || `gen ${this.gen}`,
      auto,
      pinned,
      time: now(),
      champScore: ch.conf?.n ? confStats(ch.conf).score : null,
      exam: ch.exam ? ch.exam.net.mean : null,
      config: { preset: c.preset, collect: c.collect, horizon: c.horizon },
    };
    const m = join(this.dir, 'metrics.jsonl');
    const x = join(this.dir, 'exams.jsonl');
    atomicWrite(this.ckPath(id, 'state'), gzipSync(JSON.stringify(this.ck)));
    atomicWrite(this.ckPath(id, 'metrics'), gzipSync(JSON.stringify({ metrics: existsSync(m) ? readFileSync(m, 'utf8') : '', exams: existsSync(x) ? readFileSync(x, 'utf8') : '' })));
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
  deleteCheckpoints(which: 'auto' | 'unpinned'): number {
    const list = this.listCheckpoints().filter((m) => !m.pinned && (which === 'unpinned' || m.auto));
    for (const m of list) this.deleteCheckpoint(m.id, true);
    if (list.length) this.event(`${list.length} ${which === 'auto' ? 'automatic' : 'unpinned'} checkpoint${list.length > 1 ? 's' : ''} deleted`);
    return list.length;
  }
  private editMeta(id: string, f: (m: CheckpointMeta) => void): CheckpointMeta {
    const p = this.ckPath(id, 'meta');
    if (!existsSync(p)) throw new Error('no such checkpoint');
    const m = JSON.parse(readFileSync(p, 'utf8')) as CheckpointMeta;
    f(m);
    atomicWrite(p, JSON.stringify(m));
    this.emit('checkpoints');
    return m;
  }
  pinCheckpoint(id: string, pinned: boolean): void {
    this.editMeta(id, (m) => (m.pinned = pinned));
  }
  renameCheckpoint(id: string, label: string): void {
    const l = label.trim().slice(0, 80);
    if (!l) throw new Error('give the checkpoint a name');
    this.editMeta(id, (m) => {
      m.label = l;
      m.auto = false;
    });
  }
  private loadCheckpoint(id: string): { ck: Checkpoint; logs: { metrics: string; exams: string }; meta: CheckpointMeta } {
    const mp = this.ckPath(id, 'meta');
    if (!existsSync(mp)) throw new Error('no such checkpoint');
    return {
      meta: JSON.parse(readFileSync(mp, 'utf8')) as CheckpointMeta,
      ck: JSON.parse(gunzipSync(readFileSync(this.ckPath(id, 'state'))).toString('utf8')) as Checkpoint,
      logs: JSON.parse(gunzipSync(readFileSync(this.ckPath(id, 'metrics'))).toString('utf8')) as { metrics: string; exams: string },
    };
  }
  /** go back to a checkpoint; the present is saved first (pinned), so a rewind can be undone */
  async rewind(id: string): Promise<CheckpointMeta> {
    await this.halt(true);
    const { ck, logs, meta } = this.loadCheckpoint(id);
    const undo = this.saveCheckpoint(`before rewind to gen ${meta.gen}`, false, true);
    ck.config.name = this.name;
    this.ck = ck;
    atomicWrite(join(this.dir, 'metrics.jsonl'), logs.metrics);
    atomicWrite(join(this.dir, 'exams.jsonl'), logs.exams);
    for (const d of ['gens', 'lessons'])
      for (const f of readdirSync(join(this.dir, d))) {
        const g = Number(f.split('.')[0]);
        if (Number.isFinite(g) && g >= meta.gen) rmSync(join(this.dir, d, f));
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
    if (id === 'now' && this.busy) throw new Error('wait for this generation to finish (or fork from a checkpoint)');
    const read = (f: string): string => (existsSync(join(this.dir, f)) ? readFileSync(join(this.dir, f), 'utf8') : '');
    const src = id === 'now' ? { ck: structuredClone(this.ck), logs: { metrics: read('metrics.jsonl'), exams: read('exams.jsonl') } } : this.loadCheckpoint(id);
    const ck = src.ck;
    const cfg = { ...ck.config, ...pickLive(overrides), name };
    const err = checkRun(cfg);
    if (err) throw new Error(err);
    ck.config = cfg;
    for (const d of ['gens', 'checkpoints', 'lessons']) mkdirSync(join(dir, d), { recursive: true });
    // the lessons the fork learns from next come along
    for (let g = ck.gen - 1; g >= 0 && g >= ck.gen - cfg.window; g--) {
      const f = join(this.dir, 'lessons', `${g}.json.gz`);
      if (existsSync(f)) copyFileSync(f, join(dir, 'lessons', `${g}.json.gz`));
    }
    atomicWrite(join(dir, 'checkpoint.json'), JSON.stringify(ck));
    atomicWrite(join(dir, 'metrics.jsonl'), src.logs.metrics);
    atomicWrite(join(dir, 'exams.jsonl'), src.logs.exams);
    const bf = id === 'now' ? join(this.dir, 'best.frames.json.gz') : join(this.dir, 'checkpoints', `${id}.best.frames.json.gz`);
    if (existsSync(bf)) copyFileSync(bf, join(dir, 'best.frames.json.gz'));
    const e = Engine.open(name);
    e.event(`${id === 'now' ? 'copied' : 'forked'} from "${this.name}" at generation ${e.gen}${Object.keys(overrides).length ? ` with ${JSON.stringify(pickLive(overrides))}` : ''}`);
    e.save();
    e.saveCheckpoint(id === 'now' ? 'copy start' : 'fork start', false, true);
    return name;
  }

  // ─────────────────────────────── settings ───────────────────────────────
  setConfig(change: Partial<RunConfig>): Partial<RunConfig> {
    const fixed = Object.keys(change).filter((k) => (FIXED_KEYS as readonly string[]).includes(k) && JSON.stringify((change as Record<string, unknown>)[k]) !== JSON.stringify((this.ck.config as unknown as Record<string, unknown>)[k]));
    if (fixed.length) throw new Error(`${fixed.join(', ')} ${fixed.length > 1 ? 'define' : 'defines'} the run and cannot change mid-run — fork it or start a new run`);
    const live = pickLive(change);
    if (!('preset' in change)) live.preset = presetOf({ ...this.ck.config, ...live });
    const next = { ...this.ck.config, ...live };
    const err = checkRun(next);
    if (err) throw new Error(err);
    const diff: Partial<RunConfig> = {};
    for (const [k, v] of Object.entries(live)) if (JSON.stringify((this.ck.config as unknown as Record<string, unknown>)[k]) !== JSON.stringify(v)) (diff as Record<string, unknown>)[k] = v;
    if (!Object.keys(diff).length) return diff;
    this.ck.config = next;
    if (!this.busy) this.save();
    const shown = Object.entries(diff).filter(([k]) => k !== 'preset');
    if (shown.length) this.event(`settings changed${diff.preset ? ` (preset "${PRESETS.find((p) => p.id === diff.preset)?.label}")` : ''}: ${shown.map(([k, v]) => `${k} → ${JSON.stringify(v)}`).join(', ')}`);
    this.emit('state');
    return diff;
  }
  applyPreset(id: string): Partial<RunConfig> {
    const p = PRESETS.find((q) => q.id === id);
    if (!p) throw new Error('no such preset');
    return this.setConfig({ ...p.change, preset: id });
  }

  // ─────────────────────────────── evaluation ───────────────────────────────
  /** score a policy on n held-out matches. target: 'champion' (its network) | 'player' (the
   * champion thinking ahead) | 'greedy' | 'baseline' | 'imitation' | a checkpoint id */
  evaluate(target: string, n: number): Promise<EvalResult> {
    if (!(Number.isInteger(n) && n >= 1 && n <= 2000)) return Promise.reject(new Error('evaluate 1 to 2000 matches'));
    return new Promise((resolve, reject) => {
      this.evalQueue.push({ target, n, resolve, reject });
      this.emit('log', `evaluation queued: ${target} on ${n} held-out matches`);
      if (!this.loop) void this.drainEvals().finally(() => this.emit('state'));
    });
  }
  private policyOf(target: string): { genome: string | null; label: string; extra: Partial<EpisodeArgs> } {
    const ch = this.ck.champion;
    if (target === 'greedy') return { genome: null, label: 'greedy baseline (no learning)', extra: {} };
    if (target === 'baseline') return { genome: ensureGreedy().genome, label: 'the no-learning robot as a network', extra: {} };
    if (target === 'champion') return { genome: ch.genome, label: `champion #${ch.id} (its network)`, extra: {} };
    if (target === 'player') return { genome: ch.genome, label: `champion #${ch.id} thinking ahead`, extra: { value: this.ck.value, search: SEARCH } };
    if (target === 'imitation') {
      const d = ensureData();
      if (!d) throw new Error('no replays in "Training data/" that re-simulate in this DSIM (a replay recorded before DSIM Act 2 no longer does: record new ones)');
      return { genome: d.report.genome, label: 'imitation of your replays', extra: {} };
    }
    const { ck, meta } = this.loadCheckpoint(target);
    return { genome: ck.champion.genome, label: `champion at checkpoint "${meta.label}"`, extra: {} };
  }
  private async drainEvals(): Promise<void> {
    while (this.evalQueue.length) {
      const q = this.evalQueue.shift()!;
      try {
        const { genome, label, extra } = this.policyOf(q.target);
        this.phase = 'evaluating';
        const jobs = Array.from({ length: q.n }, (_, k) => this.job(genome, seed7(EVAL_SEED, 'eval', k), extra));
        const pool = this.ensurePool();
        const res = await pool.map<EpisodeResult>(jobs, (done, total) => this.emit('progress', { gen: this.gen, done, total, eval: label }));
        const s = res.map((r) => r.reward);
        const { mean, ci95 } = meanCi(s);
        const sd = s.length > 1 ? Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / (s.length - 1)) : 0;
        const deaths: Record<Death, number> = { survived: 0, crash: 0, stall: 0 };
        for (const r of res) deaths[r.death]++;
        const out: EvalResult = { id: `e${Date.now().toString(36)}`, target: label, gen: this.gen, n: s.length, scores: s, mean, sd, ci95, min: Math.min(...s), max: Math.max(...s), tips: res.reduce((a, r) => a + r.parts.tips, 0) / res.length, deaths, time: now() };
        appendFileSync(join(this.dir, 'evals.jsonl'), JSON.stringify(out) + '\n');
        this.event(`evaluated ${label}: ${mean.toFixed(1)} ± ${ci95.toFixed(1)} (95% CI) over ${s.length} matches, ${out.tips.toFixed(1)} tips`);
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
}

function pickLive(c: Partial<RunConfig>): Partial<RunConfig> {
  const out: Partial<RunConfig> = {};
  for (const k of LIVE_KEYS) if (k in c) (out as Record<string, unknown>)[k] = (c as Record<string, unknown>)[k];
  return out;
}
export function presetOf(c: RunConfig): string {
  return PRESETS.find((q) => Object.entries(q.change).every(([k, v]) => JSON.stringify((c as unknown as Record<string, unknown>)[k]) === JSON.stringify(v)))?.id ?? '';
}
export function checkRun(c: RunConfig): string | null {
  const int = (v: number, lo: number, hi: number): boolean => Number.isInteger(v) && v >= lo && v <= hi;
  const num = (v: number, lo: number, hi: number): boolean => typeof v === 'number' && v >= lo && v <= hi;
  if (!int(c.workers, 1, 64)) return 'workers must be 1–64';
  if (!int(c.collect, 1, 512)) return 'lesson matches per generation must be 1–512';
  if (!num(c.thinkRate, 0, 1)) return 'share of re-thinks that are lessons must be 0–1';
  if (!num(c.horizon, 1, 60)) return 'play-out length must be 1–60 s';
  if (!int(c.rounds, 1, 8)) return 'luck draws must be 1–8';
  if (!int(c.window, 1, 50)) return 'generations of lessons remembered must be 1–50';
  if (!int(c.epochs, 1, 1000)) return 'epochs must be 1–1000';
  if (!num(c.lr, 1e-5, 0.1)) return 'learning rate must be 0.00001–0.1';
  if (!num(c.anchor, 0, 10)) return 'anchor must be 0–10';
  if (!num(c.demoWeight, 0, 10)) return 'replay weight must be 0–10';
  if (!int(c.demoFade, 0, 10000)) return 'replay fade must be a whole number of generations';
  if (!int(c.cmaPop, 0, 64) || (c.cmaPop > 0 && c.cmaPop < 4)) return 'skill settings tried must be 0 (off) or 4–64';
  if (!int(c.cmaMatches, 1, 64)) return 'matches per skill setting must be 1–64';
  if (!num(c.cmaSigma, 0.01, 5)) return 'skill step size must be 0.01–5';
  if (!int(c.raceMatches, 2, 64)) return 'race matches must be 2–64';
  if (!int(c.examMatches, 4, 512)) return 'exam matches must be 4–512';
  if (!int(c.examEvery, 0, 10000)) return 'exam interval must be a whole number ≥ 0';
  if (typeof c.searchExam !== 'boolean') return 'thinking-ahead exam must be on or off';
  if (!['human', 'oracle'].includes(c.driver)) return 'driver must be human or oracle';
  if (!int(c.ckEvery, 0, 1e6)) return 'checkpoint interval must be a whole number ≥ 0';
  if (!int(c.ckKeep, 1, 1e6)) return 'automatic checkpoints kept must be ≥ 1';
  if (!int(c.keepGens, 10, 1e6)) return 'generations kept must be ≥ 10';
  if (!int(c.maxGens, 0, 1e9)) return 'generation limit must be a whole number ≥ 0';
  if (typeof c.preset !== 'string' || (c.preset && !PRESETS.some((p) => p.id === c.preset))) return 'unknown preset';
  // every robot the run can draw must be the one the profile describes, or a job throws mid-run
  if (typeof c.profile !== 'string' || !/^profiles\/[A-Za-z0-9_.-]+\.json$/.test(c.profile) || !existsSync(join(ROOT, c.profile))) return 'unknown profile';
  let bad: string[];
  try {
    bad = profileProblems(loadProfile(join(ROOT, c.profile)), c.sampleProfile);
  } catch (e) {
    return `profile ${c.profile} cannot be read: ${(e as Error).message}`;
  }
  if (bad.length) return `profile ${c.profile}: DSIM builds a different robot — ${bad.slice(0, 3).join('; ')}${bad.length > 3 ? ` (+${bad.length - 3} more)` : ''}`;
  return null;
}

// ─────────────────────────────── runs on disk ───────────────────────────────
export interface RunInfo {
  name: string;
  gen: number;
  champion: number | null;
  exam: number | null; // the champion's exam score
  search: number | null; // …thinking ahead
  vsBase: number | null; // …above the no-learning robot
  updated: string;
  legacy?: string;
  bytes: number;
}
function dirBytes(d: string): number {
  let n = 0;
  for (const f of readdirSync(d, { withFileTypes: true })) n += f.isDirectory() ? dirBytes(join(d, f.name)) : statSync(join(d, f.name)).size;
  return n;
}
export function listRuns(): RunInfo[] {
  if (!existsSync(RUNS)) return [];
  return readdirSync(RUNS)
    .filter((n) => NAME_RE.test(n) && existsSync(join(RUNS, n, 'checkpoint.json')))
    .map((n) => {
      const dir = join(RUNS, n);
      const s = join(dir, 'summary.json');
      const sum = existsSync(s) ? (JSON.parse(readFileSync(s, 'utf8')) as Record<string, unknown>) : null;
      let version = sum?.version as number | undefined;
      if (version === undefined) version = (JSON.parse(readFileSync(join(dir, 'checkpoint.json'), 'utf8')) as { version?: number }).version ?? 1;
      const legacy = version !== CK_VERSION ? (LEGACY[version] ?? `made by another version (${version})`) : undefined;
      const num = (k: string): number | null => (typeof sum?.[k] === 'number' ? (sum[k] as number) : null);
      return { name: n, gen: num('gen') ?? 0, champion: legacy ? null : num('champion'), exam: legacy ? null : num('exam'), search: legacy ? null : num('search'), vsBase: legacy ? null : num('vsBase'), updated: String(sum?.updated ?? ''), ...(legacy ? { legacy } : {}), bytes: dirBytes(dir) };
    })
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}
export function deleteRun(name: string): void {
  if (!NAME_RE.test(name) || !existsSync(join(RUNS, name, 'checkpoint.json'))) throw new Error(`no run called "${name}"`);
  rmSync(join(RUNS, name), { recursive: true, force: true });
}
export function renameRun(from: string, to: string): void {
  if (!NAME_RE.test(from) || !existsSync(join(RUNS, from, 'checkpoint.json'))) throw new Error(`no run called "${from}"`);
  if (!NAME_RE.test(to)) throw new Error('run names use letters, digits, - and _ (up to 48)');
  if (existsSync(join(RUNS, to))) throw new Error(`run "${to}" already exists`);
  renameSync(join(RUNS, from), join(RUNS, to));
  const p = join(RUNS, to, 'checkpoint.json');
  const ck = JSON.parse(readFileSync(p, 'utf8')) as { config: { name: string }; gen?: number };
  ck.config.name = to;
  atomicWrite(p, JSON.stringify(ck));
  const s = join(RUNS, to, 'summary.json');
  if (existsSync(s)) atomicWrite(s, JSON.stringify({ ...JSON.parse(readFileSync(s, 'utf8')), name: to }));
  appendFileSync(join(RUNS, to, 'events.jsonl'), JSON.stringify({ time: now(), gen: ck.gen ?? 0, text: `renamed from "${from}"` }) + '\n');
}
