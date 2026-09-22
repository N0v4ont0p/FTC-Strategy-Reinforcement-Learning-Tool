// BEHAVIOUR CLONING on DECISIONS — the one place that learns from examples by gradient, used by
// both the fit to the team's replays (train/imitate.ts) and the "students" evolution breeds every
// generation (train/algos.ts). A decision is the world as the robot saw it (the global
// observation, once) + every option it had (their features) + which one was taken. The loss is
// the listwise softmax cross-entropy the policy's argmax implies: raise the chosen option's score
// against the others. Anything the same for every option cancels in it (e.g. the skip weights on
// the global observation), which is correct: it cannot change a choice.
import { skipOffset, type NetShape } from './net';

export interface Sample {
  obs: Float32Array; // the global observation (N_OBS)
  feats: Float32Array; // k × N_OPT_FEATS, option by option
  k: number;
  y: number; // index of the chosen option
}

/** many samples as three flat arrays — how they are cached, checkpointed and passed to workers */
export interface Packed {
  n: number;
  obs: string; // base64 Float32, n × nObs
  feats: string; // base64 Float32, Σk × nFeat
  ks: number[];
  ys: number[];
}

const b64 = (a: Float32Array): string => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
const f32 = (s: string): Float32Array => {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

export function pack(S: Sample[]): Packed {
  const nObs = S[0]?.obs.length ?? 0;
  const obs = new Float32Array(S.length * nObs);
  const feats = new Float32Array(S.reduce((a, s) => a + s.feats.length, 0));
  let o = 0;
  S.forEach((s, i) => {
    obs.set(s.obs, i * nObs);
    feats.set(s.feats, o);
    o += s.feats.length;
  });
  return { n: S.length, obs: b64(obs), feats: b64(feats), ks: S.map((s) => s.k), ys: S.map((s) => s.y) };
}
export function unpack(P: Packed, nObs: number, nFeat: number): Sample[] {
  const obs = f32(P.obs);
  const feats = f32(P.feats);
  const out: Sample[] = [];
  let o = 0;
  for (let i = 0; i < P.n; i++) {
    const k = P.ks[i];
    out.push({ obs: obs.subarray(i * nObs, (i + 1) * nObs), feats: feats.subarray(o, o + k * nFeat), k, y: P.ys[i] });
    o += k * nFeat;
  }
  if (obs.length !== P.n * nObs || o !== feats.length) throw new Error('decision samples do not match the network (they were made for another version)');
  return out;
}

/** the network's score for every option of one decision (shape [nin, nh, 1] + optional skip).
 * The hidden layer's input part that is the same for every option is computed once. */
function forward(shape: NetShape, p: Float32Array, s: Sample, H: Float32Array[], z: Float64Array): void {
  const [nin, nh] = shape.sizes;
  const nObs = s.obs.length;
  const nF = nin - nObs;
  const b1 = nin * nh;
  const w2 = b1 + nh;
  const b2 = w2 + nh;
  const sk = shape.skip ? skipOffset(shape) + nObs : -1;
  const base = new Float64Array(nh);
  for (let j = 0; j < nh; j++) {
    let v = p[b1 + j];
    const row = j * nin;
    for (let i = 0; i < nObs; i++) v += p[row + i] * s.obs[i];
    base[j] = v;
  }
  for (let r = 0; r < s.k; r++) {
    const f = r * nF;
    const h = (H[r] ??= new Float32Array(nh));
    let out = p[b2];
    for (let j = 0; j < nh; j++) {
      let v = base[j];
      const row = j * nin + nObs;
      for (let i = 0; i < nF; i++) v += p[row + i] * s.feats[f + i];
      h[j] = Math.tanh(v);
      out += p[w2 + j] * h[j];
    }
    if (sk >= 0) for (let i = 0; i < nF; i++) out += p[sk + i] * s.feats[f + i];
    z[r] = out;
  }
}

function checkShape(shape: NetShape): void {
  if (shape.sizes.length !== 3 || shape.sizes[2] !== 1) throw new Error('behaviour cloning supports [inputs, hidden, 1] networks'); // ponytail: one hidden layer, the policy's shape; generalize if the policy grows a layer
}

/** the option the network would take */
export function choose(shape: NetShape, p: Float32Array, s: Sample): number {
  checkShape(shape);
  const z = new Float64Array(s.k);
  forward(shape, p, s, [], z);
  let b = 0;
  for (let r = 1; r < s.k; r++) if (z[r] > z[b]) b = r;
  return b;
}

/** share of decisions where two networks choose differently */
export function disagreement(shape: NetShape, a: Float32Array, b: Float32Array, S: Sample[]): number {
  if (!S.length) return 0;
  let d = 0;
  for (const s of S) if (choose(shape, a, s) !== choose(shape, b, s)) d++;
  return d / S.length;
}

/** loss of one decision; adds d loss / d params into `g` when given */
export function lossAndGrad(shape: NetShape, p: Float32Array, s: Sample, g: Float32Array | null): { loss: number; hit: boolean } {
  checkShape(shape);
  const [nin, nh] = shape.sizes;
  const nObs = s.obs.length;
  const nF = nin - nObs;
  const b1 = nin * nh;
  const w2 = b1 + nh;
  const b2 = w2 + nh;
  const H: Float32Array[] = [];
  const z = new Float64Array(s.k);
  forward(shape, p, s, H, z);
  let m = -Infinity;
  let arg = 0;
  for (let r = 0; r < s.k; r++)
    if (z[r] > m) {
      m = z[r];
      arg = r;
    }
  let Z = 0;
  const e = new Float64Array(s.k);
  for (let r = 0; r < s.k; r++) Z += e[r] = Math.exp(z[r] - m);
  const loss = -(z[s.y] - m - Math.log(Z));
  if (g) {
    const sk = shape.skip ? skipOffset(shape) + nObs : -1;
    const dObs = new Float64Array(nh); // d loss / d hidden pre-activation, summed: the obs part is shared
    for (let r = 0; r < s.k; r++) {
      const dz = e[r] / Z - (r === s.y ? 1 : 0);
      if (dz === 0) continue;
      g[b2] += dz;
      const f = r * nF;
      if (sk >= 0) for (let i = 0; i < nF; i++) g[sk + i] += dz * s.feats[f + i];
      const h = H[r];
      for (let j = 0; j < nh; j++) {
        g[w2 + j] += dz * h[j];
        const dh = dz * p[w2 + j] * (1 - h[j] * h[j]);
        g[b1 + j] += dh;
        dObs[j] += dh;
        const row = j * nin + nObs;
        for (let i = 0; i < nF; i++) g[row + i] += dh * s.feats[f + i];
      }
    }
    for (let j = 0; j < nh; j++) {
      const row = j * nin;
      for (let i = 0; i < nObs; i++) g[row + i] += dObs[j] * s.obs[i];
    }
  }
  return { loss, hit: arg === s.y };
}

export function evaluate(shape: NetShape, p: Float32Array, S: Sample[]): { loss: number; agree: number } {
  let L = 0;
  let A = 0;
  for (const s of S) {
    const r = lossAndGrad(shape, p, s, null);
    L += r.loss;
    A += r.hit ? 1 : 0;
  }
  return { loss: S.length ? L / S.length : 0, agree: S.length ? A / S.length : 0 };
}

/** Adam on a parameter vector; `upTo` limits the update to the first genes (the style genes after
 * them are not the network's and are never touched by a gradient) */
export class Adam {
  private m: Float32Array;
  private v: Float32Array;
  private t = 0;
  constructor(
    n: number,
    private lr: number,
    private decay = 1e-4,
  ) {
    this.m = new Float32Array(n);
    this.v = new Float32Array(n);
  }
  step(p: Float32Array, g: Float32Array, scale: number, upTo = p.length): void {
    this.t++;
    const c1 = 1 - 0.9 ** this.t;
    const c2 = 1 - 0.999 ** this.t;
    for (let k = 0; k < upTo; k++) {
      const gk = g[k] * scale + this.decay * p[k];
      this.m[k] = 0.9 * this.m[k] + 0.1 * gk;
      this.v[k] = 0.999 * this.v[k] + 0.001 * gk * gk;
      p[k] -= (this.lr * (this.m[k] / c1)) / (Math.sqrt(this.v[k] / c2) + 1e-8);
    }
  }
}

/** `steps` minibatch Adam steps on decisions drawn from `pool` (with replacement, from `rng`) —
 * a student's lesson. Changes `p` in place. */
export function lesson(shape: NetShape, p: Float32Array, pool: Sample[], steps: number, rng: () => number, o: { batch?: number; lr?: number; upTo?: number } = {}): void {
  if (!pool.length || steps <= 0) return;
  const batch = o.batch ?? 16;
  const opt = new Adam(p.length, o.lr ?? 0.003);
  const g = new Float32Array(p.length);
  for (let t = 0; t < steps; t++) {
    g.fill(0);
    for (let b = 0; b < batch; b++) lossAndGrad(shape, p, pool[Math.floor(rng() * pool.length)], g);
    opt.step(p, g, 1 / batch, o.upTo);
  }
}
