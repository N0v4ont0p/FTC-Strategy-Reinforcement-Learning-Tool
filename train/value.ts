// THE REST-OF-MATCH PREDICTOR: from what the robot sees now (the policy's global observation),
// how many more points (reward) it will make by the end of the match, playing as the champion
// plays. It lets a what-if branch stop after a few seconds and still count what its end state is
// worth — so a choice that sets up the next minute (parking on time, keeping a full hopper for
// the tip) is not judged by its first 15 seconds only. Trained on real results of the champion's
// matches (Monte-Carlo returns); a small tanh network, the same float-exact kind as the policy.
import { N_OBS } from './obs';
import { Adam } from './bc';
import { initParams, paramCount, type NetShape } from './net';
import { mulberry32, seedOf } from '../harness/rng';

export const VALUE_SHAPE: NetShape = { sizes: [N_OBS, 32, 1] };
/** the network outputs points / VALUE_SCALE */
export const VALUE_SCALE = 100;

export interface ValueSet {
  obs: Float32Array; // n × N_OBS
  y: Float32Array; // points still to come
}

/** forward + gradient of ½(out − y/scale)² for one sample into g; returns the squared error in points² */
function sampleGrad(p: Float32Array, x: Float32Array, off: number, y: number, g: Float32Array | null, h: Float32Array): number {
  const [nin, nh] = VALUE_SHAPE.sizes;
  const b1 = nin * nh;
  const w2 = b1 + nh;
  const b2 = w2 + nh;
  let out = p[b2];
  for (let j = 0; j < nh; j++) {
    let v = p[b1 + j];
    const row = j * nin;
    for (let i = 0; i < nin; i++) v += p[row + i] * x[off + i];
    h[j] = Math.tanh(v);
    out += p[w2 + j] * h[j];
  }
  const e = out - y / VALUE_SCALE;
  if (g) {
    g[b2] += e;
    for (let j = 0; j < nh; j++) {
      g[w2 + j] += e * h[j];
      const dh = e * p[w2 + j] * (1 - h[j] * h[j]);
      g[b1 + j] += dh;
      const row = j * nin;
      for (let i = 0; i < nin; i++) g[row + i] += dh * x[off + i];
    }
  }
  return (e * VALUE_SCALE) ** 2;
}

/** root-mean-square error in points */
export function valueRmse(p: Float32Array, S: ValueSet): number {
  const n = S.y.length;
  if (!n) return 0;
  const h = new Float32Array(VALUE_SHAPE.sizes[1]);
  let se = 0;
  for (let k = 0; k < n; k++) se += sampleGrad(p, S.obs, k * N_OBS, S.y[k], null, h);
  return Math.sqrt(se / n);
}

/** fit (from `start`, or fresh) with Adam minibatches; early-stopped on `test` */
export function fitValue(train: ValueSet, test: ValueSet, o: { epochs?: number; seed?: number; start?: Float32Array | null } = {}): { p: Float32Array; rmse: number; epochs: number } {
  const rng = mulberry32(seedOf(o.seed ?? 1, 'value'));
  const gauss = (): number => {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
  const p = o.start ? new Float32Array(o.start) : initParams(VALUE_SHAPE, gauss);
  if (p.length !== paramCount(VALUE_SHAPE)) throw new Error('value network shape changed');
  const n = train.y.length;
  const opt = new Adam(p.length, 0.002, 0);
  const g = new Float32Array(p.length);
  const h = new Float32Array(VALUE_SHAPE.sizes[1]);
  const order = Array.from({ length: n }, (_, i) => i);
  const best = new Float32Array(p);
  let bestE = test.y.length ? valueRmse(p, test) : Infinity;
  let bestEp = -1;
  const epochs = o.epochs ?? 40;
  for (let ep = 0; ep < epochs && n; ep++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let b0 = 0; b0 < n; b0 += 64) {
      g.fill(0);
      const idx = order.slice(b0, b0 + 64);
      for (const k of idx) sampleGrad(p, train.obs, k * N_OBS, train.y[k], g, h);
      opt.step(p, g, 1 / idx.length);
    }
    if (test.y.length) {
      const e = valueRmse(p, test);
      if (e < bestE) {
        bestE = e;
        best.set(p);
        bestEp = ep;
      }
    }
  }
  if (test.y.length) p.set(best);
  return { p, rmse: test.y.length ? bestE : valueRmse(p, train), epochs: bestEp + 1 };
}
