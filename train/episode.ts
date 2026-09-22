// ONE EPISODE = one robot's life: a solo BIOBUZZ match (or just its AUTO) in unmodified DSIM, with
// the REAL profile's limits (layer B), misses (layer C) and the rule guards all on. A robot can
// DIE early — like the cars in the "AI learns to drive" videos — and its fitness is the real DSIM
// score plus annealed shaping. This is a worker job (harness/pool.ts): plain JSON in, JSON out.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { C, DT, bb, recordScore, runMatch, type World } from '../harness/dsim';
import { loadProfile, resolve } from '../harness/profiles';
import { makeFilter, HUMAN, ORACLE, RULES_CONSERVATIVE } from '../harness/filters';
import { makePerturb } from '../harness/perturb';
import { Guards } from '../harness/guards';
import { mulberry32, seedOf } from '../harness/rng';
import { fromB64 } from './net';
import { policyController } from './policy';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export type Stage = 'auto' | 'full';
export type Death = 'survived' | 'crash' | 'stall';
export const STALL_S = 20; // no progress for this long ⇒ the robot "dies"

/** shaping weights (× the engine's annealing scale); penalties are never annealed */
export const SHAPING = { pickup: 0.5, shotIn: 1.0, hpEntry: 0.25 } as const;
export const PENALTY = { violation: 10, wastedShot: 0.5, strike: 2, crash: 5 } as const;

export interface EpisodeArgs {
  genome: string; // base64 Float32 parameters
  profile: string; // profile file under the project root
  sampleProfile: boolean; // domain randomization across the profile's envelope
  seed: number; // match seed (DSIM spills/HP jitter) and our layer B/C streams
  stage: Stage;
  shaping: number; // 0..1 annealing scale on SHAPING
  driver: 'human' | 'oracle';
  track: boolean; // return a downsampled path for the viewer
  record: boolean; // return a DSIM replay (champion showcase)
}

export interface EpisodeResult {
  fitness: number;
  score: number;
  parts: { pickups: number; shotsIn: number; wasted: number; hp: number; tips: number; violations: number; strikes: number };
  ticks: number;
  death: Death;
  deathTick: number;
  point: Record<string, number>;
  track?: string; // base64 Float32 [x, y, heading] every ACTION_REPEAT ticks, blue frame as DSIM
  events?: [number, string][]; // [tick, kind]
  replay?: unknown;
  replayExact?: boolean;
}

export function runEpisode(a: EpisodeArgs): EpisodeResult {
  const prof = resolve(loadProfile(join(root, a.profile)), a.sampleProfile ? mulberry32(seedOf(a.seed, 'profile')) : undefined);
  if (prof.expectFails.length || prof.clamped.length) throw new Error(`profile: ${[...prof.expectFails, ...prof.clamped].join('; ')}`);
  const params = fromB64(a.genome);
  const guards = new Guards(RULES_CONSERVATIVE);
  const parts = { pickups: 0, shotsIn: 0, wasted: 0, hp: 0, tips: 0, violations: 0, strikes: 0 };
  const events: [number, string][] = [];
  const path: number[] = [];
  const prevKind = new Map<number, string>();
  let lastProgress = 0;
  let prevScore = 0;
  let death = 'survived' as Death; // assigned inside the per-tick callback; `as` stops TS narrowing it to 'survived'
  let deathTick = 0;
  let prevViol = 0;
  let prevStrike = 0;
  const ev = (t: number, k: string): void => {
    if (a.track && events.length < 400) events.push([t, k]);
  };

  const after = (w: World): void => {
    const t = w.tick;
    const r = w.robots[0];
    if (a.track && t % 6 === 0) path.push(r.pos.x, r.pos.y, r.heading);
    let progress = false;
    for (const b of w.balls) {
      const pk = prevKind.get(b.id);
      const k = b.state.kind;
      if (pk !== undefined && pk !== k) {
        if (k === 'held' && (b.state as { robot: number }).robot === r.id) {
          parts.pickups++;
          progress = true;
          ev(t, 'pickup');
        } else if (pk === 'flight' && k === 'element' && (b.state as { el: string }).el === `hive:${r.alliance}`) {
          parts.shotsIn++;
          progress = true;
          ev(t, 'shotIn');
        } else if (pk === 'flight' && k === 'ground') {
          parts.wasted++;
          ev(t, 'wasted');
        } else if (pk === 'stock' && k === 'ground') {
          parts.hp++;
          progress = true;
          ev(t, 'hp');
        }
      }
      prevKind.set(b.id, k);
    }
    const sc = w.match.scores[r.alliance].total;
    if (sc !== prevScore) {
      progress = true;
      prevScore = sc;
    }
    const tips = bb(w).hives[r.alliance].tips;
    if (tips > parts.tips) {
      parts.tips = tips;
      ev(t, 'tip');
    }
    const ph = w.match.phase;
    if (progress || (ph !== 'auto' && ph !== 'teleop')) lastProgress = t;
    const rep = guards.report();
    const viol = Object.entries(rep.violations).reduce((n, [k, v]) => n + (k === 'DSIM-foul' ? 0 : (v ?? 0)), 0);
    if (viol > prevViol) {
      ev(t, 'violation');
      prevViol = viol;
    }
    parts.violations = viol;
    const strikes = rep.anomalies['fast-ground-element'] ?? 0;
    if (strikes > prevStrike) prevStrike = strikes;
    parts.strikes = strikes;
    if ((rep.violations['G417-hive-frame-contact'] ?? 0) > 0) {
      death = 'crash';
      deathTick = t;
    } else if ((t - lastProgress) * DT > STALL_S) {
      death = 'stall';
      deathTick = t;
    }
  };

  const run = runMatch(
    a.seed,
    [{ id: 0, alliance: 'blue', spec: prof.spec, startIndex: a.seed % 4 }],
    policyController(params, prof, 0),
    {
      filter: makeFilter(a.seed, new Map([[0, prof.limits]]), a.driver === 'human' ? HUMAN : ORACLE, RULES_CONSERVATIVE),
      perturb: makePerturb(a.seed, { blue: prof.perturb }),
      after: (w, applied) => {
        guards.observe(w, applied);
        after(w);
      },
      stop: (w) => death !== 'survived' || (a.stage === 'auto' && w.match.phase === 'teleop'),
    },
    { record: a.record },
  );
  const w = run.world;
  if (death === 'survived') deathTick = w.tick;
  const score = a.stage === 'auto' ? Math.max(0, w.match.scores.blue.total - w.match.scores.red.foulPoints) : recordScore(w, 'blue');
  const shaped = a.shaping * (SHAPING.pickup * parts.pickups + SHAPING.shotIn * parts.shotsIn + SHAPING.hpEntry * parts.hp);
  const penalty = PENALTY.violation * parts.violations + PENALTY.wastedShot * parts.wasted + PENALTY.strike * parts.strikes + (death === 'crash' ? PENALTY.crash : 0);
  const out: EpisodeResult = { fitness: score + shaped - penalty, score, parts, ticks: w.tick, death, deathTick, point: prof.point };
  if (a.track) {
    out.track = Buffer.from(new Float32Array(path).buffer).toString('base64');
    out.events = events;
  }
  if (a.record && run.replay) {
    out.replay = run.replay;
    out.replayExact = run.replayExact;
  }
  return out;
}

export const MATCH_TICKS = Math.round((C.PRE_COUNTDOWN + C.AUTO_DURATION + C.TRANSITION_DURATION + C.TELEOP_DURATION) / DT);
