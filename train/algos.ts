// EVOLUTION over a flat parameter vector. Both algorithms are fully seeded and serializable, so a
// run can stop and resume bit-exactly (train/check.ts proves it); hyperparameters can be changed
// between generations (setConfig), and the change is part of the checkpoint.
//   · GA — deep neuroevolution GA (Such et al. 2017) + uniform crossover: elitism, tournament
//     selection among the top fraction, Gaussian mutation. Every individual has an id, parents and
//     the operator that made it, so the viewer can show lineage and mutations. Policy = the best.
//   · ES — OpenAI evolution strategies (Salimans et al. 2017): mirrored noise pairs, centered-rank
//     fitness shaping, Adam on the mean, weight decay. Policy = the MEAN.
import { mulberry32, seedOf } from '../harness/rng';
import { fromB64, initParams, toB64, type NetShape } from './net';

export type AlgoName = 'es' | 'ga';

function gaussFrom(seed: number): () => number {
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
  crossRate: number; // GA: fraction of children made by crossover of two parents
  mutProb: number; // GA: probability each gene is mutated (1 = every gene, the deep-GA default)
  tournament: number; // GA: tournament size among the parents
}
export const TUNABLE = ['pop', 'sigma', 'lr', 'elite', 'truncation', 'weightDecay', 'crossRate', 'mutProb', 'tournament'] as const;
export const DEFAULTS: Record<AlgoName, Omit<AlgoConfig, 'seed' | 'pop'>> = {
  es: { algo: 'es', sigma: 0.05, lr: 0.02, elite: 0, truncation: 0, weightDecay: 0.005, crossRate: 0, mutProb: 1, tournament: 0 },
  ga: { algo: 'ga', sigma: 0.05, lr: 0, elite: 4, truncation: 0.25, weightDecay: 0, crossRate: 0.3, mutProb: 0.2, tournament: 3 },
};

/** where an individual came from */
export interface Lineage {
  id: number;
  parents: number[];
  op: 'init' | 'seed' | 'elite' | 'mutant' | 'cross' | 'es+' | 'es-';
  muts: number; // genes changed by mutation
  born: number; // generation
}

export interface Algo {
  readonly gen: number;
  /** the parameter vectors to evaluate this generation */
  ask(): Float32Array[];
  /** where each asked vector came from (same order) */
  lineage(): Lineage[];
  /** fitness for each asked vector, same order; advances one generation */
  tell(fitness: number[]): void;
  /** the policy this algorithm currently stands behind (ES: mean; GA: best of last generation) */
  current(): Float32Array;
  setConfig(c: Partial<AlgoConfig>): void;
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
    if (!Number.isInteger(c.elite) || c.elite < 0 || c.elite >= c.pop) return 'elites must be a whole number below the population';
    if (!(c.truncation > 0 && c.truncation <= 1)) return 'parent fraction must be in (0, 1]';
    if (!(c.crossRate >= 0 && c.crossRate <= 1)) return 'crossover rate must be in [0, 1]';
    if (!(c.mutProb > 0 && c.mutProb <= 1)) return 'gene mutation probability must be in (0, 1]';
    if (!Number.isInteger(c.tournament) || c.tournament < 1) return 'tournament size must be a whole number ≥ 1';
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

export class GA implements Algo {
  gen = 0;
  private pop: Float32Array[];
  private lin: Lineage[];
  private best: Float32Array;
  private nextId: number;
  constructor(
    private cfg: AlgoConfig,
    shape: NetShape,
    restore?: { gen: number; pop: string[]; best: string; lin: Lineage[]; nextId: number },
    init?: Float32Array,
  ) {
    if (restore) {
      this.gen = restore.gen;
      this.pop = restore.pop.map(fromB64);
      this.best = fromB64(restore.best);
      this.lin = restore.lin;
      this.nextId = restore.nextId;
    } else if (init) {
      // SEEDED: individual 0 is the given network exactly, the rest are its mutants
      this.pop = [new Float32Array(init)];
      this.lin = [{ id: 0, parents: [], op: 'seed', muts: 0, born: 0 }];
      for (let i = 1; i < cfg.pop; i++) {
        const { child, muts } = this.mutate(init, seedOf(cfg.seed, 'ga-seed', i));
        this.pop.push(child);
        this.lin.push({ id: i, parents: [0], op: 'mutant', muts, born: 0 });
      }
      this.best = this.pop[0];
      this.nextId = cfg.pop;
    } else {
      this.pop = Array.from({ length: cfg.pop }, (_, i) => initParams(shape, gaussFrom(seedOf(cfg.seed, 'ga-init', i))));
      this.lin = this.pop.map((_, i) => ({ id: i, parents: [], op: 'init', muts: 0, born: 0 }));
      this.best = this.pop[0];
      this.nextId = cfg.pop;
    }
  }
  setConfig(c: Partial<AlgoConfig>): void {
    Object.assign(this.cfg, c); // a new population size takes effect when the next generation is bred
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
  ask(): Float32Array[] {
    return this.pop;
  }
  lineage(): Lineage[] {
    return this.lin;
  }
  tell(f: number[]): void {
    if (f.length !== this.pop.length) throw new Error('tell() needs one fitness per individual');
    const order = f.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(([, i]) => i);
    this.best = this.pop[order[0]];
    const nPar = Math.max(1, Math.floor(this.cfg.truncation * this.pop.length));
    const parents = order.slice(0, nPar); // indices, best first
    const next: Float32Array[] = [];
    const lin: Lineage[] = [];
    for (const i of order.slice(0, Math.min(this.cfg.elite, this.cfg.pop))) {
      next.push(this.pop[i]);
      lin.push({ ...this.lin[i], op: 'elite', parents: [this.lin[i].id], muts: 0 }); // same id: it survives
    }
    const r = mulberry32(seedOf(this.cfg.seed, 'ga-select', this.gen));
    // tournament among the parents: the best-ranked of `tournament` random picks
    const pick = (): number => {
      let b = parents[Math.floor(r() * parents.length)];
      for (let k = 1; k < this.cfg.tournament; k++) {
        const c = parents[Math.floor(r() * parents.length)];
        if (order.indexOf(c) < order.indexOf(b)) b = c;
      }
      return b;
    };
    for (let c = next.length; c < this.cfg.pop; c++) {
      const a = pick();
      const seed = seedOf(this.cfg.seed, 'ga-mut', this.gen, c);
      if (parents.length > 1 && r() < this.cfg.crossRate) {
        let b = pick();
        for (let k = 0; k < 4 && b === a; k++) b = pick();
        const mask = mulberry32(seedOf(seed, 'cross'));
        const mix = new Float32Array(this.pop[a].length);
        for (let k = 0; k < mix.length; k++) mix[k] = mask() < 0.5 ? this.pop[a][k] : this.pop[b][k];
        const { child, muts } = this.mutate(mix, seed);
        next.push(child);
        lin.push({ id: this.nextId++, parents: [this.lin[a].id, this.lin[b].id], op: 'cross', muts, born: this.gen + 1 });
      } else {
        const { child, muts } = this.mutate(this.pop[a], seed);
        next.push(child);
        lin.push({ id: this.nextId++, parents: [this.lin[a].id], op: 'mutant', muts, born: this.gen + 1 });
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
    return { gen: this.gen, pop: this.pop.map(toB64), best: toB64(this.best), lin: this.lin, nextId: this.nextId };
  }
}

export function makeAlgo(cfg: AlgoConfig, shape: NetShape, restore?: object, init?: Float32Array): Algo {
  return cfg.algo === 'es' ? new ES(cfg, shape, restore as never, init) : new GA(cfg, shape, restore as never, init);
}
