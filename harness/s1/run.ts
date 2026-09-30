// S1 MOTION LAB — run everything, write outputs/s1/*.json. Then harness/s1/check.ts gates it.
// Run: dsim-main/node_modules/.bin/tsx harness/s1/run.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BB, footprintExtents, init, newMatch, type RobotSpec, type Vec2 } from '../dsim';
import { resolve } from '../profiles';
import { runPool } from '../pool';
import { sysid } from './sysid';
import { effective } from './drive';
import { placeable, type ShotCell } from './lab';
import { S1_PROFILES } from './jobs';
import type { PairResult, Pose } from './paths';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'outputs/s1');
mkdirSync(out, { recursive: true });
const save = (name: string, data: unknown): void => writeFileSync(join(out, name), JSON.stringify(data, null, 1));
const t0 = performance.now();
const log = (s: string): void => console.log(`[${((performance.now() - t0) / 1000).toFixed(0).padStart(4)} s] ${s}`);

await init();
const specs: Record<string, RobotSpec> = Object.fromEntries(Object.keys(S1_PROFILES).map((k) => [k, resolve(S1_PROFILES[k]()).spec]));

// 1. system identification, every S1 robot
const sys = Object.fromEntries(Object.entries(specs).map(([k, s]) => [k, { eff: effective(s), cases: sysid(s) }]));
save('sysid.json', sys);
log('sysid done');

// 2. shooting envelope — 2 in grid, both cells, REAL-v0 and DREAM
const GRID = Array.from({ length: 71 }, (_, i) => -70 + 2 * i);
const env: Record<string, ShotCell[]> = {};
for (const profile of ['REAL-v0', 'DREAM'])
  for (const side of ['north', 'south'] as const) {
    const cols = await runPool<ShotCell[]>(GRID.map((x) => ({ module: 's1/jobs.ts', fn: 'envelopeColumn', args: { profile, side, x, ys: GRID } })), 8);
    env[`${profile}:${side}`] = cols.flat();
    log(`envelope ${profile} ${side}: ${env[`${profile}:${side}`].filter((c) => c.entered).length} scoring cells`);
  }
save('envelope.json', env);

// 3. spill lab — 40 seeds per cell
const spills: Record<string, { rest: Vec2[]; tipped: boolean; settleTicks: number }[]> = {};
for (const side of ['north', 'south'] as const)
  spills[side] = await runPool(Array.from({ length: 40 }, (_, i) => ({ module: 's1/jobs.ts', fn: 'spillRun', args: { profile: 'REAL-v0', side, seed: i + 1 } })), 8);
const centroid = (side: 'north' | 'south'): Vec2 => {
  const pts = spills[side].flatMap((s) => s.rest);
  return { x: pts.reduce((t, p) => t + p.x, 0) / pts.length, y: pts.reduce((t, p) => t + p.y, 0) / pts.length };
};
save('spill.json', { runs: spills, centroid: { north: centroid('north'), south: centroid('south') } });
log(`spill: north centroid (${centroid('north').x.toFixed(1)}, ${centroid('north').y.toFixed(1)}), south (${centroid('south').x.toFixed(1)}, ${centroid('south').y.toFixed(1)})`);

// 4. key poses per robot, from DSIM anchors + the measurements above
const LZ_Y = (BB.BB_LZ.blue.y0 + BB.BB_LZ.blue.y1) / 2;
function posesFor(name: string): Pose[] {
  const spec = specs[name];
  const rear = footprintExtents(spec).rear;
  const front = footprintExtents(spec).front;
  const P: Pose[] = [];
  for (let i = 0; i < 4; i++) {
    const r = newMatch(1, [{ id: 0, alliance: 'blue', spec, startIndex: i }]).robots[0];
    // an anchor touches a wall by rule: depart along that wall's inward normal
    const gaps = [{ d: BB.BB_HALF_X - r.pos.x, n: { x: -1, y: 0 } }, { d: r.pos.x + BB.BB_HALF_X, n: { x: 1, y: 0 } }, { d: BB.BB_HALF_Y - r.pos.y, n: { x: 0, y: -1 } }, { d: r.pos.y + BB.BB_HALF_Y, n: { x: 0, y: 1 } }];
    P.push({ name: `A${i}`, x: r.pos.x, y: r.pos.y, h: r.heading, n: gaps.sort((a, b) => a.d - b.d)[0].n });
  }
  const foot = BB.BB_FLOWER_FOOT.deep;
  P.push({ name: 'LZ', x: BB.BB_HALF_X - rear - 0.5, y: LZ_Y, h: Math.PI, n: { x: -1, y: 0 } }); // back into blue's LOADING ZONE
  P.push({ name: 'RLZ', x: -BB.BB_HALF_X + rear + 0.5, y: -LZ_Y, h: 0, n: { x: 1, y: 0 } }); // red's zone (solo free-preload quirk)
  // back mouth on FLOWER feet (APPROX; S2 docks exactly)
  const [F1, F2, F3, F4] = BB.BB_FLOWERS;
  P.push({ name: 'F3R', x: BB.BB_HALF_X - foot - rear - 0.3, y: F3.y, h: Math.PI, n: { x: -1, y: 0 } });
  P.push({ name: 'F4R', x: F4.x, y: -BB.BB_HALF_Y + foot + rear + 0.3, h: Math.PI / 2, n: { x: 0, y: 1 } });
  P.push({ name: 'F1R', x: -BB.BB_HALF_X + foot + rear + 0.3, y: F1.y, h: 0, n: { x: 1, y: 0 } });
  P.push({ name: 'F2R', x: F2.x, y: BB.BB_HALF_Y - foot - rear - 0.3, h: -Math.PI / 2, n: { x: 0, y: -1 } });
  P.push({ name: 'GARDEN', x: (BB.BB_GARDEN.blue.x0 + BB.BB_GARDEN.blue.x1) / 2, y: BB.BB_HALF_Y - front - 2, h: Math.PI / 2, n: { x: 0, y: -1 } }); // front bumper toward blue's GARDEN
  // where a robot goes for a spill: the nearest spot (1 in grid) it can turn a full circle in, to
  // where the spill comes to rest — in DSIM's 3D solve a spill rolls on to the side wall, where no
  // robot centre fits
  const turnSafe = (q: Vec2): boolean => Array.from({ length: 24 }, (_, k) => (k * Math.PI) / 12).every((hh) => placeable(spec, q, hh));
  const standNear = (c: Vec2): Vec2 => {
    let best: Vec2 | null = null;
    for (let dx = -40; dx <= 40; dx++)
      for (let dy = -40; dy <= 40; dy++) {
        const q = { x: Math.round(c.x) + dx, y: Math.round(c.y) + dy };
        if ((!best || Math.hypot(q.x - c.x, q.y - c.y) < Math.hypot(best.x - c.x, best.y - c.y)) && turnSafe(q)) best = q;
      }
    if (!best) throw new Error(`${name}: nowhere to stand near the spill at (${c.x.toFixed(1)}, ${c.y.toFixed(1)})`);
    return best;
  };
  for (const side of ['north', 'south'] as const) {
    const c = centroid(side);
    const st = standNear(c);
    P.push({ name: side === 'north' ? 'SPILL_N' : 'SPILL_S', x: st.x, y: st.y, h: null });
    const cellY = (side === 'north' ? 1 : -1) * BB.BB_HIVE_CELL_DY;
    const scoring = env[`REAL-v0:${side}`].filter((q) => q.entered);
    const pick = (target: Vec2, tag: string): void => {
      const ok = scoring
        .map((q) => ({ q, h: Math.atan2(cellY - q.y, BB.BB_HIVE_X - q.x) }))
        // ROTATION-SAFE: clear of every obstacle at every heading, because the robot turns there
        // (v1 picked a spot beside FLOWER F3's foot; turning into it jammed 18° short)
        .filter(({ q }) => Array.from({ length: 24 }, (_, k) => (k * Math.PI) / 12).every((hh) => placeable(spec, q, hh)))
        .sort((a, b) => Math.hypot(a.q.x - target.x, a.q.y - target.y) - Math.hypot(b.q.x - target.x, b.q.y - target.y))[0];
      if (ok) P.push({ name: tag, x: ok.q.x, y: ok.q.y, h: ok.h });
    };
    pick(c, side === 'north' ? 'SHOOT_N' : 'SHOOT_S'); // nearest scoring spot to where the spill lies
    pick({ x: BB.BB_HALF_X, y: LZ_Y }, side === 'north' ? 'SHOOT_N_LZ' : 'SHOOT_S_LZ'); // nearest to the loading zone
  }
  // anchors touch the wall by rule (G304) and are DSIM-legal by construction (bbSnapStart); every
  // other pose must be placeable clear of walls, the HIVE frame and FLOWER feet
  for (const p of P) if (!p.name.startsWith('A') && p.h !== null && !placeable(spec, p, p.h, 0.1)) throw new Error(`${name}: pose ${p.name} is not placeable`);
  return P;
}
const poses = Object.fromEntries(Object.keys(specs).map((k) => [k, posesFor(k)]));
save('poses.json', poses);
log(`poses: ${poses['REAL-v0'].map((p) => p.name).join(' ')}`);

// 5. travel-time table — every pose to every non-anchor pose, each robot
const tables: Record<string, PairResult[]> = {};
for (const profile of Object.keys(specs)) {
  const P = poses[profile];
  const jobs = P.flatMap((f) => P.filter((t) => t !== f && !t.name.startsWith('A')).map((t) => ({ module: 's1/jobs.ts', fn: 'pair', args: { profile, from: f, to: t, seed: 1 } })));
  tables[profile] = await runPool<PairResult>(jobs, 8);
  // a pair the standard search missed gets two larger, differently seeded searches
  for (const seed of [2, 3]) {
    const miss = tables[profile].map((r, i) => ({ r, i })).filter(({ r }) => r.best === null);
    if (!miss.length) break;
    const redo = await runPool<PairResult>(miss.map(({ i }) => ({ ...jobs[i], args: { ...jobs[i].args, seed, iters: 40, pop: 30 } })), 8);
    miss.forEach(({ i }, k) => { if (redo[k].best !== null) tables[profile][i] = redo[k]; });
  }
  const got = tables[profile].filter((r) => r.best !== null);
  const gap = got.map((r) => r.best! / Math.max(1, r.lb) - 1);
  log(`table ${profile}: ${got.length}/${jobs.length} arrived, median gap to bound ${(100 * gap.sort((a, b) => a - b)[gap.length >> 1]).toFixed(0)}%` + (got.length < jobs.length ? ` — MISSING: ${tables[profile].filter((r) => r.best === null).map((r) => `${r.from}->${r.to}`).join(', ')}` : ''));
}
// polish: re-search every pair seeded with the other robots' best routes for it; keep improvements
for (const profile of Object.keys(specs)) {
  const P = poses[profile];
  const others = Object.keys(specs).filter((k) => k !== profile);
  const jobs = tables[profile].map((r) => ({
    module: 's1/jobs.ts',
    fn: 'pair',
    args: {
      profile,
      from: P.find((p) => p.name === r.from)!,
      to: P.find((p) => p.name === r.to)!,
      seed: 7,
      extraStarts: [r.params, ...others.map((o) => tables[o].find((q) => q.from === r.from && q.to === r.to)!.params)],
    },
  }));
  const polished = await runPool<PairResult>(jobs, 8);
  let better = 0;
  polished.forEach((q, i) => {
    if (q.best !== null && (tables[profile][i].best === null || q.best < tables[profile][i].best!)) {
      tables[profile][i] = q;
      better++;
    }
  });
  log(`polish ${profile}: ${better} pairs improved`);
}
save('tables.json', tables);
log('S1 lab complete');
