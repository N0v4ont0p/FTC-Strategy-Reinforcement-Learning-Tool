// SHOOTING ENVELOPES PER BUILD — where THIS robot's shot goes in, measured in DSIM (the S1 lab's own
// instrument, harness/s1/lab.ts shootingColumn: place the robot, let the turret settle, hold fire,
// follow the shot). v1 used REAL-v0's envelope for every robot; REAL-v1's turrets sit at the back
// corners and the partners' launchers differ, so a spot REAL-v0 scores from can give them no shot at
// all — a robot parked there with a full hopper stalled the match. Each build FAMILY (launcher, its
// mounts, the intake mounts: what moves the muzzle and the footprint) is measured once on its
// nominal build and cached in outputs/envelopes/<key>.json.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bbLauncherOf, bbLiftOf, type RobotSpec } from '../harness/dsim';
import { shootingColumn, type ShotCell } from '../harness/s1/lab';
import { runPool } from '../harness/pool';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_DIR = join(root, 'outputs/envelopes');
type Spot = { x: number; y: number };
type Side = 'north' | 'south';
/** the S1 grid: 2 in, the whole field */
const GRID = Array.from({ length: 71 }, (_, i) => -70 + 2 * i);

/** what makes two builds shoot alike: the launcher and where it and the intakes sit, and the size */
export function familyKey(spec: RobotSpec): string {
  const l = bbLauncherOf(spec, 0);
  const lift = bbLiftOf(spec);
  const id = JSON.stringify({ k: l.kind, m: l.mount, m2: l.mount2 ?? null, hood: l.hoodDeg, i: spec.intakeMount ?? null, lift: lift ? lift.mount : null, L: spec.length, W: spec.width });
  return createHash('sha1').update(id).digest('hex').slice(0, 12);
}

export interface Envelope {
  key: string;
  spots: Record<Side, Spot[]>;
}
const cache = new Map<string, Envelope & { set: Record<Side, Set<string>> }>();

function withSet(e: Envelope): Envelope & { set: Record<Side, Set<string>> } {
  return { ...e, set: { north: new Set(e.spots.north.map((s) => `${s.x},${s.y}`)), south: new Set(e.spots.south.map((s) => `${s.x},${s.y}`)) } };
}

/** REAL-v0's S1 envelope: the fallback for a build nobody measured */
const S1 = (() => {
  const env = JSON.parse(readFileSync(join(root, 'outputs/s1/envelope.json'), 'utf8')) as Record<string, { x: number; y: number; entered: boolean }[]>;
  return withSet({
    key: 'real-v0-s1',
    spots: {
      north: env['REAL-v0:north'].filter((c) => c.entered).map(({ x, y }) => ({ x, y })),
      south: env['REAL-v0:south'].filter((c) => c.entered).map(({ x, y }) => ({ x, y })),
    },
  });
})();
export const S1_ENVELOPE: Envelope & { set: Record<Side, Set<string>> } = S1;

/** the measured envelope of this build's family (sizes snap to the nearest measured one), or S1's */
export function envelopeOf(spec: RobotSpec): Envelope & { set: Record<Side, Set<string>> } {
  const key = familyKey(spec);
  const hit = cache.get(key);
  if (hit) return hit;
  const f = join(ENV_DIR, `${key}.json`);
  const e = existsSync(f) ? withSet(JSON.parse(readFileSync(f, 'utf8')) as Envelope) : nearest(spec) ?? S1;
  cache.set(key, e);
  return e;
}

/** a measured envelope of the same launcher family at another size (sampled robots vary 1–2 in) */
function nearest(spec: RobotSpec): (Envelope & { set: Record<Side, Set<string>> }) | null {
  const f = join(ENV_DIR, 'index.json');
  if (!existsSync(f)) return null;
  const idx = JSON.parse(readFileSync(f, 'utf8')) as { key: string; family: string; L: number; W: number }[];
  const fam = familyKey({ ...spec, length: 0, width: 0 });
  const same = idx.filter((e) => e.family === fam);
  if (!same.length) return null;
  const best = same.reduce((a, b) => (Math.hypot(a.L - spec.length, a.W - spec.width) <= Math.hypot(b.L - spec.length, b.W - spec.width) ? a : b));
  return withSet(JSON.parse(readFileSync(join(ENV_DIR, `${best.key}.json`), 'utf8')) as Envelope);
}

/** is (x, y) — blue frame, 2 in grid — a scoring spot for that up cell */
export function inEnv(e: { set: Record<Side, Set<string>> }, side: Side, x: number, y: number): boolean {
  return e.set[side].has(`${Math.round(x / 2) * 2},${Math.round(y / 2) * 2}`);
}

/** the headings a spot must score from: a robot shooting on the move faces any way, so a spot
 * counts only if the shot goes in whichever way the chassis points (the muzzle sits off-centre) */
const HEADINGS = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
/** pool job: one grid column for a spec at one heading (plain JSON) */
export const column = (a: { spec: RobotSpec; side: Side; x: number; heading: number }): ShotCell[] => shootingColumn({ spec: a.spec, side: a.side, x: a.x, ys: GRID, heading: a.heading });

/** measure every build not measured yet (the pool, ~1 min a build on 12 cores) */
export async function ensureEnvelopes(specs: RobotSpec[], log: (s: string) => void = () => {}, workers = 12): Promise<void> {
  mkdirSync(ENV_DIR, { recursive: true });
  const idxF = join(ENV_DIR, 'index.json');
  const idx = existsSync(idxF) ? (JSON.parse(readFileSync(idxF, 'utf8')) as { key: string; family: string; L: number; W: number }[]) : [];
  const todo = new Map<string, RobotSpec>();
  for (const s of specs) {
    const k = familyKey(s);
    if (!existsSync(join(ENV_DIR, `${k}.json`))) todo.set(k, s);
  }
  for (const [key, spec] of todo) {
    const t = performance.now();
    const spots: Record<Side, Spot[]> = { north: [], south: [] };
    for (const side of ['north', 'south'] as const) {
      const jobs = HEADINGS.flatMap((heading) => GRID.map((x) => ({ module: '../train/envelope.ts', fn: 'column', args: { spec, side, x, heading } })));
      const cols = await runPool<ShotCell[]>(jobs, workers);
      const hits = new Map<string, number>();
      for (const c of cols.flat()) if (c.entered) hits.set(`${c.x},${c.y}`, (hits.get(`${c.x},${c.y}`) ?? 0) + 1);
      spots[side] = [...hits].filter(([, n]) => n === HEADINGS.length).map(([k]) => {
        const [x, y] = k.split(',').map(Number);
        return { x, y };
      });
    }
    writeFileSync(join(ENV_DIR, `${key}.json`), JSON.stringify({ key, spots } satisfies Envelope));
    idx.push({ key, family: familyKey({ ...spec, length: 0, width: 0 }), L: spec.length, W: spec.width });
    writeFileSync(idxF, JSON.stringify(idx));
    cache.delete(key);
    log(`shooting envelope measured for ${spec.name ?? key}: ${spots.north.length} + ${spots.south.length} scoring spots (${((performance.now() - t) / 1000).toFixed(0)} s)`);
  }
}
