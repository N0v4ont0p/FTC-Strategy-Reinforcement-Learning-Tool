// THE ALLIANCE (MASTERPLAN §5) — who plays beside our robot, where everyone starts, and the board
// the two robots of one alliance share so they do not chase the same elements.
//
// PARTNERS are the robots a qualification match can pair us with. Three are DSIM's own shipped
// builds (the builder's preset cards), one is a copy of our robot, and two are the weak partners
// real events are full of: one that only drives off the wall and parks, one that does nothing.
// Every partner plays with the same skills and brain as ours (the no-learning order unless a
// network is given), with a typical robot's limits: our profile's nominal fire rate, speeds and
// accuracy — an average FTC robot, not DSIM's perfect one.
//
// STARTS: the team's own start (back to the wall right of FLOWER F3, the start every v1 run used)
// and DSIM's four anchors (config.ts BB_START_POSES), which DSIM seats legally for any build. Two
// robots of one alliance must not overlap at the start; `legalPair` checks it on the real poses.
import { BB, bbSnapStart, coerce, footprintCorners, type Alliance, type RobotSpec, type StartPose } from '../harness/dsim';
import { loadProfile, resolve, type Resolved } from '../harness/profiles';
import { polysOverlap } from '../harness/geom';
import { mulberry32, seedOf } from '../harness/rng';
import { spawnPose } from './skills';

export const PARTNER_KINDS = ['none', 'real', 'sniper', 'hauler', 'skimmer', 'parker', 'idle'] as const;
export type PartnerKind = (typeof PARTNER_KINDS)[number];
/** how a seat's brain plays: its skills in the network's (or the greedy) order; drive off the wall
 * and park; or nothing at all */
export type BrainMode = 'play' | 'park' | 'idle' | 'defend';

export interface PartnerDef {
  kind: PartnerKind;
  label: string;
  blurb: string;
  mode: BrainMode;
  /** 'real' = our own profile (its own draw); a number = DSIM's preset build of that index */
  build: 'real' | number;
}

export const PARTNERS: Record<PartnerKind, PartnerDef> = {
  none: { kind: 'none', label: 'No partner', blurb: 'our robot alone (the v1 solo game)', mode: 'idle', build: 0 },
  real: { kind: 'real', label: 'A second REAL-v1', blurb: 'a copy of our own robot, playing the same brain', mode: 'play', build: 'real' },
  sniper: { kind: 'sniper', label: 'Sniper', blurb: 'DSIM preset: swerve, single turret (POLLEN only), front+back sweepers', mode: 'play', build: 0 },
  hauler: { kind: 'hauler', label: 'Hauler', blurb: 'DSIM preset: tank, rear dumper, front sweeper', mode: 'play', build: 1 },
  skimmer: { kind: 'skimmer', label: 'Skimmer', blurb: 'DSIM preset: x-drive, double turret, front sweeper', mode: 'play', build: 2 },
  parker: { kind: 'parker', label: 'Parks only', blurb: 'drives off the wall and parks: LEAVE + PARK, nothing else', mode: 'park', build: 0 },
  idle: { kind: 'idle', label: 'Does nothing', blurb: 'a robot that never moves (it still takes up space)', mode: 'idle', build: 0 },
};
// ─────────────────────────────── opponents (MASTERPLAN phase 5) ───────────────────────────────
/** the RED alliance a match can bring. Every red robot plays with the same skills (the no-learning
 * order, or a network), a typical robot's limits and misses, and its own alliance board:
 *   · MIRROR — two copies of our robot: every element contested (self-play when they carry our network)
 *   · PRESETS — DSIM's shipped Skimmer and Sniper playing their own game on the shared field
 *   · DEFENSE — a Sniper that plays DEFENSE (in AUTO it only leaves; in TELEOP it shadows our robot
 *     24 in toward our HIVE, in the way of its shots and its path home; it parks at the end) beside
 *     a Skimmer that plays */
export const OPPONENT_KINDS = ['none', 'presets', 'mirror', 'defense'] as const;
export type OpponentKind = (typeof OPPONENT_KINDS)[number];
export interface OpponentDef {
  kind: OpponentKind;
  label: string;
  blurb: string;
  robots: { build: PartnerKind; mode: BrainMode }[];
}
export const OPPONENTS: Record<OpponentKind, OpponentDef> = {
  none: { kind: 'none', label: 'No opponents', blurb: 'the red side empty', robots: [] },
  presets: { kind: 'presets', label: 'Skimmer + Sniper', blurb: "DSIM's shipped builds playing their own game", robots: [{ build: 'skimmer', mode: 'play' }, { build: 'sniper', mode: 'play' }] },
  mirror: { kind: 'mirror', label: 'Two REAL-v1s', blurb: 'two copies of our robot: every element contested', robots: [{ build: 'real', mode: 'play' }, { build: 'real', mode: 'play' }] },
  defense: { kind: 'defense', label: 'Defender + Skimmer', blurb: 'a Sniper shadows our robot toward our HIVE; a Skimmer plays', robots: [{ build: 'sniper', mode: 'defend' }, { build: 'skimmer', mode: 'play' }] },
};
/** the first red robot starts at DSIM's top-rear anchor (mirrored for red), the second at the first legal anchor beside it */
export const OPP_FIRST_START = 'TOP_REAR' as const;

/** the partners a playbook covers (every kind but 'none') */
export const PLAYBOOK_PARTNERS: PartnerKind[] = ['real', 'sniper', 'hauler', 'skimmer', 'parker', 'idle'];

/** the robot a partner seat gets: its build with a typical robot's limits and misses (our profile's
 * nominal ones), or — for 'real' — our own profile, drawn from its own stream */
export function partnerProfile(kind: PartnerKind, profilePath: string, seed: number, sample: boolean): Resolved {
  const file = loadProfile(profilePath);
  const def = PARTNERS[kind];
  if (def.build === 'real') return resolve(file, sample ? mulberry32(seedOf(seed, 'partner-profile')) : undefined);
  const nominal = resolve(file);
  const spec = coerce({ ...BB.BB_PRESETS[def.build] });
  return { ...nominal, id: `partner:${kind}`, spec, point: {}, clamped: [], expectFails: [] };
}

// ─────────────────────────────── starts ───────────────────────────────
export const STARTS = ['F3', 'TOP_REAR', 'BOTTOM_AUD', 'TOP_SIDE', 'BOTTOM_SIDE'] as const;
export type StartId = (typeof STARTS)[number];
export const START_LABEL: Record<StartId, string> = {
  F3: 'our start: side wall, right of FLOWER F3',
  TOP_REAR: 'DSIM anchor: top, rear wall',
  BOTTOM_AUD: 'DSIM anchor: bottom, audience wall',
  TOP_SIDE: 'DSIM anchor: top, side wall',
  BOTTOM_SIDE: 'DSIM anchor: bottom, side wall',
};
const ANCHOR: Record<Exclude<StartId, 'F3'>, number> = { TOP_REAR: 0, BOTTOM_AUD: 1, TOP_SIDE: 2, BOTTOM_SIDE: 3 };

/** a seat's start as the harness passes it to DSIM: an anchor DSIM seats itself, or our pose */
export function seatStart(spec: RobotSpec, start: StartId): { startIndex: number; startPose?: StartPose } {
  return start === 'F3' ? { startIndex: 0, startPose: spawnPose(spec) } : { startIndex: ANCHOR[start] };
}

/** the pose (blue frame) a start puts this robot in — DSIM's own snap for an anchor */
export function startPoseOf(spec: RobotSpec, start: StartId): StartPose {
  if (start === 'F3') return spawnPose(spec);
  const a = BB.BB_START_POSES[ANCHOR[start]];
  return bbSnapStart(spec, { x: a.pos.x, y: a.pos.y, headingDeg: (a.heading * 180) / Math.PI }, 'blue');
}

/** can these two robots of one alliance start here together: different starts, footprints apart */
export function legalPair(specA: RobotSpec, a: StartId, specB: RobotSpec, b: StartId): boolean {
  if (a === b) return false;
  const pa = startPoseOf(specA, a);
  const pb = startPoseOf(specB, b);
  const fa = footprintCorners(specA, { x: pa.x, y: pa.y }, (pa.headingDeg * Math.PI) / 180);
  const fb = footprintCorners(specB, { x: pb.x, y: pb.y }, (pb.headingDeg * Math.PI) / 180);
  return !polysOverlap(fa, fb, 1);
}

/** a partner's default start beside ours: the first legal of the anchors, far end first */
export function defaultPartnerStart(ours: RobotSpec, ourStart: StartId, partner: RobotSpec): StartId {
  for (const s of ['BOTTOM_AUD', 'TOP_REAR', 'BOTTOM_SIDE', 'TOP_SIDE'] as StartId[]) if (legalPair(ours, ourStart, partner, s)) return s;
  throw new Error(`no legal start for a partner beside ${ourStart}`);
}

// ─────────────────────────────── the alliance board ───────────────────────────────
type P = { x: number; y: number };
export interface Claim {
  kind: string;
  balls: number[]; // the elements its job is after
  flower: number | null; // the FLOWER it is retrieving from or placing into
  spot: P | null; // where it is shooting from
}
export interface Avoid {
  balls: Set<number>;
  flowers: Set<number>;
  spots: P[];
}
export const NO_AVOID: Avoid = { balls: new Set(), flowers: new Set(), spots: [] };

/** WHAT EACH ROBOT OF AN ALLIANCE IS DOING NOW. Each brain posts its job when it starts one and
 * reads its partners' before it lists options, so two robots never sweep the same group, work the
 * same FLOWER or shoot from the same spot. Plain fields: a fork copies it with the match. */
export class AllianceBoard {
  claims = new Map<number, Claim>();
  set(id: number, c: Claim | null): void {
    if (c) this.claims.set(id, c);
    else this.claims.delete(id);
  }
  /** everything the OTHER robots have claimed */
  avoidFor(id: number): Avoid {
    if (this.claims.size === 0 || (this.claims.size === 1 && this.claims.has(id))) return NO_AVOID;
    const out: Avoid = { balls: new Set(), flowers: new Set(), spots: [] };
    for (const [k, c] of this.claims) {
      if (k === id) continue;
      for (const b of c.balls) out.balls.add(b);
      if (c.flower !== null) out.flowers.add(c.flower);
      if (c.spot) out.spots.push(c.spot);
    }
    return out;
  }
}

export type { Alliance };
