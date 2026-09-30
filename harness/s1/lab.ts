// S1 LAB INSTRUMENTS — measured in DSIM, never computed from our own geometry:
//   · shootingRow: where a stationary robot's turret actually releases a shot, and whether it goes in
//   · spill:        where the elements of a tipped CELL actually come to rest
import { BB, C, bb, biobuzzStep, cmd, DT, dispose, footprintCorners, newMatch, snapshot, type RobotSpec, type Vec2, type World } from '../dsim';
import { polysOverlap, rect } from '../geom';

type Cell = 'north' | 'south';

/** static solids a robot footprint may not overlap when we PLACE it for a measurement */
export function placeable(spec: RobotSpec, p: Vec2, heading: number, slop = 0.5): boolean {
  const fp = footprintCorners(spec, p, heading);
  if (fp.some((q) => Math.abs(q.x) > BB.BB_HALF_X - 0.1 || Math.abs(q.y) > BB.BB_HALF_Y - 0.1)) return false;
  const bars = [rect(BB.BB_FRAME_BAR_IN, -BB.BB_FRAME_Y, BB.BB_FRAME_BAR_OUT, BB.BB_FRAME_Y), rect(-BB.BB_FRAME_BAR_OUT, -BB.BB_FRAME_Y, -BB.BB_FRAME_BAR_IN, BB.BB_FRAME_Y)];
  return !bars.some((b) => polysOverlap(fp, b, slop)) && !flowerFeet().some((f) => polysOverlap(fp, f, slop));
}

export function flowerFeet(): Vec2[][] {
  // BB_FLOWER_FOOT: `along` the wall × `deep`, flush to the wall behind each ring (colliders.ts)
  const out: Vec2[][] = [];
  const along = BB.BB_FLOWER_FOOT.along / 2;
  const depth = BB.BB_FLOWER_FOOT.deep;
  for (const f of BB.BB_FLOWERS) {
    if (f.wall === 'left') out.push(rect(-BB.BB_HALF_X, f.y - along, -BB.BB_HALF_X + depth, f.y + along));
    if (f.wall === 'right') out.push(rect(BB.BB_HALF_X - depth, f.y - along, BB.BB_HALF_X, f.y + along));
    if (f.wall === 'rear') out.push(rect(f.x - along, BB.BB_HALF_Y - depth, f.x + along, BB.BB_HALF_Y));
    if (f.wall === 'audience') out.push(rect(f.x - along, -BB.BB_HALF_Y, f.x + along, -BB.BB_HALF_Y + depth));
  }
  return out;
}

/**
 * BLUE'S UP CELL ON `side`, STAGED BEFORE THE FIRST STEP. In DSIM's 3D solve the HIVE is a real
 * see-saw whose tray is built at the pose the JSON says (hiveTiltAngle) when the engine is built —
 * on the first step. Flipping `up` after that only relabels a tray that stays where it is (a
 * "south" measurement then shoots the north cell). The three staged NECTAR move with it (y
 * mirrored), as DSIM's spawn stages a south-up cell (spawn.ts cellNectar).
 */
export function stageUp(w: World, side: Cell): void {
  if (w.tick !== 0) throw new Error('stageUp: before the first step only');
  const hb = bb(w).hives.blue;
  if (hb.up === side) return;
  hb.up = side;
  for (const b of w.balls) if (b.state.kind === 'element' && (b.state as { el: string }).el === 'hive:blue') b.pos = { x: b.pos.x, y: -b.pos.y };
}

/** a TELEOP world with blue's up CELL on `side` and EMPTY, the robot holding its 4 preloads, no
 * loose ground elements (so a measurement only sees the shot) */
export function shootBase(spec: RobotSpec, side: Cell): World {
  const w = newMatch(1, [{ id: 0, alliance: 'blue', spec, startIndex: 0 }]);
  stageUp(w, side);
  const z = new Map([[0, cmd()]]);
  while (w.match.phase !== 'auto') biobuzzStep(w, DT, z); // preloads are captured during pre
  w.match.phase = 'teleop';
  w.match.phaseTimeLeft = C.TELEOP_DURATION;
  const hb = bb(w).hives.blue; // safe: mutated before any further step
  const drop = new Set(hb.contents);
  hb.contents = [];
  w.balls = w.balls.filter((b) => !drop.has(b.id) && b.state.kind !== 'ground');
  return w;
}

export interface ShotCell {
  x: number;
  y: number;
  placeable: boolean;
  released: boolean;
  releaseTicks: number; // after the turret has settled on its aim (1 s)
  entered: boolean;
  flightTicks: number;
  /** the load fired from this spot, and how many of it settled in the up cell */
  nLoad?: number;
  nIn?: number;
}

/** one grid column: every y at this x (the pool job unit) */
export function shootingColumn(a: { spec: RobotSpec; side: Cell; x: number; ys: number[]; heading: number }): ShotCell[] {
  const base = shootBase(a.spec, a.side);
  const out = a.ys.map((y) => {
    const p = { x: a.x, y };
    if (!placeable(a.spec, p, a.heading)) return { x: a.x, y, placeable: false, released: false, releaseTicks: -1, entered: false, flightTicks: -1 };
    const w = snapshot(base);
    try {
      return shotAt(w, a, p, y);
    } finally {
      dispose(w); // one 3D engine per measured spot
    }
  });
  dispose(base);
  return out;
}
function shotAt(w: World, a: { x: number; heading: number }, p: Vec2, y: number): ShotCell {
  const r = w.robots[0];
  r.pos = p;
  r.heading = a.heading;
  r.vel = { x: 0, y: 0 };
  r.angVel = 0;
  // SETTLE FIRST: a teleported robot keeps its old turret yaw, and DSIM releases the moment the
  // CURRENT yaw would score — so a turret swinging in from one side briefly finds legal shots its
  // steady aim never has (v1 measured 43 such north-only spots). One second covers the full yaw
  // (7 rad/s) and pitch (1.6 rad/s) travel; this is what a robot tracking while it drives has.
  for (let k = 0; k < 60; k++) biobuzzStep(w, DT, new Map([[0, cmd()]]));
  // THE WHOLE LOAD, AS A MATCH FIRES IT: hold fire until the hopper is empty (3 s at most). In DSIM's
  // 3D solve a shot that reaches a cell can still clip its wall or rim, or an element already in it,
  // and bounce out — so one shot into an empty cell overstates a spot (measured: shots from 66 in
  // counted). DSIM's own bot measured four POLLEN per stand; a spot scores here only when every
  // element of the load is released AND settles in the cell.
  const load = w.balls.filter((b) => b.state.kind === 'held' && (b.state as { robot: number }).robot === r.id).map((b) => b.id);
  const n0 = r.hopper.length;
  let rel = -1;
  for (let k = 0; k < 180 && r.hopper.length > 0; k++) {
    const before = r.hopper.length;
    biobuzzStep(w, DT, new Map([[0, cmd({ fire: true })]]));
    if (rel < 0 && r.hopper.length < before) rel = k + 1;
  }
  if (rel < 0) return { x: a.x, y, placeable: true, released: false, releaseTicks: -1, entered: false, flightTicks: -1 };
  // IN IS WHERE IT SETTLES: step until every shot has been out of the air for a second
  const shots = w.balls.filter((b) => load.includes(b.id));
  let fl = -1;
  let still = 0;
  for (let k = 0; k < 150 + 60; k++) {
    biobuzzStep(w, DT, new Map([[0, cmd()]]));
    if (shots.some((b) => b.state.kind === 'flight' || b.state.kind === 'held')) {
      still = 0;
      continue;
    }
    if (fl < 0) fl = k + 1;
    if (++still >= 60) break;
  }
  const nIn = shots.filter((b) => b.state.kind === 'element' && (b.state as { el: string }).el === 'hive:blue').length;
  return { x: a.x, y, placeable: true, released: r.hopper.length === 0, releaseTicks: rel, entered: r.hopper.length === 0 && nIn === n0, flightTicks: fl, nIn, nLoad: n0 };
}

/**
 * SPILL LAB: tip blue's `side` CELL for real (a robot fires its preloads into it) and record where
 * the spilled elements come to rest. The NORTH cell is DSIM's own staging. SOUTH is staged the way
 * DSIM's spawn stages a south-up cell (spawn.ts `cellNectar`: same three NECTAR, y mirrored).
 */
export function spill(a: { spec: RobotSpec; side: Cell; seed: number }): { rest: Vec2[]; tipped: boolean; settleTicks: number } {
  const w = newMatch(a.seed, [{ id: 0, alliance: 'blue', spec: a.spec, startIndex: 0 }]);
  try {
    return spillIn(w, a);
  } finally {
    dispose(w);
  }
}
function spillIn(w: World, a: { side: Cell }): { rest: Vec2[]; tipped: boolean; settleTicks: number } {
  stageUp(w, a.side);
  const z = new Map([[0, cmd()]]);
  while (w.match.phase !== 'auto') biobuzzStep(w, DT, z);
  // ⚠ DSIM REPLACES hives[a] EVERY TICK (play.ts `bb.hives[a] = res.hive`): never hold the object
  // across a step — read bb(w).hives.blue fresh (an earlier version read a stale copy)
  const r = w.robots[0];
  // shoot from straight outboard of the cell (inside the measured envelope), 40 in out
  r.pos = { x: BB.BB_HIVE_X, y: (a.side === 'north' ? 1 : -1) * (BB.BB_HIVE_CELL_DY + 40) };
  r.vel = { x: 0, y: 0 };
  const contents = new Set(bb(w).hives.blue.contents);
  const spilled = new Set<number>();
  let tipped = false;
  for (let k = 0; k < 60 * 20; k++) {
    biobuzzStep(w, DT, new Map([[0, cmd({ fire: w.match.phase === 'auto' || w.match.phase === 'teleop' })]]));
    for (const id of bb(w).hives.blue.contents) contents.add(id);
    for (const b of w.balls) if (contents.has(b.id) && b.state.kind === 'ground') spilled.add(b.id);
    if (bb(w).hives.blue.tips > 0) tipped = true;
    // settled: the tray has finished its swing, nothing that was in the cell is still in the air
    // (a 3D spill bounces), and every spilled element has come to rest
    if (tipped && spilled.size > 0 && bb(w).hives.blue.tipping <= 0) {
      const airborne = w.balls.some((b) => contents.has(b.id) && b.state.kind === 'flight');
      const moving = w.balls.some((b) => spilled.has(b.id) && Math.hypot(b.vel.x, b.vel.y) > 0.5);
      if (!airborne && !moving) return { rest: w.balls.filter((b) => spilled.has(b.id)).map((b) => ({ ...b.pos })), tipped, settleTicks: k };
    }
    // keep the robot out of the spill: once it has fired, park it well outboard
    if (r.hopper.length === 0) {
      r.pos = { x: 60, y: (a.side === 'north' ? 1 : -1) * 60 };
      r.vel = { x: 0, y: 0 };
    }
  }
  return { rest: w.balls.filter((b) => spilled.has(b.id)).map((b) => ({ ...b.pos })), tipped, settleTicks: -1 };
}
