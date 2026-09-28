// THE ROBOT LAB (MASTERPLAN §9 "Robot page") — the team's robots as training sees them. A profile is
// the DSIM build (drivetrain, launcher, mounts…) plus RANGES for what is not known yet (speed, mass,
// fire rate, accuracy…): training samples a robot from those ranges every match, so the narrower
// and truer they are, the truer everything it learns. Here a profile is
//   · IMPORTED from DSIM itself — the builder's robot (pasted from DSIM's settings), a replay's robot,
//     or any JSON holding a spec — as a draft with sensible ranges,
//   · EDITED range by range, each against DSIM's own floors (what DSIM will actually build),
//   · VALIDATED over its whole range (harness/profiles.ts profileProblems: every robot a run can draw
//     is the one the file describes), with its shooting envelope's quality (train/envelope.ts),
//   · SAVED to profiles/<id>.json — a bad range never reaches training (runs refuse it).
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coerce, type RobotSpec } from '../harness/dsim';
import { buildOf, loadProfile, pinned, profileProblems, resolve, type ProfileFile } from '../harness/profiles';
import { ROOT } from './engine';
import { envelopeOf, envelopeQuality, zonedEnvelope } from './envelope';
import { zoneActive, zoneProblems } from './zone';
import { startPoseOf } from './team';

export const PROFILE_DIR = join(ROOT, 'profiles');
type Range = { min: number; max: number; nominal: number; unit?: string };
const isRange = (v: unknown): v is Range => typeof v === 'object' && v !== null && 'min' in v && 'max' in v && 'nominal' in v;

/** what each number is, for people */
export const FIELD_INFO: Record<string, { label: string; unit: string; help: string }> = {
  'spec.driveRpm': { label: 'Drive motor speed', unit: 'rpm', help: 'free speed of the drive motors (with the gearing DSIM models)' },
  'spec.massLb': { label: 'Mass', unit: 'lb', help: 'the whole robot with battery' },
  'spec.length': { label: 'Length', unit: 'in', help: 'front to back (DSIM snaps to 0.5 in)' },
  'spec.width': { label: 'Width', unit: 'in', help: 'side to side (DSIM snaps to 0.5 in)' },
  'limits.fireRate': { label: 'Fire rate', unit: 'shots/s', help: '13 is DSIM’s own clock (no limit)' },
  'limits.aimSettle': { label: 'Aim settle', unit: 's', help: 'slow-down before a shot releases' },
  'limits.vFire': { label: 'Max speed while firing', unit: 'in/s', help: '100 = unlimited' },
  'limits.tSecure': { label: 'Intake secure time', unit: 's', help: 'slow intake before an element is held' },
  'limits.vIntake': { label: 'Max speed to intake', unit: 'in/s', help: '100 = unlimited' },
  'limits.intakeSuccess': { label: 'Intake success', unit: 'p', help: 'chance an intake attempt works first time' },
  'limits.intakeRetry': { label: 'Intake retry cost', unit: 's', help: 'time lost on a failed attempt' },
  'limits.turretYawRange': { label: 'Turret travel', unit: '°', help: '360 = unlimited' },
  'limits.turretSlew': { label: 'Turret speed', unit: 'rad/s', help: 'how fast the turret turns' },
  'limits.turretHome': { label: 'Turret home', unit: '°', help: 'vs the robot’s front' },
  'limits.hpDelay': { label: 'Human player delay', unit: 's', help: 'from the cue to the element entering' },
  'perturb.shotAccuracy': { label: 'Shot accuracy', unit: 'p', help: 'chance a released shot lands' },
};

export interface RobotSummary {
  file: string; // profiles/<name>.json
  id: string;
  label: string;
  status: string;
  build: string;
  ok: boolean;
  problems: string[];
}
/** a build in words: "mecanum · twin turret (back-left + back-right) · vertical slide right · front intake · holds 4" */
export function describeBuild(spec: RobotSpec): string {
  const b = buildOf(spec) as Record<string, string | number | null | undefined>;
  const words: Record<string, string> = { twinturret: 'twin turret', turret: 'turret', dumper: 'dumper', vslide: 'vertical slide', backleft: 'back-left', backright: 'back-right', frontleft: 'front-left', frontright: 'front-right', frontback: 'front + back' };
  const w = (x: unknown): string => words[String(x)] ?? String(x);
  const launcher = `${w(b.launcher)} (${w(b.launcherMount)}${b.launcherMount2 ? ` + ${w(b.launcherMount2)}` : ''})`;
  const lift = b.lift ? `${w(String(b.lift).split('@')[0])} ${w(String(b.lift).split('@')[1])}` : 'no lift';
  return [b.drivetrain, launcher, lift, `${w(b.intakeMount)} intake`, `holds ${b.ballStorage}`].join(' · ');
}

export function listRobots(): RobotSummary[] {
  return readdirSync(PROFILE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const file = `profiles/${f}`;
      try {
        const p = loadProfile(join(PROFILE_DIR, f));
        const problems = profileProblems(p, true);
        const spec = resolve(p).spec;
        return { file, id: p.id, label: p.label, status: String((p as { status?: string }).status ?? ''), build: describeBuild(spec), ok: !problems.length, problems: problems.slice(0, 6) };
      } catch (e) {
        return { file, id: f, label: '', status: '', build: '', ok: false, problems: [`not a readable profile: ${(e as Error).message}`] };
      }
    });
}

/** what DSIM builds for the lowest and highest value of each spec number (its floors and ceilings) */
export function floorsOf(spec: RobotSpec): Record<string, { min: number; max: number }> {
  const out: Record<string, { min: number; max: number }> = {};
  for (const k of ['driveRpm', 'massLb', 'length', 'width'] as const) {
    const lo = coerce({ ...spec, [k]: -1e6 } as Partial<RobotSpec>)[k] as number;
    const hi = coerce({ ...spec, [k]: 1e6 } as Partial<RobotSpec>)[k] as number;
    out[`spec.${k}`] = { min: lo, max: hi };
  }
  return out;
}

/** a profile's structure is sound: every range has min ≤ nominal ≤ max, finite */
export function shapeProblems(p: ProfileFile): string[] {
  const out: string[] = [];
  if (!p || typeof p !== 'object' || typeof p.spec !== 'object' || typeof p.limits !== 'object' || typeof p.perturb !== 'object') return ['not a profile (spec, limits and perturb are needed)'];
  if (!/^[A-Za-z0-9 _.-]{1,40}$/.test(String(p.id ?? ''))) out.push('the name uses letters, digits, spaces, - _ . (up to 40)');
  for (const g of ['spec', 'limits', 'perturb'] as const)
    for (const [k, v] of Object.entries(p[g] as Record<string, unknown>)) {
      if (!isRange(v)) continue;
      const nums = [v.min, v.nominal, v.max];
      if (!nums.every((x) => typeof x === 'number' && Number.isFinite(x))) out.push(`${g}.${k}: not a number`);
      else if (!(v.min <= v.nominal && v.nominal <= v.max)) out.push(`${FIELD_INFO[`${g}.${k}`]?.label ?? `${g}.${k}`}: needs min ≤ nominal ≤ max`);
    }
  out.push(...zoneProblems(p.shootZone));
  return out;
}

/** a shooting zone must leave the robot somewhere to shoot at each CELL from */
export function zoneEmpty(p: ProfileFile): string[] {
  if (!zoneActive(p.shootZone)) return [];
  const z = zonedEnvelope(resolve(p).spec, p.shootZone).spots;
  return (['north', 'south'] as const).filter((s) => !z[s].length).map((s) => `shooting zone: no measured scoring spot for the ${s} CELL is left inside it — widen it`);
}

export interface Inspection {
  problems: string[]; // shape first, then what DSIM builds over the whole range
  build: string;
  nominal: RobotSpec;
  small: RobotSpec; // every spec range at its min
  big: RobotSpec; // …at its max
  floors: Record<string, { min: number; max: number }>;
  envelope: { key: string; quality: 'measured' | 'nearest' | 'fallback'; spots: { north: { x: number; y: number }[]; south: { x: number; y: number }[] } };
  start: { x: number; y: number; h: number }; // the team's start (F3), for the preview
  info: typeof FIELD_INFO;
}
export function inspectRobot(p: ProfileFile): Inspection {
  const shape = shapeProblems(p);
  if (shape.length) throw new Error(shape.join('; '));
  const nominal = resolve(p).spec;
  const ranges = Object.entries(p.spec).filter(([, v]) => isRange(v)) as [string, Range][];
  const at = (end: 'min' | 'max'): RobotSpec => resolve(pinned(p, Object.fromEntries(ranges.map(([k, v]) => [`spec.${k}`, v[end]])))).spec;
  const env = envelopeOf(nominal);
  return {
    problems: [...zoneEmpty(p), ...profileProblems(p, true)],
    build: describeBuild(nominal),
    nominal,
    small: at('min'),
    big: at('max'),
    floors: floorsOf(nominal),
    envelope: { key: env.key, quality: envelopeQuality(nominal), spots: env.spots },
    start: (() => {
      const q = startPoseOf(nominal, 'F3');
      return { x: q.x, y: q.y, h: (q.headingDeg * Math.PI) / 180 };
    })(),
    info: FIELD_INFO,
  };
}

// ─────────────────────────────── import ───────────────────────────────
export interface Candidate {
  label: string;
  spec: Record<string, unknown>;
}
/** every robot spec in a JSON text: a DSIM settings blob (its robot and saved robots), a replay (each
 * seat), a profile, or a bare spec */
export function specsIn(text: string): Candidate[] {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error('that is not JSON — copy it from DSIM exactly as the steps say');
  }
  const out: Candidate[] = [];
  const isSpec = (o: unknown): o is Record<string, unknown> => typeof o === 'object' && o !== null && 'drivetrain' in o && ('length' in o || 'width' in o);
  const name = (s: Record<string, unknown>, d: string): string => [s.name, s.teamNumber ? `#${s.teamNumber}` : '', s.teamName].filter(Boolean).join(' ') || d;
  const walk = (o: unknown, where: string, depth: number): void => {
    if (depth > 4 || typeof o !== 'object' || o === null) return;
    if (isSpec(o)) {
      out.push({ label: name(o, where), spec: o });
      return;
    }
    if (Array.isArray(o)) o.forEach((x, i) => walk(x, `${where} ${i + 1}`, depth + 1));
    else for (const [k, x] of Object.entries(o)) if (k !== 'frames' && k !== 'ticks') walk(x, k === 'spec' ? where : `${where ? `${where} · ` : ''}${k}`, depth + 1);
  };
  walk(v, '', 0);
  if (!out.length) throw new Error('no robot in it (a robot has a drivetrain and a size)');
  return out;
}
/** the robots in the team's replays (Training data/) */
export function replayRobots(): (Candidate & { file: string })[] {
  const dir = join(ROOT, 'Training data');
  if (!existsSync(dir)) return [];
  const out: (Candidate & { file: string })[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { setups?: { spec: Record<string, unknown>; alliance?: string }[] };
      (r.setups ?? []).forEach((s, i) => out.push({ file: f, label: `${f.replace(/^dsim-biobuzz-/, '').slice(0, 16)} · seat ${i + 1}${s.alliance ? ` (${s.alliance})` : ''}`, spec: s.spec }));
    } catch {
      /* not a replay */
    }
  }
  return out;
}

const r1 = (x: number): number => Math.round(x * 10) / 10;
/** a new profile around a DSIM spec: the build exact; mass and motor speed a range around the
 * builder's numbers (DSIM's floor respected); the size exact; limits and accuracy from a template */
export function draftFrom(raw: Record<string, unknown>, template: ProfileFile): ProfileFile {
  const spec = coerce(raw as Partial<RobotSpec>);
  const fl = floorsOf(spec);
  const mass = spec.massLb;
  const rpm = spec.driveRpm;
  const b = buildOf(spec);
  const expect = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
  const id = String(raw.name ?? spec.name ?? 'NEW-ROBOT').slice(0, 40).replace(/[^A-Za-z0-9 _.-]/g, '-') || 'NEW-ROBOT';
  return {
    id,
    label: `Imported from DSIM ${new Date().toISOString().slice(0, 10)} — ${describeBuild(spec)}. Not measured yet: performance is a range.`,
    status: 'draft: narrow the ranges as the robot is measured',
    spec: {
      ...(spec as unknown as Record<string, unknown>),
      driveRpm: { min: Math.min(rpm, Math.max(fl['spec.driveRpm'].min, Math.round(rpm * 0.8))), max: Math.max(rpm, Math.min(fl['spec.driveRpm'].max, Math.round(rpm * 1.1))), nominal: rpm },
      massLb: { min: Math.min(r1(mass), r1(Math.max(fl['spec.massLb'].min + 0.2, mass * 0.9))), max: Math.max(r1(mass), r1(Math.min(fl['spec.massLb'].max, mass * 1.15))), nominal: r1(mass) },
      length: spec.length,
      width: spec.width,
    },
    expect,
    limits: JSON.parse(JSON.stringify(template.limits)),
    perturb: JSON.parse(JSON.stringify(template.perturb)),
  } as ProfileFile;
}

/** profiles/<slug>.json for a robot name */
export const fileFor = (id: string): string => `profiles/${id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'robot'}.json`;

/** save (the shape must be sound; DSIM problems are saved too — the studio shows them and training refuses) */
export function saveRobot(p: ProfileFile, overwrite: boolean): string {
  const shape = [...shapeProblems(p), ...zoneEmpty(p)];
  if (shape.length) throw new Error(shape.join('; '));
  const file = fileFor(String(p.id));
  if (existsSync(join(ROOT, file)) && !overwrite) throw new Error(`${file} exists — save over it, or give the robot another name`);
  writeFileSync(join(ROOT, file), JSON.stringify(p, null, 2) + '\n');
  return file;
}
