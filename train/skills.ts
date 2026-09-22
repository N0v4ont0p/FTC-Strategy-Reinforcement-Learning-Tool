// SKILLS (PLAN.md S2) — what the robot already KNOWS how to do, so evolution only has to learn
// WHAT TO DO NEXT: collect off the field, collect in the loading zone, pull POLLEN out of a FLOWER,
// shoot, press the human-player button, park. Each skill is a deterministic closed-loop controller
// on DSIM's own state, driving the S1 path law (harness/s1/paths.ts rollout) along the S1
// visibility-graph planner, with the S1 measured shooting envelope. Nothing here is learned.
import {
  BB,
  BB_TIP_RELEASE_S,
  bb,
  bbAimTarget,
  bbCellSideOf,
  bbMouths,
  cmd,
  footprintCorners,
  footprintExtents,
  type Alliance,
  type RobotCommand,
  type RobotSpec,
  type RobotState,
  type World,
} from '../harness/dsim';
import { effective, type Eff } from '../harness/s1/drive';
import { planPolyline } from '../harness/s1/paths';
import { dropZoneOccupied } from '../harness/filters';
import { flowerFeet, placeable } from '../harness/s1/lab';
import { polysOverlap, rect } from '../harness/geom';
import { SPOTS } from './obs';

type P = { x: number; y: number };
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const dist = (a: P, b: P): number => Math.hypot(a.x - b.x, a.y - b.y);

export const OPTION_KINDS = ['field', 'lz', 'flower', 'shoot', 'hp', 'park'] as const;
export type OptionKind = (typeof OPTION_KINDS)[number];
/** per-option features the policy sees (plus the global observation) */
export const OPT_FEATS = ['k:field', 'k:lz', 'k:flower', 'k:shoot', 'k:hp', 'k:park', 'estTime', 'dist', 'nectar', 'cluster', 'flowerPollen', 'toShoot', 'hopperAfter', 'onUpSide'] as const;
export const N_OPT_FEATS = OPT_FEATS.length;

export interface Option {
  kind: OptionKind;
  label: string;
  x: number; // where it goes (world frame), for the viewer
  y: number;
  ball?: number;
  flower?: number;
  feats: number[];
}

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
/** HIVE frame bars grown by 1 in (the safety margin) and their centre lines */
const BAR_RECTS = BARS.map(([a, b]) => rect(a.x - 1, a.y - 1, b.x + 1, b.y + 1));
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
  /** measured scoring spots (blue frame) where this robot can turn a full circle clear of walls,
   * the HIVE frame and FLOWER feet — the only places the shoot skill parks */
  readonly spots: Record<'north' | 'south', P[]>;
  private plan: { goal: P; pts: P[]; leg: number; at: number } | null = null;
  private prog = { best: Infinity, at: 0 };
  /** true when the robot made no progress toward its goal for STUCK_TICKS (blocked) */
  stuck = false;
  /** scoring spots that just failed for THIS robot (world frame, tick until which they are avoided) */
  badSpots: { x: number; y: number; until: number }[] = [];

  constructor(readonly spec: RobotSpec) {
    this.E = effective(spec, true, 0); // intake running: the slower, safe budget
    this.ext = footprintExtents(spec);
    this.ends = bbMouths(spec)
      .map((m) => m.edge)
      .filter((e): e is 'front' | 'back' => e === 'front' || e === 'back');
    if (!this.ends.length) throw new Error('skills need a front or back intake (side intakes are not modelled yet)');
    // paths clear the HIVE frame and FLOWER feet by half the width + 4 in (it cruises along its
    // long axis); the look-ahead safety in drive() covers the corners it sweeps while turning
    const turn = Math.hypot(Math.max(this.ext.front, this.ext.rear), this.ext.half) + 1;
    this.R = this.ext.half + 4;
    const solids = [...flowerFeet(), ...BARS];
    const clear = (p: P): boolean =>
      BB.BB_HALF_X - Math.abs(p.x) >= turn && BB.BB_HALF_Y - Math.abs(p.y) >= turn && solids.every((poly) => rectDist(p, poly) >= turn);
    this.spots = { north: SPOTS.north.filter(clear), south: SPOTS.south.filter(clear) };
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
  estTime(r: RobotState, p: P, h: number | null): number {
    const turn = h === null ? 0 : Math.abs(wrap(h - r.heading));
    return dist(r.pos, p) / (0.8 * this.E.vmax) + turn / this.E.maxTurn + 0.2;
  }

  reset(): void {
    this.plan = null;
    this.prog = { best: Infinity, at: 0 };
    this.stuck = false;
  }

  /** one tick toward `goal` (arriving with heading `h`, or any heading when null). The speed and
   * heading law is harness/s1/paths.ts `rollout`'s (brake-aware profile, 0.3° deadband). */
  drive(r: RobotState, tick: number, goal: P, h: number | null, o: { vCap?: number; lockH?: boolean } = {}): RobotCommand {
    if (!this.plan || dist(this.plan.goal, goal) > 4 || tick - this.plan.at > 60) {
      this.plan = { goal: { ...goal }, pts: [...planPolyline(r.pos, goal, this.R), { ...goal }], leg: 0, at: tick };
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
    let vDes = Math.min(E.vmax, Math.sqrt(2 * 0.9 * aB * Math.max(0, remaining - 0.3)));
    if (pl.leg === pl.pts.length - 1) vDes = Math.min(vDes, 6 * d);
    if (o.vCap !== undefined && remaining < 30) vDes = Math.min(vDes, o.vCap);
    const dirH = Math.atan2(ey, ex);
    const cruise = Math.abs(wrap(dirH - r.heading)) <= Math.PI / 2 ? dirH : wrap(dirH + Math.PI);
    const hT = h === null ? (d > 3 ? cruise : r.heading) : o.lockH || remaining <= 36 ? h : cruise;
    const eh = wrap(hT - r.heading);
    const rot0 = Math.abs(eh) < 0.005 ? 0 : Math.sign(eh) * Math.min(1, Math.sqrt(2 * 0.9 * 1.4 * E.turnAccel * Math.abs(eh)) / E.maxTurn, 4 * Math.abs(eh));
    let vx = d > 1e-9 ? (vDes * ex) / d : 0;
    let vy = d > 1e-9 ? (vDes * ey) / d : 0;
    let rot = rot0;
    // SAFETY (G417 is a death): if the robot's own motion, or the commanded one, would put its
    // footprint on a HIVE frame bar within a quarter second, stop turning and back off the bar
    const hits = (px: number, py: number, h: number): boolean => {
      const fp = footprintCorners(this.spec, { x: px, y: py }, h);
      return BAR_RECTS.some((b) => polysOverlap(fp, b, 0));
    };
    let danger = false;
    for (const T of [0.08, 0.16, 0.25]) {
      if (
        hits(r.pos.x + r.vel.x * T, r.pos.y + r.vel.y * T, r.heading + r.angVel * T) ||
        hits(r.pos.x + vx * T, r.pos.y + vy * T, r.heading + rot * E.maxTurn * T)
      ) {
        danger = true;
        break;
      }
    }
    if (danger) {
      rot = 0;
      const bar = BAR_X.reduce((a, b) => (Math.abs(b - r.pos.x) < Math.abs(a - r.pos.x) ? b : a));
      if (Math.abs(r.pos.y) > BB.BB_FRAME_Y) {
        vy = Math.sign(r.pos.y) * 25; // beyond the bar's end: away along y
        vx = 0;
      } else {
        vx = (Math.sign(r.pos.x - bar) || 1) * 25; // beside the bar: away along x
        vy = 0;
      }
    }
    const c = Math.cos(r.heading);
    const s = Math.sin(r.heading);
    let fwd = (vx * c + vy * s) / E.vmax;
    let side = -(-vx * s + vy * c) / (E.vmax * E.strafeMult);
    const m = Math.max(1, Math.abs(fwd), Math.abs(side)); // keep the direction when a stick saturates
    fwd /= m;
    side /= m;
    return cmd({ driveY: fwd, driveX: side, rotate: rot });
  }
}

// ─────────────────────────────── the options available now ───────────────────────────────
function inRect(p: P, z: { x0: number; x1: number; y0: number; y1: number }): boolean {
  return p.x >= z.x0 && p.x <= z.x1 && p.y >= z.y0 && p.y <= z.y1;
}
const collectable = (a: Alliance, color: string): boolean => color === 'yellow' || color === a;

/** the up CELL a robot can score in, in the alliance's frame ('north' | 'south') */
function upSide(w: World, r: RobotState): 'north' | 'south' {
  const up = bb(w).hives[r.alliance].up;
  return r.alliance === 'blue' ? up : up === 'north' ? 'south' : 'north';
}

/** nearest turn-safe measured scoring spot for the up CELL (world frame) */
export function nearestSpot(w: World, r: RobotState, pilot: Pilot, from: P = r.pos): P {
  const a = r.alliance;
  const f = mir(a, from);
  const list = pilot.spots[upSide(w, r)];
  pilot.badSpots = pilot.badSpots.filter((b) => b.until > w.tick);
  const bad = pilot.badSpots.map((b) => mir(a, b));
  let best = list[0];
  let bd = Infinity;
  for (const s of list) {
    if (bad.some((b) => (b.x - s.x) ** 2 + (b.y - s.y) ** 2 < 144)) continue; // within 12 in of a failed spot
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
  const other = hive.up === 'north' ? 'south' : 'north';
  const taking = hive.tipping <= 0 ? hive.up : hive.released || hive.tipping - BB_TIP_RELEASE_S <= FLIGHT_S ? other : null;
  return taking !== null && bbCellSideOf(bbAimTarget(w, r)) === taking;
}

const PARK_MARGIN_S = 1.0;

export function options(w: World, r: RobotState, pilot: Pilot, cap: number, banned: Map<string, number>): Option[] {
  const a = r.alliance;
  const B = bb(w);
  const out: Option[] = [];
  const free = cap - r.hopper.length;
  const ph = w.match.phase;
  const t = w.tick;
  const ok = (key: string): boolean => (banned.get(key) ?? -1) < t;
  const feats = (k: OptionKind, p: P, h: number | null, extra: { nectar?: number; cluster?: number; flowerPollen?: number; gain?: number } = {}): number[] => {
    const est = pilot.estTime(r, p, h);
    const toShoot = k === 'shoot' || k === 'hp' || k === 'park' ? 0 : dist(p, nearestSpot(w, r, pilot, p)) / 144;
    return [
      ...OPTION_KINDS.map((q) => (q === k ? 1 : 0)),
      est / 5,
      dist(r.pos, p) / 144,
      extra.nectar ?? 0,
      (extra.cluster ?? 0) / 4,
      (extra.flowerPollen ?? 0) / 4,
      toShoot,
      (r.hopper.length + (extra.gain ?? 0)) / cap,
      // +1 when the target is on the up CELL's side of the field (shoot from there without crossing)
      Math.sign(mir(a, p).y) === (upSide(w, r) === 'north' ? 1 : -1) ? 1 : -1,
    ];
  };
  if (free > 0) {
    // loose elements: POLLEN and own NECTAR on the tiles, nearest first (8)
    const lz = BB.BB_LZ[a];
    const loose = w.balls.filter((b) => b.state.kind === 'ground' && collectable(a, b.color) && ok(`b${b.id}`));
    loose.sort((p, q) => dist(p.pos, r.pos) - dist(q.pos, r.pos));
    for (const b of loose.filter((q) => approach(pilot, r, q.pos)).slice(0, 8)) {
      const inLz = inRect(b.pos, lz);
      const cluster = loose.filter((q) => q !== b && dist(q.pos, b.pos) < 18).length;
      out.push({
        kind: inLz ? 'lz' : 'field',
        label: `${inLz ? 'loading zone' : 'field'} ${b.color === 'yellow' ? 'POLLEN' : 'NECTAR'} #${b.id}`,
        x: b.pos.x,
        y: b.pos.y,
        ball: b.id,
        feats: feats(inLz ? 'lz' : 'field', b.pos, null, { nectar: b.color === 'yellow' ? 0 : 1, cluster, gain: Math.min(free, 1 + cluster) }),
      });
    }
    // FLOWERS whose bottom element is a POLLEN (a NECTAR at the bottom locks it)
    BB.BB_FLOWERS.forEach((f, i) => {
      const st = B.flowers[i].stack;
      const bottom = st.length ? w.balls.find((q) => q.id === st[0]) : undefined;
      if (!bottom || bottom.color !== 'yellow' || !ok(`f${i}`)) return;
      const pollen = st.filter((id) => w.balls.find((q) => q.id === id)?.color === 'yellow').length;
      const g = flowerGoal(i, pilot, flowerEnd(i, pilot, r.heading));
      out.push({ kind: 'flower', label: `FLOWER ${f.id} (${pollen} POLLEN)`, x: f.x, y: f.y, flower: i, feats: feats('flower', g.pre, g.h, { flowerPollen: pollen, gain: Math.min(free, pollen) }) });
    });
  }
  if (r.hopper.length > 0 && ok('shoot')) {
    const s = nearestSpot(w, r, pilot);
    out.push({ kind: 'shoot', label: `shoot (${r.hopper.length} held)`, x: s.x, y: s.y, feats: feats('shoot', s, null, { nectar: r.hopper.filter((c) => c !== 'yellow').length / cap }) });
  }
  if (ph === 'teleop' && ok('hp') && B.nectarWhy[a] === 'ok' && !dropZoneOccupied(w, a, 2)) {
    const z = BB.BB_LZ[a];
    out.push({ kind: 'hp', label: 'human player: enter a NECTAR', x: (z.x0 + z.x1) / 2, y: (z.y0 + z.y1) / 2, feats: feats('hp', r.pos, null) });
  }
  const g = parkGoal(a, pilot);
  // PARK counts at the instant AUTO / the match ends, so go only when it takes about that long
  const parkT = pilot.estTime(r, g, g.h) + PARK_MARGIN_S;
  if ((ph === 'auto' || ph === 'teleop') && w.match.phaseTimeLeft < parkT) {
    out.push({ kind: 'park', label: 'park in the loading zone', x: g.x, y: g.y, feats: feats('park', g, g.h) });
  }
  return out;
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

/** PARK: "at least partially in the LOADING ZONE" — back 4 in into it, clear of the drop spot */
function parkGoal(a: Alliance, pilot: Pilot): P & { h: number } {
  const z = BB.BB_LZ.blue;
  const p = mir(a, { x: z.x0 - pilot.ext.rear + 4, y: (z.y0 + z.y1) / 2 });
  return { ...p, h: a === 'blue' ? Math.PI : 0 };
}

/** HOW TO TAKE A LOOSE ELEMENT with an intake end: a line-up spot `pre` (turn there, in the open)
 * and a seat `goal` (element at the roller), both on a line through the element. The direction is
 * the one closest to "from where the robot is" whose pre and goal poses are both clear of walls, the
 * HIVE frame and FLOWER feet — so an element against a wall is taken square to the wall, and one
 * beside the frame is never approached through it. null = no clear approach (skip that element). */
export function approach(pilot: Pilot, r: RobotState, b: P): { pre: P; goal: P; h: number; direct: boolean } | null {
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
      const pre = { x: b.x + u.x * (off + 12), y: b.y + u.y * (off + 12) };
      if (placeable(pilot.spec, goal, h, 0.5) && placeable(pilot.spec, pre, h, 0.5)) return { pre, goal, h, direct: k === 0 };
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
  private up0 = '';
  private end: 'front' | 'back' = 'back';

  constructor(
    readonly opt: Option,
    private pilot: Pilot,
    w: World,
    r: RobotState,
  ) {
    this.start = w.tick;
    this.lastGain = w.tick;
    this.hop0 = r.hopper.length;
    this.hopStart = r.hopper.length;
    this.up0 = bb(w).hives[r.alliance].up;
    pilot.reset();
    if (opt.kind === 'flower') this.end = flowerEnd(opt.flower!, pilot, r.heading);
    const est = opt.kind === 'flower' ? pilot.estTime(r, flowerGoal(opt.flower!, pilot, this.end).pre, null) : pilot.estTime(r, opt, null);
    this.budget = Math.round(60 * (1.8 * est + (opt.kind === 'flower' ? 4 : 2.5)));
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
      case 'lz': {
        const b = w.balls.find((q) => q.id === o.ball);
        if (!b || b.state.kind !== 'ground') {
          const mine = b?.state.kind === 'held' && (b.state as { robot: number }).robot === r.id;
          return { c: cmd(), out: mine ? 'done' : 'failed' };
        }
        if (r.hopper.length >= cap) return { c: cmd(), out: 'done' };
        if (over) return { c: cmd(), out: 'failed' };
        const d = dist(r.pos, b.pos);
        if (!this.app || dist(this.appAt, b.pos) > 3) {
          this.app = approach(this.pilot, r, b.pos);
          this.appAt = { ...b.pos };
          if (!this.app) return { c: cmd(), out: 'failed' };
        }
        const A = this.app;
        // line up at `pre` (turn in the open), then back straight in with the intake running
        // straight at it when the robot is already on the approach line; else line up at `pre` first
        if (A.direct) this.phase = 'seat';
        if (this.phase === 'go' && ((dist(r.pos, A.pre) < 6 && Math.abs(wrap(A.h - r.heading)) < 0.15) || (d < Math.max(this.pilot.ext.rear, this.pilot.ext.front) + 6 && Math.abs(wrap(A.h - r.heading)) < 0.25))) this.phase = 'seat';
        const c = this.phase === 'go' ? this.pilot.drive(r, t, A.pre, A.h) : this.pilot.drive(r, t, A.goal, A.h, { lockH: true });
        return { c, out: 'running' };
      }
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
        const c = this.pilot.drive(r, t, g.seat, g.h, { vCap: 14, lockH: true });
        c.intake = true;
        return { c, out: 'running' };
      }
      case 'shoot': {
        if (r.hopper.length === 0) return { c: cmd(), out: 'done' };
        if (bb(w).hives[r.alliance].up !== this.up0) return { c: cmd(), out: 'done' }; // the cell swapped: re-decide
        if (over) return { c: cmd(), out: 'failed' };
        const s = nearestSpot(w, r, this.pilot);
        const inRange = fireGate(w, r) && dist(r.pos, s) < 3;
        if (!inRange) return { c: this.pilot.drive(r, t, s, null), out: 'running' };
        // at the spot: hold still; if the turret cannot find the cell from this heading, turn slowly
        this.idle = r.hopper.length < this.hop0 ? 0 : this.idle + 1;
        this.hop0 = Math.min(this.hop0, r.hopper.length);
        this.holdH ??= r.heading;
        const c = this.pilot.drive(r, t, s, this.holdH);
        if (this.idle > 40) this.holdH = r.heading + 0.6;
        if (this.idle > 150) {
          this.pilot.badSpots.push({ x: s.x, y: s.y, until: t + 1200 }); // no shot from here for this robot: avoid it 20 s
          return { c: cmd(), out: 'failed' };
        }
        return { c, out: 'running' };
      }
      case 'hp':
        return { c: cmd({ bbNectar: true }), out: 'done' };
      case 'park': {
        const g = parkGoal(r.alliance, this.pilot);
        const ph = w.match.phase;
        if (ph !== 'auto' && ph !== 'teleop') return { c: cmd(), out: 'done' };
        return { c: this.pilot.drive(r, t, g, g.h, { vCap: 18 }), out: 'running' };
      }
    }
  }
}
