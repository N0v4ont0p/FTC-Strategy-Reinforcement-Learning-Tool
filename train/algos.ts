// EVOLUTION over a flat parameter vector. Both algorithms are fully seeded and serializable, so a
// run can stop and resume bit-exactly (train/check.ts proves it); hyperparameters can be changed
// between generations (setConfig), and the change is part of the checkpoint.
//   · GA — deep neuroevolution GA (Such et al. 2017) + uniform crossover: elitism, tournament
//     selection among the top fraction, Gaussian mutation. Every individual has an id, parents and
//     the operator that made it, so the viewer can show lineage and mutations. Policy = the best.
//     On top of that, four operators, each a known technique:
//       - BEHAVIOUR MUTATION (macroRate, 15 % by default): a large change to one part of the
//         network — a hidden unit re-drawn, one option's preference shifted, a burst of big
//         nudges, or a skill STYLE gene re-drawn — repeated until it provably changes what the
//         robot chooses on ≥ 10 % of probe decisions (the inverse of "safe mutations", Lehman et
//         al. 2018). Small Gaussian nudges alone mostly change nothing a robot does.
//       - STUDENTS (imitation share): a parent plus a short lesson of behaviour cloning on the
//         team's replays and the champion's own decisions — imitation learning as a genetic
//         operator (Gangwani & Peng 2018, "Policy Optimization by Genetic Distillation"; self-
//         imitation, Oh et al. 2018).
//       - ADAPTIVE OPERATOR SHARE: every generation measures how often each operator's children
//         reach the parent set, and the students' share follows it (adaptive pursuit, Thierens
//         2005) — so if learning from the replays helps, later generations use more of it, and if
//         it does not, less.
//       - RANDOM IMMIGRANTS and a CHAMPION kept in the population (hall of fame): diversity in,
//         the best validated policy never lost.
//   · ES — OpenAI evolution strategies (Salimans et al. 2017): mirrored noise pairs, centered-rank
//     fitness shaping, Adam on the mean, weight decay. Policy = the MEAN.
import { mulberry32, seedOf } from '../harness/rng';
import { fromB64, initParams, mlpCount, paramCount, styleOffset, toB64, type NetShape } from './net';
import { disagreement, lesson, type Sample } from './bc';

export type AlgoName = 'es' | 'ga';

export function gaussFrom(seed: number): () => number {
  const r = mulberry32(seed);
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = r();
    v = r();
    const m = Math.sqrt(-2 * Math.log(u));
    spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  };
}

export interface AlgoConfig {
  algo: AlgoName;
  pop: number;
  seed: number;
  sigma: number; // ES noise std / GA mutation std
  lr: number; // ES Adam step size
  elite: number; // GA: individuals carried over unchanged
  truncation: number; // GA: fraction of the population that may parent
  weightDecay: number; // ES
  crossRate: number; // GA: fraction of ordinary children made by crossover of two parents
  mutProb: number; // GA: probability each gene is mutated (1 = every gene, the deep-GA default)
  tournament: number; // GA: tournament size among the parents
  macroRate: number; // GA: share of children given a BEHAVIOUR mutation
  immigrants: number; // GA: share of children that are brand-new random networks
  imitRate: number; // GA: share of STUDENTS (the starting share when it adapts)
  imitAdapt: boolean; // GA: the students' share follows how well they do
  imitMin: number; // GA: adaptive share bounds
  imitMax: number;
  lessonSteps: number; // GA: minibatch steps in a student's lesson
}
export const TUNABLE = ['pop', 'sigma', 'lr', 'elite', 'truncation', 'weightDecay', 'crossRate', 'mutProb', 'tournament', 'macroRate', 'immigrants', 'imitRate', 'imitAdapt', 'imitMin', 'imitMax', 'lessonSteps'] as const;
export const DEFAULTS: Record<AlgoName, Omit<AlgoConfig, 'seed' | 'pop'>> = {
  es: { algo: 'es', sigma: 0.05, lr: 0.02, elite: 0, truncation: 0, weightDecay: 0.005, crossRate: 0, mutProb: 1, tournament: 0, macroRate: 0, immigrants: 0, imitRate: 0, imitAdapt: false, imitMin: 0, imitMax: 0, lessonSteps: 0 },
  ga: { algo: 'ga', sigma: 0.05, lr: 0, elite: 4, truncation: 0.25, weightDecay: 0, crossRate: 0.3, mutProb: 0.2, tournament: 3, macroRate: 0.15, immigrants: 0.03, imitRate: 0.1, imitAdapt: true, imitMin: 0.03, imitMax: 0.35, lessonSteps: 40 },
};
/** generation 0 from a seed network: this share are random networks instead of its mutants, so
 * the first generation already tries orders the replays never showed (e.g. AUTO not FLOWERS first) */
export const GEN0_RANDOM = 0.25;
/** a behaviour mutation must change the choice on at least this share of probe decisions */
export const MACRO_MIN_CHANGE = 0.1;

/** where an individual came from */
export interface Lineage {
  id: number;
  parents: number[];
  op: 'init' | 'seed' | 'greedy' | 'elite' | 'champion' | 'mutant' | 'cross' | 'macro' | 'student' | 'random' | 'es+' | 'es-';
  muts: number; // genes changed
  born: number; // generation
  changed?: number; // behaviour mutation / lesson: share of probe decisions it now chooses differently
  style?: boolean; // behaviour mutation of a skill STYLE gene (changes how it executes, not what it picks)
}
/** operators whose success is measured (a child reaching the parent set of its generation) */
export const OPS = ['mutant', 'cross', 'macro', 'student', 'random'] as const;

/** what students learn from and what proves a behaviour mutation */
export interface Teacher {
  demos: Sample[]; // the team's replays
  exp: Sample[]; // the champion's own decisions
  probes: Sample[]; // decisions a behaviour mutation must change
}

export interface Algo {
  readonly gen: number;
  /** the parameter vectors to evaluate this generation */
  ask(): Float32Array[];
  /** where each asked vector came from (same order) */
  lineage(): Lineage[];
  /** fitness for each asked vector, same order; advances one generation. `keep`: a genome that must
   * stay in the next population (the validated champion) */
  tell(fitness: number[], keep?: { genome: Float32Array; id: number } | null): void;
  /** the policy this algorithm currently stands behind (ES: mean; GA: best of last generation) */
  current(): Float32Array;
  setConfig(c: Partial<AlgoConfig>): void;
  setTeacher(t: Teacher | null): void;
  /** operator statistics for the generation summary */
  stats(): { rates: Record<string, number>; smooth: Record<string, number>; imitShare: number };
  state(): object;
}

/** centered ranks in [-0.5, 0.5] (ties get averaged ranks) */
export function centeredRanks(f: number[]): number[] {
  const idx = f.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const rank = new Array<number>(f.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) rank[idx[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return rank.map((r) => (f.length > 1 ? r / (f.length - 1) - 0.5 : 0));
}

/** checked before a change is accepted (the engine rejects anything else) */
export function validate(c: AlgoConfig): string | null {
  if (!Number.isInteger(c.pop) || c.pop < 4 || c.pop > 8192) return 'population must be a whole number from 4 to 8192';
  if (c.algo === 'es' && c.pop % 2) return 'ES needs an even population (mirrored pairs)';
  if (!(c.sigma > 0 && c.sigma <= 2)) return 'mutation / noise size must be in (0, 2]';
  if (c.algo === 'es' && !(c.lr > 0 && c.lr <= 1)) return 'learning rate must be in (0, 1]';
  if (c.algo === 'ga') {
    if (!Number.isInteger(c.elite) || c.elite < 0 || c.elite >= c.pop - 1) return 'elites must be a whole number at least 2 below the population';
    if (!(c.truncation > 0 && c.truncation <= 1)) return 'parent fraction must be in (0, 1]';
    if (!(c.crossRate >= 0 && c.crossRate <= 1)) return 'crossover rate must be in [0, 1]';
    if (!(c.mutProb > 0 && c.mutProb <= 1)) return 'gene mutation probability must be in (0, 1]';
    if (!Number.isInteger(c.tournament) || c.tournament < 1) return 'tournament size must be a whole number ≥ 1';
    if (!(c.macroRate >= 0 && c.macroRate <= 0.9)) return 'behaviour mutation share must be 0–0.9';
    if (!(c.immigrants >= 0 && c.immigrants <= 0.5)) return 'random newcomers share must be 0–0.5';
    if (!(c.imitMin >= 0 && c.imitMin <= c.imitRate && c.imitRate <= c.imitMax && c.imitMax <= 0.9)) return 'students: need 0 ≤ minimum ≤ share ≤ maximum ≤ 0.9';
    if (c.imitMax + c.immigrants + c.macroRate > 1 + 1e-9) return 'students (maximum) + random newcomers + behaviour mutations must add up to at most 1';
    if (typeof c.imitAdapt !== 'boolean') return 'adaptive students must be on or off';
    if (!Number.isInteger(c.lessonSteps) || c.lessonSteps < 1 || c.lessonSteps > 1000) return 'lesson length must be 1–1000 steps';
  }
  if (!(c.weightDecay >= 0 && c.weightDecay < 1)) return 'weight decay must be in [0, 1)';
  return null;
}

export class ES implements Algo {
  gen = 0;
  private mean: Float32Array;
  private m: Float32Array;
  private v: Float32Array;
  private eps: Float32Array[] = [];
  private asked = 0;
  constructor(private cfg: AlgoConfig, shape: NetShape, restore?: { gen: number; mean: string; m: string; v: string }, init?: Float32Array) {
    if (cfg.pop % 2) throw new Error('ES needs an even population (mirrored pairs)');
    if (restore) {
      this.gen = restore.gen;
      this.mean = fromB64(restore.mean);
      this.m = fromB64(restore.m);
      this.v = fromB64(restore.v);
    } else {
      this.mean = init ? new Float32Array(init) : initParams(shape, gaussFrom(seedOf(cfg.seed, 'init')));
      this.m = new Float32Array(this.mean.length);
      this.v = new Float32Array(this.mean.length);
    }
  }
  setConfig(c: Partial<AlgoConfig>): void {
    Object.assign(this.cfg, c);
  }
  setTeacher(): void {}
  stats(): { rates: Record<string, number>; smooth: Record<string, number>; imitShare: number } {
    return { rates: {}, smooth: {}, imitShare: 0 };
  }
  ask(): Float32Array[] {
    const n = this.mean.length;
    const out: Float32Array[] = [];
    this.eps = [];
    for (let i = 0; i < this.cfg.pop / 2; i++) {
      const g = gaussFrom(seedOf(this.cfg.seed, 'es', this.gen, i));
      const e = new Float32Array(n);
      for (let k = 0; k < n; k++) e[k] = g();
      this.eps.push(e);
      const plus = new Float32Array(n);
      const minus = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        plus[k] = this.mean[k] + this.cfg.sigma * e[k];
        minus[k] = this.mean[k] - this.cfg.sigma * e[k];
      }
      out.push(plus, minus);
    }
    this.asked = out.length;
    return out;
  }
  lineage(): Lineage[] {
    return Array.from({ length: this.asked }, (_, i) => ({ id: this.gen * 1e6 + i, parents: [], op: i % 2 ? 'es-' : 'es+', muts: this.mean.length, born: this.gen }));
  }
  tell(f: number[]): void {
    if (f.length !== this.asked || this.eps.length * 2 !== this.asked) throw new Error('tell() must follow ask() with one fitness per candidate');
    const u = centeredRanks(f);
    const n = this.mean.length;
    const grad = new Float32Array(n);
    for (let i = 0; i < this.eps.length; i++) {
      const w = u[2 * i] - u[2 * i + 1];
      const e = this.eps[i];
      for (let k = 0; k < n; k++) grad[k] += w * e[k];
    }
    const scale = 1 / (this.asked * this.cfg.sigma);
    const b1 = 0.9;
    const b2 = 0.999;
    const t = this.gen + 1;
    for (let k = 0; k < n; k++) {
      const g = grad[k] * scale - this.cfg.weightDecay * this.mean[k]; // ascent direction
      this.m[k] = b1 * this.m[k] + (1 - b1) * g;
      this.v[k] = b2 * this.v[k] + (1 - b2) * g * g;
      const mh = this.m[k] / (1 - b1 ** t);
      const vh = this.v[k] / (1 - b2 ** t);
      this.mean[k] += (this.cfg.lr * mh) / (Math.sqrt(vh) + 1e-8);
    }
    this.gen++;
  }
  current(): Float32Array {
    return this.mean;
  }
  state(): object {
    return { gen: this.gen, mean: toB64(this.mean), m: toB64(this.m), v: toB64(this.v) };
  }
}

interface GAState {
  gen: number;
  pop: string[];
  best: string;
  lin: Lineage[];
  nextId: number;
  imitShare?: number;
  smooth?: Record<string, number>;
  rates?: Record<string, number>;
}

export class GA implements Algo {
  gen = 0;
  private pop: Float32Array[];
  private lin: Lineage[];
  private best: Float32Array;
  private nextId: number;
  private imitShare: number;
  private smooth: Record<string, number> = {};
  private rates: Record<string, number> = {};
  constructor(
    private cfg: AlgoConfig,
    private shape: NetShape,
    restore?: GAState,
    /** generation 0 seeds: [the network fitted to the replays, the greedy order as a network] */
    init?: Float32Array | { genome: Float32Array; op: 'seed' | 'greedy' }[],
    /** parameter indices of the per-option-kind preference genes (skip weights on k:field…k:park) */
    private prefGenes: number[] = [],
    /** what students learn from and behaviour mutations are checked on (also for generation 0) */
    private teacher: Teacher | null = null,
  ) {
    this.imitShare = cfg.imitRate;
    if (restore) {
      this.gen = restore.gen;
      this.pop = restore.pop.map(fromB64);
      this.best = fromB64(restore.best);
      this.lin = restore.lin;
      this.nextId = restore.nextId;
      this.imitShare = restore.imitShare ?? cfg.imitRate;
      this.smooth = restore.smooth ?? {};
      this.rates = restore.rates ?? {};
    } else if (init) {
      // SEEDED: the seeds exactly (each tagged with what it is), then their mutants (15 % of them
      // behaviour mutations, spread evenly over the seeds), plus GEN0_RANDOM random networks for
      // orders no seed shows
      const seeds = init instanceof Float32Array ? [{ genome: init, op: 'seed' as const }] : init;
      this.pop = seeds.map((q) => new Float32Array(q.genome));
      this.lin = seeds.map((q, i) => ({ id: i, parents: [], op: q.op, muts: 0, born: 0 }));
      const nRand = Math.round(GEN0_RANDOM * (cfg.pop - seeds.length));
      for (let i = seeds.length; i < cfg.pop; i++) {
        const s0 = seedOf(cfg.seed, 'ga-seed', i);
        const from = i % seeds.length;
        const parent = seeds[from].genome;
        if (i >= cfg.pop - nRand) {
          this.pop.push(this.randomNet(s0));
          this.lin.push({ id: i, parents: [], op: 'random', muts: paramCount(shape), born: 0 });
        } else if (mulberry32(seedOf(s0, 'macro?'))() < cfg.macroRate) {
          const m = this.macro(parent, s0);
          this.pop.push(m.child);
          this.lin.push({ id: i, parents: [from], op: 'macro', muts: m.muts, born: 0, changed: m.changed, ...(m.style ? { style: true } : {}) });
        } else {
          const { child, muts } = this.mutate(parent, s0);
          this.pop.push(child);
          this.lin.push({ id: i, parents: [from], op: 'mutant', muts, born: 0 });
        }
      }
      this.best = this.pop[0];
      this.nextId = cfg.pop;
    } else {
      this.pop = Array.from({ length: cfg.pop }, (_, i) => this.randomNet(seedOf(cfg.seed, 'ga-init', i)));
      this.lin = this.pop.map((_, i) => ({ id: i, parents: [], op: 'init', muts: 0, born: 0 }));
      this.best = this.pop[0];
      this.nextId = cfg.pop;
    }
  }
  setConfig(c: Partial<AlgoConfig>): void {
    Object.assign(this.cfg, c); // a new population size takes effect when the next generation is bred
    if (c.imitRate !== undefined || c.imitAdapt === false) this.imitShare = this.cfg.imitRate;
  }
  setTeacher(t: Teacher | null): void {
    this.teacher = t;
  }
  stats(): { rates: Record<string, number>; smooth: Record<string, number>; imitShare: number } {
    return { rates: { ...this.rates }, smooth: { ...this.smooth }, imitShare: this.imitShare };
  }

  /** a random network: random weights, random option preferences, random skill style */
  private randomNet(seed: number): Float32Array {
    const g = gaussFrom(seed);
    const p = initParams(this.shape, g);
    const so = styleOffset(this.shape);
    for (let k = mlpCount(this.shape); k < so; k++) p[k] = 0.3 * g();
    for (let k = so; k < p.length; k++) p[k] = 1.5 * g();
    return p;
  }
  private mutate(p: Float32Array, seed: number): { child: Float32Array; muts: number } {
    const g = gaussFrom(seed);
    const r = mulberry32(seedOf(seed, 'mask'));
    const child = new Float32Array(p);
    let muts = 0;
    for (let k = 0; k < p.length; k++) {
      if (this.cfg.mutProb >= 1 || r() < this.cfg.mutProb) {
        child[k] += this.cfg.sigma * g();
        muts++;
      }
    }
    return { child, muts };
  }
  /** BEHAVIOUR MUTATION: one large, structured change, repeated (stronger each time, up to 10
   * tries) until it changes the chosen option on ≥ MACRO_MIN_CHANGE of the probe decisions — or,
   * for a STYLE gene, until the skill setting it encodes really changes */
  private macro(p: Float32Array, seed: number): { child: Float32Array; muts: number; changed: number; style: boolean } {
    const rng = mulberry32(seedOf(seed, 'macro'));
    const g = gaussFrom(seedOf(seed, 'macro-g'));
    const [nin, nh] = this.shape.sizes;
    const so = styleOffset(this.shape);
    const nStyle = this.shape.style ?? 0;
    const probes = this.teacher?.probes ?? [];
    let child = new Float32Array(p);
    let changed = 0;
    const kinds = [0, 2, ...(this.prefGenes.length ? [1] : []), ...(nStyle ? [3] : [])];
    const kind = kinds[Math.floor(rng() * kinds.length)];
    for (let attempt = 0; attempt < 10; attempt++) {
      child = new Float32Array(p);
      const boost = 1 + attempt;
      if (kind === 0) {
        // a hidden unit re-drawn: its input weights, bias and output weight
        const j = Math.floor(rng() * nh);
        const k = Math.sqrt(1 / nin) * boost;
        for (let i = 0; i < nin; i++) child[j * nin + i] = g() * k;
        child[nin * nh + j] = g() * 0.5 * boost;
        child[nin * nh + nh + j] = g() * Math.sqrt(1 / nh) * 2 * boost;
      } else if (kind === 1) {
        // one option kind suddenly preferred or avoided (a FLOWER-first robot, a shoot-early one…)
        const i = this.prefGenes[Math.floor(rng() * this.prefGenes.length)];
        child[i] += (rng() < 0.5 ? -1 : 1) * (0.5 + rng()) * boost;
      } else if (kind === 2) {
        // a burst of big nudges on a tenth of the network
        for (let i = 0; i < so; i++) if (rng() < 0.1) child[i] += 0.5 * boost * g();
      } else {
        // a skill style gene re-drawn (fire while collecting, react to tips…): accepted once the
        // setting it encodes moves across a threshold (sigmoid 0.5 = the middle of its range)
        const i = so + Math.floor(rng() * nStyle);
        child[i] = (p[i] > 0 ? -1 : 1) * (0.3 + 1.5 * Math.abs(g()));
        break;
      }
      if (!probes.length) break;
      changed = disagreement(this.shape, p, child, probes);
      if (changed >= MACRO_MIN_CHANGE) break;
    }
    // a network change that still does not alter choices is not a behaviour mutation: change a skill
    // setting instead (it crosses the middle of its range, so how the robot acts always changes)
    let style = kind === 3;
    if (!style && probes.length && changed < MACRO_MIN_CHANGE && nStyle) {
      child = new Float32Array(p);
      const i = so + Math.floor(rng() * nStyle);
      child[i] = (p[i] > 0 ? -1 : 1) * (0.3 + 1.5 * Math.abs(g()));
      style = true;
      changed = 0;
    }
    let muts = 0;
    for (let k = 0; k < p.length; k++) if (child[k] !== p[k]) muts++;
    return { child, muts, changed, style };
  }
  /** STUDENT: the parent after a lesson on the replays (and the champion's own decisions) */
  private student(p: Float32Array, seed: number): { child: Float32Array; muts: number; changed: number } {
    const t = this.teacher!;
    const child = new Float32Array(p);
    const rng = mulberry32(seedOf(seed, 'lesson'));
    // half the lesson from the team's replays, half from the champion's own decisions (when there are both)
    const pool = t.exp.length && t.demos.length ? [...t.demos, ...Array.from({ length: t.demos.length }, (_, i) => t.exp[i % t.exp.length])] : t.demos.length ? t.demos : t.exp;
    lesson(this.shape, child, pool, this.cfg.lessonSteps, rng, { upTo: styleOffset(this.shape) });
    let muts = 0;
    for (let k = 0; k < p.length; k++) if (child[k] !== p[k]) muts++;
    return { child, muts, changed: t.probes.length ? disagreement(this.shape, p, child, t.probes) : 0 };
  }

  ask(): Float32Array[] {
    return this.pop;
  }
  lineage(): Lineage[] {
    return this.lin;
  }
  tell(f: number[], keep?: { genome: Float32Array; id: number } | null): void {
    if (f.length !== this.pop.length) throw new Error('tell() needs one fitness per individual');
    const order = f.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(([, i]) => i);
    const rankOf = new Map(order.map((i, k) => [i, k]));
    this.best = this.pop[order[0]];
    const nPar = Math.max(1, Math.floor(this.cfg.truncation * this.pop.length));
    const parents = order.slice(0, nPar); // indices, best first

    // how did each operator's children of THIS generation do: share that reached the parent set
    this.rates = {};
    for (const op of OPS) {
      const mine = this.lin.map((l, i) => (l.op === op && l.born === this.gen ? i : -1)).filter((i) => i >= 0);
      if (!mine.length) continue;
      const rate = mine.filter((i) => rankOf.get(i)! < nPar).length / mine.length;
      this.rates[op] = rate;
      this.smooth[op] = this.smooth[op] === undefined ? rate : 0.7 * this.smooth[op] + 0.3 * rate;
    }
    // ADAPTIVE PURSUIT: the students' share moves toward its maximum while students do better than
    // plain mutants, toward its minimum while they do worse
    const canTeach = !!this.teacher && (this.teacher.demos.length > 0 || this.teacher.exp.length > 0);
    if (!canTeach) this.imitShare = this.cfg.imitRate;
    else if (this.cfg.imitAdapt && this.smooth.student !== undefined && this.smooth.mutant !== undefined) {
      const target = this.smooth.student > this.smooth.mutant ? this.cfg.imitMax : this.smooth.student < this.smooth.mutant ? this.cfg.imitMin : this.imitShare;
      this.imitShare = Math.min(this.cfg.imitMax, Math.max(this.cfg.imitMin, this.imitShare + 0.3 * (target - this.imitShare)));
    } else if (!this.cfg.imitAdapt) this.imitShare = this.cfg.imitRate;

    const next: Float32Array[] = [];
    const lin: Lineage[] = [];
    for (const i of order.slice(0, Math.min(this.cfg.elite, this.cfg.pop - 1))) {
      next.push(this.pop[i]);
      lin.push({ id: this.lin[i].id, born: this.lin[i].born, op: 'elite', parents: [this.lin[i].id], muts: 0 }); // same id: it survives
    }
    // the validated champion is never lost (hall of fame)
    if (keep && !lin.some((l) => l.id === keep.id) && next.length < this.cfg.pop) {
      next.push(new Float32Array(keep.genome));
      lin.push({ id: keep.id, parents: [keep.id], op: 'champion', muts: 0, born: this.gen + 1 });
    }
    const r = mulberry32(seedOf(this.cfg.seed, 'ga-select', this.gen));
    // tournament among the parents: the best-ranked of `tournament` random picks
    const pick = (): number => {
      let b = parents[Math.floor(r() * parents.length)];
      for (let k = 1; k < this.cfg.tournament; k++) {
        const c = parents[Math.floor(r() * parents.length)];
        if (rankOf.get(c)! < rankOf.get(b)!) b = c;
      }
      return b;
    };
    const share = canTeach ? this.imitShare : 0;
    for (let c = next.length; c < this.cfg.pop; c++) {
      const seed = seedOf(this.cfg.seed, 'ga-mut', this.gen, c);
      const u = r();
      const born = this.gen + 1;
      if (u < share) {
        const a = pick();
        const s = this.student(this.pop[a], seed);
        next.push(s.child);
        lin.push({ id: this.nextId++, parents: [this.lin[a].id], op: 'student', muts: s.muts, born, changed: s.changed });
      } else if (u < share + this.cfg.immigrants) {
        next.push(this.randomNet(seed));
        lin.push({ id: this.nextId++, parents: [], op: 'random', muts: paramCount(this.shape), born });
      } else if (u < share + this.cfg.immigrants + this.cfg.macroRate) {
        const a = pick();
        const m = this.macro(this.pop[a], seed);
        next.push(m.child);
        lin.push({ id: this.nextId++, parents: [this.lin[a].id], op: 'macro', muts: m.muts, born, changed: m.changed, ...(m.style ? { style: true } : {}) });
      } else if (parents.length > 1 && r() < this.cfg.crossRate) {
        const a = pick();
        let b = pick();
        for (let k = 0; k < 4 && b === a; k++) b = pick();
        const mask = mulberry32(seedOf(seed, 'cross'));
        const mix = new Float32Array(this.pop[a].length);
        for (let k = 0; k < mix.length; k++) mix[k] = mask() < 0.5 ? this.pop[a][k] : this.pop[b][k];
        const { child, muts } = this.mutate(mix, seed);
        next.push(child);
        lin.push({ id: this.nextId++, parents: [this.lin[a].id, this.lin[b].id], op: 'cross', muts, born });
      } else {
        const a = pick();
        const { child, muts } = this.mutate(this.pop[a], seed);
        next.push(child);
        lin.push({ id: this.nextId++, parents: [this.lin[a].id], op: 'mutant', muts, born });
      }
    }
    this.pop = next;
    this.lin = lin;
    this.gen++;
  }
  current(): Float32Array {
    return this.best;
  }
  state(): object {
    const s: GAState = { gen: this.gen, pop: this.pop.map(toB64), best: toB64(this.best), lin: this.lin, nextId: this.nextId, imitShare: this.imitShare, smooth: this.smooth, rates: this.rates };
    return s;
  }
}

export function makeAlgo(cfg: AlgoConfig, shape: NetShape, restore?: object, init?: Float32Array | { genome: Float32Array; op: 'seed' | 'greedy' }[], prefGenes: number[] = [], teacher: Teacher | null = null): Algo {
  const first = init instanceof Float32Array ? init : init?.[0]?.genome;
  return cfg.algo === 'es' ? new ES(cfg, shape, restore as never, first) : new GA(cfg, shape, restore as GAState | undefined, init, prefGenes, teacher);
}
