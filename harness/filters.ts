// LAYER B (PLAN.md §2.2): the real robot's limits and the driver's limits, applied to commands
// BEFORE DSIM sees them. What comes out is what the replay records, so filtered runs replay
// exactly in unmodified DSIM. Reads world state; never writes it.
import { BB, DT, footprintCorners, footprintExtents, type Alliance, type RobotCommand, type RobotState, type Vec2, type World } from './dsim';
import type { Limits } from './profiles';
import { mulberry32, seedOf, type Stream } from './rng';
import { polysOverlap } from './geom';

/** Driver limits. ORACLE = none. HUMAN = the S0 default human tier (PLAN.md §3). */
export interface DriverModel {
  reaction: number; // s between what the driver sees and what the robot receives
  holdTicks: number; // decisions held this many ticks (6 ⇒ 10 Hz)
}
export const ORACLE: DriverModel = { reaction: 0, holdTicks: 1 };
export const HUMAN: DriverModel = { reaction: 0.25, holdTicks: 6 };

export interface RuleOpts {
  /** G426 allows a human-player entry per TIP with no AUTO exception, but G401's "indirectly
   * interact" is ambiguous (PLAN.md §7.2). Conservative default: hold AUTO presses to TELEOP. */
  hpInAuto: 'forbid' | 'allow';
  /** G427 C: an entered NECTAR must touch the tile before any robot → hold the press while a
   * robot covers the drop area. Off only for the identity test. */
  g427c: boolean;
}
export const RULES_CONSERVATIVE: RuleOpts = { hpInAuto: 'forbid', g427c: true };
/** no rule holds at all — only for proving layer B is an exact identity at ideal limits */
export const RULES_NONE: RuleOpts = { hpInAuto: 'allow', g427c: false };

const EDGE_KEYS = ['bbNectar', 'bbPlace', 'bbPlaceNectar', 'driveMode', 'catalyst', 'fling'] as const;
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const speedOf = (r: RobotState): number => Math.hypot(r.vel.x, r.vel.y);

/** Where a human-player NECTAR can land (DSIM: loading-zone spot ± 4 in jitter, play.ts). G427 C
 * requires it to touch the tile before any robot, so this square must be clear to press. */
export function hpDropZone(a: Alliance): Vec2[] {
  const s = BB.bbLoadingZoneSpot(a, BB.BB_NECTAR_R);
  const h = 4 + BB.BB_NECTAR_R + 0.5;
  return [
    { x: s.x - h, y: s.y - h },
    { x: s.x + h, y: s.y - h },
    { x: s.x + h, y: s.y + h },
    { x: s.x - h, y: s.y + h },
  ];
}
/** `lookahead`: grow each robot by how far its fastest point can travel in that many ticks, so a
 * robot that is about to enter during this step still counts (the press is judged before the
 * step; the NECTAR lands during it). s0-check caught the plain version letting 9 of ~12k through. */
export const dropZoneOccupied = (w: World, a: Alliance, lookahead = 0): boolean =>
  w.robots.some((r) => {
    const e = footprintExtents(r.spec);
    const reach = Math.hypot(r.vel.x, r.vel.y) + Math.abs(r.angVel) * Math.hypot(Math.max(e.front, e.rear), e.half);
    const pad = lookahead > 0 ? reach * DT * lookahead + 1 : 0;
    return polysOverlap(footprintCorners(r.spec, r.pos, r.heading, pad), hpDropZone(a));
  });

class RobotFilter {
  private q: RobotCommand[] = [];
  private held: RobotCommand | null = null;
  private edgeAcc: Partial<Record<(typeof EDGE_KEYS)[number], boolean>> = {};
  private n = 0;
  private slowT = 0;
  private intakeT = 0;
  private episode = false;
  private blockUntil = -1;
  private turret: [number, number];
  private hpPrevIntent = false;
  private hpPrevOut = false;
  private hpDue: number[] = [];
  private rng: Stream;

  constructor(
    private L: Limits,
    private D: DriverModel,
    private rules: RuleOpts,
    seed: number,
    id: number,
  ) {
    const home = (L.turretHome * Math.PI) / 180;
    this.turret = [home, home];
    this.rng = mulberry32(seedOf(seed, id, 'filter'));
  }
  /** new luck from here on (what-if branches; train/fork.ts) */
  reseed(seed: number, id: number): void {
    this.rng.reseed(seedOf(seed, id, 'filter'));
  }

  apply(w: World, r: RobotState, intent: RobotCommand): RobotCommand {
    const c = this.driver(intent);
    const L = this.L;
    const out: RobotCommand = { ...c };
    const speed = speedOf(r);

    // intake: must be slow for tSecure before a capture can happen; an attempt can fail
    if (!(L.vIntake >= 100 && L.tSecure <= 0 && L.intakeSuccess >= 1)) {
      if (!c.intake) {
        this.intakeT = 0;
        this.episode = false;
        out.intake = false;
      } else {
        this.intakeT = speed <= L.vIntake ? this.intakeT + DT : 0;
        if (speed > L.vIntake) this.episode = false;
        if (!this.episode && this.intakeT >= L.tSecure - 1e-9) {
          this.episode = true;
          if (this.rng() >= L.intakeSuccess) this.blockUntil = w.time + L.intakeRetry;
        }
        out.intake = this.episode && w.time >= this.blockUntil;
      }
    }

    // fire: rate cap, settle-before-shot, and an emulated turret with real travel and slew
    this.slowT = speed <= L.vFire ? this.slowT + DT : 0;
    let fireOk = true;
    if (L.fireRate < 13 && w.time - r.lastFireAt < 1 / L.fireRate - 1e-9) fireOk = false;
    if (!(L.vFire >= 100 && L.aimSettle <= 0) && this.slowT < L.aimSettle - 1e-9) fireOk = false;
    if (L.vFire < 100 && speed > L.vFire) fireOk = false;
    if (!(L.turretYawRange >= 360 && L.turretSlew >= 7)) {
      const top = r.hopper[r.hopper.length - 1];
      const which = top === undefined || top === 'yellow' ? 0 : 1; // POLLEN turret 0, NECTAR turret 1
      const home = (L.turretHome * Math.PI) / 180;
      const half = ((L.turretYawRange >= 360 ? 360 : L.turretYawRange) * Math.PI) / 360;
      const unlimited = L.turretYawRange >= 360;
      const fieldYaw = [r.turretHeading, r.bbTurret2Heading ?? r.turretHeading];
      let aimed = false;
      for (const k of [0, 1] as const) {
        const req = wrap(fieldYaw[k] - r.heading - home); // wanted yaw relative to home
        const reachable = unlimited || Math.abs(req) <= half;
        const goal = unlimited ? req : Math.max(-half, Math.min(half, req));
        const cur = this.turret[k];
        const err = unlimited ? wrap(goal - cur) : goal - cur;
        const step = L.turretSlew * DT;
        this.turret[k] = Math.abs(err) <= step ? goal : cur + Math.sign(err) * step;
        if (k === which) aimed = reachable && Math.abs(unlimited ? wrap(req - this.turret[k]) : req - this.turret[k]) <= (2 * Math.PI) / 180;
      }
      if (!aimed) fireOk = false;
    }
    out.fire = c.fire && fireOk;

    // human player: a separate person with a cue delay; G427 C and the AUTO rule hold presses
    const pressed = !!c.bbNectar && !this.hpPrevIntent;
    this.hpPrevIntent = !!c.bbNectar;
    if (pressed) this.hpDue.push(w.time + L.hpDelay);
    out.bbNectar = false;
    const phaseOk = w.match.phase === 'teleop' || (w.match.phase === 'auto' && this.rules.hpInAuto === 'allow');
    if (!this.hpPrevOut && this.hpDue.length && w.time >= this.hpDue[0] - 1e-9 && phaseOk && !(this.rules.g427c && dropZoneOccupied(w, r.alliance, 2))) {
      out.bbNectar = true;
      this.hpDue.shift();
    }
    this.hpPrevOut = out.bbNectar;
    return out;
  }

  /** reaction delay (FIFO) then sample-and-hold; edge buttons are OR-ed over a hold window so a
   * one-tick press is never lost */
  private driver(c: RobotCommand): RobotCommand {
    const d = Math.round(this.D.reaction / DT);
    let x = c;
    if (d > 0) {
      this.q.push(c);
      x = this.q.length > d ? (this.q.shift() as RobotCommand) : { ...c, ...ZERO_INTENT };
    }
    if (this.D.holdTicks <= 1) return x;
    for (const k of EDGE_KEYS) if (x[k]) this.edgeAcc[k] = true;
    if (this.n++ % this.D.holdTicks === 0 || !this.held) {
      this.held = { ...x, ...this.edgeAcc };
      this.edgeAcc = {};
    } else {
      this.held = { ...this.held, ...Object.fromEntries(EDGE_KEYS.map((k) => [k, false])) };
    }
    return this.held;
  }
}

const ZERO_INTENT: Partial<RobotCommand> = {
  driveX: 0, driveY: 0, rotate: 0, leftDrive: 0, rightDrive: 0, intake: false, fire: false,
  bbNectar: false, bbPlace: false, bbPlaceNectar: false,
};

/** One filter for a match. `limits` per robot id; robots without limits pass through (the
 * driver model still applies to them). A class, so a running match can be forked (train/fork.ts). */
export class MatchFilter {
  private per = new Map<number, RobotFilter>();
  constructor(
    private seed: number,
    private limits: Map<number, Limits>,
    private driver: DriverModel = ORACLE,
    private rules: RuleOpts = RULES_CONSERVATIVE,
  ) {}
  apply(w: World, intents: Map<number, RobotCommand>): Map<number, RobotCommand> {
    const out = new Map<number, RobotCommand>();
    for (const r of w.robots) {
      const c = intents.get(r.id);
      if (!c) continue;
      const L = this.limits.get(r.id);
      if (!L) {
        out.set(r.id, c);
        continue;
      }
      let f = this.per.get(r.id);
      if (!f) this.per.set(r.id, (f = new RobotFilter(L, this.driver, this.rules, this.seed, r.id)));
      out.set(r.id, f.apply(w, r, c));
    }
    return out;
  }
  /** every robot's intake-failure luck restarts from `seed` (a filter not created yet starts from it too) */
  reseed(seed: number): void {
    this.seed = seed;
    for (const [id, f] of this.per) f.reseed(seed, id);
  }
}

export function makeFilter(
  seed: number,
  limits: Map<number, Limits>,
  driver: DriverModel = ORACLE,
  rules: RuleOpts = RULES_CONSERVATIVE,
): (w: World, intents: Map<number, RobotCommand>) => Map<number, RobotCommand> {
  const f = new MatchFilter(seed, limits, driver, rules);
  return (w, intents) => f.apply(w, intents);
}
