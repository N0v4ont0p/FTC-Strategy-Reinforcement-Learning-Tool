// OBSERVATION: what the learning robot sees, as a fixed-length vector of numbers ~[-1, 1].
// Everything is DSIM state or a measured S1 artifact (the shooting envelope); robot-relative where
// direction matters; alliance-mirrored (DSIM's field is point-symmetric, config.ts bbMirror) so one
// network can play red or blue. The profile's numbers ride along so one network can learn every
// robot in the envelope (PLAN.md §2.5).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BB, C, bb, type RobotState, type World } from '../harness/dsim';
import type { Resolved } from '../harness/profiles';
import { envelopeOf, inEnv } from './envelope';
import { N_OPT_FEATS, type Option } from './skills';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const K_NEAR = 6; // nearest collectable elements seen

// scoring spots measured in S1 (REAL-v0, turret settled) — blue frame
type Spot = { x: number; y: number };
export const SPOTS: Record<'north' | 'south', Spot[]> = (() => {
  const env = JSON.parse(readFileSync(join(root, 'outputs/s1/envelope.json'), 'utf8')) as Record<string, { x: number; y: number; entered: boolean }[]>;
  return {
    north: env['REAL-v0:north'].filter((c) => c.entered).map(({ x, y }) => ({ x, y })),
    south: env['REAL-v0:south'].filter((c) => c.entered).map(({ x, y }) => ({ x, y })),
  };
})();
const SPOT_SET: Record<'north' | 'south', Set<string>> = {
  north: new Set(SPOTS.north.map((s) => `${s.x},${s.y}`)),
  south: new Set(SPOTS.south.map((s) => `${s.x},${s.y}`)),
};
/** is (x, y) — blue frame — within the measured envelope for that up cell? (2 in grid) */
export function inEnvelope(side: 'north' | 'south', x: number, y: number): boolean {
  const gx = Math.round(x / 2) * 2;
  const gy = Math.round(y / 2) * 2;
  return SPOT_SET[side].has(`${gx},${gy}`);
}

export const OBS_NAMES: string[] = [
  'x', 'y', 'cosH', 'sinH', 'vFwd', 'vLeft', 'omega',
  'hopPollen', 'hopNectar', 'topIsNectar', 'hopEmpty',
  'phPre', 'phAuto', 'phTransition', 'phTeleop', 'phPost', 'phaseLeft', 'matchLeft', 'nectarUnlocked',
  'upNorth', 'cellPollen', 'cellNectar', 'tipping', 'tips', 'hpStock', 'hpDue', 'pollenToTip', 'released', 'targetNorth',
  'inEnvelope', 'spotFwd', 'spotLeft', 'spotDist',
  ...Array.from({ length: K_NEAR }, (_, k) => [`e${k}Fwd`, `e${k}Left`, `e${k}Dist`, `e${k}Nectar`]).flat(),
  'lzFwd', 'lzLeft', 'lzDist', 'frameDist', 'score',
  'pFireRate', 'pVFire', 'pVIntake', 'pIntakeOk', 'pYawRange', 'pHpDelay', 'pAccuracy', 'pRpm', 'pMass',
];
export const N_OBS = OBS_NAMES.length;

const MATCH_LEN = C.AUTO_DURATION + C.TRANSITION_DURATION + C.TELEOP_DURATION;

/** encode the world for robot `r` into `out` (length N_OBS) */
export function encode(w: World, r: RobotState, prof: Resolved, out: Float32Array): Float32Array {
  const m = r.alliance === 'blue' ? 1 : -1; // red sees the field rotated 180° (point symmetry)
  const px = m * r.pos.x;
  const py = m * r.pos.y;
  const h = r.heading + (m > 0 ? 0 : Math.PI);
  const c = Math.cos(h);
  const s = Math.sin(h);
  const toRobot = (fx: number, fy: number): [number, number] => [fx * c + fy * s, -fx * s + fy * c];
  let i = 0;
  const put = (v: number): void => {
    out[i++] = Number.isFinite(v) ? Math.max(-4, Math.min(4, v)) : 0;
  };
  put(px / 72);
  put(py / 72);
  put(c);
  put(s);
  const [vf, vl] = toRobot(m * r.vel.x, m * r.vel.y);
  put(vf / 100);
  put(vl / 100);
  put(r.angVel / 10);
  const own = r.alliance;
  const pollen = r.hopper.filter((q) => q === 'yellow').length;
  put(pollen / 4);
  put((r.hopper.length - pollen) / 4);
  const top = r.hopper[r.hopper.length - 1];
  put(top !== undefined && top !== 'yellow' ? 1 : 0);
  put(r.hopper.length === 0 ? 1 : 0);
  const ph = w.match.phase;
  for (const p of ['pre', 'auto', 'transition', 'teleop', 'post']) put(ph === p ? 1 : 0);
  const phaseLen = ph === 'auto' ? C.AUTO_DURATION : ph === 'transition' ? C.TRANSITION_DURATION : ph === 'teleop' ? C.TELEOP_DURATION : 1;
  put(Math.max(0, w.match.phaseTimeLeft) / phaseLen);
  const left = ph === 'pre' ? MATCH_LEN : ph === 'auto' ? w.match.phaseTimeLeft + C.TRANSITION_DURATION + C.TELEOP_DURATION : ph === 'transition' ? w.match.phaseTimeLeft + C.TELEOP_DURATION : ph === 'teleop' ? w.match.phaseTimeLeft : 0;
  put(left / MATCH_LEN);
  put(ph === 'teleop' && w.match.phaseTimeLeft <= 60 ? 1 : 0);
  const B = bb(w);
  const hive = B.hives[own];
  const upBlue = m > 0 ? hive.up : hive.up === 'north' ? 'south' : 'north'; // up cell in the robot's frame
  put(upBlue === 'north' ? 1 : -1);
  let cellP = 0;
  let cellN = 0;
  for (const id of hive.contents) {
    const b = w.balls.find((q) => q.id === id);
    if (!b) continue;
    if (b.color === 'yellow') cellP++;
    else cellN++;
  }
  put(cellP / 8);
  put(cellN / 5);
  put(hive.tipping / 4);
  put(hive.tips / 10);
  put(B.nectarStock[own] / 5);
  put(B.nectarDue[own] / 5);
  put(Math.max(0, (BB.BB_TIP_POLLEN[Math.min(cellN, BB.BB_TIP_POLLEN.length - 1)] ?? 0) - cellP) / 8);
  put(hive.released ? 1 : 0);
  // where shots should go: the up cell, or the other one once a tip has started (skills.ts targetCell)
  const target = hive.tipping > 0 ? (upBlue === 'north' ? 'south' : 'north') : upBlue;
  put(target === 'north' ? 1 : -1);
  const env = envelopeOf(r.spec); // this build's own measured envelope
  put(inEnv(env, target, px, py) ? 1 : 0);
  // nearest measured scoring spot for that cell
  let best: Spot | null = null;
  let bd = Infinity;
  for (const sp of env.spots[target]) {
    const d = (sp.x - px) ** 2 + (sp.y - py) ** 2;
    if (d < bd) {
      bd = d;
      best = sp;
    }
  }
  const sd = Math.sqrt(bd);
  const [sf, sl] = best ? toRobot(best.x - px, best.y - py) : [0, 0];
  put(sd > 1e-6 ? sf / sd : 0);
  put(sd > 1e-6 ? sl / sd : 0);
  put(sd / 144);
  // nearest collectable ground elements (POLLEN, own NECTAR)
  const near: { f: number; l: number; d: number; n: number }[] = [];
  for (const b of w.balls) {
    if (b.state.kind !== 'ground') continue;
    const isN = b.color !== 'yellow';
    if (isN && b.color !== own) continue;
    const dx = m * b.pos.x - px;
    const dy = m * b.pos.y - py;
    const d = Math.hypot(dx, dy);
    const [f, l] = toRobot(dx, dy);
    near.push({ f, l, d, n: isN ? 1 : 0 });
  }
  near.sort((a, b) => a.d - b.d);
  for (let k = 0; k < K_NEAR; k++) {
    const e = near[k];
    put(e ? e.f / 72 : 0);
    put(e ? e.l / 72 : 0);
    put(e ? e.d / 144 : 1);
    put(e ? e.n : 0);
  }
  const lz = BB.BB_LZ.blue;
  const lx = (lz.x0 + lz.x1) / 2 - px;
  const ly = (lz.y0 + lz.y1) / 2 - py;
  const [lf, ll] = toRobot(lx, ly);
  put(lf / 72);
  put(ll / 72);
  put(Math.hypot(lx, ly) / 144);
  // distance from the robot centre to the nearer HIVE frame leg (G417 danger)
  const fx = Math.max(0, Math.abs(Math.abs(px) - (BB.BB_FRAME_BAR_IN + BB.BB_FRAME_BAR_OUT) / 2) - 0.5);
  const fy = Math.max(0, Math.abs(py) - BB.BB_FRAME_Y);
  put(Math.hypot(fx, fy) / 72);
  put(w.match.scores[own].total / 100);
  const L = prof.limits;
  put(L.fireRate / 13);
  put(L.vFire / 100);
  put(L.vIntake / 100);
  put(L.intakeSuccess);
  put(L.turretYawRange / 360);
  put(L.hpDelay / 2);
  put(prof.perturb.shotAccuracy);
  put(prof.spec.driveRpm / 600);
  put(prof.spec.massLb / 42);
  if (i !== N_OBS) throw new Error(`obs length ${i} ≠ ${N_OBS}`);
  return out;
}

// ─────────────────────── the entity view (phase 4, train/entnet.ts) ───────────────────────
/** every robot and every element in play (on the ground, in the air, in a FLOWER) as one row each —
 * a SET the entity network attends over, robot-relative and alliance-mirrored like `encode`.
 * Elements in a hopper or a HIVE cell are counted in the global observation instead */
export const ENT_FEATS = ['self', 'partner', 'opponent', 'pollen', 'ownNectar', 'otherNectar', 'ground', 'inFlower', 'flight', 'fwd', 'left', 'dist', 'x', 'y', 'vFwd', 'vLeft', 'cosH', 'sinH', 'hopper', 'z'] as const;
export const N_ENT = ENT_FEATS.length;
/** at most this many entities (the nearest): the field never holds more in play, it only bounds the cost */
export const ENT_MAX = 96;
/** an option as the entity network reads it: its features and where it goes, robot-relative */
export const N_OPT_IN = N_OPT_FEATS + 3;

export function encodeEnts(w: World, r: RobotState): { e: Float32Array; n: number } {
  const m = r.alliance === 'blue' ? 1 : -1;
  const px = m * r.pos.x;
  const py = m * r.pos.y;
  const h = r.heading + (m > 0 ? 0 : Math.PI);
  const c = Math.cos(h);
  const s = Math.sin(h);
  const rows: { d: number; v: number[] }[] = [];
  const clip = (v: number): number => (Number.isFinite(v) ? Math.max(-4, Math.min(4, v)) : 0);
  const row = (who: number, colour: number, where: number, x: number, y: number, vx: number, vy: number, heading: number | null, hopper: number, z: number): void => {
    const dx = m * x - px;
    const dy = m * y - py;
    const d = Math.hypot(dx, dy);
    const v = new Array<number>(N_ENT).fill(0);
    if (who >= 0) v[who] = 1;
    if (colour >= 0) v[3 + colour] = 1;
    if (where >= 0) v[6 + where] = 1;
    v[9] = (dx * c + dy * s) / 72;
    v[10] = (-dx * s + dy * c) / 72;
    v[11] = d / 144;
    v[12] = (m * x) / 72;
    v[13] = (m * y) / 72;
    v[14] = (m * vx * c + m * vy * s) / 100;
    v[15] = (-m * vx * s + m * vy * c) / 100;
    if (heading !== null) {
      v[16] = Math.cos(heading - r.heading);
      v[17] = Math.sin(heading - r.heading);
    }
    v[18] = hopper / 4;
    v[19] = z / 10;
    rows.push({ d, v: v.map(clip) });
  };
  for (const q of w.robots) row(q.id === r.id ? 0 : q.alliance === r.alliance ? 1 : 2, -1, -1, q.pos.x, q.pos.y, q.vel.x, q.vel.y, q.heading, q.hopper.length, 0);
  for (const b of w.balls) {
    const k = b.state.kind;
    const where = k === 'ground' ? 0 : k === 'flight' ? 2 : k === 'element' && String((b.state as { el?: string }).el ?? '').startsWith('flower:') ? 1 : -1;
    if (where < 0) continue;
    const colour = b.color === 'yellow' ? 0 : b.color === r.alliance ? 1 : 2;
    row(-1, colour, where, b.pos.x, b.pos.y, b.vel.x, b.vel.y, null, 0, b.z ?? 0);
  }
  // the robots first, then the nearest elements (a set: the order means nothing to the network)
  const robots = rows.slice(0, w.robots.length);
  const els = rows.slice(w.robots.length).sort((a, b) => a.d - b.d).slice(0, ENT_MAX - robots.length);
  const all = [...robots, ...els];
  const e = new Float32Array(all.length * N_ENT);
  all.forEach((x, i) => e.set(x.v, i * N_ENT));
  return { e, n: all.length };
}

/** every option's input row: its features, then its first target relative to the robot */
export function optInput(r: RobotState, opts: Option[]): Float32Array {
  const m = r.alliance === 'blue' ? 1 : -1;
  const h = r.heading + (m > 0 ? 0 : Math.PI);
  const c = Math.cos(h);
  const s = Math.sin(h);
  const out = new Float32Array(opts.length * N_OPT_IN);
  opts.forEach((o, j) => {
    const dx = m * (o.x - r.pos.x);
    const dy = m * (o.y - r.pos.y);
    out.set(o.feats, j * N_OPT_IN);
    const b = j * N_OPT_IN + N_OPT_FEATS;
    out[b] = Math.max(-4, Math.min(4, (dx * c + dy * s) / 72));
    out[b + 1] = Math.max(-4, Math.min(4, (-dx * s + dy * c) / 72));
    out[b + 2] = Math.min(4, Math.hypot(dx, dy) / 144);
  });
  return out;
}
