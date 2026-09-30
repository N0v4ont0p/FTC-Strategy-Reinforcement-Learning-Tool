// S1 GATE — independent checks on outputs/s1/*.json, then outputs/s1/REPORT.md.
// Run: dsim-main/node_modules/.bin/tsx harness/s1/check.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BB, DT, init, newMatch, type RobotSpec } from '../dsim';
import { resolve } from '../profiles';
import { effective } from './drive';
import { placeable, type ShotCell } from './lab';
import { S1_PROFILES } from './jobs';
import { rollout, type PairResult, type Pose } from './paths';
import type { SysIdCase } from './sysid';
import { mulberry32 } from '../rng';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(root, 'outputs/s1');
const read = <T,>(f: string): T => JSON.parse(readFileSync(join(dir, f), 'utf8')) as T;
let fails = 0;
const lines: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) fails++;
  const l = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`;
  console.log(l);
  lines.push(l);
};

await init();
const specs: Record<string, RobotSpec> = Object.fromEntries(Object.keys(S1_PROFILES).map((k) => [k, resolve(S1_PROFILES[k]()).spec]));
const sys = read<Record<string, { eff: ReturnType<typeof effective>; cases: SysIdCase[] }>>('sysid.json');
const env = read<Record<string, ShotCell[]>>('envelope.json');
const spill = read<{ runs: Record<string, { rest: { x: number; y: number }[]; tipped: boolean }[]>; centroid: Record<string, { x: number; y: number }> }>('spill.json');
const poses = read<Record<string, Pose[]>>('poses.json');
const tables = read<Record<string, PairResult[]>>('tables.json');

// 1. system identification
// (in DSIM's 3D solve the chassis is a Rapier 3D body driven by the shared drivetrain model: every
// speed, and the position of every translation, still match the model to 1e-3; the HEADING of a
// full-rate spin trails it by up to one tick of turning — the 3D body integrates its yaw a tick
// later — so that one number is held to 0.1 rad: one tick at ~5.3 rad/s is 0.088)
const YAW_TOL = 0.1;
for (const [k, s] of Object.entries(sys)) {
  const worst = s.cases.reduce((m, c) => Math.max(m, c.maxSpeedErr, c.name.startsWith('rotate') ? 0 : c.maxPosErr), 0);
  const yaw = Math.max(0, ...s.cases.filter((c) => c.name.startsWith('rotate')).map((c) => c.maxPosErr));
  check(`1 sysid ${k}: DSIM matches the drive model in all ${s.cases.length} step tests (speeds and translations to 1e-3; a full-rate spin's heading within one tick)`, worst < 1e-3 && yaw < YAW_TOL, `worst error ${worst.toExponential(1)}, spin heading ${yaw.toFixed(3)} rad`);
}

// 2–4. travel table
for (const [k, T] of Object.entries(tables)) {
  check(`2 table ${k}: every one of ${T.length} pairs arrived`, T.every((r) => r.best !== null));
  const under = T.filter((r) => r.best !== null && r.best < r.lb);
  check(`2 table ${k}: no DSIM time beats its provable lower bound`, under.length === 0, under.map((r) => `${r.from}->${r.to} ${r.best}<${r.lb}`).join(', '));
  check(`3 table ${k}: every best time reproduced by its own re-run`, T.every((r) => r.verify === r.best));
}
{
  // physics ordering on identical trips: the slow corner never beats nominal, the fast corner never loses to it
  const pos = (k: string, n: string): string => { const p = poses[k].find((q) => q.name === n)!; return `${p.x.toFixed(2)},${p.y.toFixed(2)}`; };
  const t = (k: string, f: string, to: string): number => tables[k].find((r) => r.from === f && r.to === to)!.best!;
  const same = (k: string, f: string, to: string): boolean => pos(k, f) === pos('REAL-v0', f) && pos(k, to) === pos('REAL-v0', to);
  const pairs = tables['REAL-v0'].map((r) => [r.from, r.to] as const);
  // each table time is its own route search's best, so a slower robot can find a route the faster one
  // missed: the physics is ordered when the faster robot, driving the SLOWER one's own route, is not
  // slower on it (the same trip, the same route — only the robot differs)
  const P0 = Object.fromEntries(poses['REAL-v0'].map((p) => [p.name, p]));
  const onRoute = (k: string, via: string, f: string, to: string): number | null => rollout(specs[k], effective(specs[k]), P0[f], P0[to], tables[via].find((r) => r.from === f && r.to === to)!.params).ticks;
  // …and only on trips long enough for top speed to matter: a lower-RPM drivetrain has more torque
  // (REAL-v0-slow accelerates at 241 in/s², the nominal robot at 233), so on a hop shorter than the
  // faster robot needs to reach the slower one's top speed the slower build is genuinely quicker —
  // measured: LZ → SHOOT_S_LZ, 3.75 in with a turn, 16 ticks against 17
  const Ek = (k: string) => effective(specs[k]);
  const dist = (f: string, to: string): number => Math.hypot(P0[to].x - P0[f].x, P0[to].y - P0[f].y);
  const long = (f: string, to: string, slower: string, faster: string): boolean => dist(f, to) >= Ek(slower).vmax ** 2 / (2 * Ek(faster).accel);
  const short: string[] = [];
  const slowWins = pairs.filter(([f, to]) => same('REAL-v0-slow', f, to) && t('REAL-v0-slow', f, to) < t('REAL-v0', f, to) && !((onRoute('REAL-v0', 'REAL-v0-slow', f, to) ?? Infinity) <= t('REAL-v0-slow', f, to)) && (long(f, to, 'REAL-v0-slow', 'REAL-v0') || (short.push(`${f}->${to}`), false)));
  const fastLoses = pairs.filter(([f, to]) => same('REAL-v0-fast', f, to) && t('REAL-v0-fast', f, to) > t('REAL-v0', f, to) && !((onRoute('REAL-v0-fast', 'REAL-v0', f, to) ?? Infinity) <= t('REAL-v0', f, to)) && (long(f, to, 'REAL-v0', 'REAL-v0-fast') || (short.push(`${f}->${to}`), false)));
  check('4 physics ordering on identical trips: slow ≥ nominal ≥ fast (on the same route, once top speed matters)', slowWins.length === 0 && fastLoses.length === 0, `${slowWins.length} slow wins, ${fastLoses.length} fast losses${short.length ? `; ${short.length} hop${short.length === 1 ? '' : 's'} too short for top speed to count (${short.join(', ')})` : ''}`);
}
{
  // fresh-process re-run of a random sample, with the G417 check and the arrival pose re-measured
  const rng = mulberry32(4242);
  let bad = 0;
  let n = 0;
  for (const [k, T] of Object.entries(tables)) {
    const P = Object.fromEntries(poses[k].map((p) => [p.name, p]));
    const E = effective(specs[k]);
    for (let i = 0; i < 12; i++) {
      const r = T[Math.floor(rng() * T.length)];
      const o = rollout(specs[k], E, P[r.from], P[r.to], r.params, true);
      const end = o.trace![o.trace!.length - 1];
      n++;
      if (o.ticks !== r.best || o.g417 || o.impact || Math.hypot(end.x - P[r.to].x, end.y - P[r.to].y) > 1.0) bad++;
    }
  }
  check(`4 ${n} sampled routes re-run from scratch: same time, no HIVE-frame contact, no impact over IMPACT_MAX, arrive within 1 in`, bad === 0, `${bad} bad`);
}

// 5. poses
for (const [k, P] of Object.entries(poses)) {
  for (let i = 0; i < 4; i++) {
    const r = newMatch(1, [{ id: 0, alliance: 'blue', spec: specs[k], startIndex: i }]).robots[0];
    const a = P.find((p) => p.name === `A${i}`)!;
    if (Math.hypot(a.x - r.pos.x, a.y - r.pos.y) > 1e-9) check(`5 ${k} anchor A${i} is DSIM's legal start`, false);
  }
  const bad = P.filter((p) => !p.name.startsWith('A') && p.h !== null && !placeable(specs[k], p, p.h, 0.1));
  const shoot = P.filter((p) => p.name.startsWith('SHOOT'));
  const rotUnsafe = shoot.filter((p) => !Array.from({ length: 24 }, (_, j) => (j * Math.PI) / 12).every((h) => placeable(specs[k], p, h)));
  check(`5 ${k}: all ${P.length} poses legal; shooting poses clear at every heading`, bad.length === 0 && rotUnsafe.length === 0 && shoot.length === 4, [...bad, ...rotUnsafe].map((p) => p.name).join(','));
}

// 6. shooting envelope physics
for (const [key, cells] of Object.entries(env)) {
  const side = key.endsWith('north') ? 1 : -1;
  const cy = side * BB.BB_HIVE_CELL_DY;
  const entered = cells.filter((c) => c.entered);
  const wrongSide = entered.filter((c) => side * (c.y - cy) <= 0);
  const range = entered.map((c) => Math.hypot(c.x - BB.BB_HIVE_X, c.y - cy));
  const wasted = cells.filter((c) => c.released && !c.entered).length;
  check(`6 envelope ${key}: every scoring spot is outboard of the up CELL`, entered.length > 500 && wrongSide.length === 0, `${entered.length} scoring cells, ${wrongSide.length} on the wrong side`);
  check(`6 envelope ${key}: scoring range within DSIM's launch limits (≈18–115 in + turret offset)`, Math.min(...range) > 12 && Math.max(...range) < 125, `${Math.min(...range).toFixed(0)}–${Math.max(...range).toFixed(0)} in; ${wasted} placeable spots release a shot that misses (turret aims at the NEARER cell)`);
}

{
  // north and south are mirror images wherever the robot can stand at both mirrored spots (the
  // FLOWER feet are not mirror-symmetric, so placeability legitimately differs near them)
  for (const prof of ['REAL-v0', 'DREAM']) {
    const N = new Map(env[`${prof}:north`].map((c) => [`${c.x},${c.y}`, c]));
    let bothPlace = 0;
    let differ = 0;
    for (const c of env[`${prof}:south`]) {
      const m = N.get(`${c.x},${-c.y}`);
      if (!m || !m.placeable || !c.placeable) continue;
      bothPlace++;
      if (m.entered !== c.entered) differ++;
    }
    // (DSIM's 3D solve is not mirror-exact: the turret sits off the robot's centre, so a mirrored
    // stand is not a mirrored muzzle, and a shot's contacts with the cell's walls and rim differ in
    // detail — measured, 1.5 % of the spots differ; the 2D pipeline's ballistic verdict gave 0)
    check(`6 envelope ${prof}: north = mirror of south, at all but a few percent of the spots placeable in both`, bothPlace > 2800 && differ / bothPlace <= 0.03, `${bothPlace} mirrored spots compared, ${differ} differ (${((100 * differ) / Math.max(1, bothPlace)).toFixed(1)} %)`);
  }
}

// 7. spill lab
for (const side of ['north', 'south']) {
  const runs = spill.runs[side];
  check(`7 spill ${side}: all ${runs.length} runs tipped and spilled`, runs.every((r) => r.tipped && r.rest.length >= 6), `elements spilled per tip: ${[...new Set(runs.map((r) => r.rest.length))].join('/')}`);
}
{
  const n = spill.centroid.north;
  const s = spill.centroid.south;
  // (in DSIM's 3D solve a tipped cell's load really falls and rolls — on to the side wall, ~66 in from
  // the HIVE — so the two rest centroids agree to a few inches, not exactly: measured 3.6 in)
  check('7 spill: north and south rest centroids are mirror images (within 5 in)', Math.hypot(n.x - s.x, n.y + s.y) < 5, `(${n.x.toFixed(1)}, ${n.y.toFixed(1)}) vs (${s.x.toFixed(1)}, ${s.y.toFixed(1)})`);
}

// ---------- REPORT ----------
const POSE_WHAT: Record<string, string> = {
  A: 'DSIM start anchor (G304-legal, touches a wall)',
  LZ: 'back into blue LOADING ZONE (HP NECTAR drop, loose POLLEN, PARK)',
  RLZ: "red LOADING ZONE (solo mode's free preloads)",
  F3R: 'back mouth on FLOWER F3 foot (POLLEN retrieval, approx.)',
  F4R: 'back mouth on FLOWER F4 foot (POLLEN retrieval, approx.)',
  F1R: 'back mouth on FLOWER F1 foot (POLLEN retrieval, approx.)',
  F2R: 'back mouth on FLOWER F2 foot (POLLEN retrieval, approx.)',
  GARDEN: 'front bumper toward blue GARDEN',
  SPILL_N: 'nearest turn-safe spot to where a north-cell spill rests (measured)',
  SPILL_S: 'nearest turn-safe spot to where a south-cell spill rests (measured)',
  SHOOT_N: 'scoring spot for the north cell nearest its spill',
  SHOOT_N_LZ: 'scoring spot for the north cell nearest the loading zone',
  SHOOT_S: 'scoring spot for the south cell nearest its spill',
  SHOOT_S_LZ: 'scoring spot for the south cell nearest the loading zone',
};
const sec = (t: number): string => (t * DT).toFixed(2);
const R = tables['REAL-v0'];
const names = poses['REAL-v0'].map((p) => p.name).filter((n) => !n.startsWith('A'));
const src = poses['REAL-v0'].map((p) => p.name);
const at = (f: string, t: string): string => {
  const r = R.find((q) => q.from === f && q.to === t);
  return r ? sec(r.best!) : '—';
};
const gapStats = (T: PairResult[]): string => {
  const g = T.map((r) => r.best! / Math.max(1, r.lb) - 1).sort((a, b) => a - b);
  return `median ${(100 * g[g.length >> 1]).toFixed(0)}%, 90th pct ${(100 * g[Math.floor(g.length * 0.9)]).toFixed(0)}%`;
};
const md = [
  '# S1 Motion Lab — report',
  '',
  `Generated ${new Date().toISOString().slice(0, 10)} by \`harness/s1/check.ts\` from \`outputs/s1/*.json\`. DSIM pinned (\`harness/dsim-pin.json\`). All times are DSIM ticks at 60 Hz, shown in seconds.`,
  '',
  '## Gate',
  '',
  '```',
  ...lines,
  '```',
  '',
  '## Robots measured',
  '',
  '| robot | top speed in/s | accel in/s² | turn rad/s | turn accel rad/s² |',
  '|---|---|---|---|---|',
  ...Object.entries(sys).map(([k, s]) => `| ${k} | ${s.eff.vmax.toFixed(1)} | ${s.eff.accel.toFixed(0)} | ${s.eff.maxTurn.toFixed(2)} | ${s.eff.turnAccel.toFixed(1)} |`),
  '',
  'The drive model (DSIM\'s own `driveParams` + `motorStep`, power draw, and a measured 0.44-tick position lag) matches DSIM to < 1e-3 in and in/s in every step test. **Diagonal driving is slow**: mecanum sum saturation halves both axes, so a full diagonal runs at ~64 % of top speed. Strafe runs at 80 %.',
  '',
  '## Travel times, REAL-v0 nominal (seconds, best found; row = from, column = to)',
  '',
  `| from \\ to | ${names.join(' | ')} |`,
  `|---|${names.map(() => '---').join('|')}|`,
  ...src.map((f) => `| **${f}** | ${names.map((t) => (t === f ? '·' : at(f, t))).join(' | ')} |`),
  '',
  '| robot | pairs | gap to provable lower bound |',
  '|---|---|---|',
  ...Object.entries(tables).map(([k, T]) => `| ${k} | ${T.length} | ${gapStats(T)} |`),
  '',
  'The lower bound ignores obstacles, heading and strafe (straight line at forward top speed with DSIM\'s own acceleration and braking budget), so part of every gap is geometry the bound cannot see, not controller slack.',
  '',
  '## Key poses (REAL-v0)',
  '',
  '| pose | x | y | heading° | what |',
  '|---|---|---|---|---|',
  ...poses['REAL-v0'].map((p) => `| ${p.name} | ${p.x.toFixed(1)} | ${p.y.toFixed(1)} | ${p.h === null ? 'any' : ((p.h * 180) / Math.PI).toFixed(0)} | ${POSE_WHAT[p.name.replace(/\d$/, '')] ?? ''} |`),
  '',
  '## Shooting envelope',
  '',
  ...Object.entries(env).map(([k, c]) => `- **${k}**: ${c.filter((q) => q.entered).length} scoring spots on a 2 in grid; ${c.filter((q) => q.released && !q.entered).length} spots where DSIM releases a shot that MISSES (it aims at the nearer cell, which is down).`),
  '- Scoring spots are always outboard of the up cell. A robot on the wrong half of the field wastes every shot: the S2+ controllers and the rule layer must stop firing there.',
  '',
  '## Spill (where a tipped CELL\'s elements come to rest)',
  '',
  `- North tip: centroid (${spill.centroid.north.x.toFixed(1)}, ${spill.centroid.north.y.toFixed(1)}); south tip: (${spill.centroid.south.x.toFixed(1)}, ${spill.centroid.south.y.toFixed(1)}). ${spill.runs.north[0].rest.length} elements spill per first tip (3 NECTAR + the POLLEN that tipped it + one more that entered before the release).`,
  '- Spill lands ~40–60 in outboard of the cell toward the rear/audience wall — far from the loading zone.',
  '',
  '## Honest limits',
  '',
  '- Times are for a robot alone on an empty field. Elements on the floor and other robots are S2/S3 concerns.',
  '- FLOWER retrieval poses (F*R) are approximate docking spots; exact docking is an S2 skill.',
  '- "Best found" is optimal within a 12-parameter controller family, tuned by cross-entropy search with every candidate scored in DSIM. The provable bound gives the remaining gap.',
  '- The spill south case is staged the way DSIM stages a south-up cell (spawn.ts `cellNectar`), not reached by play; its mirror agreement with north is checked above.',
].join('\n');
writeFileSync(join(dir, 'REPORT.md'), md + '\n');
console.log(fails === 0 ? '\nS1 GATE: ALL PASS' : `\nS1 GATE: ${fails} FAIL`);
process.exit(fails ? 1 : 0);

