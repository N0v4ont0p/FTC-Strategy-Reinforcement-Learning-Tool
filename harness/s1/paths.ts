// S1 TRAVEL TIMES — pose to pose, measured in DSIM (a lab world: robot alone on the field).
// A route is start → [depart] → [detour] → [approach] → goal. Poses against a wall or FLOWER foot
// get a perpendicular depart/approach point (drive out square, drive in square); a detour point
// goes around whatever the straight line meets. Every parameter is tuned per pair by the
// cross-entropy method, every candidate scored by an actual DSIM rollout. "Best found" is the
// honest wording — optimal only within this family — and each result carries a PROVABLE lower
// bound (drive.ts), so the gap to the true optimum is known.
// (v1 only routed around the HIVE frame: 29/208 REAL-v0 pairs jammed on FLOWER feet and walls.)
import { BB, biobuzzStep, cmd, DT, footprintCorners, labWorld, type RobotCommand, type RobotSpec, type World } from '../dsim';
import { polysOverlap, rect } from '../geom';
import { mulberry32, seedOf } from '../rng';
import { effective, lbTicks, lbTurnTicks, type Eff } from './drive';

export interface Pose {
  name: string;
  x: number;
  y: number;
  h: number | null; // null = any heading at arrival
  /** unit normal INTO the field when the pose sits against a wall/foot (depart/approach axis) */
  n?: { x: number; y: number };
}
export interface Params {
  beta: number; // fraction of DSIM's braking budget the speed profile plans on
  rotStart: number; // in: remaining path length at which the final heading is chased
  rotGain: number;
  align: number; // > 0.5: cruise along the robot's fast forward/back axis (strafe is 0.8×)
  dOff: number; // in: depart point distance along the start pose's normal
  aOff: number; // in: approach point distance along the goal pose's normal
  wpN: number; // detour points used: round(wpN) ∈ {0..4}
  w1x: number;
  w1y: number;
  w2x: number;
  w2y: number;
  w3x: number;
  w3y: number;
  w4x: number;
  w4y: number;
}
const WX = ['w1x', 'w2x', 'w3x', 'w4x'] as const;
const WY = ['w1y', 'w2y', 'w3y', 'w4y'] as const;
const MAXWP = 4;
export const ARRIVE = { pos: 1.0, speed: 5, heading: (3 * Math.PI) / 180, omega: 0.3 };
/** in/s: the fastest a robot may hit a wall, FLOWER foot or HIVE frame. DSIM's walls stop a robot
 * dead (restitution 0) at any speed; v1 of the table used that to "arrive" without braking — no
 * real robot should. Contact below this is allowed (wall-squaring is a normal FTC move). */
export const IMPACT_MAX = 20;
const CAP = 900; // 15 s
const PASS = 8; // in: an intermediate route point counts as passed inside this radius

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const BARS = [rect(BB.BB_FRAME_BAR_IN, -BB.BB_FRAME_Y, BB.BB_FRAME_BAR_OUT, BB.BB_FRAME_Y), rect(-BB.BB_FRAME_BAR_OUT, -BB.BB_FRAME_Y, -BB.BB_FRAME_BAR_IN, BB.BB_FRAME_Y)];

export function route(from: Pose, to: Pose, p: Params): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  if (from.n) pts.push({ x: from.x + from.n.x * p.dOff, y: from.y + from.n.y * p.dOff });
  const n = Math.max(0, Math.min(MAXWP, Math.round(p.wpN)));
  for (let k = 0; k < n; k++) pts.push({ x: p[WX[k]], y: p[WY[k]] });
  if (to.n) pts.push({ x: to.x + to.n.x * p.aOff, y: to.y + to.n.y * p.aOff });
  pts.push({ x: to.x, y: to.y });
  return pts;
}

export interface TracePoint {
  x: number;
  y: number;
  h: number;
  v: number;
  w: number;
}
export interface Rollout {
  ticks: number | null; // null = did not arrive within CAP
  g417: boolean;
  impact: boolean; // hit something faster than IMPACT_MAX
  endErr: number;
  trace?: TracePoint[];
}

export function rollout(spec: RobotSpec, E: Eff, from: Pose, to: Pose, p: Params, trace = false, base?: World): Rollout {
  const w = base ? structuredClone(base) : labWorld(1, [{ id: 0, alliance: 'blue', spec, startIndex: 0 }]);
  const r = w.robots[0];
  r.pos = { x: from.x, y: from.y };
  r.heading = from.h ?? 0;
  r.vel = { x: 0, y: 0 };
  r.angVel = 0;
  const pts = route(from, to, p);
  let leg = 0;
  const tr: TracePoint[] = [];
  const aB = 1.4 * E.accel;
  // the drive alone changes velocity by at most (1.4 + 0.45)·accel·DT ≈ 7 in/s per tick, so a
  // one-tick change above IMPACT_MAX can only be a collision
  let pv = { x: 0, y: 0 };
  for (let t = 1; t <= CAP; t++) {
    while (leg < pts.length - 1 && Math.hypot(pts[leg].x - r.pos.x, pts[leg].y - r.pos.y) < PASS) leg++;
    const tgt = pts[leg];
    const ex = tgt.x - r.pos.x;
    const ey = tgt.y - r.pos.y;
    const d = Math.hypot(ex, ey);
    let remaining = d;
    for (let k = leg; k < pts.length - 1; k++) remaining += Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].y - pts[k].y);
    const last = leg === pts.length - 1;
    let vDes = Math.min(E.vmax, Math.sqrt(2 * p.beta * aB * Math.max(0, remaining - 0.3)));
    if (last) vDes = Math.min(vDes, 6 * d);
    const dirH = Math.atan2(ey, ex);
    const cruise = Math.abs(wrap(dirH - r.heading)) <= Math.PI / 2 ? dirH : wrap(dirH + Math.PI);
    // a goal against a wall/foot is approached already square: the final heading is held from the
    // leg INTO the approach point onward (turning a long robot beside a wall struck it at ~40 in/s)
    const squareIn = to.n !== undefined && to.h !== null && leg >= pts.length - 2;
    const hT = to.h === null ? (p.align > 0.5 ? cruise : r.heading) : squareIn || remaining <= p.rotStart ? to.h : p.align > 0.5 ? cruise : to.h;
    // heading uses the same brake-aware profile as translation (a derivative term here limit-cycled
    // at ±0.39 rad/s against DSIM's 1/127 stick quantization), with a 0.3° deadband
    const eh = wrap(hT - r.heading);
    const rot = Math.abs(eh) < 0.005 ? 0 : Math.sign(eh) * Math.min(1, Math.sqrt(2 * p.beta * 1.4 * E.turnAccel * Math.abs(eh)) / E.maxTurn, p.rotGain * Math.abs(eh));
    const c = Math.cos(r.heading);
    const s = Math.sin(r.heading);
    const vx = d > 1e-9 ? (vDes * ex) / d : 0;
    const vy = d > 1e-9 ? (vDes * ey) / d : 0;
    const vf = vx * c + vy * s;
    const vs = -vx * s + vy * c;
    // DSIM robot-centric stick: robot-local {x: driveY, y: −driveX}; strafe runs at strafeMult
    const u: RobotCommand = cmd({ driveY: vf / E.vmax, driveX: -vs / (E.vmax * E.strafeMult), rotate: rot });
    biobuzzStep(w, DT, new Map([[0, u]]));
    if (trace) tr.push({ x: r.pos.x, y: r.pos.y, h: r.heading, v: Math.hypot(r.vel.x, r.vel.y), w: r.angVel });
    if (BARS.some((b) => polysOverlap(footprintCorners(r.spec, r.pos, r.heading), b, 0.25))) return { ticks: null, g417: true, impact: false, endErr: Infinity, trace: tr };
    if (Math.hypot(r.vel.x - pv.x, r.vel.y - pv.y) > IMPACT_MAX) return { ticks: null, g417: false, impact: true, endErr: Infinity, trace: tr };
    pv = { ...r.vel };
    const err = Math.hypot(to.x - r.pos.x, to.y - r.pos.y);
    const hOk = to.h === null || Math.abs(wrap(to.h - r.heading)) <= ARRIVE.heading;
    if (last && err <= ARRIVE.pos && Math.hypot(r.vel.x, r.vel.y) <= ARRIVE.speed && Math.abs(r.angVel) <= ARRIVE.omega && hOk) return { ticks: t, g417: false, impact: false, endErr: err, trace: tr };
  }
  return { ticks: null, g417: false, impact: false, endErr: Math.hypot(to.x - r.pos.x, to.y - r.pos.y), trace: tr };
}

export interface PairResult {
  from: string;
  to: string;
  dist: number;
  lb: number; // ticks, provable
  baseline: number | null; // ticks with the direct route and default parameters
  best: number | null; // ticks, best found
  params: Params;
  evals: number;
  verify: number | null; // independent re-run of `best` (must equal `best`)
}

export const DEFAULT: Params = { beta: 0.9, rotStart: 20, rotGain: 4, align: 1, dOff: 10, aOff: 10, wpN: 0, w1x: 0, w1y: 0, w2x: 0, w2y: 0, w3x: 0, w3y: 0, w4x: 0, w4y: 0 };
/** parameters for a given list of detour points */
export function withWaypoints(p: Params, wps: { x: number; y: number }[]): Params {
  const q: Params = { ...p, wpN: Math.min(MAXWP, wps.length) };
  wps.slice(0, MAXWP).forEach((w, k) => {
    q[WX[k]] = w.x;
    q[WY[k]] = w.y;
  });
  return q;
}

/** could the robot sit at `p` with heading `h` at least 2 in clear of walls, the HIVE frame and
 * FLOWER feet? (bound validity: closer than that, contact can do the last of the braking) */
function placeableAt(spec: RobotSpec, p: { x: number; y: number }, h: number): boolean {
  const fp = footprintCorners(spec, p, h);
  if (fp.some((q) => Math.abs(q.x) > BB.BB_HALF_X - 2 || Math.abs(q.y) > BB.BB_HALF_Y - 2)) return false;
  return !obstacles(0).some((b) => polysOverlap(fp, rect(b.x0, b.y0, b.x1, b.y1), 2));
}

/** OBSTACLES a robot centre must keep `R` from: both HIVE frame legs and the four FLOWER feet */
function obstacles(R: number): { x0: number; y0: number; x1: number; y1: number }[] {
  const o = [
    { x0: BB.BB_FRAME_BAR_IN, y0: -BB.BB_FRAME_Y, x1: BB.BB_FRAME_BAR_OUT, y1: BB.BB_FRAME_Y },
    { x0: -BB.BB_FRAME_BAR_OUT, y0: -BB.BB_FRAME_Y, x1: -BB.BB_FRAME_BAR_IN, y1: BB.BB_FRAME_Y },
  ];
  const along = BB.BB_FLOWER_FOOT.along / 2;
  const deep = BB.BB_FLOWER_FOOT.deep;
  for (const f of BB.BB_FLOWERS) {
    if (f.wall === 'left') o.push({ x0: -BB.BB_HALF_X, y0: f.y - along, x1: -BB.BB_HALF_X + deep, y1: f.y + along });
    if (f.wall === 'right') o.push({ x0: BB.BB_HALF_X - deep, y0: f.y - along, x1: BB.BB_HALF_X, y1: f.y + along });
    if (f.wall === 'rear') o.push({ x0: f.x - along, y0: BB.BB_HALF_Y - deep, x1: f.x + along, y1: BB.BB_HALF_Y });
    if (f.wall === 'audience') o.push({ x0: f.x - along, y0: -BB.BB_HALF_Y, x1: f.x + along, y1: -BB.BB_HALF_Y + deep });
  }
  return o.map((b) => ({ x0: b.x0 - R, y0: b.y0 - R, x1: b.x1 + R, y1: b.y1 + R }));
}

/** strictly inside an inflated box (touching an edge or corner is allowed) */
function segHitsBox(a: { x: number; y: number }, b: { x: number; y: number }, q: { x0: number; y0: number; x1: number; y1: number }): boolean {
  for (let k = 1; k < 80; k++) {
    const t = k / 80;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (x > q.x0 + 1e-6 && x < q.x1 - 1e-6 && y > q.y0 + 1e-6 && y < q.y1 - 1e-6) return true;
  }
  return false;
}

/**
 * SHORTEST OBSTACLE-FREE POLYLINE for a disc of radius R (visibility graph over the inflated boxes'
 * corners, Dijkstra). Only SEEDS the search: DSIM decides the real time. Returns interior points.
 */
export function planPolyline(a: { x: number; y: number }, b: { x: number; y: number }, R: number): { x: number; y: number }[] {
  const obs = obstacles(R);
  const lim = BB.BB_HALF_X - 0.5;
  const nodes = [a, b, ...obs.flatMap((q) => [{ x: q.x0 - 0.5, y: q.y0 - 0.5 }, { x: q.x1 + 0.5, y: q.y0 - 0.5 }, { x: q.x1 + 0.5, y: q.y1 + 0.5 }, { x: q.x0 - 0.5, y: q.y1 + 0.5 }])].filter(
    (p, i) => i < 2 || (Math.abs(p.x) < lim && Math.abs(p.y) < lim && !obs.some((q) => p.x > q.x0 && p.x < q.x1 && p.y > q.y0 && p.y < q.y1)),
  );
  // an endpoint may itself sit inside a grown box (a pose beside a FLOWER foot is reachable; the
  // disc is only an approximation): that box is ignored for segments leaving/entering it
  const inside = (p: { x: number; y: number }, q: (typeof obs)[number]): boolean => p.x > q.x0 && p.x < q.x1 && p.y > q.y0 && p.y < q.y1;
  const free = (i: number, j: number): boolean =>
    !obs.some((q) => !((i < 2 && inside(nodes[i], q)) || (j < 2 && inside(nodes[j], q))) && segHitsBox(nodes[i], nodes[j], q));
  const dist = nodes.map(() => Infinity);
  const prev = nodes.map(() => -1);
  const done = nodes.map(() => false);
  dist[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || u === 1) break;
    done[u] = true;
    for (let v = 0; v < nodes.length; v++) {
      if (done[v] || !free(u, v)) continue;
      const d = dist[u] + Math.hypot(nodes[v].x - nodes[u].x, nodes[v].y - nodes[u].y);
      if (d < dist[v]) {
        dist[v] = d;
        prev[v] = u;
      }
    }
  }
  const path: { x: number; y: number }[] = [];
  for (let v = prev[1]; v > 0; v = prev[v]) path.unshift(nodes[v]);
  return path;
}

/** tune one ordered pair by cross-entropy search, seeded from the best of several starting routes */
export function optimizePair(a: { spec: RobotSpec; from: Pose; to: Pose; seed: number; iters?: number; pop?: number; extraStarts?: Params[] }): PairResult {
  const E = effective(a.spec);
  const base = labWorld(1, [{ id: 0, alliance: 'blue', spec: a.spec, startIndex: 0 }]);
  const R = Math.hypot(a.spec.length / 2 + 3, a.spec.width / 2) + 1;
  const score = (p: Params): number => {
    const o = rollout(a.spec, E, a.from, a.to, p, false, base);
    if (o.g417 || o.impact) return 1e5;
    return o.ticks ?? CAP + 10 * o.endErr;
  };
  // starting routes: direct; around each end of the HIVE frame nearest the midpoint; the midpoint
  // pushed ±15/±30 in sideways. The best start seeds the search.
  const mx = (a.from.x + a.to.x) / 2;
  const my = (a.from.y + a.to.y) / 2;
  const L = Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y) || 1;
  const px = -(a.to.y - a.from.y) / L;
  const py = (a.to.x - a.from.x) / L;
  const barX = mx >= 0 ? (BB.BB_FRAME_BAR_IN + BB.BB_FRAME_BAR_OUT) / 2 : -(BB.BB_FRAME_BAR_IN + BB.BB_FRAME_BAR_OUT) / 2;
  const starts: Params[] = [{ ...DEFAULT }];
  for (const s of [1, -1]) starts.push(withWaypoints(DEFAULT, [{ x: barX, y: s * (BB.BB_FRAME_Y + R + 3) }]));
  for (const k of [-30, -15, 15, 30]) starts.push(withWaypoints(DEFAULT, [{ x: mx + px * k, y: my + py * k }]));
  // the planner's polyline between the depart and approach points (both HIVE legs, FLOWER feet)
  const d0 = { ...DEFAULT };
  const r0 = route(a.from, a.to, d0);
  const aPt = a.from.n ? r0[0] : { x: a.from.x, y: a.from.y };
  const bPt = a.to.n ? r0[r0.length - 2] : { x: a.to.x, y: a.to.y };
  for (const rr of [R + 1, R, R * 0.8]) {
    const poly = planPolyline(aPt, bPt, rr);
    if (poly.length >= 1 && poly.length <= MAXWP) starts.push(withWaypoints(DEFAULT, poly));
  }
  // both corridors around the whole HIVE (north side / south side): out past the first leg by the
  // robot radius, across above/below both legs, out past the second — legs in travel order
  const out = BB.BB_FRAME_BAR_OUT + R + 2;
  const cy = BB.BB_FRAME_Y + R + 2;
  const [x1, x2] = a.from.x >= a.to.x ? [out, -out] : [-out, out];
  for (const s of [1, -1]) starts.push(withWaypoints(DEFAULT, [{ x: x1, y: s * cy }, { x: x2, y: s * cy }]));
  // cross-seeding: the best routes other robots found for this same pair (run.ts polish pass)
  for (const e of a.extraStarts ?? []) starts.push({ ...DEFAULT, ...e });
  const scored = starts.map((p) => ({ p, s: score(p) })).sort((x, y) => x.s - y.s);
  const baseline = scored.find((q) => q.p.wpN === 0)!.s;
  let best = scored[0];
  let evals = starts.length;

  const keys: (keyof Params)[] = ['beta', 'rotStart', 'rotGain', 'align', 'dOff', 'aOff', 'wpN', ...WX, ...WY];
  const lo = { beta: 0.3, rotStart: 0, rotGain: 1, align: 0, dOff: 2, aOff: 2, wpN: 0 } as Record<keyof Params, number>;
  const hi = { beta: 1.3, rotStart: 80, rotGain: 10, align: 1, dOff: 30, aOff: 30, wpN: MAXWP } as Record<keyof Params, number>;
  const sd = { beta: 0.25, rotStart: 20, rotGain: 2.5, align: 0.4, dOff: 6, aOff: 6, wpN: 0.3 } as Record<keyof Params, number>;
  for (const k of [...WX, ...WY]) {
    lo[k] = -70;
    hi[k] = 70;
    sd[k] = 8;
  }
  const mean = { ...best.p };
  const rng = mulberry32(seedOf(a.seed, a.from.name, a.to.name));
  const gauss = (): number => Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng());
  // no feasible start at all ⇒ this is a hard pair: search twice as long
  const hard = best.s >= CAP;
  const iters = a.iters ?? (hard ? 28 : 14);
  const pop = a.pop ?? (hard ? 30 : 20);
  for (let it = 0; it < iters; it++) {
    const cand: { p: Params; s: number }[] = [];
    for (let k = 0; k < pop; k++) {
      const p = { ...mean };
      for (const key of keys) p[key] = Math.max(lo[key], Math.min(hi[key], mean[key] + sd[key] * gauss()));
      const s = score(p);
      evals++;
      cand.push({ p, s });
      if (s < best.s) best = { p, s };
    }
    cand.sort((x, y) => x.s - y.s);
    const elite = cand.slice(0, 5);
    for (const key of keys) {
      const m = elite.reduce((t, e) => t + e.p[key], 0) / elite.length;
      const v = elite.reduce((t, e) => t + (e.p[key] - m) ** 2, 0) / elite.length;
      mean[key] = m;
      sd[key] = Math.max(Math.sqrt(v), 0.02 * (hi[key] - lo[key]));
    }
  }
  const dist = Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y);
  const dh = a.to.h === null || a.from.h === null ? 0 : Math.abs(wrap(a.to.h - a.from.h));
  // a goal an obstacle can touch lets the robot shed its last ≤ IMPACT_MAX in/s on contact, so the
  // bound only asks it to be that slow there (v1 asked for 5 in/s and 4 wall arrivals beat it)
  const nearObstacle = a.to.n !== undefined || !Array.from({ length: 24 }, (_, k) => (k * Math.PI) / 12).every((h) => placeableAt(a.spec, a.to, h));
  const lb = Math.max(lbTicks(dist, E.accel, E.vmax, ARRIVE.pos, nearObstacle ? IMPACT_MAX : ARRIVE.speed), lbTurnTicks(dh, E.turnAccel, E.maxTurn));
  const ok = best.s < CAP ? best.s : null;
  const re = ok === null ? null : rollout(a.spec, E, a.from, a.to, best.p, false, base).ticks;
  return { from: a.from.name, to: a.to.name, dist, lb, baseline: baseline < CAP ? baseline : null, best: ok, params: best.p, evals, verify: re };
}
