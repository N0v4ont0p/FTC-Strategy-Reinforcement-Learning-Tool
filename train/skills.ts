// SKILLS (PLAN.md S2) — what the robot already KNOWS how to do, so evolution only has to learn
// WHAT TO DO NEXT: sweep up a GROUP of loose elements (field or loading zone), pull POLLEN out of
// a FLOWER, shoot, press the human-player button, park. Each skill is a deterministic closed-loop
// controller on DSIM's own state, driving the S1 path law (harness/s1/paths.ts rollout) along the
// S1 visibility-graph planner, with the S1 measured shooting envelope. Nothing here is learned
// except the few STYLE numbers the genome carries (train/policy.ts STYLE).
//
// Version 2 follows the team's world-record replays (Training data/, 730–825 points):
//   · elements are taken as a GROUP — the robot commits to a whole cluster and sweeps it, nearest
//     next, instead of deciding again after every element;
//   · the moment a CELL starts to tip, shots go to the OTHER cell (it takes them from the release,
//     2 s into the 4 s swing): the robot crosses at once instead of waiting out the swing;
//   · it fires from wherever a shot can land (the measured envelope), not only from a parking
//     spot, and can slow to its firing speed while it collects (STYLE fireHold / fireMinV).
import {
  BB,
  BB_TIP_RELEASE_S,
  bb,
  bbAimTarget,
  bbCellSideOf,
  bbFlowerInReach,
  bbIntakeAccepts,
  bbLauncherOf,
  bbMouths,
  bbPlacePointLocal,
  cmd,
  footprintCorners,
  footprintExtents,
  type Alliance,
  type RobotCommand,
  type RobotSpec,
  type RobotState,
  type World,
} from '../harness/dsim';
import type { Limits } from '../harness/profiles';
import { effective, type Eff } from '../harness/s1/drive';
import { dropZoneOccupied } from '../harness/filters';
import { flowerFeet } from '../harness/s1/lab';
import { polysOverlap, rect } from '../harness/geom';
import { S1_ENVELOPE, envelopeOf, inEnv, type Envelope } from './envelope';
import { share } from './fork';
import type { Avoid } from './team';

type P = { x: number; y: number };
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const dist = (a: P, b: P): number => Math.hypot(a.x - b.x, a.y - b.y);

/** bump when the options or how a replay is labelled change: cached demonstrations are rebuilt */
export const SKILLS_VERSION = 5;
export const OPTION_KINDS = ['field', 'lz', 'flower', 'shoot', 'hp', 'park', 'position', 'cycle', 'place'] as const;
export type OptionKind = (typeof OPTION_KINDS)[number];
/** per-option features the policy sees (plus the global observation) */
export const OPT_FEATS = ['k:field', 'k:lz', 'k:flower', 'k:shoot', 'k:hp', 'k:park', 'k:position', 'k:cycle', 'k:place', 'estTime', 'dist', 'nectar', 'cluster', 'flowerPollen', 'toShoot', 'hopperAfter', 'onTargetSide', 'sweepTime', 'current'] as const;
/** index of the estimated-time feature (the greedy baseline reads it) and of the 'current' flag */
export const F_EST = OPT_FEATS.indexOf('estTime');
export const F_CURRENT = OPT_FEATS.indexOf('current');
export const N_OPT_FEATS = OPT_FEATS.length;

export interface Option {
  kind: OptionKind;
  label: string;
  x: number; // where it goes first (world frame), for the viewer
  y: number;
  balls?: number[]; // a group: its elements
  flower?: number;
  feats: number[];
  close?: boolean; // collected nearer the HIVE frame than usual (nothing else was left)
  anchor?: number; // a group: the element it goes for first (what a plan step remembers it by)
}
const NO_AVOID: Avoid = { balls: new Set(), flowers: new Set(), spots: [] };
/** G410: a NECTAR goes into a FLOWER only after the 1:00 cue — with a margin for the tick it lands */
export const PLACE_UNLOCK_S = 59.5;

/** SKILL SETTINGS the genome carries (tuned by CMA-ES, train/cma.ts). Gene g → lo + (hi − lo)·sigmoid(g);
 * `def` is what the skills used before they were tunable, so the default robot is unchanged. */
export const STYLE = [
  { key: 'fireHold', lo: 0, hi: 5, def: 2, label: 'fire while collecting once holding this many' },
  { key: 'fireMinV', lo: 0, hi: 60, def: 15, label: '…on robots allowed to fire at this speed (in/s) or more' },
  { key: 'stick', lo: 0, hi: 10, def: 0.3, label: 'switch job only when another scores this much more' },
  { key: 'sweepIdleS', lo: 1, hi: 12, def: 6, label: 'a sweep ends after this long without a new element (s)' },
  { key: 'budgetMul', lo: 1, hi: 4, def: 1.8, label: 'time allowed for a job: × the estimated travel time' },
  { key: 'budgetAddS', lo: 0.5, hi: 8, def: 2.5, label: '…plus this many seconds' },
  { key: 'vIntakeMargin', lo: 0.5, hi: 1, def: 0.85, label: 'intake approach speed, share of the robot\'s capture limit' },
  { key: 'vFireMargin', lo: 0.5, hi: 1, def: 0.85, label: 'speed while firing, share of the robot\'s firing limit' },
  { key: 'preDist', lo: 4, hi: 24, def: 12, label: 'line up this far from an element before driving in (in)' },
  { key: 'seatV', lo: 6, hi: 19.5, def: 14, label: 'speed into a FLOWER (in/s, under the 20 in/s impact limit)' },
  { key: 'shootTurnS', lo: 0.1, hi: 3, def: 40 / 60, label: 'at a scoring spot, turn to find the cell after (s)' },
  { key: 'shootGiveUpS', lo: 1, hi: 8, def: 2.5, label: '…and give the spot up after (s)' },
  { key: 'parkMarginS', lo: 0.2, hi: 5, def: 1, label: 'leave to park this long before it counts (s)' },
  { key: 'positionMaxS', lo: 0.5, hi: 10, def: 3, label: 'wait in position at most (s)' },
  { key: 'spillWait', lo: 10, hi: 45, def: 26, label: 'wait this far out from a tipping cell for its spill (in)' },
  { key: 'brake', lo: 0.5, hi: 1, def: 0.9, label: 'braking: share of the measured deceleration used' },
  { key: 'arriveGain', lo: 2, hi: 15, def: 6, label: 'final approach speed per inch left (1/s)' },
  { key: 'failBanS', lo: 1, hi: 15, def: 5, label: 'after a failed job, leave its target alone for (s)' },
] as const;
export type StyleKey = (typeof STYLE)[number]['key'];
export type Style = Record<StyleKey, number>;
export const DEFAULT_STYLE: Style = Object.fromEntries(STYLE.map((d) => [d.key, d.def])) as Style;

/** the alliance's own frame → world (the field is point-symmetric; blue's frame is the world) */
const mir = (a: Alliance, p: P): P => (a === 'blue' ? p : { x: -p.x, y: -p.y });

/** the start pose: back against the alliance wall just right of its FLOWER (F3 for blue), facing
 * the field — legal (G304) for every robot size in the REAL-v0 envelope (checked in train/check.ts) */
export function spawnPose(spec: RobotSpec): { x: number; y: number; headingDeg: number } {
  const e = footprintExtents(spec);
  const f = BB.BB_FLOWERS[2]; // F3, blue's wall
  return { x: BB.BB_HALF_X - e.rear, y: f.y + BB.BB_FLOWER_FOOT.along / 2 + e.half + 0.5, headingDeg: 180 };
}

const BARS: P[][] = [
  [{ x: BB.BB_FRAME_BAR_IN, y: -BB.BB_FRAME_Y }, { x: BB.BB_FRAME_BAR_OUT, y: BB.BB_FRAME_Y }],
  [{ x: -BB.BB_FRAME_BAR_OUT, y: -BB.BB_FRAME_Y }, { x: -BB.BB_FRAME_BAR_IN, y: BB.BB_FRAME_Y }],
];
const STUCK_TICKS = 60;
/** the static solids a robot may not overlap (harness/s1/lab.ts placeable, with its solids built
 * once: options are listed every quarter second now, and rebuilding them was most of the cost) */
const SOLIDS: P[][] = [...BARS.map(([a, b]) => rect(a.x, a.y, b.x, b.y)), ...flowerFeet()];
function placeable(spec: RobotSpec, p: P, heading: number, slop = 0.5): boolean {
  const fp = footprintCorners(spec, p, heading);
  if (fp.some((q) => Math.abs(q.x) > BB.BB_HALF_X - 0.1 || Math.abs(q.y) > BB.BB_HALF_Y - 0.1)) return false;
  return !SOLIDS.some((b) => polysOverlap(fp, b, slop));
}
/** HIVE frame bars grown by 2 in (the safety margin) and their centre lines */
const BAR_RECTS = BARS.map(([a, b]) => rect(a.x - 2, a.y - 2, b.x + 2, b.y + 2));
const BAR_SOLIDS = BARS.map(([a, b]) => rect(a.x, a.y, b.x, b.y));
/** a pose this far clear of the HIVE frame (G417 ends a robot's match): approaches keep 1 in (a
 * spill lands beside the frame; 2.5 in ruled out every element there and robots stood idle) */
function clearOfFrame(spec: RobotSpec, p: P, heading: number, margin: number): boolean {
  const fp = footprintCorners(spec, p, heading);
  return !BAR_SOLIDS.some((b) => polysOverlap(fp, b, margin));
}
// ─────────────────────────────── paths ───────────────────────────────
type Box = { x0: number; y0: number; x1: number; y1: number };
/** the solids a path goes around: the two HIVE frame bars and the four FLOWER feet (DSIM colliders.ts) */
const SOLID_BOXES: Box[] = [
  { x0: BB.BB_FRAME_BAR_IN, y0: -BB.BB_FRAME_Y, x1: BB.BB_FRAME_BAR_OUT, y1: BB.BB_FRAME_Y },
  { x0: -BB.BB_FRAME_BAR_OUT, y0: -BB.BB_FRAME_Y, x1: -BB.BB_FRAME_BAR_IN, y1: BB.BB_FRAME_Y },
  ...flowerFeet().map((poly) => ({ x0: Math.min(...poly.map((q) => q.x)), y0: Math.min(...poly.map((q) => q.y)), x1: Math.max(...poly.map((q) => q.x)), y1: Math.max(...poly.map((q) => q.y)) })),
];
/** how far outside box q point p is, measured the way a box GROWS (axis by axis): growing q by less
 * than this leaves p outside it (the straight-line distance does not, next to a corner) */
const boxGap = (p: P, q: Box): number => Math.max(q.x0 - p.x, p.x - q.x1, q.y0 - p.y, p.y - q.y1);
/** does segment a→b pass strictly through box q's interior (slab test, exact) */
function segThroughBox(a: P, b: P, q: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  for (const [p0, d, lo, hi] of [[a.x, b.x - a.x, q.x0, q.x1], [a.y, b.y - a.y, q.y0, q.y1]] as const) {
    if (Math.abs(d) < 1e-12) {
      if (p0 <= lo + 1e-6 || p0 >= hi - 1e-6) return false;
      continue;
    }
    let ta = (lo - p0) / d;
    let tb = (hi - p0) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
  }
  return t1 - t0 > 1e-6;
}
/** SHORTEST PATH for a disc of radius R around the frame bars and FLOWER feet (visibility graph over
 * the grown boxes' corners, Dijkstra) — interior waypoints. Each solid is grown by R, or by less where
 * an endpoint sits nearer than R to it, so the path still goes AROUND it: the S1 planner dropped such
 * a solid altogether, and a robot sent to a scoring spot 14 in from the red frame bar was planned
 * straight through it. */
export function planPath(a: P, b: P, R: number): P[] {
  const obs = SOLID_BOXES.map((q) => {
    const r = Math.max(0, Math.min(R, boxGap(a, q) - 0.5, boxGap(b, q) - 0.5));
    return { x0: q.x0 - r, y0: q.y0 - r, x1: q.x1 + r, y1: q.y1 + r };
  });
  const lim = BB.BB_HALF_X - 0.5;
  const inside = (p: P, q: Box): boolean => p.x > q.x0 && p.x < q.x1 && p.y > q.y0 && p.y < q.y1;
  const nodes: P[] = [a, b];
  for (const q of obs)
    for (const c of [{ x: q.x0 - 0.5, y: q.y0 - 0.5 }, { x: q.x1 + 0.5, y: q.y0 - 0.5 }, { x: q.x1 + 0.5, y: q.y1 + 0.5 }, { x: q.x0 - 0.5, y: q.y1 + 0.5 }])
      if (Math.abs(c.x) < lim && Math.abs(c.y) < lim && !obs.some((o) => inside(c, o))) nodes.push(c);
  // an endpoint inside a SOLID itself (a seat pressed into a FLOWER foot) may leave/enter that one
  const free = (i: number, j: number): boolean =>
    !obs.some((q, k) => !((i < 2 && inside(nodes[i], SOLID_BOXES[k])) || (j < 2 && inside(nodes[j], SOLID_BOXES[k]))) && segThroughBox(nodes[i], nodes[j], q));
  const dd = nodes.map(() => Infinity);
  const prev = nodes.map(() => -1);
  const done = nodes.map(() => false);
  dd[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && dd[i] < Infinity && (u < 0 || dd[i] < dd[u])) u = i;
    if (u < 0 || u === 1) break;
    done[u] = true;
    for (let v = 0; v < nodes.length; v++) {
      if (done[v] || !free(u, v)) continue;
      const w = dd[u] + dist(nodes[u], nodes[v]);
      if (w < dd[v]) {
        dd[v] = w;
        prev[v] = u;
      }
    }
  }
  if (prev[1] < 0 && !free(0, 1)) return R > 1 ? planPath(a, b, R / 2) : []; // no way round at this clearance: less (never straight through)
  const path: P[] = [];
  for (let v = prev[1]; v > 0; v = prev[v]) path.unshift(nodes[v]);
  return path;
}

/** how far a point is from a convex polygon (0 inside it) */
function polyDist(p: P, poly: P[]): number {
  let inside = true;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    if (ex * (p.y - a.y) - ey * (p.x - a.x) < 0) inside = false;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / (ex * ex + ey * ey || 1)));
    best = Math.min(best, Math.hypot(a.x + ex * t - p.x, a.y + ey * t - p.y));
  }
  // (a footprint's corners run one way round: inside means on the same side of every edge)
  return inside ? 0 : best;
}

/** the other robots on the field, as a pilot needs them: where they are and how big */
type Other = { pos: P; heading: number; spec: RobotSpec };
const BAR_X = BARS.map(([a, b]) => (a.x + b.x) / 2);
/** distance from a point to an axis-aligned box given by any of its corner points */
function rectDist(p: P, poly: P[]): number {
  const x0 = Math.min(...poly.map((q) => q.x));
  const x1 = Math.max(...poly.map((q) => q.x));
  const y0 = Math.min(...poly.map((q) => q.y));
  const y1 = Math.max(...poly.map((q) => q.y));
  return Math.hypot(Math.max(x0 - p.x, 0, p.x - x1), Math.max(y0 - p.y, 0, p.y - y1));
}

// ─────────────────────────────── the pilot: path + speed law ───────────────────────────────
export class Pilot {
  readonly E: Eff;
  readonly ext: { front: number; rear: number; half: number };
  /** the chassis ends with an intake mouth (REAL-v0: back; DREAM / the world-record build: both) */
  readonly ends: ('front' | 'back')[];
  private readonly R: number;
  /** centre → the farthest corner (in) */
  readonly reachR: number;
  /** measured scoring spots (blue frame) where this robot can turn a full circle clear of walls,
   * the HIVE frame and FLOWER feet — where the shoot skill parks when it is not in range already */
  readonly spots: Record<'north' | 'south', P[]>;
  /** this build's measured shooting envelope (train/envelope.ts) */
  readonly env: Envelope & { set: Record<'north' | 'south', Set<string>> };
  /** top speed at which an intake capture still happens (the profile's vIntake), with margin */
  readonly vIntake: number;
  /** top speed at which a shot still releases (vFire), with margin; Infinity = no limit */
  readonly vFire: number;
  private plan: { goal: P; pts: P[]; leg: number; at: number } | null = null;
  private prog = { best: Infinity, at: 0 };
  /** true when the robot made no progress toward its goal for STUCK_TICKS (blocked) */
  stuck = false;
  /** scoring spots that just failed for THIS robot (world frame, tick until which they are avoided) */
  badSpots: { x: number; y: number; until: number }[] = [];
  /** a tank drivetrain (DSIM: side drives, no strafe) — steers by turning, not strafing */
  readonly tank: boolean;
  /** a turretless launcher (the dumper): it aims by turning the chassis and must be close */
  readonly dumper: boolean;
  /** a team play's park timing (train/teamplay.ts): leave this many seconds earlier; < 0 = never
   * park in TELEOP (score to the last moment) */
  parkLead = 0;
  /** centre → the dumper's firing edge (in) */
  private readonly fireReach: number;
  /** the Box Tube's placement point in the robot frame (DSIM bbPlacePointLocal), null without one */
  readonly tube: P | null;
  /** where it parks: 0 alone (the middle of the loading zone), 1 / 2 its upper / lower end when two robots park */
  parkSlot = 0;
  /** scoring spots a partner is shooting from (world frame): not this robot's */
  avoidSpots: P[] = [];
  /** the other robots this tick (set by the brain): it never drives into one */
  others: Other[] = [];
  /** ticks in a row another robot has held it back (the traffic rule took most of its motion) */
  blockedTicks = 0;

  constructor(
    readonly spec: RobotSpec,
    limits?: Pick<Limits, 'vIntake' | 'vFire'>,
    readonly style: Style = DEFAULT_STYLE,
  ) {
    this.E = effective(spec, true, 0); // intake running: the slower, safe budget
    this.ext = footprintExtents(spec);
    this.ends = bbMouths(spec)
      .map((m) => m.edge)
      .filter((e): e is 'front' | 'back' => e === 'front' || e === 'back');
    if (!this.ends.length) throw new Error('skills need a front or back intake (side intakes are not modelled yet)');
    // paths clear the HIVE frame and FLOWER feet by half the width + 4 in (it cruises along its
    // long axis); the look-ahead safety in drive() covers the corners it sweeps while turning
    const turn = Math.hypot(Math.max(this.ext.front, this.ext.rear), this.ext.half) + 1;
    // paths keep a TURNING robot's corners clear (the footprint's half-diagonal, sweepers included,
    // + 1.5 in — S1's own path optimizer uses the same disc): half the width + 4 let a robot
    // turning at a planned corner clip the HIVE frame's end
    this.R = Math.max(this.ext.half + 4, turn + 0.5);
    this.reachR = turn - 1;
    const solids = [...flowerFeet(), ...BARS];
    const clear = (p: P): boolean =>
      BB.BB_HALF_X - Math.abs(p.x) >= turn && BB.BB_HALF_Y - Math.abs(p.y) >= turn && solids.every((poly) => rectDist(p, poly) >= turn);
    this.env = envelopeOf(spec);
    this.spots = { north: this.env.spots.north.filter(clear), south: this.env.spots.south.filter(clear) };
    this.vIntake = limits && limits.vIntake < 100 ? Math.max(4, style.vIntakeMargin * limits.vIntake) : Infinity;
    this.vFire = limits && limits.vFire < 100 ? Math.max(0.5, style.vFireMargin * limits.vFire) : Infinity;
    this.tank = this.E.strafeMult === 0;
    const launcher = bbLauncherOf(spec, 0);
    this.dumper = launcher.kind === 'dumper';
    this.fireReach = launcher.mount === 'front' ? this.ext.front : launcher.mount === 'back' ? this.ext.rear : this.ext.half;
    if (this.dumper) {
      // a dump reaches BB_DUMP_MAX_DIST from its edge: only the measured spots that close to the cell
      const near = (side: 'north' | 'south') => (p: P): boolean => this.dumpRange(p, { x: BB.BB_HIVE_X, y: (side === 'north' ? 1 : -1) * BB.BB_HIVE_CELL_DY });
      this.spots = { north: this.spots.north.filter(near('north')), south: this.spots.south.filter(near('south')) };
    }
    this.tube = bbPlacePointLocal(spec);
    for (const o of [this.E, this.ext, this.ends, this.spots, this.style, this.env]) share(o); // fixed for the match: forks reference them
    if (this.tube) share(this.tube);
  }

  /** will this robot's intake take an element of this colour (DSIM's own rule: POLLEN always, own
   * NECTAR only on a launcher that carries NECTAR) */
  accepts(color: string, a: Alliance): boolean {
    return bbIntakeAccepts(this.spec, a, color);
  }
  /** a dumper throws only this close (its edge within BB_DUMP_MAX_DIST of the cell, with a margin) */
  private dumpRange(p: P, cell: P): boolean {
    const d = dist(p, cell) - this.fireReach;
    return d >= 4 && d <= BB.BB_DUMP_MAX_DIST - 6;
  }
  /** can this robot score from p on the target cell: the measured envelope, and a dumper's reach */
  inRange(w: World, a: Alliance, p: P): boolean {
    if (!canScoreFrom(w, a, p, this.env)) return false;
    if (!this.dumper) return true;
    const cell = targetCell(w, a);
    const hx = a === 'blue' ? BB.BB_HIVE_X : -BB.BB_HIVE_X;
    return this.dumpRange(p, { x: hx, y: (cell === 'north' ? 1 : -1) * BB.BB_HIVE_CELL_DY });
  }

  /** did a shot from near here just fail for this robot (within 12 in, still banned) */
  isBad(p: P, tick: number): boolean {
    return this.badSpots.some((b) => b.until > tick && (b.x - p.x) ** 2 + (b.y - p.y) ** 2 < 144);
  }
  /** reach from the centre to the roller of an end */
  reach(end: 'front' | 'back'): number {
    return end === 'back' ? this.ext.rear : this.ext.front;
  }
  /** the heading that puts `end` toward direction `a` (radians, from the robot to the target) */
  static facing(end: 'front' | 'back', a: number): number {
    return end === 'front' ? a : wrap(a + Math.PI);
  }
  /** the intake end that needs the least turning to face direction `a` */
  bestEnd(heading: number, a: number): 'front' | 'back' {
    let best = this.ends[0];
    for (const e of this.ends) if (Math.abs(wrap(Pilot.facing(e, a) - heading)) < Math.abs(wrap(Pilot.facing(best, a) - heading))) best = e;
    return best;
  }

  /** seconds to get there (straight line at 80 % speed + the turn) — an estimate for the policy */
  estTime(r: { pos: P; heading: number }, p: P, h: number | null): number {
    const turn = h === null ? 0 : Math.abs(wrap(h - r.heading));
    return dist(r.pos, p) / (0.8 * this.E.vmax) + turn / this.E.maxTurn + 0.2;
  }
  /** seconds to face `p` with the nearest intake end, from a pose */
  turnTo(pos: P, heading: number, p: P): number {
    const a = Math.atan2(p.y - pos.y, p.x - pos.x);
    return Math.abs(wrap(Pilot.facing(this.bestEnd(heading, a), a) - heading)) / this.E.maxTurn;
  }

  reset(): void {
    this.plan = null;
    this.prog = { best: Infinity, at: 0 };
    this.stuck = false;
  }

  /** one tick toward `goal` (arriving with heading `h`, or any heading when null). The speed and
   * heading law is harness/s1/paths.ts `rollout`'s (brake-aware profile, 0.3° deadband).
   * vCap: speed limit for the last 30 in (a capture); vMax: speed limit everywhere (firing). */
  drive(r: RobotState, tick: number, goal: P, h: number | null, o: { vCap?: number; vMax?: number; lockH?: boolean } = {}): RobotCommand {
    if (!this.plan || dist(this.plan.goal, goal) > 4 || tick - this.plan.at > 60) {
      this.plan = { goal: { ...goal }, pts: [...planPath(r.pos, goal, this.R), { ...goal }], leg: 0, at: tick };
    }
    const pl = this.plan;
    pl.pts[pl.pts.length - 1] = { ...goal };
    while (pl.leg < pl.pts.length - 1 && dist(pl.pts[pl.leg], r.pos) < 8) pl.leg++;
    const tgt = pl.pts[pl.leg];
    const ex = tgt.x - r.pos.x;
    const ey = tgt.y - r.pos.y;
    const d = Math.hypot(ex, ey);
    let remaining = d;
    for (let k = pl.leg; k < pl.pts.length - 1; k++) remaining += dist(pl.pts[k], pl.pts[k + 1]);
    // progress watch: remaining distance must shrink by 2 in every STUCK_TICKS unless arrived
    if (remaining < this.prog.best - 2 || remaining < 3) this.prog = { best: remaining, at: tick };
    this.stuck = tick - this.prog.at > STUCK_TICKS;
    const E = this.E;
    const aB = 1.4 * E.accel;
    let vDes = Math.min(E.vmax, Math.sqrt(2 * this.style.brake * aB * Math.max(0, remaining - 0.3)));
    if (pl.leg === pl.pts.length - 1) vDes = Math.min(vDes, this.style.arriveGain * d);
    if (o.vCap !== undefined && remaining < 30) vDes = Math.min(vDes, o.vCap);
    if (o.vMax !== undefined) vDes = Math.min(vDes, o.vMax);
    const dirH = Math.atan2(ey, ex);
    const cruise = Math.abs(wrap(dirH - r.heading)) <= Math.PI / 2 ? dirH : wrap(dirH + Math.PI);
    // a tank cannot strafe: it faces the way it drives until the last few inches, then turns in place
    const hT = this.tank
      ? h === null || (!o.lockH && remaining > 2.5) ? (d > 2.5 ? cruise : r.heading) : h
      : h === null ? (d > 3 ? cruise : r.heading) : o.lockH || remaining <= 36 ? h : cruise;
    const eh = wrap(hT - r.heading);
    const rot0 = Math.abs(eh) < 0.005 ? 0 : Math.sign(eh) * Math.min(1, Math.sqrt(2 * 0.9 * 1.4 * E.turnAccel * Math.abs(eh)) / E.maxTurn, 4 * Math.abs(eh));
    let vx = d > 1e-9 ? (vDes * ex) / d : 0;
    let vy = d > 1e-9 ? (vDes * ey) / d : 0;
    let rot = rot0;
    // SAFETY (G417 is a death). Two different dangers, two different answers:
    //   · its OWN motion (momentum, spin) carries its footprint onto a HIVE frame bar within a third
    //     of a second → stop turning and back off THAT bar (the one the footprint would hit);
    //   · only the COMMAND would → do not command it: the same move without the turn if that is
    //     clear, else no translation (turning in place only if that is clear).
    // The command is extrapolated only up to the goal (past it the speed law stops the robot) and its
    // turn only up to the heading it turns to — extrapolating a full-rate turn for the whole horizon
    // predicted a 158° spin into a bar the robot was never going to reach, and the escape that
    // followed flipped direction every tick at the field's centre (a stall).
    const hitBar = (px: number, py: number, h: number): number => {
      const fp = footprintCorners(this.spec, { x: px, y: py }, h);
      return BAR_RECTS.findIndex((b) => polysOverlap(fp, b, 0));
    };
    const turnBy = (T: number): number => {
      const dh = rot * E.maxTurn * T;
      return Math.abs(dh) > Math.abs(eh) ? eh : dh;
    };
    const HORIZON = [0.08, 0.16, 0.25, 0.33, 0.45];
    let danger = false;
    let vc = Math.hypot(vx, vy);
    // the command points at this leg's end: extrapolated no further than that (past a waypoint the
    // path turns — running straight on through it once "saw" the red frame bar from 37 in away and
    // the escape pinned a robot against a FLOWER foot for the rest of the match)
    const leg = Math.min(d, remaining);
    const cmdHits = (turn: boolean): boolean =>
      HORIZON.some((T) => {
        const ahead = vc > 1e-9 ? Math.min(vc * T, leg) / vc : 0;
        return hitBar(r.pos.x + vx * ahead, r.pos.y + vy * ahead, r.heading + (turn ? turnBy(T) : 0)) >= 0;
      });
    // which bar the move would hit: its own motion first, then the command (with its turn, and
    // without it — the same move without turning is taken when that alone is clear)
    let hit = -1;
    for (const T of HORIZON) {
      hit = hitBar(r.pos.x + r.vel.x * T, r.pos.y + r.vel.y * T, r.heading + r.angVel * T);
      if (hit >= 0) break;
    }
    if (hit < 0 && cmdHits(true)) {
      if (!cmdHits(false)) rot = 0;
      else
        for (const T of HORIZON) {
          const ahead = vc > 1e-9 ? Math.min(vc * T, leg) / vc : 0;
          hit = hitBar(r.pos.x + vx * ahead, r.pos.y + vy * ahead, r.heading);
          if (hit >= 0) break;
        }
    }
    if (hit >= 0) {
      danger = true;
      rot = 0;
      this.plan = null; // and plan again from wherever the escape leaves it
      const bar = BAR_X[hit];
      if (Math.abs(r.pos.y) > BB.BB_FRAME_Y) {
        vy = Math.sign(r.pos.y) * 25; // beyond the bar's end: away along y
        vx = 0;
      } else {
        vx = (Math.sign(r.pos.x - bar) || 1) * 25; // beside the bar: away along x
        vy = 0;
      }
    }
    // TRAFFIC: never drive INTO another robot. Another robot is a DISC as wide as its corners reach
    // (any robot can spin in place: a dumper aiming turns its whole chassis at 7 rad/s, and its
    // corners swept a partner into the HIVE frame). If where the command takes this robot in 0.3 s
    // (no further than this leg's end) comes within 1.5 in of that disc, the part of the motion
    // toward it is dropped — it slides past or waits — and a tank, which cannot slide, stops.
    let held = false;
    const want = Math.hypot(vx, vy);
    if (!danger)
      for (const q of this.others) {
        const dx = q.pos.x - r.pos.x;
        const dy = q.pos.y - r.pos.y;
        const dq = Math.hypot(dx, dy);
        if (dq < 1e-6 || dq > 48) continue;
        const qe = footprintExtents(q.spec);
        const qR = Math.hypot(Math.max(qe.front, qe.rear), qe.half);
        const vn = Math.hypot(vx, vy);
        const T = vn > 1e-9 ? Math.min(0.3 * vn, Math.min(d, remaining)) / vn : 0; // only to this leg's end
        const fp = footprintCorners(this.spec, { x: r.pos.x + vx * T, y: r.pos.y + vy * T }, r.heading + turnBy(T));
        if (polyDist(q.pos, fp) > qR + 1.5) continue;
        const toward = (vx * dx + vy * dy) / dq;
        if (toward > 0) {
          vx -= (toward * dx) / dq;
          vy -= (toward * dy) / dq;
          if (toward > 0.5 * want) held = true;
          if (this.tank) {
            vx = 0;
            vy = 0;
          }
        }
      }
    this.blockedTicks = held ? this.blockedTicks + 1 : 0;
    const c = Math.cos(r.heading);
    const s = Math.sin(r.heading);
    let fwd = (vx * c + vy * s) / E.vmax;
    if (this.tank) {
      // DSIM tank (sim/robot.ts): forward = (L + R) / 2 · vmax, turn = (R − L) · maxTurn / 2
      const k = Math.max(1, Math.abs(fwd - rot), Math.abs(fwd + rot));
      return cmd({ leftDrive: (fwd - rot) / k, rightDrive: (fwd + rot) / k });
    }
    let side = -(-vx * s + vy * c) / (E.vmax * E.strafeMult);
    const m = Math.max(1, Math.abs(fwd), Math.abs(side)); // keep the direction when a stick saturates
    fwd /= m;
    side /= m;
    return cmd({ driveY: fwd, driveX: side, rotate: rot });
  }
}

// ─────────────────────────────── the HIVE: where shots should go ───────────────────────────────
function inRect(p: P, z: { x0: number; x1: number; y0: number; y1: number }): boolean {
  return p.x >= z.x0 && p.x <= z.x1 && p.y >= z.y0 && p.y <= z.y1;
}
const flip = (s: 'north' | 'south'): 'north' | 'south' => (s === 'north' ? 'south' : 'north');

/** the CELL shots should go to now (WORLD side): the up cell — or, once it has started to tip, the
 * OTHER one, which takes every shot from the release on (hive.ts hiveTakingSide). Crossing takes
 * about as long as the 2 s before the release, so the robot goes there the moment a tip starts. */
export function targetCell(w: World, a: Alliance): 'north' | 'south' {
  const h = bb(w).hives[a];
  return h.tipping > 0 ? flip(h.up) : h.up;
}
/** the same, in the alliance's own frame (the frame SPOTS and the envelope are measured in) */
const targetSide = (w: World, a: Alliance): 'north' | 'south' => (a === 'blue' ? targetCell(w, a) : flip(targetCell(w, a)));
/** would Aim Assist, from here, aim at the target cell (it aims at the NEARER own cell) */
const onTarget = (w: World, a: Alliance, p: P): boolean => (p.y >= 0 ? 'north' : 'south') === targetCell(w, a);
/** is this a measured scoring position for the target cell (a build's own envelope; S1's REAL-v0 one by default) */
export const canScoreFrom = (w: World, a: Alliance, p: P, env: { set: Record<'north' | 'south', Set<string>> } = S1_ENVELOPE as never): boolean => {
  const m = mir(a, p);
  return inEnv(env, targetSide(w, a), m.x, m.y);
};

/** nearest turn-safe measured scoring spot for a cell (default: the target cell), world frame */
export function nearestSpot(w: World, r: RobotState, pilot: Pilot, from: P = r.pos, side: 'north' | 'south' = targetSide(w, r.alliance)): P {
  const a = r.alliance;
  const f = mir(a, from);
  const list = pilot.spots[side];
  pilot.badSpots = pilot.badSpots.filter((b) => b.until > w.tick);
  const bad = pilot.badSpots.map((b) => mir(a, b));
  const partner = pilot.avoidSpots.map((b) => mir(a, b));
  // a spot another robot stands on (or next to) is not free either: the traffic rule would stop
  // this robot short of it for as long as the other one stays
  const bodies = pilot.others.map((q) => ({ ...mir(a, q.pos), r: pilot.reachR + Math.hypot(footprintExtents(q.spec).front, footprintExtents(q.spec).half) }));
  let best = list[0];
  let bd = Infinity;
  for (const s of list) {
    if (bad.some((b) => (b.x - s.x) ** 2 + (b.y - s.y) ** 2 < 144)) continue; // within 12 in of a failed spot
    if (partner.some((b) => (b.x - s.x) ** 2 + (b.y - s.y) ** 2 < 324)) continue; // within 18 in of a partner's spot
    if (bodies.some((b) => (b.x - s.x) ** 2 + (b.y - s.y) ** 2 < b.r * b.r)) continue; // taken by a robot
    const d = (s.x - f.x) ** 2 + (s.y - f.y) ** 2;
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return mir(a, best);
}

/** seconds a shot is in the air (typical; S1 envelope flights are ~0.5–1 s) */
export const FLIGHT_S = 0.75;
/** is firing now worth it: something to fire, and the turret's aim (the NEARER cell — DSIM aim
 * assist, play.ts bbAimTarget) is the cell that will be TAKING shots when this one arrives. A swing
 * after a tip hands over to the other tray at the release (hive.ts hiveTakingSide, 2 s into the
 * 4 s swing); a shot reaching the tipping tray before that only joins its spill. The world-record
 * replays score all through the swing — refusing it (as a first version did) lost 53 s of firing. */
export function fireGate(w: World, r: RobotState): boolean {
  if (r.hopper.length === 0) return false;
  const hive = bb(w).hives[r.alliance];
  const other = flip(hive.up);
  const taking = hive.tipping <= 0 ? hive.up : hive.released || hive.tipping - BB_TIP_RELEASE_S <= FLIGHT_S ? other : null;
  return taking !== null && bbCellSideOf(bbAimTarget(w, r)) === taking;
}

// ─────────────────────────────── groups of loose elements ───────────────────────────────
/** elements closer than this, chained, are one GROUP (the world-record runs sweep a spill or a
 * wall row in one pass, picking the next element 0.05–0.3 s after the last) */
export const GROUP_LINK = 16;
type Ball = World['balls'][number];

/** single-linkage clusters (union–find), each in world.balls order */
export function groupsOf(balls: Ball[]): Ball[][] {
  const n = balls.length;
  const up = balls.map((_, i) => i);
  const root = (i: number): number => (up[i] === i ? i : (up[i] = root(up[i])));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) if (dist(balls[i].pos, balls[j].pos) < GROUP_LINK) up[root(i)] = root(j);
  const by = new Map<number, Ball[]>();
  balls.forEach((b, i) => {
    const k = root(i);
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(b);
  });
  return [...by.values()];
}

/** length of a nearest-next tour from `from` through `m` of `pts` */
function tourLength(from: P, pts: P[], m: number): number {
  const left = [...pts];
  let at = from;
  let L = 0;
  for (let n = 0; n < m && left.length; n++) {
    let k = 0;
    for (let i = 1; i < left.length; i++) if (dist(at, left[i]) < dist(at, left[k])) k = i;
    L += dist(at, left[k]);
    at = left.splice(k, 1)[0];
  }
  return L;
}

// ─────────────────────────────── the tip cycle ───────────────────────────────
/** THE TIP CYCLE — the loop of the team's world-record replays, measured (train/gap.ts): a tip every
 * 4.3 s, ~9 shots per tip, the robot ~44 in from its HIVE the whole time. The tipped cell's spill
 * lands beside the HIVE; it is swept up there and shot straight into the other cell, which tips
 * and spills in turn. As ONE job the robot stays in that zone: it takes the nearest element in
 * it, fires whenever a shot can score, shoots from the zone when full, waits by a coming spill —
 * and only leaves when the zone has run dry. */
export const CYCLE_R = 54; // in, from the own HIVE's centre
const hiveCentre = (a: Alliance): P => ({ x: a === 'blue' ? BB.BB_HIVE_X : -BB.BB_HIVE_X, y: 0 });
/** collectable loose elements in the cycle zone */
function cycleLoose(w: World, a: Alliance, pilot: Pilot, skip?: Set<number>): Ball[] {
  const c = hiveCentre(a);
  return w.balls.filter((b) => b.state.kind === 'ground' && pilot.accepts(b.color, a) && !skip?.has(b.id) && dist(b.pos, c) <= CYCLE_R);
}

// ─────────────────────────────── the options available now ───────────────────────────────
/** THINKING ON THE GO: `isCurrent` names the option the robot is already doing, so it is listed
 * with the 'current' feature set and the policy can weigh carrying on against switching */
export function options(w: World, r: RobotState, pilot: Pilot, cap: number, banned: Map<string, number>, isCurrent: (o: Option) => boolean = () => false, avoid: Avoid = NO_AVOID): Option[] {
  const a = r.alliance;
  const B = bb(w);
  const out: Option[] = [];
  const free = cap - r.hopper.length;
  const ph = w.match.phase;
  const t = w.tick;
  const ok = (key: string): boolean => (banned.get(key) ?? -1) < t;
  const side = targetSide(w, a);
  const feats = (k: OptionKind, p: P, h: number | null, x: { nectar?: number; cluster?: number; flowerPollen?: number; gain?: number; sweep?: number; center?: P } = {}): number[] => {
    const est = pilot.estTime(r, p, h);
    const c = x.center ?? p;
    const toShoot = k === 'shoot' || k === 'hp' || k === 'park' ? 0 : dist(c, nearestSpot(w, r, pilot, c, side)) / 144;
    return [
      ...OPTION_KINDS.map((q) => (q === k ? 1 : 0)),
      est / 5,
      dist(r.pos, p) / 144,
      x.nectar ?? 0,
      (x.cluster ?? 0) / 4,
      (x.flowerPollen ?? 0) / 4,
      toShoot,
      (r.hopper.length + (x.gain ?? 0)) / cap,
      // +1 when it is on the side of the cell shots should go to (shoot from there, no crossing)
      onTarget(w, a, c) ? 1 : -1,
      (x.sweep ?? 0) / 5,
      0, // 'current', set below
    ];
  };
  if (free > 0) {
    // GROUPS of loose POLLEN and own NECTAR on the tiles, the 6 the robot reaches first
    const lz = BB.BB_LZ[a];
    const loose = w.balls.filter((b) => b.state.kind === 'ground' && pilot.accepts(b.color, a) && ok(`b${b.id}`) && !avoid.balls.has(b.id));
    const est = (b: Ball): number => pilot.estTime(r, b.pos, null) + pilot.turnTo(r.pos, r.heading, b.pos);
    let cand: { g: Ball[]; anchor: Ball; t: number }[] = [];
    let close = false;
    const groups = groupsOf(loose);
    for (const near of [false, true]) {
      for (const g of groups) {
        const byT = [...g].sort((p, q) => est(p) - est(q) || p.id - q.id);
        const anchor = byT.slice(0, 3).find((b) => approach(pilot, r, b.pos, near));
        if (anchor) cand.push({ g, anchor, t: est(anchor) });
      }
      if (cand.length || !groups.length) break;
      close = true;
      cand = [];
    }
    cand.sort((p, q) => p.t - q.t || p.anchor.id - q.anchor.id);
    const vSweep = Math.min(pilot.vIntake, 0.6 * pilot.E.vmax);
    for (const { g, anchor } of cand.slice(0, 6)) {
      const n = g.length;
      const nectar = g.filter((b) => b.color !== 'yellow').length;
      const center = { x: g.reduce((s, b) => s + b.pos.x, 0) / n, y: g.reduce((s, b) => s + b.pos.y, 0) / n };
      const inLz = inRect(anchor.pos, lz);
      const take = Math.min(free, n);
      const sweep = tourLength(anchor.pos, g.filter((b) => b !== anchor).map((b) => b.pos), take - 1) / vSweep + take * 0.25;
      out.push({
        kind: inLz ? 'lz' : 'field',
        anchor: anchor.id,
        label: `${n} ${n === 1 ? 'element' : 'elements'} (${n - nectar} POLLEN${nectar ? `, ${nectar} NECTAR` : ''}) ${inLz ? 'in the loading zone' : 'on the field'}`,
        x: anchor.pos.x,
        y: anchor.pos.y,
        balls: g.map((b) => b.id),
        feats: feats(inLz ? 'lz' : 'field', anchor.pos, null, { nectar: nectar / n, cluster: Math.min(n, 8), gain: take, sweep, center }),
        ...(close ? { close: true } : {}),
      });
    }
    // FLOWERS whose bottom element is a POLLEN (a NECTAR at the bottom locks it)
    BB.BB_FLOWERS.forEach((f, i) => {
      const st = B.flowers[i].stack;
      const bottom = st.length ? w.balls.find((q) => q.id === st[0]) : undefined;
      if (!bottom || bottom.color !== 'yellow' || !ok(`f${i}`) || avoid.flowers.has(i)) return;
      const pollen = st.filter((id) => w.balls.find((q) => q.id === id)?.color === 'yellow').length;
      const g = flowerGoal(i, pilot, flowerEnd(i, pilot, r.heading));
      out.push({ kind: 'flower', label: `FLOWER ${f.id} (${pollen} POLLEN)`, x: f.x, y: f.y, flower: i, feats: feats('flower', g.pre, g.h, { flowerPollen: pollen, gain: Math.min(free, pollen), sweep: Math.min(free, pollen) * 0.35 }) });
    });
  }
  // THE BOX TUBE: a held own NECTAR into a FLOWER, from the 1:00 cue on (G410). The top-most NECTAR
  // owns the FLOWER (2 a scoring element) and the bottom-most earns 5 — about 15 on a staged FLOWER.
  const ownNectar = r.hopper.filter((c) => c === a).length;
  if (pilot.tube && ownNectar > 0 && ph === 'teleop' && w.match.phaseTimeLeft < PLACE_UNLOCK_S) {
    BB.BB_FLOWERS.forEach((f, i) => {
      if (!ok(`p${i}`) || avoid.flowers.has(i)) return;
      const st = B.flowers[i].stack;
      const colours = st.map((id) => w.balls.find((q) => q.id === id)?.color ?? '');
      const top = [...colours].reverse().find((c) => c !== 'yellow' && c !== '');
      if (top === a) return; // ours already: another NECTAR adds little
      const g = placeGoal(i, pilot);
      out.push({ kind: 'place', label: `place a NECTAR on FLOWER ${f.id}${top ? ' (take it over)' : ''}`, x: f.x, y: f.y, flower: i, feats: feats('place', g.pre, g.h, { nectar: 1, flowerPollen: colours.filter((c) => c === 'yellow').length, gain: -1 }) });
    });
  }
  if (r.hopper.length > 0 && ok('shoot')) {
    const here = pilot.inRange(w, a, r.pos) && !pilot.isBad(r.pos, w.tick);
    const s = here ? r.pos : nearestSpot(w, r, pilot, r.pos, side);
    const cell = targetCell(w, a);
    out.push({ kind: 'shoot', label: `shoot ${r.hopper.length} into the ${cell} CELL${here ? ' from here' : ''}`, x: s.x, y: s.y, feats: feats('shoot', s, null, { nectar: r.hopper.filter((c) => c !== 'yellow').length / cap }) });
  }
  if (ph === 'teleop' && ok('hp') && B.nectarWhy[a] === 'ok' && !dropZoneOccupied(w, a, 2)) {
    const z = BB.BB_LZ[a];
    out.push({ kind: 'hp', label: 'human player: enter a NECTAR', x: (z.x0 + z.x1) / 2, y: (z.y0 + z.y1) / 2, feats: feats('hp', r.pos, null) });
  }
  // never idle: getting where the next thing happens is always an option (the spill of a tipping
  // cell, or a scoring spot for the target cell)
  if ((ph === 'auto' || ph === 'teleop') && ok('position')) {
    const q = positionGoal(w, r, pilot);
    out.push({ kind: 'position', label: q.label, x: q.x, y: q.y, feats: feats('position', q, q.h) });
  }
  // the TIP CYCLE: worth it when the zone by the HIVE has elements (or a spill is coming)
  if ((ph === 'auto' || ph === 'teleop') && ok('cycle')) {
    const zone = cycleLoose(w, a, pilot);
    const hive = B.hives[a];
    const coming = hive.tipping > 0 && !hive.released && hive.contents.length >= 2;
    if (zone.length >= 2 || (coming && free > 0)) {
      const near = zone.reduce<Ball | null>((m, b) => (!m || dist(b.pos, r.pos) < dist(m.pos, r.pos) ? b : m), null);
      const q = near ? near.pos : positionGoal(w, r, pilot);
      const n = zone.length + (coming ? hive.contents.length : 0);
      const nectar = zone.filter((b) => b.color !== 'yellow').length;
      out.push({ kind: 'cycle', label: `the tip cycle by the HIVE (${zone.length} element${zone.length === 1 ? '' : 's'} there${coming ? ', a spill coming' : ''})`, x: q.x, y: q.y, feats: feats('cycle', q, null, { nectar: zone.length ? nectar / zone.length : 0, cluster: Math.min(n, 8), gain: Math.min(free, n), sweep: n * 0.4, center: hiveCentre(a) }) });
    }
  }
  const g = parkGoal(a, pilot, pilot.parkSlot);
  // PARK counts at the instant AUTO / the match ends, so go only when it takes about that long
  const parkT = pilot.estTime(r, g, g.h) + pilot.style.parkMarginS + Math.max(0, pilot.parkLead);
  if ((ph === 'auto' || (ph === 'teleop' && pilot.parkLead >= 0)) && w.match.phaseTimeLeft < parkT) {
    out.push({ kind: 'park', label: 'park in the loading zone', x: g.x, y: g.y, feats: feats('park', g, g.h) });
  }
  // never idle: with nothing else on the list, getting in position is always there (even while
  // banned for having waited too long — a robot with no option at all stood still for 18 s)
  if (!out.length && (ph === 'auto' || ph === 'teleop')) {
    const q = positionGoal(w, r, pilot);
    out.push({ kind: 'position', label: q.label, x: q.x, y: q.y, feats: feats('position', q, q.h) });
  }
  for (const o of out) o.feats[F_CURRENT] = isCurrent(o) ? 1 : 0;
  return out;
}

/** where to be when there is nothing better: beside the lane a tipping cell's spill will run down
 * (intake toward the HIVE), else the nearest scoring spot for the target cell */
function positionGoal(w: World, r: RobotState, pilot: Pilot): P & { h: number | null; label: string } {
  const a = r.alliance;
  const hive = bb(w).hives[a];
  if (hive.tipping > 0 && !hive.released && hive.contents.length) {
    const hx = a === 'blue' ? BB.BB_HIVE_X : -BB.BB_HIVE_X;
    const sy = hive.up === 'north' ? 1 : -1; // the up cell is the one emptying
    const p = { x: hx, y: sy * (BB.BB_HIVE_CELL_DY + BB.BB_CELL_OPEN.d / 2 + pilot.style.spillWait) };
    const dir = Math.atan2(sy * BB.BB_HIVE_CELL_DY - p.y, hx - p.x);
    const h = Pilot.facing(pilot.bestEnd(r.heading, dir), dir);
    if (placeable(pilot.spec, p, h, 0.5)) return { ...p, h, label: 'wait beside the coming spill' };
  }
  const s = nearestSpot(w, r, pilot);
  return { ...s, h: null, label: `get in position for the ${targetCell(w, a)} CELL` };
}

// ─────────────────────────────── goals ───────────────────────────────
/** which intake end goes into FLOWER i (the one needing the least turn) */
function flowerEnd(i: number, pilot: Pilot, heading: number): 'front' | 'back' {
  const n = BB.FLOWER_MOUTH[BB.BB_FLOWERS[i].wall];
  return pilot.bestEnd(heading, Math.atan2(-n.y, -n.x));
}
/** a FLOWER's retrieval opening: the robot drives an intake end square into the foot */
function flowerGoal(i: number, pilot: Pilot, end: 'front' | 'back'): { pre: P; seat: P; h: number } {
  const f = BB.BB_FLOWERS[i];
  const n = BB.FLOWER_MOUTH[f.wall];
  const out = BB.BB_FLOWER_FOOT.deep - BB.BB_FLOWER_D;
  const O = { x: f.x + n.x * out, y: f.y + n.y * out }; // centre of the foot's field-side face
  const k = pilot.reach(end);
  return {
    pre: { x: O.x + n.x * (k + 14), y: O.y + n.y * (k + 14) },
    seat: { x: O.x + n.x * (k - 1.2), y: O.y + n.y * (k - 1.2) }, // pushes into the foot; contact stops it
    h: Pilot.facing(end, Math.atan2(-n.y, -n.x)), // the intake end toward the FLOWER
  };
}

/** PARK: "at least partially in the LOADING ZONE" — back 4 in into it, clear of the drop spot. Alone
 * (slot 0) in the middle; two robots take its two ends (slots 1, 2), each 6 in into the zone. */
export function parkGoal(a: Alliance, pilot: Pilot, slot = 0): P & { h: number } {
  const z = BB.BB_LZ.blue;
  const y = slot === 1 ? z.y1 + pilot.ext.half - 6 : slot === 2 ? z.y0 - pilot.ext.half + 6 : (z.y0 + z.y1) / 2;
  const p = mir(a, { x: z.x0 - pilot.ext.rear + 4, y });
  return { ...p, h: a === 'blue' ? Math.PI : 0 };
}

/** THE BOX TUBE AT A FLOWER: the pose that puts the tube's placement point (DSIM bbPlacePointLocal,
 * which sits flush against the foot at the FLOWER's centre) on FLOWER i — the tube pointing into it —
 * and a line-up pose 10 in out along the FLOWER's field-side normal */
export function placeGoal(i: number, pilot: Pilot): { pre: P; seat: P; h: number } {
  const f = BB.BB_FLOWERS[i];
  const n = BB.FLOWER_MOUTH[f.wall];
  const t = pilot.tube!;
  const h = wrap(Math.atan2(-n.y, -n.x) - Math.atan2(t.y, t.x));
  const c = Math.cos(h);
  const s = Math.sin(h);
  const seat = { x: f.x - (t.x * c - t.y * s), y: f.y - (t.x * s + t.y * c) };
  return { pre: { x: seat.x + n.x * 10, y: seat.y + n.y * 10 }, seat, h };
}

/** HOW TO TAKE A LOOSE ELEMENT with an intake end: a line-up spot `pre` (turn there, in the open)
 * and a seat `goal` (element at the roller), both on a line through the element. The direction is
 * the one closest to "from where the robot is" whose pre and goal poses are both clear of walls, the
 * HIVE frame and FLOWER feet — so an element against a wall is taken square to the wall, and one
 * beside the frame is never approached through it. null = no clear approach (skip that element). */
export function approach(pilot: Pilot, r: { pos: P; heading: number }, b: P, close = false): { pre: P; goal: P; h: number; direct: boolean } | null {
  // 2.5 in from the HIVE frame. `close`: when nothing else is left to collect, an element only
  // reachable nearer the frame (a spill beside it — late in a match often all there is) with 1 in.
  // Offered only then: taken whenever it is nearest, those cost the no-learning robot ~12 points
  for (const margin of close ? [2.5, 1] : [2.5]) {
    const a0 = Math.atan2(r.pos.y - b.y, r.pos.x - b.x);
    for (let k = 0; k <= 16; k++) {
      const a = a0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 16);
      const u = { x: Math.cos(a), y: Math.sin(a) };
      const end = pilot.bestEnd(r.heading, a + Math.PI); // the intake end faces back along u, at the element
      const ends = end === pilot.ends[0] ? pilot.ends : [...pilot.ends].reverse();
      for (const e of ends) {
        const off = pilot.reach(e) - 1.5; // element at the roller
        const h = Pilot.facing(e, a + Math.PI);
        const goal = { x: b.x + u.x * off, y: b.y + u.y * off };
        const pre = { x: b.x + u.x * (off + pilot.style.preDist), y: b.y + u.y * (off + pilot.style.preDist) };
        if (placeable(pilot.spec, goal, h, 0.5) && placeable(pilot.spec, pre, h, 0.5) && clearOfFrame(pilot.spec, goal, h, margin) && clearOfFrame(pilot.spec, pre, h, margin)) return { pre, goal, h, direct: k === 0 };
      }
    }
  }
  return null;
}

// ─────────────────────────────── executing one option ───────────────────────────────
export type Outcome = 'running' | 'done' | 'failed';

export class Executor {
  private start = 0;
  private budget = 0;
  private app: { pre: P; goal: P; h: number; direct: boolean } | null = null;
  private appAt: P = { x: 0, y: 0 };
  private phase: 'go' | 'seat' = 'go';
  private lastGain = 0;
  private holdH: number | null = null;
  private idle = 0;
  private hop0 = 0;
  private readonly hopStart: number;
  private end: 'front' | 'back' = 'back';
  // a sweep
  private ids: Set<number>; // (the tip cycle re-reads its zone every tick)
  private center: P;
  private radius: number;
  private target: number | null = null;
  private targetAt = 0;
  private targetBudget = 0;
  private readonly skip = new Set<number>();
  // shooting
  private hold: P | null = null;
  private holdCell = '';
  /** at its shooting spot (a dumper holds fire only then: fire turns its chassis) */
  firing = false;
  // placing
  private nectar0 = -1;
  private seatAt = -1;

  constructor(
    readonly opt: Option,
    private pilot: Pilot,
    w: World,
    r: RobotState,
    private banned: Map<string, number> = new Map(),
  ) {
    this.start = w.tick;
    this.lastGain = w.tick;
    this.hop0 = r.hopper.length;
    this.hopStart = r.hopper.length;
    pilot.reset();
    if (opt.kind === 'flower') this.end = flowerEnd(opt.flower!, pilot, r.heading);
    const est = opt.kind === 'flower' ? pilot.estTime(r, flowerGoal(opt.flower!, pilot, this.end).pre, null) : pilot.estTime(r, opt, null);
    const S = pilot.style;
    this.budget = Math.round(60 * (S.budgetMul * est + S.budgetAddS + (opt.kind === 'flower' ? 1.5 : 0)));
    this.ids = new Set(opt.balls ?? []);
    const mem = w.balls.filter((b) => this.ids.has(b.id));
    this.center = mem.length ? { x: mem.reduce((s, b) => s + b.pos.x, 0) / mem.length, y: mem.reduce((s, b) => s + b.pos.y, 0) / mem.length } : { x: opt.x, y: opt.y };
    this.radius = Math.max(12, ...mem.map((b) => dist(b.pos, this.center) + 8));
  }

  /** is `o` (from a fresh option list) the same thing this executor is doing */
  holds(o: Option): boolean {
    const g = (k: OptionKind): boolean => k === 'field' || k === 'lz';
    if (g(this.opt.kind) && g(o.kind)) return !!o.balls?.some((id) => this.ids.has(id) || id === this.target);
    if (o.kind !== this.opt.kind) return false;
    return (o.kind !== 'flower' && o.kind !== 'place') || o.flower === this.opt.flower;
  }

  /** has this option already collected anything */
  get gained(): boolean {
    return this.hop0 > this.hopStart;
  }

  /** this tick's command and whether the option is finished */
  step(w: World, r: RobotState, cap: number): { c: RobotCommand; out: Outcome } {
    const t = w.tick;
    if (r.hopper.length > this.hop0) {
      this.hop0 = r.hopper.length;
      this.lastGain = t;
    }
    const over = t - this.start > this.budget || (this.pilot.stuck && !(this.opt.kind === 'flower' && this.phase === 'seat') && this.opt.kind !== 'park');
    const o = this.opt;
    switch (o.kind) {
      case 'field':
      case 'lz':
        return this.sweep(w, r, cap);
      case 'flower': {
        const g = flowerGoal(o.flower!, this.pilot, this.end);
        const st = bb(w).flowers[o.flower!].stack;
        const bottom = st.length ? w.balls.find((q) => q.id === st[0]) : undefined;
        if (r.hopper.length >= cap || !bottom || bottom.color !== 'yellow') return { c: cmd(), out: r.hopper.length > 0 ? 'done' : 'failed' };
        if (over) return { c: cmd(), out: r.hopper.length > this.hopStart ? 'done' : 'failed' };
        if (this.phase === 'go' && dist(r.pos, g.pre) < 3 && Math.abs(wrap(g.h - r.heading)) < 0.08) {
          this.phase = 'seat';
          this.lastGain = t;
        }
        if (this.phase === 'go') return { c: this.pilot.drive(r, t, g.pre, g.h), out: 'running' };
        // square in, slower than IMPACT_MAX (20 in/s), and keep pressing while it pulls POLLEN out
        if (t - this.lastGain > 90) return { c: cmd(), out: r.hopper.length > this.hopStart ? 'done' : 'failed' };
        const c = this.pilot.drive(r, t, g.seat, g.h, { vCap: Math.min(this.pilot.style.seatV, this.pilot.vIntake), lockH: true });
        c.intake = true;
        return { c, out: 'running' };
      }
      case 'shoot':
        if (r.hopper.length === 0) return { c: cmd(), out: 'done' };
        if (over) return { c: cmd(), out: 'failed' };
        return this.shootStep(w, r);
      case 'hp':
        return { c: cmd({ bbNectar: true }), out: 'done' };
      case 'position': {
        // hold there (a new target each think): the policy leaves the moment something is better
        const q = positionGoal(w, r, this.pilot);
        return { c: this.pilot.drive(r, t, q, q.h), out: 'running' };
      }
      case 'park': {
        const g = parkGoal(r.alliance, this.pilot, this.pilot.parkSlot);
        const ph = w.match.phase;
        if (ph !== 'auto' && ph !== 'teleop') return { c: cmd(), out: 'done' };
        return { c: this.pilot.drive(r, t, g, g.h, { vCap: 18 }), out: 'running' };
      }
      case 'cycle':
        return this.cycle(w, r, cap);
      case 'place':
        return this.placeStep(w, r, over);
    }
  }

  /** PLACING with the Box Tube: line up 10 in out, square in along the FLOWER's normal at under
   * 12 in/s (contact stops it), and once DSIM says the placement point is in reach
   * (bbFlowerInReach) press the NECTAR button — edge-triggered, so every other tick — until a
   * NECTAR has left the hopper. */
  private placeStep(w: World, r: RobotState, over: boolean): { c: RobotCommand; out: Outcome } {
    const t = w.tick;
    const i = this.opt.flower!;
    const g = placeGoal(i, this.pilot);
    const held = r.hopper.filter((c) => c === r.alliance).length;
    if (this.nectar0 < 0) this.nectar0 = held;
    if (held < this.nectar0) return { c: cmd(), out: 'done' };
    if (held === 0 || over || w.match.phase !== 'teleop') return { c: cmd(), out: 'failed' };
    if (this.phase === 'go' && dist(r.pos, g.pre) < 3 && Math.abs(wrap(g.h - r.heading)) < 0.06) {
      this.phase = 'seat';
      this.seatAt = t;
    }
    if (this.phase === 'go') return { c: this.pilot.drive(r, t, g.pre, g.h), out: 'running' };
    const c = this.pilot.drive(r, t, g.seat, g.h, { vCap: 12, lockH: true });
    if (bbFlowerInReach(w, r) === i) c.bbPlaceNectar = t % 2 === 0;
    else if (t - this.seatAt > 120) return { c: cmd(), out: 'failed' }; // 2 s squaring in and never in reach
    return { c, out: 'running' };
  }

  /** SHOOTING from here when this is a measured scoring position for the target cell, else from
   * the nearest turn-safe spot; the target cell switches the moment a tip starts. There: hold still
   * at firing speed (fire is held by the brain whenever a shot can score). Waiting for the release
   * after a tip is the one wait left (≤ 2 s); a turret that cannot find the cell from this heading
   * turns slowly; a spot that gives no shot at all is given up ('failed') and avoided for 20 s. */
  private shootStep(w: World, r: RobotState): { c: RobotCommand; out: Outcome } {
    const t = w.tick;
    const cell = targetCell(w, r.alliance);
    if (!this.hold || this.holdCell !== cell) {
      this.hold = this.pilot.inRange(w, r.alliance, r.pos) && !this.pilot.isBad(r.pos, t) ? { ...r.pos } : nearestSpot(w, r, this.pilot);
      this.holdCell = cell;
      this.holdH = null;
      this.idle = 0;
    }
    const s = this.hold;
    this.firing = dist(r.pos, s) < 3;
    if (!this.firing) return { c: this.pilot.drive(r, t, s, null), out: 'running' };
    const gate = fireGate(w, r);
    this.idle = gate && r.hopper.length >= this.hop0 ? this.idle + 1 : 0;
    this.hop0 = Math.min(this.hop0, r.hopper.length);
    this.holdH ??= r.heading;
    if (this.idle > Math.round(60 * this.pilot.style.shootTurnS)) this.holdH = r.heading + 0.6;
    if (this.idle > Math.round(60 * this.pilot.style.shootGiveUpS)) {
      this.pilot.badSpots.push({ x: s.x, y: s.y, until: t + 1200 }); // no shot from here for this robot: avoid it 20 s
      return { c: cmd(), out: 'failed' };
    }
    return { c: this.pilot.drive(r, t, s, this.holdH, { vMax: this.pilot.vFire }), out: 'running' };
  }

  /** THE TIP CYCLE (cycleLoose): collect in the zone by the HIVE — the sweep, with the zone as its
   * group — firing whenever a shot can score; when full (or the zone is empty and it holds some),
   * shoot from where it is or the nearest scoring spot; wait by a coming spill. It ends when there
   * is nothing left to take or shoot, or nothing has been taken or shot for sweepIdleS. */
  private lastShotT = 0;
  private dry = 0;
  private cHop = -1;
  private took = false;
  private cycle(w: World, r: RobotState, cap: number): { c: RobotCommand; out: Outcome } {
    const t = w.tick;
    const a = r.alliance;
    // progress: an element taken or a shot fired
    if (this.cHop >= 0 && r.hopper.length > this.cHop) {
      this.lastGain = t;
      this.took = true;
    } else if (this.cHop >= 0 && r.hopper.length < this.cHop) this.lastShotT = t;
    this.cHop = r.hopper.length;
    this.lastGain = Math.max(this.lastGain, this.lastShotT); // a shot is progress for the sweep inside too
    // no element taken and no shot for sweepIdleS: the loop is not working here — a failure, so the
    // brain leaves it alone for a while (a forced tip cycle once stalled every match by re-picking it)
    if (t - this.lastGain > Math.round(60 * this.pilot.style.sweepIdleS)) return { c: cmd(), out: 'failed' };
    const loose = cycleLoose(w, a, this.pilot, this.skip);
    const hive = bb(w).hives[a];
    const coming = hive.tipping > 0 && !hive.released && hive.contents.length >= 2;
    this.dry = !loose.length && !coming && r.hopper.length === 0 ? this.dry + 1 : 0;
    if (this.dry > 30) return { c: cmd(), out: this.took ? 'done' : 'failed' };
    if (r.hopper.length >= cap || (!loose.length && r.hopper.length > 0 && !coming)) {
      // shoot from the zone (the shoot job's own step: it gives a spot up when no shot comes)
      const s = this.shootStep(w, r);
      return s.out === 'failed' ? { c: s.c, out: 'failed' } : { c: s.c, out: 'running' };
    }
    this.hold = null;
    this.hop0 = r.hopper.length;
    if (!loose.length) {
      const q = positionGoal(w, r, this.pilot); // a spill is coming: be beside it
      return { c: this.pilot.drive(r, t, q, q.h), out: 'running' };
    }
    this.ids = new Set(loose.map((b) => b.id));
    this.center = hiveCentre(a);
    this.radius = CYCLE_R;
    const s = this.sweep(w, r, cap);
    if (s.out !== 'running') this.target = null; // (not expected: the cases the sweep ends on are handled above) — next tick picks again
    return { c: s.c, out: 'running' };
  }

  /** SWEEP A GROUP: nearest-next through its elements (and any that rolled in beside them), the
   * intake end leading, until the hopper is full or the group is gone. An element that takes too
   * long is skipped, not the whole group. Holding enough (STYLE fireHold) on a robot that may fire
   * while moving (fireMinV), in range of the target cell, it slows to firing speed and scores as
   * it goes — the world-record conveyor. */
  private sweep(w: World, r: RobotState, cap: number): { c: RobotCommand; out: Outcome } {
    const t = w.tick;
    const a = r.alliance;
    if (r.hopper.length >= cap) return { c: cmd(), out: 'done' };
    const S = this.pilot.style;
    const ban = Math.round(60 * S.failBanS);
    if (t - this.lastGain > Math.round(60 * S.sweepIdleS)) {
      if (this.target !== null) this.banned.set(`b${this.target}`, t + ban); // not straight back to it
      return { c: cmd(), out: this.gained ? 'done' : 'failed' };
    }
    const loose = w.balls.filter(
      (b) => b.state.kind === 'ground' && this.pilot.accepts(b.color, a) && !this.skip.has(b.id) && (this.ids.has(b.id) || dist(b.pos, this.center) <= this.radius),
    );
    let b = this.target === null ? undefined : loose.find((q) => q.id === this.target);
    // a target it cannot get to is skipped: over its time, stuck on the way, or held off by another
    // robot for 3/4 s (a partner parked beside it) — never for slow progress pushing into it
    if (b && (t - this.targetAt > this.targetBudget || (this.pilot.stuck && this.phase === 'go') || this.pilot.blockedTicks > 45)) {
      this.skip.add(b.id);
      this.banned.set(`b${b.id}`, t + ban);
      b = undefined;
    }
    if (!b) {
      let best: Ball | undefined;
      let bc = Infinity;
      for (const q of loose) {
        const c = this.pilot.estTime(r, q.pos, null) + this.pilot.turnTo(r.pos, r.heading, q.pos);
        if (c < bc || (c === bc && best && q.id < best.id)) {
          bc = c;
          best = q;
        }
      }
      if (!best) return { c: cmd(), out: this.gained ? 'done' : 'failed' };
      b = best;
      this.target = b.id;
      this.targetAt = t;
      this.targetBudget = Math.round(60 * (S.budgetMul * bc + S.budgetAddS));
      this.app = null;
      this.phase = 'go';
      this.pilot.reset();
    }
    const d = dist(r.pos, b.pos);
    if (!this.app || dist(this.appAt, b.pos) > 3) {
      this.app = approach(this.pilot, r, b.pos, !!this.opt.close || this.opt.kind === 'cycle');
      this.appAt = { ...b.pos };
      if (!this.app) {
        this.skip.add(b.id);
        this.target = null;
        return { c: cmd({ intake: true }), out: 'running' };
      }
    }
    const A = this.app;
    // line up at `pre` (turn in the open), then drive the intake end straight in — straight at it
    // when the robot is already on the approach line
    if (A.direct) this.phase = 'seat';
    if (this.phase === 'go' && ((dist(r.pos, A.pre) < 6 && Math.abs(wrap(A.h - r.heading)) < 0.15) || (d < Math.max(this.pilot.ext.rear, this.pilot.ext.front) + 6 && Math.abs(wrap(A.h - r.heading)) < 0.25))) this.phase = 'seat';
    // (a hair under: a Float32 gene decoding to 2.0000001 means 2)
    // (a dumper never fires on the move: holding fire turns its whole chassis toward the HIVE)
    const fire = !this.pilot.dumper && r.hopper.length >= Math.max(1, Math.ceil(S.fireHold - 1e-6)) && this.pilot.vFire / 0.85 >= S.fireMinV && fireGate(w, r) && this.pilot.inRange(w, a, r.pos);
    const vMax = fire ? this.pilot.vFire : undefined;
    const c = this.phase === 'go' ? this.pilot.drive(r, t, A.pre, A.h, { vMax }) : this.pilot.drive(r, t, A.goal, A.h, { lockH: true, vCap: this.pilot.vIntake, vMax });
    return { c, out: 'running' };
  }
}
