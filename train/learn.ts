// POLICY IMPROVEMENT from lessons — the step that turns "what if" into a better robot.
//
// A lesson is one decision the champion faced in a real match, with the points every option made
// when played out on copies of that moment (train/episode.ts whatIf: the same fresh luck for every
// option, the rest-of-match predictor after the horizon). The network learns those POINTS: its
// scores, centred over the options, regress the options' centred what-if points (train/bc.ts
// pointsLossAndGrad). Every option's measurement counts, so the noise of a single play-out
// averages out instead of deciding a label.
//
// This is approximate policy iteration (Bertsekas & Tsitsiklis, "rollout"): acting on the
// champion's own what-if values is never worse than the champion when the values are exact (the
// policy improvement theorem). The trained network only approximates that, so it is a CANDIDATE:
// it replaces the champion only by beating it on fresh matches (train/engine.ts race). Training
// starts from the champion's weights and is pulled toward them (an L2 anchor): a small, safe step.
// The team's replays can ride along as demonstrations (weight `demoWeight`, hard labels).
//
// HELD-OUT REGRET is the honest score of a fit: on lessons from matches it never trained on, how
// many what-if points the option the network would pick loses against the best one.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Adam, pointsLossAndGrad, scoreAll, unpack, type Packed, type Sample } from './bc';
import { fromB64, styleOffset, toB64, type NetShape } from './net';
import { mulberry32, seedOf } from '../harness/rng';
import { N_OBS } from './obs';
import { N_OPT_FEATS } from './skills';
import { SHAPE } from './policy';
import { fitValue, valueRmse, type ValueSet } from './value';
import { loadSet, setSamples, hasSet } from './imitate';

export interface FitOpts {
  epochs: number;
  lr: number;
  anchor: number; // L2 pull toward the starting weights
  demoWeight: number; // weight of a demonstration relative to a lesson
  seed: number;
}
export interface FitReport {
  lessons: number; // trained on
  held: number; // held-out lessons
  epochs: number; // epochs run (early stopping keeps the best)
  kept: number; // the epoch kept (0 = the start was best)
  trainLoss: number;
  testLoss: number;
  testStartLoss: number;
  regret: number; // held-out: what-if points the network's pick loses to the best option
  startRegret: number; // …the starting network (the champion) on the same lessons
  hit: number; // held-out: its pick is the best option
  startHit: number;
}

/** the network's top option for a lesson (only options that were played out count) */
function pickOf(shape: NetShape, p: Float32Array, s: Sample): number {
  const z = scoreAll(shape, p, s);
  let b = -1;
  for (let r = 0; r < s.k; r++) if (!(s.q && Number.isNaN(s.q[r])) && (b < 0 || z[r] > z[b])) b = r;
  return b;
}

/** held-out quality: mean loss, regret (points) and how often the pick is the best option */
export function judge(shape: NetShape, p: Float32Array, S: Sample[]): { loss: number; regret: number; hit: number } {
  let L = 0;
  let R = 0;
  let H = 0;
  let n = 0;
  for (const s of S) {
    L += pointsLossAndGrad(shape, p, s, null).loss;
    if (!s.q) continue;
    let best = -Infinity;
    for (let r = 0; r < s.k; r++) if (!Number.isNaN(s.q[r])) best = Math.max(best, s.q[r]);
    const pick = pickOf(shape, p, s);
    R += best - s.q[pick];
    H += s.q[pick] === best ? 1 : 0;
    n++;
  }
  return { loss: S.length ? L / S.length : 0, regret: n ? R / n : 0, hit: n ? H / n : 0 };
}

/** train a candidate from `start` on lessons (+ demonstrations); early-stopped on held-out regret */
export function fitLessons(shape: NetShape, start: Float32Array, train: Sample[], test: Sample[], demos: Sample[], o: FitOpts): { p: Float32Array; report: FitReport } {
  const p = new Float32Array(start);
  const upTo = styleOffset(shape); // style genes are the skills', not the network's
  const opt = new Adam(p.length, o.lr, 0);
  const g = new Float32Array(p.length);
  const gi = new Float32Array(p.length);
  const rng = mulberry32(seedOf(o.seed, 'fit'));
  const pool: { s: Sample; w: number }[] = [...train.map((s) => ({ s, w: 1 })), ...demos.map((s) => ({ s, w: o.demoWeight }))].filter((q) => q.w > 0);
  const order = pool.map((_, i) => i);
  const j0 = judge(shape, start, test);
  const best = new Float32Array(p);
  let bestR = j0.regret;
  let bestL = j0.loss;
  let kept = 0;
  let ran = 0;
  for (let ep = 0; ep < o.epochs && pool.length; ep++) {
    ran = ep + 1;
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let b0 = 0; b0 < order.length; b0 += 32) {
      g.fill(0);
      const idx = order.slice(b0, b0 + 32);
      let wsum = 0;
      for (const i of idx) {
        const { s, w } = pool[i];
        if (w === 1) pointsLossAndGrad(shape, p, s, g);
        else {
          gi.fill(0);
          pointsLossAndGrad(shape, p, s, gi);
          for (let k = 0; k < upTo; k++) g[k] += w * gi[k];
        }
        wsum += w;
      }
      for (let k = 0; k < upTo; k++) g[k] += o.anchor * wsum * (p[k] - start[k]);
      opt.step(p, g, 1 / wsum, upTo);
    }
    // keep the epoch with the least held-out regret (ties: the lower loss)
    const t = judge(shape, p, test);
    if (t.regret < bestR - 1e-9 || (Math.abs(t.regret - bestR) <= 1e-9 && t.loss < bestL)) {
      bestR = t.regret;
      bestL = t.loss;
      best.set(p);
      kept = ep + 1;
    } else if (ep + 1 - kept >= 10) break; // nothing better for 10 epochs
  }
  const tr = judge(shape, best, train);
  const te = judge(shape, best, test);
  return {
    p: best,
    report: { lessons: train.length, held: test.length, epochs: ran, kept, trainLoss: tr.loss, testLoss: te.loss, testStartLoss: j0.loss, regret: te.regret, startRegret: j0.regret, hit: te.hit, startHit: j0.hit },
  };
}

// ─────────────────────────────── the worker job ───────────────────────────────
/** one generation's lessons on disk (runs/<run>/lessons/<gen>.json.gz) */
export interface LessonFile {
  gen: number;
  champ: number;
  matches: { lessons: Packed | null; values: { n: number; obs: string; y: number[] } | null }[];
}
export interface FitJobArgs {
  dir: string; // the run's directory
  gens: number[]; // lesson files to learn from (the window)
  start: string; // the champion's genome
  value: string | null; // the current predictor
  demoKey: string;
  opts: FitOpts;
  valueEpochs: number;
}
export interface FitJobResult {
  genome: string;
  report: FitReport;
  value: string;
  valueRmse: number; // held-out, the new predictor
  valueStartRmse: number; // held-out, the predictor it replaces
  valueSamples: number;
}

/** every 6th match of every lesson file is held out (policy and predictor alike); a file with
 * fewer matches holds out its last one, so a candidate is always judged on matches it never saw */
const HOLD = 6;
export function fitJob(a: FitJobArgs): FitJobResult {
  const train: Sample[] = [];
  const test: Sample[] = [];
  const vTrain: { obs: number[]; y: number[] } = { obs: [], y: [] };
  const vTest: { obs: number[]; y: number[] } = { obs: [], y: [] };
  for (const g of a.gens) {
    const f = join(a.dir, 'lessons', `${g}.json.gz`);
    if (!existsSync(f)) continue;
    const L = JSON.parse(gunzipSync(readFileSync(f)).toString('utf8')) as LessonFile;
    const n = L.matches.length;
    L.matches.forEach((m, i) => {
      const held = n < HOLD ? i === n - 1 && n > 1 : i % HOLD === HOLD - 1;
      if (m.lessons?.n) (held ? test : train).push(...unpack(m.lessons, N_OBS, N_OPT_FEATS));
      if (m.values?.n) {
        const v = held ? vTest : vTrain;
        for (const x of fromB64(m.values.obs)) v.obs.push(x);
        v.y.push(...m.values.y);
      }
    });
  }
  const demos = a.demoKey && a.opts.demoWeight > 0 && hasSet(a.demoKey) ? setSamples(loadSet(a.demoKey)) : [];
  const { p, report } = fitLessons(SHAPE, fromB64(a.start), train, test, demos, a.opts);
  const set = (v: { obs: number[]; y: number[] }): ValueSet => ({ obs: new Float32Array(v.obs), y: new Float32Array(v.y) });
  const vt = set(vTrain);
  const vh = set(vTest);
  const startV = a.value ? fromB64(a.value) : null;
  const v = fitValue(vt, vh, { epochs: a.valueEpochs, seed: a.opts.seed, start: startV });
  return { genome: toB64(p), report, value: toB64(v.p), valueRmse: v.rmse, valueStartRmse: startV && vh.y.length ? valueRmse(startV, vh) : NaN, valueSamples: vt.y.length + vh.y.length };
}
