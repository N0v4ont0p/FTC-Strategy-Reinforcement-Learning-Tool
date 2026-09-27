// THE ENTITY NETWORK (MASTERPLAN §6, phase 4) — the robot's judgement, reading the field the way it
// is: a SET of things (every robot, every element) rather than v1's fixed list of the six nearest
// elements. Each option (a job the robot could start now) attends over every entity — its partner,
// the elements, what is in the HIVE — and the network scores the option in POINTS.
//
//   entities e_i  → h_i = relu(We·e_i + be)                           (D)
//   global g      → G   = relu(Wg·g + bg)                             (D)  (the v1 observation)
//   option o_j    → u_j = relu(Wo·o_j + Wog·G + bo)                   (D)
//   attention      a_ij = softmax_i((Wq·u_j)·(Wk·h_i)/√A),  c_j = Σ_i a_ij·(Wv·h_i)   (A)
//   option value   z_j = relu(W1·[u_j; c_j; G] + b1),  q_j = w2·z_j + b2         (points)
//   state value    y = relu(Wy·[G; mean_i h_i] + by),  v = wv·y + bv            (points to come)
//
// Plain Float32 maths, forward AND backward by hand (checked against finite differences in the
// gate), Adam, deterministic. ~15 k parameters: small enough to train on the CPU while every other
// core plays. The flat parameter vector ends with the skill-setting genes (train/policy.ts STYLE),
// which the network itself never reads.
export interface EntShape {
  G: number; // global features
  F: number; // entity features
  O: number; // option features
  D: number; // embedding width
  A: number; // attention width
  H: number; // head width
  style: number; // skill genes appended
}

type Blocks = Record<'We' | 'be' | 'Wg' | 'bg' | 'Wo' | 'Wog' | 'bo' | 'Wq' | 'Wk' | 'Wv' | 'W1' | 'b1' | 'w2' | 'b2' | 'Wy' | 'by' | 'wv' | 'bv', [number, number]>;
/** where each weight block sits in the flat vector: [offset, length] */
export function layout(s: EntShape): { blocks: Blocks; total: number; style: number } {
  const sizes: [keyof Blocks, number][] = [
    ['We', s.D * s.F], ['be', s.D],
    ['Wg', s.D * s.G], ['bg', s.D],
    ['Wo', s.D * s.O], ['Wog', s.D * s.D], ['bo', s.D],
    ['Wq', s.A * s.D], ['Wk', s.A * s.D], ['Wv', s.A * s.D],
    ['W1', s.H * (2 * s.D + s.A)], ['b1', s.H], ['w2', s.H], ['b2', 1],
    ['Wy', s.H * 2 * s.D], ['by', s.H], ['wv', s.H], ['bv', 1],
  ];
  const blocks = {} as Blocks;
  let o = 0;
  for (const [k, n] of sizes) {
    blocks[k] = [o, n];
    o += n;
  }
  return { blocks, total: o + s.style, style: o };
}
export const entCount = (s: EntShape): number => layout(s).total;

/** Xavier-like start from a seeded normal source; biases 0; style genes at their defaults */
export function entInit(s: EntShape, gauss: () => number, style?: readonly number[]): Float32Array {
  const L = layout(s);
  const p = new Float32Array(L.total);
  const fanIn: Partial<Record<keyof Blocks, number>> = { We: s.F, Wg: s.G, Wo: s.O + s.D, Wog: s.O + s.D, Wq: s.D, Wk: s.D, Wv: s.D, W1: 2 * s.D + s.A, w2: s.H, Wy: 2 * s.D, wv: s.H };
  for (const [k, [o, n]] of Object.entries(L.blocks) as [keyof Blocks, [number, number]][]) {
    const f = fanIn[k];
    if (f) for (let i = 0; i < n; i++) p[o + i] = gauss() * Math.sqrt(1 / f);
  }
  if (style) p.set(style, L.style);
  return p;
}

/** one decision's input: the global vector, n entities × F, k options × O */
export interface EntInput {
  g: Float32Array;
  e: Float32Array;
  n: number;
  o: Float32Array;
  k: number;
}

/** everything the forward pass keeps for the backward pass */
interface Trace {
  G: Float32Array; // D
  Gpre: Float32Array;
  h: Float32Array; // n × D
  hpre: Float32Array;
  u: Float32Array; // k × D
  upre: Float32Array;
  qv: Float32Array; // k × A  (queries)
  kk: Float32Array; // n × A  (keys)
  vv: Float32Array; // n × A  (values)
  a: Float32Array; // k × n  (attention)
  c: Float32Array; // k × A
  z: Float32Array; // k × H
  zpre: Float32Array;
  q: Float32Array; // k
  hm: Float32Array; // D (mean of h)
  y: Float32Array; // H
  ypre: Float32Array;
  v: number;
}

const relu = (x: number): number => (x > 0 ? x : 0);

export class EntNet {
  readonly L: ReturnType<typeof layout>;
  constructor(
    readonly s: EntShape,
    readonly p: Float32Array,
  ) {
    this.L = layout(s);
    if (p.length !== this.L.total) throw new Error(`entity network: ${p.length} parameters, expected ${this.L.total}`);
  }
  private at(k: keyof Blocks): number {
    return this.L.blocks[k][0];
  }
  style(): Float32Array {
    return this.p.subarray(this.L.style, this.L.style + this.s.style);
  }

  /** the option values (points) and the state value, with the trace for backward */
  forward(x: EntInput): Trace {
    const { D, A, H, F, G: NG, O } = this.s;
    const p = this.p;
    const n = x.n;
    const k = x.k;
    // global
    const Gpre = new Float32Array(D);
    const Gv = new Float32Array(D);
    {
      const W = this.at('Wg');
      const b = this.at('bg');
      for (let d = 0; d < D; d++) {
        let v = p[b + d];
        const row = W + d * NG;
        for (let i = 0; i < NG; i++) v += p[row + i] * x.g[i];
        Gpre[d] = v;
        Gv[d] = relu(v);
      }
    }
    // entities
    const hpre = new Float32Array(n * D);
    const h = new Float32Array(n * D);
    const hm = new Float32Array(D);
    {
      const W = this.at('We');
      const b = this.at('be');
      for (let i = 0; i < n; i++)
        for (let d = 0; d < D; d++) {
          let v = p[b + d];
          const row = W + d * F;
          for (let f = 0; f < F; f++) v += p[row + f] * x.e[i * F + f];
          hpre[i * D + d] = v;
          const r = relu(v);
          h[i * D + d] = r;
          hm[d] += r / Math.max(1, n);
        }
    }
    // keys and values
    const kk = new Float32Array(n * A);
    const vv = new Float32Array(n * A);
    {
      const Wk = this.at('Wk');
      const Wv = this.at('Wv');
      for (let i = 0; i < n; i++)
        for (let a = 0; a < A; a++) {
          let sk = 0;
          let sv = 0;
          for (let d = 0; d < D; d++) {
            const hd = h[i * D + d];
            sk += p[Wk + a * D + d] * hd;
            sv += p[Wv + a * D + d] * hd;
          }
          kk[i * A + a] = sk;
          vv[i * A + a] = sv;
        }
    }
    // options
    const upre = new Float32Array(k * D);
    const u = new Float32Array(k * D);
    const qv = new Float32Array(k * A);
    const att = new Float32Array(k * n);
    const c = new Float32Array(k * A);
    const zpre = new Float32Array(k * H);
    const z = new Float32Array(k * H);
    const q = new Float32Array(k);
    const Wo = this.at('Wo');
    const Wog = this.at('Wog');
    const bo = this.at('bo');
    const Wq = this.at('Wq');
    const W1 = this.at('W1');
    const b1 = this.at('b1');
    const w2 = this.at('w2');
    const b2 = this.at('b2');
    const IN = 2 * D + A;
    const scale = 1 / Math.sqrt(A);
    for (let j = 0; j < k; j++) {
      for (let d = 0; d < D; d++) {
        let v = p[bo + d];
        for (let f = 0; f < O; f++) v += p[Wo + d * O + f] * x.o[j * O + f];
        for (let e = 0; e < D; e++) v += p[Wog + d * D + e] * Gv[e];
        upre[j * D + d] = v;
        u[j * D + d] = relu(v);
      }
      for (let a = 0; a < A; a++) {
        let v = 0;
        for (let d = 0; d < D; d++) v += p[Wq + a * D + d] * u[j * D + d];
        qv[j * A + a] = v;
      }
      // attention over the entities (a set: no position, no order)
      let mx = -Infinity;
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let a = 0; a < A; a++) s += qv[j * A + a] * kk[i * A + a];
        s *= scale;
        att[j * n + i] = s;
        if (s > mx) mx = s;
      }
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const e = Math.exp(att[j * n + i] - mx);
        att[j * n + i] = e;
        sum += e;
      }
      for (let i = 0; i < n; i++) att[j * n + i] /= sum || 1;
      for (let a = 0; a < A; a++) {
        let v = 0;
        for (let i = 0; i < n; i++) v += att[j * n + i] * vv[i * A + a];
        c[j * A + a] = v;
      }
      // the option's value
      let out = p[b2];
      for (let hh = 0; hh < H; hh++) {
        let v = p[b1 + hh];
        const row = W1 + hh * IN;
        for (let d = 0; d < D; d++) v += p[row + d] * u[j * D + d];
        for (let a = 0; a < A; a++) v += p[row + D + a] * c[j * A + a];
        for (let d = 0; d < D; d++) v += p[row + D + A + d] * Gv[d];
        zpre[j * H + hh] = v;
        const r = relu(v);
        z[j * H + hh] = r;
        out += p[w2 + hh] * r;
      }
      q[j] = out;
    }
    // the state value
    const ypre = new Float32Array(H);
    const y = new Float32Array(H);
    let vOut = this.p[this.at('bv')];
    {
      const Wy = this.at('Wy');
      const by = this.at('by');
      const wv = this.at('wv');
      for (let hh = 0; hh < H; hh++) {
        let v = p[by + hh];
        const row = Wy + hh * 2 * D;
        for (let d = 0; d < D; d++) v += p[row + d] * Gv[d];
        for (let d = 0; d < D; d++) v += p[row + D + d] * hm[d];
        ypre[hh] = v;
        y[hh] = relu(v);
        vOut += p[wv + hh] * y[hh];
      }
    }
    return { G: Gv, Gpre, h, hpre, u, upre, qv, kk, vv, a: att, c, z, zpre, q, hm, y, ypre, v: vOut };
  }

  /** add ∂loss/∂p into `g`, given ∂loss/∂q (per option) and ∂loss/∂v */
  backward(x: EntInput, t: Trace, dq: ArrayLike<number>, dv: number, g: Float32Array): void {
    const { D, A, H, F, G: NG, O } = this.s;
    const p = this.p;
    const n = x.n;
    const k = x.k;
    const IN = 2 * D + A;
    const scale = 1 / Math.sqrt(A);
    const dG = new Float32Array(D);
    const dh = new Float32Array(n * D);
    const dk = new Float32Array(n * A);
    const dvv = new Float32Array(n * A);
    const W1 = this.at('W1');
    const b1 = this.at('b1');
    const w2 = this.at('w2');
    const b2 = this.at('b2');
    const Wq = this.at('Wq');
    const Wo = this.at('Wo');
    const Wog = this.at('Wog');
    const bo = this.at('bo');
    for (let j = 0; j < k; j++) {
      const dqj = dq[j];
      if (dqj === 0) continue;
      g[b2] += dqj;
      const du = new Float32Array(D);
      const dc = new Float32Array(A);
      for (let hh = 0; hh < H; hh++) {
        g[w2 + hh] += dqj * t.z[j * H + hh];
        if (t.zpre[j * H + hh] <= 0) continue;
        const dz = dqj * p[w2 + hh];
        g[b1 + hh] += dz;
        const row = W1 + hh * IN;
        for (let d = 0; d < D; d++) {
          g[row + d] += dz * t.u[j * D + d];
          du[d] += dz * p[row + d];
        }
        for (let a = 0; a < A; a++) {
          g[row + D + a] += dz * t.c[j * A + a];
          dc[a] += dz * p[row + D + a];
        }
        for (let d = 0; d < D; d++) {
          g[row + D + A + d] += dz * t.G[d];
          dG[d] += dz * p[row + D + A + d];
        }
      }
      // c_j = Σ_i a_ij v_i
      const da = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const aij = t.a[j * n + i];
        let s = 0;
        for (let a = 0; a < A; a++) {
          s += dc[a] * t.vv[i * A + a];
          dvv[i * A + a] += aij * dc[a];
        }
        da[i] = s;
      }
      // softmax
      let dot = 0;
      for (let i = 0; i < n; i++) dot += t.a[j * n + i] * da[i];
      const dqv = new Float32Array(A);
      for (let i = 0; i < n; i++) {
        const ds = t.a[j * n + i] * (da[i] - dot) * scale;
        if (ds === 0) continue;
        for (let a = 0; a < A; a++) {
          dqv[a] += ds * t.kk[i * A + a];
          dk[i * A + a] += ds * t.qv[j * A + a];
        }
      }
      // queries
      for (let a = 0; a < A; a++) {
        const r = Wq + a * D;
        for (let d = 0; d < D; d++) {
          g[r + d] += dqv[a] * t.u[j * D + d];
          du[d] += dqv[a] * p[r + d];
        }
      }
      // u_j = relu(Wo o_j + Wog G + bo)
      for (let d = 0; d < D; d++) {
        if (t.upre[j * D + d] <= 0) continue;
        const dp = du[d];
        g[bo + d] += dp;
        for (let f = 0; f < O; f++) g[Wo + d * O + f] += dp * x.o[j * O + f];
        for (let e = 0; e < D; e++) {
          g[Wog + d * D + e] += dp * t.G[e];
          dG[e] += dp * p[Wog + d * D + e];
        }
      }
    }
    // keys and values
    {
      const Wk = this.at('Wk');
      const Wv = this.at('Wv');
      for (let i = 0; i < n; i++)
        for (let a = 0; a < A; a++) {
          const dka = dk[i * A + a];
          const dva = dvv[i * A + a];
          if (dka === 0 && dva === 0) continue;
          for (let d = 0; d < D; d++) {
            const hd = t.h[i * D + d];
            g[Wk + a * D + d] += dka * hd;
            g[Wv + a * D + d] += dva * hd;
            dh[i * D + d] += dka * p[Wk + a * D + d] + dva * p[Wv + a * D + d];
          }
        }
    }
    // the state value
    if (dv !== 0) {
      const Wy = this.at('Wy');
      const by = this.at('by');
      const wv = this.at('wv');
      g[this.at('bv')] += dv;
      for (let hh = 0; hh < H; hh++) {
        g[wv + hh] += dv * t.y[hh];
        if (t.ypre[hh] <= 0) continue;
        const dy = dv * p[wv + hh];
        g[by + hh] += dy;
        const row = Wy + hh * 2 * D;
        for (let d = 0; d < D; d++) {
          g[row + d] += dy * t.G[d];
          dG[d] += dy * p[row + d];
          g[row + D + d] += dy * t.hm[d];
          const dm = (dy * p[row + D + d]) / Math.max(1, n);
          for (let i = 0; i < n; i++) dh[i * D + d] += dm;
        }
      }
    }
    // entities
    {
      const W = this.at('We');
      const b = this.at('be');
      for (let i = 0; i < n; i++)
        for (let d = 0; d < D; d++) {
          if (t.hpre[i * D + d] <= 0) continue;
          const dp = dh[i * D + d];
          if (dp === 0) continue;
          g[b + d] += dp;
          const row = W + d * F;
          for (let f = 0; f < F; f++) g[row + f] += dp * x.e[i * F + f];
        }
    }
    // global
    {
      const W = this.at('Wg');
      const b = this.at('bg');
      for (let d = 0; d < D; d++) {
        if (t.Gpre[d] <= 0) continue;
        const dp = dG[d];
        if (dp === 0) continue;
        g[b + d] += dp;
        const row = W + d * NG;
        for (let i = 0; i < NG; i++) g[row + i] += dp * x.g[i];
      }
    }
  }
}

/** Adam (Kingma & Ba), skipping the style genes (the skills' settings are tuned by CMA-ES) */
export class EntAdam {
  private m: Float32Array;
  private v: Float32Array;
  private t = 0;
  constructor(
    n: number,
    private lr: number,
    private b1 = 0.9,
    private b2 = 0.999,
    private eps = 1e-8,
  ) {
    this.m = new Float32Array(n);
    this.v = new Float32Array(n);
  }
  step(p: Float32Array, g: Float32Array, scale: number, until: number): void {
    this.t++;
    const c1 = 1 - this.b1 ** this.t;
    const c2 = 1 - this.b2 ** this.t;
    for (let i = 0; i < until; i++) {
      const gi = g[i] * scale;
      this.m[i] = this.b1 * this.m[i] + (1 - this.b1) * gi;
      this.v[i] = this.b2 * this.v[i] + (1 - this.b2) * gi * gi;
      p[i] -= (this.lr * (this.m[i] / c1)) / (Math.sqrt(this.v[i] / c2) + this.eps);
    }
  }
}
