// THE LEARNER (MASTERPLAN §6, phase 4; redone 2026-10-02) — the residual network (train/policy.ts
// RES_PREFIX) learns from the searched decisions in the Store. At every decision the search
// (train/episode.ts searchHalving) played the options on shared luck draws and gave a VERDICT: the
// hand-written order's job, or one that clearly beat it. The network reads each option with a flag on
// the hand-written pick and is fitted to that verdict (softmax cross-entropy over the options), plus
// the state value (points still to come).
//
// Why not as before. The entity network used to regress every option's value and choose by itself:
// over 12,902 decisions half of the first rounds cannot tell the options apart, the targets were mostly
// noise, its training loss never fell, and its picks matched the search no better than chance (28%,
// the hand-written order: 79%). All 31 candidates lost 32–78 points on the exam.
//
// THE MARGIN. Overruling only pays where the network is sure: each fit is scored on a validation
// tenth of the matches as points gained over the hand-written pick (the search's own paired values,
// deepest round both options reached) when it overrules by more than a margin; the best margin is
// kept, and none (Infinity: it never overrules) when overruling gained nothing. A separate test tenth
// then measures its gain over the champion's own picks: no gain there, no exam (continuous.ts).
// Plain CPU, one worker, deterministic for a seed.
import { mulberry32, seedOf } from '../harness/rng';
import { progress } from '../harness/progress';
import type { LearnProgress } from './live';
import { EntAdam, EntNet, entInit, type EntInput } from './entnet';
import { ENT_PREFIX, ENT_SHAPE, RES_SHAPE, STYLE_DEFAULT_GENES, decodeGenome, resGenome, withHand } from './policy';
import { toB64 } from './net';
import { N_ENT, N_OPT_IN } from './obs';
import { F_CURRENT, OPT_FEATS } from './skills';
import { Store, type DecisionRow } from './store';
import type { EpisodeResult, Search2Spec } from './episode';

const V_UNIT = 50; // points per unit of the state-value loss
const V_WEIGHT = 0.25;
const F_HP = OPT_FEATS.indexOf('k:hp');
/** the margins tried (in the network's logits: how much surer of another option it must be) */
export const MARGINS = [0, 0.5, 1, 1.5, 2, 3, 4, 6];

/** one decision the learner can use */
export interface EntLabel {
  x: EntInput; // the residual network's input (option rows flagged with the hand-written pick)
  rq: Float32Array; // rounds × k: the search's values
  rd: Float32Array; // draws per round
  v: number;
  match: number;
  hand: number; // the hand-written order's job
  target: number; // the search's verdict, as a job (pressing the human player's button is not one)
  hp: boolean[]; // which options are the human player's button
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
        match, gen, tick: l.tick, robot: l.robot ?? 0, chosen: l.chosen, best: l.chosen, net: l.net, hand: l.hand,
        obs: f(l.x!.g), feats: f(l.x!.f), ents: f(l.x!.e), opt: f(l.x!.o),
        q: Float32Array.from(l.q.map((v) => v ?? NaN)), se: Float32Array.from(l.se.map((v) => v ?? NaN)), n: Float32Array.from(l.n),
        rq, rd: Float32Array.from(spec.rounds.slice(0, l.rq.length).map((x) => x.draws)),
        v: l.sofar === undefined ? undefined : r.reward - l.sofar,
        source: 'search2',
      };
    });
}

/** Store rows → learner labels. The hand-written job: recorded since 2026-10-02; in older rows the
 * robot's own choice (its champion was the hand-written order), or at a re-think the job in progress
 * when that choice was the button; rows where it cannot be told are skipped */
export function toLabels(rows: DecisionRow[]): EntLabel[] {
  const out: EntLabel[] = [];
  for (const d of rows) {
    if (!d.ents || !d.opt || !d.rq || !d.rd) continue;
    const k = d.q.length;
    if (d.opt.length !== k * N_OPT_IN || d.ents.length % N_ENT) continue;
    const hp = Array.from({ length: k }, (_, j) => d.opt![j * N_OPT_IN + F_HP] === 1);
    let hand = d.hand ?? d.net ?? -1;
    if (hand >= 0 && hp[hand]) hand = Array.from({ length: k }, (_, j) => j).find((j) => d.opt![j * N_OPT_IN + F_CURRENT] === 1) ?? -1;
    if (hand < 0 || hand >= k || hp[hand]) continue;
    const target = hp[d.chosen] ? hand : d.chosen;
    out.push({ x: { g: d.obs, e: d.ents, n: d.ents.length / N_ENT, o: withHand(d.opt, k, hand), k }, rq: d.rq, rd: d.rd, v: d.v ?? NaN, match: d.match, hand, target, hp });
  }
  return out;
}

/** the search's paired value of option a over option b (the deepest round both reached; 0: none) */
export function gainOf(L: EntLabel, a: number, b: number): number {
  const k = L.x.k;
  for (let r = L.rd.length - 1; r >= 0; r--) {
    const va = L.rq[r * k + a];
    const vb = L.rq[r * k + b];
    if (Number.isFinite(va) && Number.isFinite(vb)) return va - vb;
  }
  return 0;
}
/** what the residual policy does: the hand-written job, or the option the network rates higher by
 * more than the margin (never the button) */
export function residualPick(q: ArrayLike<number>, L: EntLabel, margin: number): number {
  let j = -1;
  for (let i = 0; i < L.x.k; i++) if (!L.hp[i] && (j < 0 || q[i] > q[j])) j = i;
  return j >= 0 && j !== L.hand && q[j] - q[L.hand] > margin ? j : L.hand;
}

/** the loss of one decision and (with `g`) its gradient added into g */
function lossOf(net: EntNet, L: EntLabel, g: Float32Array | null): { q: number; v: number; out: Float32Array } {
  const t = net.forward(L.x);
  const k = L.x.k;
  // the search's verdict: softmax cross-entropy over the options
  let mx = -Infinity;
  for (let j = 0; j < k; j++) mx = Math.max(mx, t.q[j]);
  let z = 0;
  const e = new Float64Array(k);
  for (let j = 0; j < k; j++) z += e[j] = Math.exp(t.q[j] - mx);
  const lq = -(t.q[L.target] - mx - Math.log(z));
  const dq = new Float32Array(k);
  for (let j = 0; j < k; j++) dq[j] = e[j] / z - (j === L.target ? 1 : 0);
  let lv = 0;
  let dv = 0;
  if (Number.isFinite(L.v)) {
    const err = (t.v - L.v) / V_UNIT;
    lv = V_WEIGHT * huber(err);
    dv = (V_WEIGHT * huberGrad(err)) / V_UNIT;
  }
  if (g) net.backward(L.x, t, dq, dv, g);
  return { q: lq, v: lv, out: t.q };
}
const huberGrad = (e: number): number => (e > 1 ? 1 : e < -1 ? -1 : e);
const huber = (e: number): number => (Math.abs(e) <= 1 ? 0.5 * e * e : Math.abs(e) - 0.5);

export interface EntFitReport {
  train: number; // decisions
  test: number;
  lossTrain: number; // verdict loss, mean per decision
  lossTest: number;
  vErr: number; // held-out state value: mean absolute error (points)
  agree: number; // held-out: what it does (with its margin) is the search's verdict
  regret: number; // held-out: points what it does gives away against the search's verdict
  margin: number; // how much surer it must be to overrule the hand-written order (Infinity: never)
  gain: number; // held-out: points per decision over the hand-written order (the search's values)
  overrule: number; // held-out: the share of decisions it overrules the hand-written order
  vsChampion: number; // held-out: points per decision over the champion's own picks
  seconds: number;
}

/** held-out quality of `p` with `margin` on these labels; `champ`: the champion's pick per label */
export function entEval(p: Float32Array, labels: EntLabel[], margin = 0, champ?: number[]): Omit<EntFitReport, 'train' | 'test' | 'lossTrain' | 'seconds'> {
  const net = new EntNet(RES_SHAPE, p);
  let loss = 0;
  let agree = 0;
  let regret = 0;
  let gain = 0;
  let over = 0;
  let vs = 0;
  let ve = 0;
  let vn = 0;
  labels.forEach((L, i) => {
    const r = lossOf(net, L, null);
    loss += r.q;
    const pick = residualPick(r.out, L, margin);
    if (pick === L.target) agree++;
    regret += gainOf(L, L.target, pick);
    gain += gainOf(L, pick, L.hand);
    if (pick !== L.hand) over++;
    vs += gainOf(L, pick, champ ? champ[i] : L.hand);
    if (Number.isFinite(L.v)) {
      ve += Math.abs(net.forward(L.x).v - L.v);
      vn++;
    }
  });
  const n = Math.max(1, labels.length);
  return { lossTest: loss / n, vErr: vn ? ve / vn : NaN, agree: agree / n, regret: regret / n, margin, gain: gain / n, overrule: over / n, vsChampion: vs / n };
}
/** the margin that gains most over the hand-written order on these labels (Infinity: none gains) */
export function bestMargin(p: Float32Array, labels: EntLabel[]): { margin: number; gain: number } {
  const net = new EntNet(RES_SHAPE, p);
  const qs = labels.map((L) => Array.from(net.forward(L.x).q));
  let best = { margin: Infinity, gain: 0 };
  for (const m of MARGINS) {
    let gn = 0;
    labels.forEach((L, i) => (gn += gainOf(L, residualPick(qs[i], L, m), L.hand)));
    gn /= Math.max(1, labels.length);
    if (gn > best.gain + 1e-9) best = { margin: m, gain: gn };
  }
  return best;
}
/** the champion's picks on these labels: the hand-written job, or its own residual network's say */
export function championPicks(genome: string | null, labels: EntLabel[]): number[] {
  const c = decodeGenome(genome);
  if (!c || c instanceof Float32Array || c.margin === undefined) return labels.map((L) => L.hand);
  const net = new EntNet(RES_SHAPE, c.ent);
  return labels.map((L) => residualPick(net.forward(L.x).q, L, c.margin!));
}

/** split by match: a tenth to choose the margin and the learning rate (val), a tenth to judge (test) */
export function split(labels: EntLabel[], seed: number): { train: EntLabel[]; val: EntLabel[]; test: EntLabel[] } {
  const fold = (m: number): number => seedOf(seed, 'holdout', m) % 10;
  return { train: labels.filter((l) => fold(l.match) >= 2), val: labels.filter((l) => fold(l.match) === 0), test: labels.filter((l) => fold(l.match) === 1) };
}

export interface FitOpts {
  epochs: number;
  lr: number;
  batch: number;
  seed: number;
  maxSeconds?: number;
  /** how far it is (epoch, share of the fit 0–1, the last epoch's training loss), a few times a second */
  onProgress?: (epoch: number, frac: number, loss: number | null) => void;
}
/** Adam over the training labels from `start` (a residual network) */
export function entFit(start: Float32Array, train: EntLabel[], test: EntLabel[], o: FitOpts): { p: Float32Array; report: EntFitReport } {
  const t0 = performance.now();
  const p = Float32Array.from(start);
  const net = new EntNet(RES_SHAPE, p);
  const style = net.L.style; // the skill genes are CMA-ES's, not the learner's
  const opt = new EntAdam(p.length, o.lr);
  const g = new Float32Array(p.length);
  const rnd = mulberry32(seedOf(o.seed, 'entfit'));
  const idx = train.map((_, i) => i);
  let lossTrain = 0;
  let beat = 0;
  let lastLoss: number | null = null;
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
      if (o.onProgress && performance.now() - beat > 400) {
        beat = performance.now();
        o.onProgress(ep, (ep + end / Math.max(1, idx.length)) / o.epochs, lastLoss);
      }
    }
    lossTrain = sum / Math.max(1, idx.length);
    lastLoss = lossTrain;
    if (o.maxSeconds && (performance.now() - t0) / 1000 > o.maxSeconds) break;
  }
  const ev = entEval(p, test);
  return { p, report: { train: train.length, test: test.length, lossTrain, ...ev, seconds: (performance.now() - t0) / 1000 } };
}

const gaussOf = (seed: number): (() => number) => {
  const r = mulberry32(seed);
  return () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
};
/** a fresh entity network (the v1-era chooser; kept for older runs and the gate) */
export function entGenome(seed: number, style: readonly number[] = STYLE_DEFAULT_GENES): string {
  return ENT_PREFIX + toB64(entInit(ENT_SHAPE, gaussOf(seedOf(seed, 'entinit')), style));
}
/** a fresh residual network: it never overrules (margin Infinity) until the learner finds a margin
 * that gains — so it starts out playing exactly like the hand-written skills */
export function residualGenome(seed: number): string {
  return resGenome(entInit(RES_SHAPE, gaussOf(seedOf(seed, 'resinit')), STYLE_DEFAULT_GENES), Infinity);
}

export interface LearnArgs {
  store: string; // the Store file
  start: string; // the genome to start from (a residual network; anything else: a fresh one)
  champion: string | null; // the champion's genome (what a candidate must beat on held-out decisions)
  lrs: number[]; // one fit per learning rate, the best on the validation tenth wins
  epochs: number;
  window: number; // newest decisions used
  seed: number;
  maxSeconds?: number;
}
export interface LearnResult {
  genome: string;
  lr: number;
  report: EntFitReport; // on the test tenth, with its margin
  tried: { lr: number; lossTest: number; agree: number; regret: number; margin?: number; gain?: number }[];
  before: ReturnType<typeof entEval>; // the starting network, on the test tenth
}
/** the learner as a worker job: read the newest decisions, fit one network per learning rate, keep
 * the one that gains most over the hand-written order on the validation tenth (with its best margin),
 * and report it on the test tenth */
export function learnJob(a: LearnArgs): LearnResult {
  const st = new Store(a.store);
  let rows: DecisionRow[];
  try {
    rows = st.decisions({ source: 'search2', limit: a.window });
  } finally {
    st.close();
  }
  const { train, val, test } = split(toLabels(rows), a.seed);
  const s0 = decodeGenome(a.start);
  const start = s0 && !(s0 instanceof Float32Array) && s0.margin !== undefined ? s0 : (decodeGenome(residualGenome(a.seed)) as { ent: Float32Array; margin: number });
  const champ = championPicks(a.champion, test);
  const before = entEval(start.ent, test, start.margin, champ);
  let best: { p: Float32Array; lr: number; margin: number; gain: number; loss: number } | null = null;
  const tried: LearnResult['tried'] = [];
  const t0 = performance.now();
  for (const [li, lr] of a.lrs.entries()) {
    // (the studio shows the learner's progress: which learning rate, which epoch)
    const onProgress = (epoch: number, frac: number, loss: number | null): void =>
      progress({ k: 'learn', lr: li, lrs: a.lrs.length, epoch, epochs: a.epochs, frac: (li + frac) / a.lrs.length, loss } satisfies LearnProgress);
    onProgress(0, 0, null);
    const r = entFit(start.ent, train, val, { epochs: a.epochs, lr, batch: 32, seed: a.seed, maxSeconds: a.maxSeconds ? a.maxSeconds / a.lrs.length : undefined, onProgress });
    const m = bestMargin(r.p, val);
    tried.push({ lr, lossTest: r.report.lossTest, agree: r.report.agree, regret: r.report.regret, margin: m.margin, gain: m.gain });
    if (!best || m.gain > best.gain + 1e-9 || (Math.abs(m.gain - best.gain) <= 1e-9 && r.report.lossTest < best.loss)) best = { p: r.p, lr, margin: m.margin, gain: m.gain, loss: r.report.lossTest };
  }
  const B = best!;
  const ev = entEval(B.p, test, B.margin, champ);
  const report: EntFitReport = { train: train.length, test: test.length, lossTrain: NaN, ...ev, seconds: (performance.now() - t0) / 1000 };
  return { genome: resGenome(B.p, B.margin), lr: B.lr, report, tried, before };
}
