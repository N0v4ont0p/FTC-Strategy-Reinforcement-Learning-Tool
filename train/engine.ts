// THE TRAINING ENGINE — one run: generation after generation with no built-in end, checkpointed
// atomically every generation (resume is bit-exact, train/check.ts), plus the controls of a real
// training stack: pause / resume / stop / abort a generation / step N generations; named and
// automatic CHECKPOINTS you can pin, rename, REWIND to, FORK into a new run or delete; settings
// changed between generations (logged, and part of the checkpoint) or all at once from a PRESET;
// EVALUATIONS of any policy on held-out seeds; exact frames of every generation's best robot.
//
// How a generation works (GA):
//   1. every robot plays `episodes` matches on the generation's common seeds (same field, same
//      robot draw for everybody — differences are the policy's, not luck's);
//   2. the best few (validateTop) are VALIDATED on `valEpisodes` fixed validation matches: the
//      CHAMPION is the best validated mean, never a single lucky match (the winner's curse), and it
//      only changes when a challenger beats it on the very same matches;
//   3. the champion's own decisions become EXPERIENCE; students (train/algos.ts) learn from it and
//      from the team's replays (the run's DATA SET, pinned by key so rewinds re-learn identically);
//   4. the GA breeds the next generation, the champion kept in it (hall of fame).
import { EventEmitter } from 'node:events';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { availableParallelism } from 'node:os';
import { WorkerPool, type Job } from '../harness/pool';
import { seedOf } from '../harness/rng';
import { exportReplay } from '../harness/export';
import type { Replay } from '../harness/dsim';
import { DEFAULTS, TUNABLE, makeAlgo, validate, type Algo, type AlgoConfig, type AlgoName, type Lineage, type Teacher } from './algos';
import { fromB64, skipOffset, toB64 } from './net';
import { SHAPE } from './policy';
import { N_OBS } from './obs';
import { N_OPT_FEATS, OPTION_KINDS } from './skills';
import { unpack, type Packed, type Sample } from './bc';
import { currentKey, ensureData, ensureGreedy, hasSet, loadSet, setSamples } from './imitate';
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
  validateTop: number; // the best this many of each generation are validated (0 = champion by one match)
  valEpisodes: number; // validation matches per candidate (fixed seeds for the whole run)
  confirmEpisodes: number; // fresh matches a candidate must beat the champion on (paired); 0 = off
  workers: number;
  keepGens: number; // generation files kept on disk (every 100th is kept forever)
  ckEvery: number; // automatic checkpoint every N generations (0 = off)
  ckKeep: number; // automatic checkpoints kept (pinned and named ones are never pruned)
  maxGens: number; // 0 = no limit
  preset: string; // the preset last applied ('' = none / changed since)
}

/** settings that can change mid-run (everything else defines the run) */
export const LIVE_KEYS = [...TUNABLE, 'episodes', 'annealGens', 'shaping', 'penalty', 'validateTop', 'valEpisodes', 'confirmEpisodes', 'workers', 'keepGens', 'ckEvery', 'ckKeep', 'maxGens', 'stage', 'driver', 'sampleProfile', 'preset'] as const;

const CORES = availableParallelism();

// ─────────────────────────────── presets ───────────────────────────────
/** how hard and how to train — each preset sets every strategy key, so it is one click and one
 * state. What the robots play (stage, driver, robot, hints, penalties) is never touched. */
const BALANCED = {
  pop: 128,
  episodes: 1,
  sigma: 0.05,
  mutProb: 0.2,
  crossRate: 0.3,
  elite: 4,
  truncation: 0.25,
  tournament: 3,
  macroRate: 0.15,
  immigrants: 0.03,
  imitRate: 0.1,
  imitAdapt: true,
  imitMin: 0.03,
  imitMax: 0.35,
  lessonSteps: 40,
  validateTop: 3,
  valEpisodes: 8,
  confirmEpisodes: 12,
  workers: Math.max(1, CORES - 1),
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
    blurb: 'The default. 128 robots; the best 3 of every generation checked on 8 validation matches; a new champion must beat the old one on 12 fresh matches; 15% behaviour mutations; students learning from your replays (their share adapts); all cores but one.',
    change: { ...BALANCED },
  },
  {
    id: 'full-push',
    label: 'Full push',
    blurb: 'Maximum results, maximum load. 256 robots on 2 matches each (half the luck in the ranking), the best 4 checked on 16 validation matches, a new champion must win over 24 fresh matches, 6 elites, every core. About 4× the time per generation.',
    change: { ...BALANCED, pop: 256, episodes: 2, elite: 6, validateTop: 4, valEpisodes: 16, confirmEpisodes: 24, workers: CORES },
  },
  {
    id: 'explore',
    label: 'Explore new strategies',
    blurb: 'For when it has stalled. Bigger mutations, 30% behaviour mutations, 10% brand-new random robots, weaker selection. Scores drop for a while; new orders get tried.',
    change: { ...BALANCED, pop: 192, sigma: 0.1, mutProb: 0.3, macroRate: 0.3, immigrants: 0.1, imitRate: 0.05, imitMin: 0.02, imitMax: 0.2, elite: 2, tournament: 2, truncation: 0.35, crossRate: 0.4 },
  },
  {
    id: 'refine',
    label: 'Refine the champion',
    blurb: 'For polishing a good strategy. Small mutations, 3 matches per robot for accurate ranking, 8 elites, the best 5 proven on 16 validation matches.',
    change: { ...BALANCED, episodes: 3, sigma: 0.02, mutProb: 0.1, crossRate: 0.2, elite: 8, tournament: 4, truncation: 0.2, immigrants: 0, imitRate: 0.05, imitMin: 0.02, imitMax: 0.15, validateTop: 5, valEpisodes: 16, confirmEpisodes: 24 },
  },
  {
    id: 'replays',
    label: 'Learn from my replays',
    blurb: 'A third of every generation takes a longer lesson from your replays (up to half if it pays off). Use after adding new replays.',
    change: { ...BALANCED, imitRate: 0.3, imitMin: 0.15, imitMax: 0.5, lessonSteps: 80, immigrants: 0.02 },
  },
  {
    id: 'quick',
    label: 'Quick look',
    blurb: '32 robots, fast generations for watching and testing settings. Noisy; not for real results.',
    change: { ...BALANCED, pop: 32, elite: 2, validateTop: 1, valEpisodes: 4, confirmEpisodes: 6 },
  },
  {
    id: 'background',
    label: 'Background',
    blurb: 'Keeps the Mac usable: half the cores, 64 robots.',
    change: { ...BALANCED, pop: 64, elite: 3, validateTop: 2, workers: Math.max(1, Math.floor(CORES / 2)) },
  },
];

export function defaultConfig(name: string, algo: AlgoName = 'ga'): RunConfig {
  const c: RunConfig = {
    name,
    ...DEFAULTS[algo],
    algo,
    seed: 1,
    profile: 'profiles/real-v0.json',
    sampleProfile: true,
    driver: 'oracle',
    stage: 'full',
    curriculum: { autoScore: 60, holdGens: 20, minGens: 30, maxGens: 3000 },
    annealGens: 1000,
    shaping: { ...DEFAULT_SHAPING },
    penalty: { ...DEFAULT_PENALTY },
    init: 'imitation',
    keepGens: 300,
    ckEvery: 10,
    ckKeep: 30,
    maxGens: 0,
    ...(algo === 'ga' ? BALANCED : { pop: BALANCED.pop, episodes: 1, validateTop: 3, valEpisodes: 8, confirmEpisodes: 12, workers: BALANCED.workers }),
    preset: '',
  };
  c.preset = presetOf(c);
  return c;
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
  /** champion: validated mean score and its 95 % half-width */
  champScore: number;
  champCi: number;
  /** champion test of this generation's candidate: paired difference on fresh matches */
  confirm: { id: number; diff: number; se: number; n: number; promoted: boolean } | null;
  /** candidates validated this generation: id, mean score, mean fitness */
  validated: { id: number; score: number; fitness: number; ci: number }[];
  /** share of each operator's children that reached the parent set (this generation / smoothed) */
  opRates: Record<string, number>;
  opSmooth: Record<string, number>;
  /** share of the next generation made as students */
  imitShare: number;
}

export interface Val {
  fitness: number; // mean over the validation matches (score − penalties, no hints)
  score: number;
  sd: number;
  ci95: number; // on the score
  n: number;
  key: string; // what it was validated on (stage, matches, robot, penalties) — changes force a re-check
}

export interface Best {
  fitness: number;
  score: number;
  gen: number;
  genome: string;
  parts: Parts;
  id: number;
  val: Val | null; // null: chosen by one match (validation off)
  conf?: Conf | null; // its results on fresh test matches (never selected on), summed
  baseline?: boolean; // the no-learning robot as a network, the bar the run started with
}
/** running sums of a robot's results on fresh matches */
export interface Conf {
  n: number;
  fit: number;
  fitSq: number;
  score: number;
  scoreSq: number;
}
/** a contender racing the champion: its paired advantage (fitness − champion's, same fresh matches) */
export interface ArenaEntry {
  id: number;
  genome: string;
  lineage: Lineage;
  val: Val | null;
  since: number; // generation it entered
  n: number;
  sd: number; // Σ differences
  sd2: number; // Σ squared differences
  conf: Conf | null; // its own results on those matches
}
/** contenders raced at once */
export const ARENA = 3;
/** Pocock boundary (Pocock 1977), one-sided α = 0.05 over up to ~10 looks (≈ 2.23 for 8, 2.28 for 10;
 * rounded up): looking at the accumulating evidence every generation keeps the chance of promoting a
 * contender that is NOT better near 5 % per contender. (Three race at once, so a merely EQUAL robot
 * can occasionally take over — harmless; a worse one practically never.) */
export const Z_PROMOTE = 2.3;
/** a contender this far below the champion (z) is dropped */
export const Z_DROP = 1.645;
/** the most fresh matches a contender gets to prove itself (8 looks at the default 12) */
export const RACE_MAX = 96;
function diffStats(a: ArenaEntry): { mean: number; se: number } {
  if (a.n < 2) return { mean: a.n ? a.sd / a.n : 0, se: Infinity };
  const mean = a.sd / a.n;
  const v = Math.max(0, (a.sd2 - a.n * mean * mean) / (a.n - 1));
  return { mean, se: Math.sqrt(v / a.n) };
}
/** the contender's paired z-score against the champion (0 without evidence) */
export function zOf(a: ArenaEntry): number {
  const { mean, se } = diffStats(a);
  return se > 0 && Number.isFinite(se) ? mean / se : 0;
}

/** has the champion been measured yet (the starting baseline has not, before generation 0) */
const scored = (b: Best | null): boolean => !!b && Number.isFinite(b.fitness);
function addConf(c: Conf | null, rs: EpisodeResult[]): Conf {
  const o = c ? { ...c } : { n: 0, fit: 0, fitSq: 0, score: 0, scoreSq: 0 };
  for (const r of rs) {
    o.n++;
    o.fit += r.fitness;
    o.fitSq += r.fitness * r.fitness;
    o.score += r.score;
    o.scoreSq += r.score * r.score;
  }
  return o;
}
/** mean fitness, mean score and the 95 % half-width of the score */
export function confStats(c: Conf): { fitness: number; score: number; ci95: number; n: number } {
  const m = c.score / c.n;
  const v = c.n > 1 ? Math.max(0, (c.scoreSq - c.n * m * m) / (c.n - 1)) : 0;
  return { fitness: c.fit / c.n, score: m, ci95: c.n > 1 ? (1.96 * Math.sqrt(v)) / Math.sqrt(c.n) : 0, n: c.n };
}

/** checkpoint format: 4 = thinking on the go (option 'position', 'current' feature, stick gene) */
export const CK_VERSION = 4;
const LEGACY: Record<number, string> = {
  1: 'made by the first training version (a raw joystick policy — the one that never learned to shoot)',
  2: 'made before the group-intake skills and the new network (its robots cannot run on them)',
  3: 'made before the robots learned to think on the go (the network gained inputs; its robots cannot run on it)',
};

interface Checkpoint {
  version: number;
  config: RunConfig;
  algoState: object;
  stage: Stage;
  autoHeld: number; // consecutive gens at/above the curriculum AUTO score
  totals: { spawned: number; matches: number; simSeconds: number; wallSeconds: number; deaths: Record<Death, number> };
  bestEver: Best | null;
  demoKey: string; // the data set (team replays) students learn from; '' = none
  experience: Packed | null; // the champion's own decisions
  valCache: Record<string, Val>; // candidates already validated (by id), for the ones still alive
  arena?: ArenaEntry[]; // contenders racing the champion on fresh matches
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
  config: Pick<RunConfig, 'algo' | 'pop' | 'sigma' | 'lr' | 'elite' | 'crossRate' | 'mutProb'> & { preset?: string };
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
const meanSd = (v: number[]): { mean: number; sd: number; ci95: number } => {
  const mean = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : 0;
  return { mean, sd, ci95: v.length > 1 ? (1.96 * sd) / Math.sqrt(v.length) : 0 };
};
/** the preference genes a behaviour mutation may shift: skip weights on the option-kind features */
const PREF_GENES = OPTION_KINDS.map((_, k) => skipOffset(SHAPE) + N_OBS + k);
const PROBES = 256;

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
  private demoCache: { key: string; samples: Sample[] } | null = null;
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
    const v = ck.version ?? 1; // the first version wrote no version number
    if (v !== CK_VERSION) throw new Error(`"${name}" was ${LEGACY[v] ?? `made by another version (${v})`}; it cannot continue. Its files are untouched; start a new run`);
    return new Engine(dir, ck);
  }

  /** create a new run (never overwrites one). With init 'imitation' the replays must already be
   * fitted (the studio does that in a worker) or they are fitted here (~20 s). */
  static create(cfg: RunConfig, log: (s: string) => void = () => {}): Engine {
    if (!NAME_RE.test(cfg.name)) throw new Error('run names use letters, digits, - and _ (up to 48)');
    const err = validate(cfg) ?? checkRun(cfg);
    if (err) throw new Error(err);
    const dir = join(RUNS, cfg.name);
    if (existsSync(join(dir, 'checkpoint.json'))) throw new Error(`run "${cfg.name}" already exists`);
    const data = ensureData(log);
    // generation 0 starts AT the bar: the no-learning robot distilled into a network is always a seed,
    // and the network fitted to your replays is the other one (when there are replays)
    let init: { genome: Float32Array; op: 'seed' | 'greedy' }[] | undefined;
    const greedy = ensureGreedy(log).genome;
    if (cfg.init === 'imitation') {
      init = [...(data ? [{ genome: fromB64(data.report.genome), op: 'seed' as const }] : []), { genome: fromB64(greedy), op: 'greedy' as const }];
      if (!data) log('no replays in "Training data/": generation 0 starts from the no-learning robot as a network');
    }
    const ck: Checkpoint = {
      version: CK_VERSION,
      config: cfg,
      algoState: {},
      stage: cfg.stage === 'auto' || cfg.stage === 'curriculum' ? 'auto' : 'full',
      autoHeld: 0,
      totals: { spawned: 0, matches: 0, simSeconds: 0, wallSeconds: 0, deaths: { survived: 0, crash: 0, stall: 0 } },
      bestEver: null,
      demoKey: data?.key ?? '',
      experience: null,
      valCache: {},
    };
    // THE STARTING CHAMPION is the no-learning robot as a network — the bar. With the champion test
    // on, a robot replaces it only by beating it on fresh matches, so the champion can never be
    // worse than the baseline (the first version crowned generation 0's validated best without a
    // test, and it lost 14 of 16 unseen matches to the baseline)
    if (cfg.confirmEpisodes > 0) {
      const gi = cfg.init === 'imitation' ? (data ? 1 : 0) : -1; // its id in generation 0, if it is there
      ck.bestEver = { fitness: -Infinity, score: 0, gen: 0, genome: greedy, parts: { pickups: 0, shotsIn: 0, wasted: 0, hp: 0, tips: 0, violations: 0, strikes: 0 }, id: gi, val: null, conf: null, baseline: true };
    }
    mkdirSync(join(dir, 'gens'), { recursive: true });
    mkdirSync(join(dir, 'checkpoints'), { recursive: true });
    const e = new Engine(dir, ck, init);
    e.save();
    e.event(`created: ${cfg.algo.toUpperCase()}, population ${cfg.pop}, ${cfg.init === 'imitation' ? `generation 0 = ${data ? 'the network fitted to your replays, ' : ''}the no-learning robot as a network, their mutants and random robots` : 'random generation 0'}${data ? `; students learn from ${data.report.files.filter((f) => f.samples > 0).length} replays` : ''}`);
    e.saveCheckpoint('start', false, true);
    return e;
  }

  private constructor(dir: string, ck: Checkpoint, init?: { genome: Float32Array; op: 'seed' | 'greedy' }[]) {
    super();
    this.dir = dir;
    this.ck = ck;
    mkdirSync(join(dir, 'gens'), { recursive: true });
    mkdirSync(join(dir, 'checkpoints'), { recursive: true });
    const restore = init || !Object.keys(ck.algoState).length ? undefined : ck.algoState;
    this.algo = makeAlgo({ ...ck.config }, SHAPE, restore, init, PREF_GENES, this.teacher());
    if (!restore) this.ck.algoState = this.algo.state();
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
  /** the data set this run's students learn from, and whether it is still on disk */
  get data(): { key: string; onDisk: boolean; latest: string; experience: number } {
    return { key: this.ck.demoKey, onDisk: hasSet(this.ck.demoKey), latest: currentKey(), experience: this.ck.experience?.n ?? 0 };
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

  // ─────────────────────────────── the teacher ───────────────────────────────
  /** what students learn from: the run's pinned data set + the champion's decisions. A function of
   * the checkpoint only, so a rewound run re-learns exactly as before. */
  private teacher(): Teacher {
    const key = this.ck.demoKey;
    if (this.demoCache?.key !== key) {
      let samples: Sample[] = [];
      if (key && hasSet(key)) {
        try {
          samples = setSamples(loadSet(key));
        } catch {
          samples = [];
        }
      }
      this.demoCache = { key, samples };
    }
    const demos = this.demoCache.samples;
    const exp = this.ck.experience ? unpack(this.ck.experience, N_OBS, N_OPT_FEATS) : [];
    // probe decisions: evenly spread over the replays, then the champion's own
    const nd = Math.min(demos.length, PROBES - Math.min(exp.length, 64));
    const probes = [...Array.from({ length: nd }, (_, i) => demos[Math.floor((i * demos.length) / nd)]), ...exp.slice(0, PROBES - nd)];
    return { demos, exp, probes };
  }
  /** switch this run's students to another data set (the latest by default). Mid-generation it
   * waits for the generation to end — a data set changes only between generations, so a rewind
   * re-learns exactly as before. */
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
    const n = key ? this.teacher().demos.length : 0;
    this.event(key ? `students now learn from the refreshed training data (${n} demonstrations) from generation ${this.gen}` : 'students no longer learn from replays');
    this.emit('state');
  }
  private pendingData: string | null = null;

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

  private job(genome: string | null, seed: number, o: { stage?: Stage; track?: boolean; frames?: boolean; record?: boolean; samples?: boolean; shaping?: number } = {}): Job {
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
      samples: o.samples ?? false,
    };
    return { module: '../train/episode.ts', fn: 'runEpisode', args };
  }
  private genSeed(gen: number, e: number): number {
    return seedOf(this.ck.config.seed, 'episode', gen, e) % 1_000_000_007; // common random numbers across the generation
  }
  /** the run's fixed validation matches (never used for training, never the evaluation seeds) */
  private valSeed(k: number): number {
    return seedOf(this.ck.config.seed, 'validate', k) % 1_000_000_007;
  }
  /** what a validation result is only comparable within */
  private valKey(): string {
    const c = this.ck.config;
    return JSON.stringify([this.ck.stage, c.valEpisodes, c.profile, c.sampleProfile, c.driver, c.penalty]);
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
        if (this.pendingData !== null) this.useData(this.pendingData);
        this.phase = 'generation';
        this.busy = true;
        const saved = JSON.stringify(this.ck);
        try {
          await this.generation();
        } catch (e) {
          if (!this.abortFlag) throw e;
          // an aborted generation leaves nothing behind: the in-memory run goes back to the last save,
          // keeping only settings changed while it ran
          const { config, stage } = this.ck;
          this.ck = JSON.parse(saved) as Checkpoint;
          this.ck.config = config;
          this.ck.stage = stage;
          this.algo = makeAlgo({ ...config }, SHAPE, this.ck.algoState, undefined, PREF_GENES, this.teacher());
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

  private check(): void {
    if (this.abortFlag) throw new Error('aborted');
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

    // VALIDATION of the best few (and of the champion when what it was validated on changed), in
    // one batch with the exact-frames re-run of the generation's best
    const vk = this.valKey();
    const champ = this.ck.bestEver;
    const toVal: { i: number; id: number; genome: string }[] = [];
    if (c.validateTop > 0) {
      for (const [, i] of order.slice(0, c.validateTop)) {
        const v = this.ck.valCache[lin[i].id];
        if (!v || v.key !== vk) toVal.push({ i, id: lin[i].id, genome: genomes[i] });
      }
      if (champ && (!champ.val || champ.val.key !== vk) && !toVal.some((q) => q.id === champ.id)) toVal.push({ i: -1, id: champ.id, genome: champ.genome });
    }
    const valJobs = toVal.flatMap((q) => Array.from({ length: c.valEpisodes }, (_, k) => this.job(q.genome, this.valSeed(k), { shaping: 0 })));
    const focusJob = this.job(genomes[bi], this.genSeed(gen, 0), { frames: true });
    this.emit('progress', { gen, done: 0, total: valJobs.length + 1, stage: 'validating' });
    const [focus, ...vres] = await pool.map<EpisodeResult>([focusJob, ...valJobs], (done, total) => this.emit('progress', { gen, done, total, stage: 'validating' }));
    this.check();
    atomicWrite(join(this.dir, 'gens', `${gen}.frames.json.gz`), gzipSync(JSON.stringify({ gen, fitness: focus.fitness, score: focus.score, death: focus.death, parts: focus.parts, lineage: lin[bi], frames: focus.frames, events: focus.events })));
    const validated: GenSummary['validated'] = [];
    toVal.forEach((q, k) => {
      const rs = vres.slice(k * c.valEpisodes, (k + 1) * c.valEpisodes);
      const s = meanSd(rs.map((r) => r.score));
      const v: Val = { fitness: rs.reduce((a, r) => a + r.fitness, 0) / rs.length, score: s.mean, sd: s.sd, ci95: s.ci95, n: rs.length, key: vk };
      this.ck.valCache[q.id] = v;
      if (champ && q.id === champ.id) {
        champ.val = v;
        champ.fitness = v.fitness;
        champ.score = v.score;
        champ.conf = null; // what it is measured on changed: its running fresh-match score starts over
        this.ck.arena = []; // …and so does every race against it
      }
      if (q.i >= 0) validated.push({ id: q.id, score: v.score, fitness: v.fitness, ci: v.ci95 });
    });

    // THE CHAMPION. The candidate is the best VALIDATED robot of this generation (or, with validation
    // off, the best single match). Picking the best of many on the same validation matches inflates
    // its score — the winner's curse; measured: validated 220, then 192 on unseen matches. So, with
    // confirmEpisodes on, a candidate REPLACES the champion only when it beats it on brand-new matches
    // (never used before, both robots on the same ones), by more than chance allows (one-sided 95 %
    // paired test). The champion replays fresh matches every generation, so the score shown for it
    // is a running mean over matches it was never selected on.
    let newBest = false;
    let challenger: { i: number; fitness: number; score: number; val: Val | null } | null = null;
    if (c.validateTop > 0) {
      for (const [, i] of order.slice(0, c.validateTop)) {
        const v = this.ck.valCache[lin[i].id];
        if (v && v.key === vk && (!challenger || v.fitness > challenger.fitness)) challenger = { i, fitness: v.fitness, score: v.score, val: v };
      }
    } else challenger = { i: bi, fitness: bf, score: score[bi], val: null };
    const T = this.ck.totals;
    const K = c.confirmEpisodes;
    const cur = this.ck.bestEver;
    const isNew = !!challenger && (!cur || lin[challenger.i].id !== cur.id);
    let confirm: GenSummary['confirm'] = null;
    let winner: { genome: string; id: number; lineage: Lineage; val: Val | null; fitness: number; score: number; conf: Conf | null } | null = null;
    if (K > 0 && !cur) {
      // no champion at all (never the case for a new run, which starts with the baseline): the
      // first validated robot takes the place
      if (challenger) winner = { genome: genomes[challenger.i], id: lin[challenger.i].id, lineage: lin[challenger.i], val: challenger.val, fitness: challenger.fitness, score: challenger.score, conf: null };
    } else if (K > 0 && cur) {
      // RACING (as in irace / F-race): up to ARENA contenders stay across generations. Each generation
      // the champion and every contender play the same K brand-new matches; each contender's paired
      // advantage over the champion accumulates. It is promoted when that advantage crosses a
      // group-sequential boundary (Pocock, Z_PROMOTE: safe although it is looked at every generation),
      // dropped when it is clearly worse or has used RACE_MAX matches without proving itself.
      const arena = (this.ck.arena ??= []);
      if (isNew && challenger && !arena.some((a) => a.id === lin[challenger.i].id)) {
        if (arena.length >= ARENA) arena.splice(arena.reduce((w, a, k) => (zOf(a) < zOf(arena[w]) ? k : w), 0), 1); // make room: drop the weakest
        arena.push({ id: lin[challenger.i].id, genome: genomes[challenger.i], lineage: lin[challenger.i], val: challenger.val, since: gen, n: 0, sd: 0, sd2: 0, conf: null });
      }
      const fresh = Array.from({ length: K }, (_, k) => seedOf(c.seed, 'confirm', gen, k) % 1_000_000_007);
      const who = [cur.genome, ...arena.map((a) => a.genome)];
      const cres = await pool.map<EpisodeResult>(
        who.flatMap((g) => fresh.map((sd) => this.job(g, sd, { shaping: 0 }))),
        (done, total) => this.emit('progress', { gen, done, total, stage: 'confirming' }),
      );
      this.check();
      T.matches += cres.length;
      for (const r of cres) T.simSeconds += r.ticks / 60;
      const champRes = cres.slice(0, K);
      cur.conf = addConf(cur.conf ?? null, champRes);
      arena.forEach((a, j) => {
        const rs = cres.slice((j + 1) * K, (j + 2) * K);
        for (let k = 0; k < K; k++) {
          const d = rs[k].fitness - champRes[k].fitness;
          a.n++;
          a.sd += d;
          a.sd2 += d * d;
        }
        a.conf = addConf(a.conf, rs);
      });
      // the strongest contender is promoted once it crosses the boundary
      const top = arena.reduce<ArenaEntry | null>((b, a) => (!b || zOf(a) > zOf(b) ? a : b), null);
      if (top) {
        const { mean, se } = diffStats(top);
        const promoted = zOf(top) >= Z_PROMOTE;
        confirm = { id: top.id, diff: mean, se, n: top.n, promoted };
        this.emit('log', `champion race: #${top.id} vs champion over ${top.n} fresh matches ${mean >= 0 ? '+' : ''}${mean.toFixed(1)} ± ${(1.96 * se).toFixed(1)} (z ${zOf(top).toFixed(2)}, promote at ${Z_PROMOTE})${promoted ? ' — NEW CHAMPION' : ''}`);
        if (promoted) {
          const q = confStats(top.conf!);
          winner = { genome: top.genome, id: top.id, lineage: top.lineage, val: top.val, fitness: q.fitness, score: q.score, conf: top.conf };
          arena.splice(arena.indexOf(top), 1);
          for (const a of arena) Object.assign(a, { n: 0, sd: 0, sd2: 0 }); // their evidence was against the old champion
        }
      }
      // drop the clearly worse and the ones that had their chance
      for (let k = arena.length - 1; k >= 0; k--) if (arena[k].n >= 2 * K && (zOf(arena[k]) <= -Z_DROP || arena[k].n >= RACE_MAX)) arena.splice(k, 1);
      if (!winner) {
        const q = confStats(cur.conf);
        cur.fitness = q.fitness;
        cur.score = q.score;
      }
    } else if (isNew && challenger && (!cur || challenger.fitness > cur.fitness)) {
      winner = { genome: genomes[challenger.i], id: lin[challenger.i].id, lineage: lin[challenger.i], val: challenger.val, fitness: challenger.fitness, score: challenger.score, conf: null };
    }
    if (winner) {
      newBest = true;
      const rec = await this.showcase(pool, winner.genome, winner.lineage, gen, winner.val);
      this.ck.bestEver = { fitness: winner.fitness, score: winner.score, gen, genome: winner.genome, parts: rec.parts, id: winner.id, val: winner.val, conf: winner.conf };
      this.emit('best', this.ck.bestEver);
    } else if (cur && !existsSync(join(this.dir, 'best.frames.json.gz'))) {
      // a champion without a showcase yet (the starting baseline, or after a rewind to before one)
      const rec = await this.showcase(pool, cur.genome, { id: cur.id, parents: [], op: cur.baseline ? 'greedy' : 'elite', muts: 0, born: cur.gen }, gen, cur.val);
      cur.parts = rec.parts;
      this.emit('best', cur);
    }

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
    for (const r of [focus, ...vres]) T.simSeconds += r.ticks / 60;
    const wall = (performance.now() - t0) / 1000;
    T.spawned += res.length;
    T.matches += res.length + 1 + vres.length;
    T.wallSeconds += wall;

    // generation file for the viewer: every robot's path and choices, best first, with lineage
    const indiv = order.map(([f, i]) => {
      const r = res[i * c.episodes];
      return { i, ...lin[i], fitness: f, score: score[i], death: r.death, deathTick: r.deathTick, track: r.track, events: r.events, decisions: r.decisions, point: r.point, parts: r.parts, val: this.ck.valCache[lin[i].id]?.key === vk ? this.ck.valCache[lin[i].id] : undefined };
    });
    atomicWrite(join(this.dir, 'gens', `${gen}.json`), JSON.stringify({ gen, stage: this.ck.stage, individuals: indiv }));
    this.pruneGens(gen);

    // advance the algorithm (the champion stays in the population), then the curriculum
    const keep = this.ck.bestEver ? { genome: fromB64(this.ck.bestEver.genome), id: this.ck.bestEver.id } : null;
    this.algo.setTeacher(this.teacher());
    this.algo.tell(fit, keep);
    const st = this.algo.stats();
    // validation results are kept only for robots still alive (and the champion)
    const alive = new Set(this.algo.lineage().map((l) => String(l.id)));
    if (this.ck.bestEver) alive.add(String(this.ck.bestEver.id));
    for (const id of Object.keys(this.ck.valCache)) if (!alive.has(id)) delete this.ck.valCache[id];

    const sorted = [...fit].sort((a, b) => a - b);
    const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    const ops: Record<string, number> = {};
    let muts = 0;
    for (const l of lin) {
      ops[l.op] = (ops[l.op] ?? 0) + 1;
      muts += l.muts;
    }
    const be = this.ck.bestEver!;
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
      bestEver: be.fitness,
      bestEverScore: be.score,
      newBest,
      ops,
      meanMuts: muts / lin.length,
      bestOp: lin[bi].op,
      choices,
      meanTips: tips / res.length,
      champScore: be.score,
      champCi: be.conf?.n ? confStats(be.conf).ci95 : (be.val?.ci95 ?? 0),
      confirm,
      validated,
      opRates: st.rates,
      opSmooth: st.smooth,
      imitShare: st.imitShare,
    };
    if (this.ck.stage === 'auto' && c.stage === 'curriculum') {
      this.ck.autoHeld = summary.bestScore >= c.curriculum.autoScore ? this.ck.autoHeld + 1 : 0;
      const g = this.algo.gen;
      if ((g >= c.curriculum.minGens && this.ck.autoHeld >= c.curriculum.holdGens) || g >= c.curriculum.maxGens) {
        this.ck.stage = 'full';
        this.event(`curriculum: AUTO mastered (best AUTO score ≥ ${c.curriculum.autoScore} for ${this.ck.autoHeld} generations) — full matches from now on; the champion is re-validated on full matches`);
      }
    }
    this.ck.algoState = this.algo.state();
    appendFileSync(join(this.dir, 'metrics.jsonl'), JSON.stringify(summary) + '\n');
    this.save();
    this.emit('generation', summary);
    if (c.ckEvery > 0 && this.algo.gen % c.ckEvery === 0) this.saveCheckpoint(`auto · gen ${this.algo.gen}`, true);
    for (const l of this.pendingCk.splice(0)) this.saveCheckpoint(l);
  }

  /** the champion's showcase life — exact frames for the viewer, a DSIM replay and paste snippet —
   * and its decisions, which become the experience students learn from */
  private async showcase(pool: WorkerPool, genome: string, lineage: Lineage, gen: number, val: Val | null): Promise<EpisodeResult> {
    const c = this.ck.config;
    const seed = c.validateTop > 0 ? this.valSeed(0) : this.genSeed(gen, 0);
    const [rec] = await pool.map<EpisodeResult>([this.job(genome, seed, { frames: true, record: true, samples: true, shaping: 0 })]);
    this.check();
    this.ck.experience = rec.samples && rec.samples.n ? rec.samples : this.ck.experience;
    if (rec.replay) {
      exportReplay(join(this.dir, 'best'), rec.replay as Replay, {
        title: `${c.name} champion (gen ${gen})`,
        profile: `${c.profile}${c.sampleProfile ? ' (sampled robot)' : ''}, ${c.driver} driver`,
        score: rec.score,
        replayExact: rec.replayExact ?? false,
      });
    }
    atomicWrite(join(this.dir, 'best.frames.json.gz'), gzipSync(JSON.stringify({ gen, fitness: rec.fitness, score: rec.score, death: rec.death, parts: rec.parts, lineage, frames: rec.frames, events: rec.events, val })));
    this.ck.totals.matches += 1;
    this.ck.totals.simSeconds += rec.ticks / 60;
    return rec;
  }

  private save(): void {
    atomicWrite(join(this.dir, 'checkpoint.json'), JSON.stringify(this.ck));
    const b = this.ck.bestEver;
    atomicWrite(
      join(this.dir, 'summary.json'),
      JSON.stringify({ name: this.name, gen: this.gen, algo: this.ck.config.algo, pop: this.ck.config.pop, bestFitness: scored(b) ? b!.fitness : null, bestScore: scored(b) ? b!.score : null, updated: now(), version: CK_VERSION }),
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
      bestFitness: scored(this.ck.bestEver) ? this.ck.bestEver!.fitness : null,
      bestScore: scored(this.ck.bestEver) ? this.ck.bestEver!.score : null,
      config: { algo: c.algo, pop: c.pop, sigma: c.sigma, lr: c.lr, elite: c.elite, crossRate: c.crossRate, mutProb: c.mutProb, preset: c.preset },
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
  /** delete many at once: every automatic unpinned one, or every unpinned one */
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
      m.auto = false; // a named checkpoint is never pruned automatically
    });
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
    ck.config.name = this.name; // the run's name is its identity (it may have been renamed since)
    this.ck = ck;
    this.algo = makeAlgo({ ...ck.config }, SHAPE, ck.algoState, undefined, PREF_GENES, this.teacher());
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
    if (id === 'now' && this.busy) throw new Error('wait for this generation to finish (or fork from a checkpoint)');
    const src = id === 'now' ? { ck: structuredClone(this.ck), metrics: existsSync(join(this.dir, 'metrics.jsonl')) ? readFileSync(join(this.dir, 'metrics.jsonl')) : Buffer.alloc(0) } : this.loadCheckpoint(id);
    const ck = src.ck;
    const cfg = { ...ck.config, ...pickLive(overrides), name };
    const err = validate(cfg) ?? checkRun(cfg);
    if (err) throw new Error(err);
    if (cfg.algo !== ck.config.algo) throw new Error('a fork keeps its algorithm (start a new run to change it)');
    ck.config = cfg;
    mkdirSync(join(dir, 'gens'), { recursive: true });
    mkdirSync(join(dir, 'checkpoints'), { recursive: true });
    atomicWrite(join(dir, 'checkpoint.json'), JSON.stringify(ck));
    atomicWrite(join(dir, 'metrics.jsonl'), src.metrics);
    const bf = id === 'now' ? join(this.dir, 'best.frames.json.gz') : join(this.dir, 'checkpoints', `${id}.best.frames.json.gz`);
    if (existsSync(bf)) copyFileSync(bf, join(dir, 'best.frames.json.gz'));
    const e = Engine.open(name);
    e.event(`${id === 'now' ? 'copied' : 'forked'} from "${this.name}" at generation ${e.gen}${Object.keys(overrides).length ? ` with ${JSON.stringify(pickLive(overrides))}` : ''}`);
    e.save();
    e.saveCheckpoint(id === 'now' ? 'copy start' : 'fork start', false, true);
    return name;
  }

  // ─────────────────────────────── settings ───────────────────────────────
  /** change settings between generations; returns the applied change */
  setConfig(change: Partial<RunConfig>): Partial<RunConfig> {
    const fixed = Object.keys(change).filter((k) => !(LIVE_KEYS as readonly string[]).includes(k) && JSON.stringify((change as Record<string, unknown>)[k]) !== JSON.stringify((this.ck.config as unknown as Record<string, unknown>)[k]));
    if (fixed.length) throw new Error(`${fixed.join(', ')} ${fixed.length > 1 ? 'define' : 'defines'} the run and cannot change mid-run — fork it or start a new run`);
    const live = pickLive(change);
    // a hand edit of a strategy key means the settings are no longer that preset
    if (!('preset' in change)) live.preset = presetOf({ ...this.ck.config, ...live });
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
    const shown = Object.entries(diff).filter(([k]) => k !== 'preset');
    if (shown.length) this.event(`settings changed${diff.preset ? ` (preset "${PRESETS.find((p) => p.id === diff.preset)?.label}")` : ''}: ${shown.map(([k, v]) => `${k} → ${JSON.stringify(v)}`).join(', ')}`);
    this.emit('state');
    return diff;
  }
  applyPreset(id: string): Partial<RunConfig> {
    const p = PRESETS.find((q) => q.id === id);
    if (!p) throw new Error('no such preset');
    const change: Partial<RunConfig> = { ...p.change, preset: id };
    if (this.ck.config.algo === 'es') for (const k of GA_ONLY) delete change[k];
    return this.setConfig(change);
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
    if (target === 'imitation') {
      const d = ensureData();
      if (!d) throw new Error('no replays in "Training data/"');
      return { genome: d.report.genome, label: 'imitation of your replays (no evolution)' };
    }
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
        const { mean, sd, ci95 } = meanSd(s);
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
          ci95,
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
/** settings only the GA has (ES runs ignore them in presets) */
const GA_ONLY = ['elite', 'truncation', 'crossRate', 'mutProb', 'tournament', 'macroRate', 'immigrants', 'imitRate', 'imitAdapt', 'imitMin', 'imitMax', 'lessonSteps'] as const;
/** the preset these settings are exactly, or '' */
export function presetOf(c: RunConfig): string {
  const p = PRESETS.find((q) =>
    Object.entries(q.change).every(([k, v]) => (c.algo === 'es' && (GA_ONLY as readonly string[]).includes(k)) || JSON.stringify((c as unknown as Record<string, unknown>)[k]) === JSON.stringify(v)),
  );
  return p?.id ?? '';
}
export function checkRun(c: RunConfig): string | null {
  if (!Number.isInteger(c.workers) || c.workers < 1 || c.workers > 64) return 'workers must be 1–64';
  if (!Number.isInteger(c.episodes) || c.episodes < 1 || c.episodes > 32) return 'matches per robot must be 1–32';
  if (!Number.isInteger(c.validateTop) || c.validateTop < 0 || c.validateTop > Math.min(32, c.pop)) return 'robots validated per generation must be 0–32 (and at most the population)';
  if (!Number.isInteger(c.valEpisodes) || c.valEpisodes < 1 || c.valEpisodes > 64) return 'validation matches must be 1–64';
  if (!Number.isInteger(c.confirmEpisodes) || (c.confirmEpisodes !== 0 && (c.confirmEpisodes < 2 || c.confirmEpisodes > 64))) return 'champion test matches must be 0 (off) or 2–64';
  if (!['auto', 'full', 'curriculum'].includes(c.stage)) return 'stage must be auto, full or curriculum';
  if (!['human', 'oracle'].includes(c.driver)) return 'driver must be human or oracle';
  if (!(c.annealGens >= 1)) return 'shaping fade must be ≥ 1 generation';
  for (const [k, v] of Object.entries({ ...c.shaping, ...c.penalty })) if (!(typeof v === 'number' && v >= 0 && v <= 1000)) return `${k} must be 0–1000`;
  if (!Number.isInteger(c.ckEvery) || c.ckEvery < 0) return 'checkpoint interval must be a whole number ≥ 0';
  if (!Number.isInteger(c.ckKeep) || c.ckKeep < 1) return 'automatic checkpoints kept must be ≥ 1';
  if (!Number.isInteger(c.keepGens) || c.keepGens < 10) return 'generations kept must be ≥ 10';
  if (!Number.isInteger(c.maxGens) || c.maxGens < 0) return 'generation limit must be a whole number ≥ 0';
  if (typeof c.preset !== 'string' || (c.preset && !PRESETS.some((p) => p.id === c.preset))) return 'unknown preset';
  return null;
}

// ─────────────────────────────── runs on disk ───────────────────────────────
export interface RunInfo {
  name: string;
  gen: number;
  algo: string;
  pop: number;
  bestFitness: number | null;
  bestScore: number | null;
  updated: string;
  legacy?: string; // why it cannot be opened
  bytes: number;
}
function dirBytes(d: string): number {
  let n = 0;
  for (const f of readdirSync(d, { withFileTypes: true })) n += f.isDirectory() ? dirBytes(join(d, f.name)) : statSync(join(d, f.name)).size;
  return n;
}
/** every run on disk (small summaries, newest first) */
export function listRuns(): RunInfo[] {
  if (!existsSync(RUNS)) return [];
  return readdirSync(RUNS)
    .filter((n) => NAME_RE.test(n) && existsSync(join(RUNS, n, 'checkpoint.json')))
    .map((n) => {
      const dir = join(RUNS, n);
      const s = join(dir, 'summary.json');
      // the summary carries the version (written every generation); older runs are read in full
      const sum = existsSync(s) ? (JSON.parse(readFileSync(s, 'utf8')) as Omit<RunInfo, 'bytes'> & { version?: number }) : null;
      let version = sum?.version;
      let base: Omit<RunInfo, 'bytes'> | null = sum;
      if (version === undefined || !base) {
        const ck = JSON.parse(readFileSync(join(dir, 'checkpoint.json'), 'utf8')) as Checkpoint;
        version = ck.version ?? 1;
        base ??= { name: n, gen: (ck.algoState as { gen?: number }).gen ?? 0, algo: ck.config.algo, pop: ck.config.pop, bestFitness: ck.bestEver?.fitness ?? null, bestScore: ck.bestEver?.score ?? null, updated: '' };
      }
      const legacy = version !== CK_VERSION ? (LEGACY[version] ?? `made by another version (${version})`) : undefined;
      const { version: _v, ...rest } = base as Omit<RunInfo, 'bytes'> & { version?: number };
      void _v;
      return { ...rest, name: n, ...(legacy ? { legacy } : {}), bytes: dirBytes(dir) };
    })
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

/** delete a whole run (the viewer asks for the name typed back) */
export function deleteRun(name: string): void {
  if (!NAME_RE.test(name) || !existsSync(join(RUNS, name, 'checkpoint.json'))) throw new Error(`no run called "${name}"`);
  rmSync(join(RUNS, name), { recursive: true, force: true });
}
/** rename a run (not open / not training — the server checks) */
export function renameRun(from: string, to: string): void {
  if (!NAME_RE.test(from) || !existsSync(join(RUNS, from, 'checkpoint.json'))) throw new Error(`no run called "${from}"`);
  if (!NAME_RE.test(to)) throw new Error('run names use letters, digits, - and _ (up to 48)');
  if (existsSync(join(RUNS, to))) throw new Error(`run "${to}" already exists`);
  renameSync(join(RUNS, from), join(RUNS, to));
  const p = join(RUNS, to, 'checkpoint.json');
  const ck = JSON.parse(readFileSync(p, 'utf8')) as Checkpoint;
  ck.config.name = to;
  atomicWrite(p, JSON.stringify(ck));
  const s = join(RUNS, to, 'summary.json');
  if (existsSync(s)) atomicWrite(s, JSON.stringify({ ...JSON.parse(readFileSync(s, 'utf8')), name: to }));
  appendFileSync(join(RUNS, to, 'events.jsonl'), JSON.stringify({ time: now(), gen: (ck.algoState as { gen?: number }).gen ?? 0, text: `renamed from "${from}"` }) + '\n');
}
