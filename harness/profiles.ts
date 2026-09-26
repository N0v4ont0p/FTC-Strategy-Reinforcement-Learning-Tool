// Robot profiles (PLAN.md §2): builder spec (layer A) + robot limits (layer B) + perturbations
// (layer C). A value is a number, or a range {min,max,nominal} that is sampled for envelope runs.
import { readFileSync } from 'node:fs';
import { coerce, type RobotSpec } from './dsim';
import { mulberry32, type Rng } from './rng';

type Num = number | { min: number; max: number; nominal: number };
export interface ProfileFile {
  id: string;
  label: string;
  spec: Record<string, unknown>;
  expect: Record<string, unknown>;
  limits: Record<string, Num>;
  perturb: Record<string, Num>;
}

export interface Limits {
  fireRate: number;
  aimSettle: number;
  vFire: number;
  tSecure: number;
  vIntake: number;
  intakeSuccess: number;
  intakeRetry: number;
  turretYawRange: number;
  turretSlew: number;
  turretHome: number;
  hpDelay: number;
}
export interface Perturb {
  shotAccuracy: number;
}
export interface Resolved {
  id: string;
  /** every sampled/nominal number, flat, for logging and for the profile-conditioned agent */
  point: Record<string, number>;
  spec: RobotSpec;
  limits: Limits;
  perturb: Perturb;
  /** spec fields DSIM changed during coercion — must be empty for a trustworthy sample */
  clamped: string[];
  /** `expect` entries the coerced spec violates — must be empty */
  expectFails: string[];
}

const isRange = (v: unknown): v is { min: number; max: number; nominal: number } =>
  typeof v === 'object' && v !== null && 'min' in v && 'max' in v;

export const loadProfile = (path: string): ProfileFile => JSON.parse(readFileSync(path, 'utf8')) as ProfileFile;

/** the same profile with some spec/limits/perturb values pinned (e.g. an envelope corner) —
 * keys like 'spec.driveRpm', 'limits.fireRate' */
export function pinned(p: ProfileFile, fix: Record<string, number>, id?: string): ProfileFile {
  const q = JSON.parse(JSON.stringify(p)) as ProfileFile;
  for (const [k, v] of Object.entries(fix)) {
    const [grp, key] = k.split('.') as ['spec' | 'limits' | 'perturb', string];
    (q[grp] as Record<string, unknown>)[key] = v;
  }
  if (id) q.id = id;
  return q;
}

/** `rng` absent → nominal point; present → uniform sample of every range. */
export function resolve(p: ProfileFile, rng?: Rng): Resolved {
  const point: Record<string, number> = {};
  const pick = (key: string, v: Num): number => {
    const x = isRange(v) ? (rng ? v.min + (v.max - v.min) * rng() : v.nominal) : v;
    point[key] = x;
    return x;
  };
  const raw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.spec)) raw[k] = isRange(v) || typeof v === 'number' ? pick(`spec.${k}`, v as Num) : v;
  // DSIM snaps sizes to 0.5 in; sample on that grid so "clamped" only ever means a real clamp
  for (const k of ['length', 'width']) if (typeof raw[k] === 'number') raw[k] = point[`spec.${k}`] = Math.round((raw[k] as number) * 2) / 2;
  for (const k of ['driveRpm']) if (typeof raw[k] === 'number') raw[k] = point[`spec.${k}`] = Math.round(raw[k] as number);
  for (const k of ['massLb']) if (typeof raw[k] === 'number') raw[k] = point[`spec.${k}`] = Math.round((raw[k] as number) * 10) / 10;

  const spec = coerce(raw as Partial<RobotSpec>);
  const clamped: string[] = [];
  for (const k of ['driveRpm', 'massLb', 'length', 'width', 'ballStorage'] as const)
    if (typeof raw[k] === 'number' && Math.abs((spec[k] as number) - (raw[k] as number)) > 1e-9)
      clamped.push(`${k}: asked ${raw[k]}, DSIM built ${spec[k]}`);

  const limits = {} as Record<string, number>;
  for (const [k, v] of Object.entries(p.limits)) limits[k] = pick(`limits.${k}`, v);
  const perturb = {} as Record<string, number>;
  for (const [k, v] of Object.entries(p.perturb)) perturb[k] = pick(`perturb.${k}`, v);

  return { id: p.id, point, spec, limits: limits as unknown as Limits, perturb: perturb as unknown as Perturb, clamped, expectFails: checkExpect(spec, p.expect) };
}

/** Every way this profile's robot comes out wrong in DSIM, over the whole envelope a run can
 * draw from: the nominal point, each spec range at its min and max (the rest nominal), all at
 * min, all at max, and 256 fixed random samples. Empty = every robot a run samples is the one
 * the file describes. A run must not start otherwise: `robotFor` throws on the first bad draw. */
export function profileProblems(p: ProfileFile, sample: boolean): string[] {
  const out = new Set<string>();
  const add = (r: Resolved, where: string): void => {
    for (const f of [...r.expectFails, ...r.clamped]) out.add(`${f} (${where})`);
  };
  add(resolve(p), 'nominal');
  if (sample) {
    const ranges = Object.entries(p.spec).filter(([, v]) => isRange(v)) as [string, { min: number; max: number }][];
    for (const [k, v] of ranges) for (const end of ['min', 'max'] as const) add(resolve(pinned(p, { [`spec.${k}`]: v[end] })), `${k} at its ${end}`);
    for (const end of ['min', 'max'] as const) add(resolve(pinned(p, Object.fromEntries(ranges.map(([k, v]) => [`spec.${k}`, v[end]])))), `every range at its ${end}`);
    for (let s = 1; s <= 256; s++) add(resolve(p, mulberry32(s)), `sample ${s}`);
  }
  return [...out];
}

function checkExpect(spec: RobotSpec, e: Record<string, unknown>): string[] {
  const m = (spec as unknown as { bbMech?: { launcher: { kind: string; mount: string; mount2?: string }; lift: { kind: string; mount: string } | null } }).bbMech;
  const got: Record<string, unknown> = {
    drivetrain: spec.drivetrain,
    launcher: m?.launcher.kind,
    launcherMount: m?.launcher.mount,
    launcherMount2: m?.launcher.mount2,
    lift: m?.lift ? `${m.lift.kind}@${m.lift.mount}` : null,
    intakeMount: spec.intakeMount,
    ballStorage: spec.ballStorage,
  };
  return Object.entries(e)
    .filter(([k, v]) => got[k] !== v)
    .map(([k, v]) => `${k}: expected ${JSON.stringify(v)}, DSIM built ${JSON.stringify(got[k])}`);
}
