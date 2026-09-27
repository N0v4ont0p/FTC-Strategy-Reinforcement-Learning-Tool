// THE LEARNER (MASTERPLAN §6, phase 4) — the entity network (train/entnet.ts) learns from the
// searched decisions in the Store: at every decision the search (train/episode.ts searchHalving)
// played the options on shared luck draws, round after round. Those values are clean labels:
//   · OPTION VALUES — within each round, every surviving option's value relative to the round's mean
//     (the rounds differ in horizon, so only differences within a round mean anything). The network's
//     q, centred the same way, is fitted to them (Huber loss in 10-point units), each round weighted
//     by its draws: the deep, well-sampled rounds count most.
//   · STATE VALUE — the points the match still made from there (a baseline for later search).
// Held-out decisions (a tenth of the matches) measure what matters: how often the network's first
// choice is the search's, and the points its choice gives away on the search's first round.
// Plain CPU, one worker, deterministic for a seed.
import { mulberry32, seedOf } from '../harness/rng';
import { EntAdam, EntNet, entInit, type EntInput } from './entnet';
import { ENT_PREFIX, ENT_SHAPE, STYLE_DEFAULT_GENES, decodeGenome } from './policy';
import { toB64 } from './net';
import { N_ENT, N_OPT_IN } from './obs';
import { Store, type DecisionRow } from './store';
import type { EpisodeResult, Search2Spec } from './episode';

const Q_UNIT = 10; // points per unit of the option loss
const V_UNIT = 50; // …of the state-value loss
const V_WEIGHT = 0.25;

/** one decision the learner can use */
export interface EntLabel {
  x: EntInput;
  rq: Float32Array; // rounds × k
  rd: Float32Array; // draws per round
  v: number;
  match: number;
}

/** an episode's searched decisions as Store rows (source 'search2') */
export function labelRows(r: EpisodeResult, match: number, gen: number, spec: Search2Spec): DecisionRow[] {
  const f = (s: string): Float32Array => {
    const b = Buffer.from(s, 'base64');
    return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  };
  return (r.labels ?? [])
    .filter((l) => l.x)
    .map((l) => {
      const k = l.q.length;
      const rq = new Float32Array(l.rq.length * k).fill(NaN);
      l.rq.forEach((row, i) => row.forEach((v, j) => v !== null && (rq[i * k + j] = v)));
      return {
        match, gen, tick: l.tick, robot: 0, chosen: l.chosen, best: l.chosen, net: l.net,
        obs: f(l.x!.g), feats: f(l.x!.f), ents: f(l.x!.e), opt: f(l.x!.o),
        q: Float32Array.from(l.q.map((v) => v ?? NaN)), se: Float32Array.from(l.se.map((v) => v ?? NaN)), n: Float32Array.from(l.n),
        rq, rd: Float32Array.from(spec.rounds.slice(0, l.rq.length).map((x) => x.draws)),
        v: l.sofar === undefined ? undefined : r.reward - l.sofar,
        source: 'search2',
      };
    });
}

/** Store rows → learner labels (rows without the entity view are skipped) */
export function toLabels(rows: DecisionRow[]): EntLabel[] {
  const out: EntLabel[] = [];
  for (const d of rows) {
    if (!d.ents || !d.opt || !d.rq || !d.rd) continue;
    const k = d.q.length;
    if (d.opt.length !== k * N_OPT_IN || d.ents.length % N_ENT) continue;
    out.push({ x: { g: d.obs, e: d.ents, n: d.ents.length / N_ENT, o: d.opt, k }, rq: d.rq, rd: d.rd, v: d.v ?? NaN, match: d.match });
  }
  return out;
}

const huberGrad = (e: number): number => (e > 1 ? 1 : e < -1 ? -1 : e);
const huber = (e: number): number => (Math.abs(e) <= 1 ? 0.5 * e * e : Math.abs(e) - 0.5);

/** the loss of one decision and (with `g`) its gradient added into g */
function lossOf(net: EntNet, L: EntLabel, g: Float32Array | null): { q: number; v: number; out: Float32Array } {
  const t = net.forward(L.x);
  const k = L.x.k;
  const R = L.rd.length;
  const dq = new Float32Array(k);
  const wsum = L.rd.reduce((a, b) => a + b, 0) || 1;
  let lq = 0;
  for (let r = 0; r < R; r++) {
    const alive: number[] = [];
    for (let j = 0; j < k; j++) if (Number.isFinite(L.rq[r * k + j])) alive.push(j);
    if (alive.length < 2) continue;
    const w = L.rd[r] / wsum / alive.length;
    const mt = alive.reduce((a, j) => a + L.rq[r * k + j], 0) / alive.length;
    const mp = alive.reduce((a, j) => a + t.q[j], 0) / alive.length;
    const gr = alive.map((j) => huberGrad((t.q[j] - mp - (L.rq[r * k + j] - mt)) / Q_UNIT));
    const gm = gr.reduce((a, b) => a + b, 0) / alive.length;
    alive.forEach((j, i) => {
      lq += w * huber((t.q[j] - mp - (L.rq[r * k + j] - mt)) / Q_UNIT);
      dq[j] += (w * (gr[i] - gm)) / Q_UNIT; // through the centring: ∂p_i/∂q_j = δ_ij − 1/|alive|
    });
  }
  let lv = 0;
  let dv = 0;
  if (Number.isFinite(L.v)) {
    const e = (t.v - L.v) / V_UNIT;
    lv = V_WEIGHT * huber(e);
    dv = (V_WEIGHT * huberGrad(e)) / V_UNIT;
  }
  if (g) net.backward(L.x, t, dq, dv, g);
  return { q: lq, v: lv, out: t.q };
}

export interface EntFitReport {
  train: number; // decisions
  test: number;
  lossTrain: number; // option loss, mean per decision
  lossTest: number;
  vErr: number; // held-out state value: mean absolute error (points)
  agree: number; // held-out: the network's first choice is the search's
  regret: number; // held-out: points its choice gives away on the search's first round (all options, shared draws)
  seconds: number;
}

/** held-out quality of `p` on these labels */
export function entEval(p: Float32Array, labels: EntLabel[]): Omit<EntFitReport, 'train' | 'test' | 'lossTrain' | 'seconds'> {
  const net = new EntNet(ENT_SHAPE, p);
  let loss = 0;
  let agree = 0;
  let regret = 0;
  let ve = 0;
  let vn = 0;
  for (const L of labels) {
    const r = lossOf(net, L, null);
    loss += r.q;
    const k = L.x.k;
    const pick = argmax(Array.from(r.out));
    // the search's best: the leader of the deepest round
    const R = L.rd.length;
    let best = -1;
    for (let rr = R - 1; rr >= 0 && best < 0; rr--) {
      let bv = -Infinity;
      for (let j = 0; j < k; j++) {
        const v = L.rq[rr * k + j];
        if (Number.isFinite(v) && v > bv) {
          bv = v;
          best = j;
        }
      }
    }
    if (pick === best) agree++;
    const r0 = Array.from({ length: k }, (_, j) => L.rq[j]);
    regret += Math.max(...r0.filter(Number.isFinite)) - (Number.isFinite(r0[pick]) ? r0[pick] : Math.min(...r0.filter(Number.isFinite)));
    if (Number.isFinite(L.v)) {
      ve += Math.abs(net.forward(L.x).v - L.v);
      vn++;
    }
  }
  const n = Math.max(1, labels.length);
  return { lossTest: loss / n, vErr: vn ? ve / vn : NaN, agree: agree / n, regret: regret / n };
}
const argmax = (v: number[]): number => v.reduce((b, x, i) => (x > v[b] ? i : b), 0);

/** split by match: a tenth of the matches are held out */
export function split(labels: EntLabel[], seed: number): { train: EntLabel[]; test: EntLabel[] } {
  const hold = (m: number): boolean => seedOf(seed, 'holdout', m) % 10 === 0;
  return { train: labels.filter((l) => !hold(l.match)), test: labels.filter((l) => hold(l.match)) };
}

export interface FitOpts {
  epochs: number;
  lr: number;
  batch: number;
  seed: number;
  maxSeconds?: number;
}
/** Adam over the training labels from `start` */
export function entFit(start: Float32Array, train: EntLabel[], test: EntLabel[], o: FitOpts): { p: Float32Array; report: EntFitReport } {
  const t0 = performance.now();
  const p = Float32Array.from(start);
  const net = new EntNet(ENT_SHAPE, p);
  const style = net.L.style; // the skill genes are CMA-ES's, not the learner's
  const opt = new EntAdam(p.length, o.lr);
  const g = new Float32Array(p.length);
  const rnd = mulberry32(seedOf(o.seed, 'entfit'));
  const idx = train.map((_, i) => i);
  let lossTrain = 0;
  for (let ep = 0; ep < o.epochs; ep++) {
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    let sum = 0;
    for (let b = 0; b < idx.length; b += o.batch) {
      g.fill(0);
      const end = Math.min(idx.length, b + o.batch);
      for (let i = b; i < end; i++) sum += lossOf(net, train[idx[i]], g).q;
      opt.step(p, g, 1 / (end - b), style);
    }
    lossTrain = sum / Math.max(1, idx.length);
    if (o.maxSeconds && (performance.now() - t0) / 1000 > o.maxSeconds) break;
  }
  const ev = entEval(p, test);
  return { p, report: { train: train.length, test: test.length, lossTrain, ...ev, seconds: (performance.now() - t0) / 1000 } };
}

/** a fresh entity network (the skills' default settings) */
export function entGenome(seed: number, style: readonly number[] = STYLE_DEFAULT_GENES): string {
  const r = mulberry32(seedOf(seed, 'entinit'));
  const gauss = (): number => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
  return ENT_PREFIX + toB64(entInit(ENT_SHAPE, gauss, style));
}

export interface LearnArgs {
  store: string; // the Store file
  start: string; // the genome to start from (ent1:…)
  lrs: number[]; // population-based: one candidate per learning rate, the best held-out wins
  epochs: number;
  window: number; // newest decisions used
  seed: number;
  maxSeconds?: number;
}
export interface LearnResult {
  genome: string;
  lr: number;
  report: EntFitReport;
  tried: { lr: number; lossTest: number; agree: number; regret: number }[];
  before: ReturnType<typeof entEval>;
}
/** the learner as a worker job: read the newest decisions, fit one candidate per learning rate, keep
 * the best on held-out regret (ties: loss) */
export function learnJob(a: LearnArgs): LearnResult {
  const st = new Store(a.store);
  let rows: DecisionRow[];
  try {
    rows = st.decisions({ source: 'search2', limit: a.window });
  } finally {
    st.close();
  }
  const labels = toLabels(rows);
  const { train, test } = split(labels, a.seed);
  const start = decodeGenome(a.start);
  if (!start || start instanceof Float32Array) throw new Error('the learner starts from an entity network');
  const before = entEval(start.ent, test);
  let best: { p: Float32Array; lr: number; report: EntFitReport } | null = null;
  const tried: LearnResult['tried'] = [];
  for (const lr of a.lrs) {
    const r = entFit(start.ent, train, test, { epochs: a.epochs, lr, batch: 32, seed: a.seed, maxSeconds: a.maxSeconds ? a.maxSeconds / a.lrs.length : undefined });
    tried.push({ lr, lossTest: r.report.lossTest, agree: r.report.agree, regret: r.report.regret });
    if (!best || r.report.regret < best.report.regret - 1e-9 || (Math.abs(r.report.regret - best.report.regret) <= 1e-9 && r.report.lossTest < best.report.lossTest)) best = { ...r, lr };
  }
  return { genome: ENT_PREFIX + toB64(best!.p), lr: best!.lr, report: best!.report, tried, before };
}
