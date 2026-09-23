// ONE EPISODE = one robot's life: a solo BIOBUZZ match (or just its AUTO) in unmodified DSIM, with
// the REAL profile's limits (layer B), misses (layer C) and the rule guards all on. The robot plays
// with its skills (train/skills.ts); the evolved network picks WHAT TO DO NEXT (train/policy.ts).
// A robot can still DIE early — a crash into the HIVE frame (G417) or 20 s without progress.
// Fitness = the real DSIM score + annealed shaping − penalties. A worker job: plain JSON in and out.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { C, DT, bb, recordScore, runMatch, type World } from '../harness/dsim';
import { loadProfile, resolve } from '../harness/profiles';
import { makeFilter, HUMAN, ORACLE, RULES_CONSERVATIVE } from '../harness/filters';
import { makePerturb } from '../harness/perturb';
import { Guards } from '../harness/guards';
import { mulberry32, seedOf } from '../harness/rng';
import { fromB64 } from './net';
import { policyController, type Decision } from './policy';
import { pack, type Packed, type Sample } from './bc';
import { OPTION_KINDS, spawnPose } from './skills';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export type Stage = 'auto' | 'full';
export type Death = 'survived' | 'crash' | 'stall';
export const STALL_S = 20; // no progress for this long ⇒ the robot "dies"
export const TRACK_STRIDE = 3; // ticks between swarm samples (20 per second)
export const FRAME_STRIDE = 2; // ticks between exact frames (30 per second)
/** a swarm sample: x, y, heading, turret 1, turret 2, hopper count, option kind (-1 = none) */
export const TRACK_FIELDS = 7;

/** shaping weights (× the engine's annealing scale); penalties are never annealed */
export const DEFAULT_SHAPING = { pickup: 0.5, shotIn: 1.0, hpEntry: 0.25 };
export const DEFAULT_PENALTY = { violation: 10, wastedShot: 0.5, strike: 2, crash: 5 };
export type Shaping = typeof DEFAULT_SHAPING;
export type Penalty = typeof DEFAULT_PENALTY;

export interface EpisodeArgs {
  genome: string | null; // base64 Float32 parameters; null = the greedy baseline
  profile: string; // profile file under the project root
  sampleProfile: boolean; // domain randomization across the profile's envelope
  seed: number; // match seed (DSIM spills/HP jitter) and our layer B/C streams
  stage: Stage;
  shaping: number; // 0..1 annealing scale on the shaping weights
  weights?: { shaping: Shaping; penalty: Penalty };
  driver: 'human' | 'oracle';
  track: boolean; // return a downsampled path + decisions for the swarm view
  frames?: boolean; // return exact frames for the focus view
  record: boolean; // return a DSIM replay (champion showcase / DSIM snippet)
  samples?: boolean; // return every decision (observation, options, choice) — the robot's own experience
}

export interface Parts {
  pickups: number;
  shotsIn: number;
  wasted: number;
  hp: number;
  tips: number;
  violations: number;
  strikes: number;
}

export interface EpisodeResult {
  fitness: number;
  score: number;
  parts: Parts;
  ticks: number;
  death: Death;
  deathTick: number;
  point: Record<string, number>;
  track?: string; // base64 Float32 TRACK_FIELDS per sample, every TRACK_STRIDE ticks from tick 0
  events?: [number, string][]; // [tick, kind]
  decisions?: [number, number, number, number, number][]; // [tick, kind index, x, y, 1 = done / 0 = failed / 2 = switched to something better]
  frames?: Frames;
  replay?: unknown;
  replayExact?: boolean;
  samples?: Packed;
}

/** exact frames — what DSIM's renderers need to redraw this life exactly as it was trained */
export interface Frames {
  stride: number;
  spec: unknown;
  alliance: string;
  meta: [number, string, number | null][]; // ball id, colour, radius (world.balls order)
  f: Frame[];
}
export interface Frame {
  t: number;
  r: number[]; // x, y, heading, turret, turret2, pitch, pitch2, intake
  h: string; // hopper, one letter per element (y/r/b)
  b: number[]; // x, y, z per ball (0.01 in)
  s?: [number, unknown][]; // ball index → new state
  g?: unknown; // world.biobuzz when it changed
  m: [string, number, number, number]; // phase, phase time left, own total, fouls against
  o?: [number, string, number, number]; // current option: kind index, label, target x, y
}

export function runEpisode(a: EpisodeArgs): EpisodeResult {
  const prof = resolve(loadProfile(join(root, a.profile)), a.sampleProfile ? mulberry32(seedOf(a.seed, 'profile')) : undefined);
  if (prof.expectFails.length || prof.clamped.length) throw new Error(`profile: ${[...prof.expectFails, ...prof.clamped].join('; ')}`);
  const W = a.weights ?? { shaping: DEFAULT_SHAPING, penalty: DEFAULT_PENALTY };
  const guards = new Guards(RULES_CONSERVATIVE);
  const parts: Parts = { pickups: 0, shotsIn: 0, wasted: 0, hp: 0, tips: 0, violations: 0, strikes: 0 };
  const events: [number, string][] = [];
  const path: number[] = [];
  const decisions: Decision[] = [];
  const prevKind = new Map<number, string>();
  let lastProgress = 0;
  let prevScore = 0;
  let death = 'survived' as Death; // assigned inside the per-tick callback; `as` stops TS narrowing it
  let deathTick = 0;
  let prevViol = 0;
  const ev = (t: number, k: string): void => {
    if ((a.track || a.frames) && events.length < 2000) events.push([t, k]);
  };
  const exp: Sample[] = [];
  const ctl = policyController(a.genome ? fromB64(a.genome) : null, prof, 0, decisions, a.samples ? exp : undefined);
  const kindIdx = (k: string | undefined): number => (k ? OPTION_KINDS.indexOf(k as (typeof OPTION_KINDS)[number]) : -1);

  // exact frames
  const fr: Frames | null = a.frames ? { stride: FRAME_STRIDE, spec: null, alliance: 'blue', meta: [], f: [] } : null;
  const lastState: string[] = [];
  let lastBb = '';
  const frame = (w: World, intake = false): void => {
    const r = w.robots[0];
    if (!fr!.spec) {
      fr!.spec = r.spec;
      fr!.alliance = r.alliance;
    }
    if (fr!.meta.length !== w.balls.length) fr!.meta = w.balls.map((b) => [b.id, b.color, (b as { r?: number }).r ?? null]);
    const q = (v: number): number => Math.round(v * 100) / 100;
    const s: [number, unknown][] = [];
    const b: number[] = [];
    w.balls.forEach((x, i) => {
      b.push(q(x.pos.x), q(x.pos.y), q(x.z ?? 0));
      const st = JSON.stringify(x.state);
      if (st !== lastState[i]) {
        lastState[i] = st;
        s.push([i, x.state]);
      }
    });
    const g = JSON.stringify(bb(w));
    const cur = ctl.current();
    const out: Frame = {
      t: w.tick,
      r: [q(r.pos.x), q(r.pos.y), r.heading, r.turretHeading ?? r.heading, r.bbTurret2Heading ?? r.heading + Math.PI, r.bbTurretPitch ?? 0, r.bbTurret2Pitch ?? 0, intake ? 1 : 0],
      h: r.hopper.map((c) => c[0]).join(''),
      b,
      m: [w.match.phase, w.match.phaseTimeLeft, w.match.scores[r.alliance].total, w.match.scores[r.alliance === 'blue' ? 'red' : 'blue'].foulPoints],
    };
    if (s.length) out.s = s;
    if (g !== lastBb) {
      lastBb = g;
      out.g = JSON.parse(g);
    }
    if (cur) out.o = [kindIdx(cur.kind), cur.label, q(cur.x), q(cur.y)];
    fr!.f.push(out);
  };

  const after = (w: World, intake: boolean): void => {
    const t = w.tick;
    const r = w.robots[0];
    if (a.track && t % TRACK_STRIDE === 0) path.push(r.pos.x, r.pos.y, r.heading, r.turretHeading ?? r.heading, r.bbTurret2Heading ?? r.heading + Math.PI, r.hopper.length, kindIdx(ctl.current()?.kind));
    if (fr && t % FRAME_STRIDE === 0) frame(w, intake);
    let progress = false;
    for (const b of w.balls) {
      const pk = prevKind.get(b.id);
      const k = b.state.kind;
      if (pk !== undefined && pk !== k) {
        if (k === 'held' && (b.state as { robot: number }).robot === r.id) {
          parts.pickups++;
          progress = true;
          ev(t, 'pickup');
        } else if (pk === 'held' && k === 'flight') {
          ev(t, 'shot');
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
    parts.strikes = rep.anomalies['fast-ground-element'] ?? 0;
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
    [{ id: 0, alliance: 'blue', spec: prof.spec, startIndex: 0, startPose: spawnPose(prof.spec) }],
    ctl,
    {
      filter: makeFilter(a.seed, new Map([[0, prof.limits]]), a.driver === 'human' ? HUMAN : ORACLE, RULES_CONSERVATIVE),
      perturb: makePerturb(a.seed, { blue: prof.perturb }),
      after: (w, applied) => {
        guards.observe(w, applied);
        after(w, applied.get(0)?.intake ?? false);
      },
      // AUTO-only: stop the moment AUTO ends (LEAVE / PARK are latched at that instant)
      stop: (w) => death !== 'survived' || (a.stage === 'auto' && w.match.phase !== 'pre' && w.match.phase !== 'auto'),
    },
    { record: a.record },
  );
  const w = run.world;
  if (fr) frame(w);
  if (death === 'survived') deathTick = w.tick;
  const score = a.stage === 'auto' ? Math.max(0, w.match.scores.blue.total - w.match.scores.red.foulPoints) : recordScore(w, 'blue');
  const S = W.shaping;
  const Pn = W.penalty;
  const shaped = a.shaping * (S.pickup * parts.pickups + S.shotIn * parts.shotsIn + S.hpEntry * parts.hp);
  const penalty = Pn.violation * parts.violations + Pn.wastedShot * parts.wasted + Pn.strike * parts.strikes + (death === 'crash' ? Pn.crash : 0);
  const out: EpisodeResult = { fitness: score + shaped - penalty, score, parts, ticks: w.tick, death, deathTick, point: prof.point };
  if (a.track) {
    out.track = Buffer.from(new Float32Array(path).buffer).toString('base64');
    out.events = events;
    out.decisions = decisions.map((d) => [d.tick, kindIdx(d.kind), Math.round(d.x), Math.round(d.y), d.outcome === 'failed' ? 0 : d.outcome === 'switched' ? 2 : 1]);
  }
  if (fr) {
    out.frames = fr;
    out.events = events;
  }
  if (a.samples) out.samples = pack(exp);
  if (a.record && run.replay) {
    out.replay = run.replay;
    out.replayExact = run.replayExact;
  }
  return out;
}

export const MATCH_TICKS = Math.round((C.PRE_COUNTDOWN + C.AUTO_DURATION + C.TRANSITION_DURATION + C.TELEOP_DURATION) / DT);
