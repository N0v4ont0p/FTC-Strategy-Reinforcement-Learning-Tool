// EVOLUTION over a flat parameter vector. Both algorithms are fully seeded and serializable, so a
// run can stop and resume bit-exactly (train/check.ts proves it).
//   · ES — OpenAI evolution strategies (Salimans et al. 2017): mirrored noise pairs, centered-rank
//     fitness shaping, Adam on the mean, weight decay. The policy is the MEAN.
//   · GA — deep neuroevolution GA (Such et al. 2017): elitism, truncation selection, Gaussian
//     mutation. The policy is the BEST individual.
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
  weightDecay: number;
}
export const DEFAULTS: Record<AlgoName, Omit<AlgoConfig, 'seed' | 'pop'>> = {
  es: { algo: 'es', sigma: 0.05, lr: 0.02, elite: 0, truncation: 0, weightDecay: 0.005 },
  ga: { algo: 'ga', sigma: 0.02, lr: 0, elite: 1, truncation: 0.2, weightDecay: 0 },
};

export interface Algo {
  readonly gen: number;
  /** the parameter vectors to evaluate this generation */
  ask(): Float32Array[];
  /** fitness for each asked vector, same order; advances one generation */
  tell(fitness: number[]): void;
  /** the policy this algorithm currently stands behind (ES: mean; GA: best of last generation) */
  current(): Float32Array;
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

export class ES implements Algo {
  gen = 0;
  private mean: Float32Array;
  private m: Float32Array;
  private v: Float32Array;
  private eps: Float32Array[] = [];
  constructor(private cfg: AlgoConfig, shape: NetShape, restore?: { gen: number; mean: string; m: string; v: string }) {
    if (cfg.pop % 2) throw new Error('ES needs an even population (mirrored pairs)');
    if (restore) {
      this.gen = restore.gen;
      this.mean = fromB64(restore.mean);
      this.m = fromB64(restore.m);
      this.v = fromB64(restore.v);
    } else {
      this.mean = initParams(shape, gaussFrom(seedOf(cfg.seed, 'init')));
      this.m = new Float32Array(this.mean.length);
      this.v = new Float32Array(this.mean.length);
    }
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
    return out;
  }
  tell(f: number[]): void {
    if (f.length !== this.cfg.pop || this.eps.length !== this.cfg.pop / 2) throw new Error('tell() must follow ask() with one fitness per candidate');
    const u = centeredRanks(f);
    const n = this.mean.length;
    const grad = new Float32Array(n);
    for (let i = 0; i < this.eps.length; i++) {
      const w = u[2 * i] - u[2 * i + 1];
      const e = this.eps[i];
      for (let k = 0; k < n; k++) grad[k] += w * e[k];
    }
    const scale = 1 / (this.cfg.pop * this.cfg.sigma);
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
  private best: Float32Array;
  constructor(private cfg: AlgoConfig, shape: NetShape, restore?: { gen: number; pop: string[]; best: string }) {
    if (restore) {
      this.gen = restore.gen;
      this.pop = restore.pop.map(fromB64);
      this.best = fromB64(restore.best);
    } else {
      this.pop = Array.from({ length: cfg.pop }, (_, i) => initParams(shape, gaussFrom(seedOf(cfg.seed, 'ga-init', i))));
      this.best = this.pop[0];
    }
  }
  ask(): Float32Array[] {
    return this.pop;
  }
  tell(f: number[]): void {
    if (f.length !== this.pop.length) throw new Error('tell() needs one fitness per individual');
    const order = f.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
    this.best = this.pop[order[0]];
    const parents = order.slice(0, Math.max(1, Math.floor(this.cfg.truncation * this.pop.length))).map((i) => this.pop[i]);
    const next: Float32Array[] = order.slice(0, this.cfg.elite).map((i) => this.pop[i]);
    const r = mulberry32(seedOf(this.cfg.seed, 'ga-select', this.gen));
    for (let c = next.length; c < this.pop.length; c++) {
      const p = parents[Math.floor(r() * parents.length)];
      const g = gaussFrom(seedOf(this.cfg.seed, 'ga-mut', this.gen, c));
      const child = new Float32Array(p.length);
      for (let k = 0; k < p.length; k++) child[k] = p[k] + this.cfg.sigma * g();
      next.push(child);
    }
    this.pop = next;
    this.gen++;
  }
  current(): Float32Array {
    return this.best;
  }
  state(): object {
    return { gen: this.gen, pop: this.pop.map(toB64), best: toB64(this.best) };
  }
}

export function makeAlgo(cfg: AlgoConfig, shape: NetShape, restore?: object): Algo {
  return cfg.algo === 'es' ? new ES(cfg, shape, restore as never) : new GA(cfg, shape, restore as never);
}
