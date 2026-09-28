// TEAM PLAYS — the alliance plays TOGETHER, not two robots each doing its own thing. A PLAY gives each
// robot a ROLE for each part of the match (AUTO, TELEOP, the last 30 s). A role shapes what the
// robot's brain may and wants to do, on top of its own judgement:
//   · KIND BIAS — prefer or avoid kinds of job, in seconds of travel: "FLOWERs +4 s" means a FLOWER
//     is chosen over a group up to 4 s closer (the network's points: ×PTS_PER_S);
//   · ZONE — where it collects: the top or bottom half of the field (each robot one side of the
//     HIVE: its north and south cells face those halves), our half or the far half, or a MOVING zone —
//     the half the HIVE's target cell faces now ("both on the target side") or the other one; hard
//     (jobs outside are off the list when anything inside is on it) or soft (a penalty in seconds);
//   · PARK LEAD — leave to park this many seconds earlier (one robot parks, the other scores on);
//   · HOLD — a joint volley: hold fire until the partner is loaded too (or its own hopper is full,
//     or 4 s passed), so both robots' elements reach the cell together (a tip needs them).
// Shooting, parking and getting in position are never taken off the list: roles steer, they never
// strand a robot. A play with no roles is FREE: the two brains and the alliance board alone.
//
// The library below is the plays a coach would draw up. The PLAY SEARCH (searchPlays) scores every
// one beside a partner in DSIM on shared luck draws, then MUTATES and CROSSES the best (a zone line
// moves, roles swap, a bias grows, a phase takes another's role…) to discover plays nobody drew up;
// the finalists are re-scored on fresh draws, so the numbers shown are not the search's luck.
import type { World } from '../harness/dsim';
import type { WorkerPool, Job } from '../harness/pool';
import { mulberry32, seedOf, type Rng } from '../harness/rng';
import type { Option, OptionKind } from './skills';
import { targetCell } from './skills';
import type { EpisodeArgs } from './episode';
import type { PartnerKind } from './team';

/** the network's points per second of preference (a greedy score is minus seconds) */
export const PTS_PER_S = 1.2;
/** the last part of TELEOP where the 'end' roles take over (s) */
export const END_S = 30;
const COLLECT = new Set<OptionKind>(['field', 'lz', 'flower', 'cycle', 'place']);

export type ZoneY = 'top' | 'bottom' | 'target' | 'away' | null;
export interface Role {
  kinds: Partial<Record<OptionKind, number>>; // preference in seconds (+ prefer, − avoid)
  y: ZoneY; // which half it collects in (world frame, y ≥ yLine is the top / north half)
  yLine: number;
  x: 'ours' | 'far' | null; // our half (x > xLine) or the far half
  xLine: number;
  hard: boolean; // outside-zone collecting off the list (when something inside is on it)
  out: number; // soft: seconds of penalty for collecting outside the zone
  parkLead: number; // leave to park this many seconds earlier
  hold: boolean; // joint volley
}
export interface PhaseRoles {
  auto: Role | null;
  teleop: Role | null;
  end: Role | null;
}
export interface Play {
  id: string;
  label: string;
  blurb: string;
  roles: [PhaseRoles, PhaseRoles]; // [our robot, the partner]
  parent?: string; // a mutant: what it came from, and how
  change?: string;
}
export type PlayPhase = keyof PhaseRoles;

export const role = (o: Partial<Role> = {}): Role => ({ kinds: {}, y: null, yLine: 0, x: null, xLine: 0, hard: false, out: 0, parkLead: 0, hold: false, ...o });
const same = (r: Role | null): PhaseRoles => ({ auto: r, teleop: r, end: r });
const tele = (r: Role | null, end: Role | null = r): PhaseRoles => ({ auto: null, teleop: r, end });

// ─────────────────────────────── the library ───────────────────────────────
const FLOWERS = { flower: 5, place: 5, field: -2, lz: -2 };
const GROUND = { field: 2, lz: 2, flower: -6, place: -6 };
export const PLAYS: Play[] = [
  { id: 'free', label: 'Free play', blurb: 'no roles: each robot its own brain, the alliance board keeps them off each other’s elements', roles: [same(null), same(null)] },
  // (FLOWERs hold most of their POLLEN in AUTO, and take NECTAR from the 1:00 cue: the role spans both)
  { id: 'flower-ground', label: 'FLOWERs · ground', blurb: 'from AUTO on, we work the FLOWERs (and place NECTAR on them after the cue); the partner sweeps the ground and the loading zone', roles: [same(role({ kinds: FLOWERS })), same(role({ kinds: GROUND }))] },
  { id: 'ground-flower', label: 'Ground · FLOWERs', blurb: 'from AUTO on, we sweep the ground and the loading zone; the partner works the FLOWERs', roles: [same(role({ kinds: GROUND })), same(role({ kinds: FLOWERS }))] },
  { id: 'top-bottom', label: 'Top · bottom', blurb: 'each robot one side of the HIVE: we collect in the top half (the north cell’s side), the partner in the bottom', roles: [same(role({ y: 'top', hard: true })), same(role({ y: 'bottom', hard: true }))] },
  { id: 'bottom-top', label: 'Bottom · top', blurb: 'each robot one side of the HIVE: we take the bottom half, the partner the top', roles: [same(role({ y: 'bottom', hard: true })), same(role({ y: 'top', hard: true }))] },
  { id: 'both-target', label: 'Both on the target side', blurb: 'both robots work the half of the field the HIVE’s target cell faces, and move with it when a tip flips it', roles: [tele(role({ y: 'target', out: 6 })), tele(role({ y: 'target', out: 6 }))] },
  { id: 'target-away', label: 'Target · other side', blurb: 'we work the target side (short shots, fast tips); the partner clears the other side and brings it over', roles: [tele(role({ y: 'target', out: 6 })), tele(role({ y: 'away', out: 6 }))] },
  { id: 'away-target', label: 'Other side · target', blurb: 'the partner works the target side; we clear the other side', roles: [tele(role({ y: 'away', out: 6 })), tele(role({ y: 'target', out: 6 }))] },
  { id: 'near-far', label: 'Our half · far half', blurb: 'we stay in our half (near our HIVE and loading zone); the partner goes to the far half', roles: [tele(role({ x: 'ours', xLine: 0, hard: true })), tele(role({ x: 'far', xLine: 0, out: 4 }))] },
  { id: 'far-near', label: 'Far half · our half', blurb: 'we raid the far half; the partner keeps our half', roles: [tele(role({ x: 'far', xLine: 0, out: 4 })), tele(role({ x: 'ours', xLine: 0, hard: true }))] },
  { id: 'cycle-support', label: 'Tip cycle · support', blurb: 'we run the tip cycle by the HIVE; the partner feeds it from the field and the loading zone', roles: [tele(role({ kinds: { cycle: 6, field: -1 } })), tele(role({ kinds: { cycle: -8, field: 2, lz: 2 } }))] },
  { id: 'support-cycle', label: 'Support · tip cycle', blurb: 'the partner runs the tip cycle; we feed it', roles: [tele(role({ kinds: { cycle: -8, field: 2, lz: 2 } })), tele(role({ kinds: { cycle: 6, field: -1 } }))] },
  { id: 'lz-field', label: 'Loading zone · field', blurb: 'we take the human player’s NECTAR and the loading zone; the partner the open field', roles: [tele(role({ kinds: { hp: 4, lz: 5, field: -2 } })), tele(role({ kinds: { lz: -6, hp: -6, field: 2, flower: 1 } }))] },
  { id: 'field-lz', label: 'Field · loading zone', blurb: 'the partner handles the human player and the loading zone; we the field', roles: [tele(role({ kinds: { lz: -6, hp: -6, field: 2, flower: 1 } })), tele(role({ kinds: { hp: 4, lz: 5, field: -2 } }))] },
  { id: 'volley', label: 'Joint volleys', blurb: 'both collect freely but fire together: whoever is loaded waits (up to 4 s) for the other, so the cell fills at once', roles: [tele(role({ hold: true })), tele(role({ hold: true }))] },
  { id: 'target-volley', label: 'Target side, joint volleys', blurb: 'both on the target side, firing together', roles: [tele(role({ y: 'target', out: 6, hold: true })), tele(role({ y: 'target', out: 6, hold: true }))] },
  { id: 'diagonal', label: 'Diagonal split', blurb: 'we take the top of our half and the bottom of the far half… as a diagonal: top-ours / bottom-far', roles: [tele(role({ y: 'top', x: 'ours', out: 5 })), tele(role({ y: 'bottom', x: 'far', out: 5 }))] },
  { id: 'we-park-early', label: 'Partner scores to the end', blurb: 'free play; we park 20 s early (a sure PARK), the partner scores until the last moment', roles: [tele(null, role({ parkLead: 20 })), tele(null, role({ parkLead: -1 }))] },
  { id: 'partner-parks-early', label: 'We score to the end', blurb: 'free play; the partner parks 20 s early, we score until the last moment', roles: [tele(null, role({ parkLead: -1 })), tele(null, role({ parkLead: 20 }))] },
  { id: 'flower-rush', label: 'FLOWER rush, then split', blurb: 'AUTO: both go for FLOWERs; TELEOP: top · bottom halves', roles: [{ auto: role({ kinds: { flower: 6 } }), teleop: role({ y: 'top', hard: true }), end: role({ y: 'top' }) }, { auto: role({ kinds: { flower: 6 } }), teleop: role({ y: 'bottom', hard: true }), end: role({ y: 'bottom' }) }] },
  { id: 'endgame-flowers', label: 'Endgame FLOWERs', blurb: 'free play, then the last 30 s: we place NECTAR on FLOWERs while the partner finishes the HIVE', roles: [tele(null, role({ kinds: { place: 8, flower: 3 } })), tele(null, role({ kinds: { place: -8, shoot: 2, cycle: 2 } }))] },
];
/** the solo plays: a style for our robot alone (the partner's roles unused) */
export const SOLO_PLAYS = ['free', 'flower-ground', 'ground-flower', 'top-bottom', 'bottom-top', 'both-target', 'away-target', 'near-far', 'far-near', 'cycle-support', 'lz-field', 'field-lz', 'we-park-early', 'endgame-flowers'];
export const playById = (id: string): Play | null => PLAYS.find((p) => p.id === id) ?? null;

// ─────────────────────────────── applying a role ───────────────────────────────
export function phaseOf(w: World): PlayPhase {
  if (w.match.phase === 'auto') return 'auto';
  return w.match.phase === 'teleop' && w.match.phaseTimeLeft <= END_S ? 'end' : 'teleop';
}
/** the role robot `i` (0 = ours, 1 = partner) plays now */
export function roleNow(p: Play | null, i: number, w: World): Role | null {
  if (!p || i > 1) return null;
  return p.roles[i][phaseOf(w)];
}
/** is this option inside the role's zone (always true for jobs that are not collecting) */
export function inZone(r: Role, o: Option, w: World): boolean {
  if (!COLLECT.has(o.kind)) return true;
  if (r.y) {
    const top = o.y >= r.yLine;
    const want = r.y === 'top' ? true : r.y === 'bottom' ? false : (targetCell(w, 'blue') === 'north') === (r.y === 'target');
    if (top !== want) return false;
  }
  if (r.x && (o.x > r.xLine) !== (r.x === 'ours')) return false;
  return true;
}
/** the role's preference for an option, in seconds */
export function roleBias(r: Role, o: Option, w: World): number {
  let b = r.kinds[o.kind] ?? 0;
  if (!r.hard && r.out && !inZone(r, o, w)) b -= r.out;
  if (o.kind === 'park' && r.parkLead > 0) b += 30; // its park is decided: go
  return b;
}
/** the options a role leaves on the list: collecting outside a hard zone goes, unless nothing inside
 * is left (and the job being done now always stays) */
export function roleFilter(r: Role | null, opts: Option[], w: World, keep: (o: Option) => boolean = () => false): Option[] {
  if (!r || !r.hard) return opts;
  const inside = opts.filter((o) => keep(o) || inZone(r, o, w));
  return inside.some((o) => COLLECT.has(o.kind)) || inside.length === opts.length ? inside : opts;
}

// ─────────────────────────────── in words ───────────────────────────────
const KIND_WORDS: Record<string, string> = { field: 'ground groups', lz: 'the loading zone', flower: 'FLOWERs', shoot: 'shooting', hp: 'the human player', park: 'parking', position: 'waiting in position', cycle: 'the tip cycle', place: 'placing NECTAR' };
export function roleWords(r: Role | null): string {
  if (!r) return 'its own judgement';
  const out: string[] = [];
  const zone = [r.y === 'top' ? `the top half${r.yLine ? ` (y ≥ ${r.yLine})` : ''}` : r.y === 'bottom' ? `the bottom half${r.yLine ? ` (y < ${r.yLine})` : ''}` : r.y === 'target' ? 'the target side' : r.y === 'away' ? 'the side away from the target' : '', r.x === 'ours' ? 'our half' : r.x === 'far' ? 'the far half' : ''].filter(Boolean);
  if (zone.length) out.push(`${r.hard ? 'only' : 'mostly'} in ${zone.join(', ')}`);
  const pro = Object.entries(r.kinds).filter(([, v]) => (v ?? 0) > 0).sort((a, b) => b[1]! - a[1]!);
  const con = Object.entries(r.kinds).filter(([, v]) => (v ?? 0) < 0);
  if (pro.length) out.push(`prefers ${pro.map(([k, v]) => `${KIND_WORDS[k]} (+${v} s)`).join(', ')}`);
  if (con.length) out.push(`avoids ${con.map(([k]) => KIND_WORDS[k]).join(', ')}`);
  if (r.parkLead > 0) out.push(`parks ${r.parkLead} s early`);
  if (r.parkLead < 0) out.push('scores to the last moment');
  if (r.hold) out.push('fires together with the partner');
  return out.join(' · ') || 'its own judgement';
}
export function playWords(p: Play): { us: Record<PlayPhase, string>; partner: Record<PlayPhase, string> } {
  const w = (pr: PhaseRoles): Record<PlayPhase, string> => ({ auto: roleWords(pr.auto), teleop: roleWords(pr.teleop), end: roleWords(pr.end) });
  return { us: w(p.roles[0]), partner: w(p.roles[1]) };
}

// ─────────────────────────────── mutation ───────────────────────────────
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const pick = <T>(rnd: Rng, a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
const KINDS: OptionKind[] = ['field', 'lz', 'flower', 'cycle', 'place', 'shoot', 'hp'];
const PHASES: PlayPhase[] = ['auto', 'teleop', 'end'];

/** one random change to a play (named, so the lineage reads as a story) */
export function mutate(p: Play, rnd: Rng, n: number): Play {
  const q = clone(p);
  const who = rnd() < 0.5 ? 0 : 1;
  const ph = pick(rnd, rnd() < 0.7 ? (['teleop', 'end'] as PlayPhase[]) : PHASES);
  const R = (): Role => (q.roles[who][ph] ??= role());
  const name = who === 0 ? 'our robot' : 'the partner';
  let change = '';
  switch (Math.floor(rnd() * 9)) {
    case 0: {
      const r = R();
      const k = pick(rnd, KINDS);
      const d = pick(rnd, [-4, -2, 2, 4, 6]);
      r.kinds[k] = Math.max(-10, Math.min(10, (r.kinds[k] ?? 0) + d));
      change = `${ph}: ${name} ${d > 0 ? 'prefers' : 'avoids'} ${KIND_WORDS[k]} more (${d > 0 ? '+' : ''}${d} s)`;
      break;
    }
    case 1: {
      const r = R();
      r.y = pick(rnd, ['top', 'bottom', 'target', 'away', null] as ZoneY[]);
      change = `${ph}: ${name} collects ${r.y === 'target' ? 'on the target side' : r.y === 'away' ? 'away from the target' : r.y ? `in the ${r.y} half` : 'at any height'}`;
      break;
    }
    case 2: {
      const r = R();
      r.y ??= pick(rnd, ['top', 'bottom'] as ZoneY[]);
      r.yLine = Math.max(-36, Math.min(36, r.yLine + pick(rnd, [-12, -6, 6, 12])));
      change = `${ph}: ${name}: the top/bottom line moves to y = ${r.yLine}`;
      break;
    }
    case 3: {
      const r = R();
      r.x = pick(rnd, ['ours', 'far', null] as const);
      r.xLine = pick(rnd, [-24, -12, 0, 12, 24]);
      change = `${ph}: ${name} ${r.x ? `works ${r.x === 'ours' ? 'our' : 'the far'} half (x line ${r.xLine})` : 'works either half'}`;
      break;
    }
    case 4: {
      const r = R();
      if (r.hard || r.out >= 8) {
        r.hard = !r.hard;
        change = `${ph}: ${name}: zone ${r.hard ? 'strict' : 'loose'}`;
      } else {
        r.out += 3;
        change = `${ph}: ${name}: leaving the zone costs ${r.out} s`;
      }
      break;
    }
    case 5: {
      const r = (q.roles[who].end ??= role());
      r.parkLead = pick(rnd, [-1, 0, 8, 15, 25]);
      change = `end: ${name} ${r.parkLead > 0 ? `parks ${r.parkLead} s early` : r.parkLead < 0 ? 'scores to the last moment' : 'parks on time'}`;
      break;
    }
    case 6: {
      const r = R();
      r.hold = !r.hold;
      change = `${ph}: ${name} ${r.hold ? 'fires together with the other robot' : 'fires freely'}`;
      break;
    }
    case 7: {
      q.roles = [q.roles[1], q.roles[0]];
      change = 'the robots swap roles';
      break;
    }
    default: {
      const from = pick(rnd, PHASES.filter((x) => x !== ph));
      q.roles[who][ph] = clone(q.roles[who][from]);
      change = `${name} plays its ${from} role in ${ph} too`;
    }
  }
  q.id = `${p.id.split('~')[0]}~${n}`;
  q.label = `${p.label.split(' (')[0]} (mutant ${n})`;
  // a second change in the same generation extends the first one's story
  const again = p.id === q.id;
  q.parent = again ? p.parent : p.label;
  q.change = again ? `${p.change}; ${change}` : change;
  return q;
}
/** a child taking each phase's roles (both robots) from one parent or the other */
export function cross(a: Play, b: Play, rnd: Rng, n: number): Play {
  const q = clone(a);
  const took: string[] = [];
  for (const ph of PHASES)
    if (rnd() < 0.5) {
      q.roles[0][ph] = clone(b.roles[0][ph]);
      q.roles[1][ph] = clone(b.roles[1][ph]);
      took.push(ph);
    }
  q.id = `${a.id.split('~')[0]}x${b.id.split('~')[0]}~${n}`;
  q.label = `${a.label.split(' (')[0]} × ${b.label.split(' (')[0]}`;
  q.parent = `${a.label} × ${b.label}`;
  q.change = took.length ? `${took.join(', ')} from ${b.label.split(' (')[0]}` : 'all from the first';
  return q;
}

/** what a play DOES, whatever its history: settings that change nothing dropped (a line without its
 * zone, a zero preference, a penalty on a hard zone, a role that is all defaults) — two plays with
 * the same key play the same, so the search scores it once */
export function playKey(p: Play): string {
  const canon = (r: Role | null): unknown => {
    if (!r) return null;
    const kinds = Object.fromEntries(Object.entries(r.kinds).filter(([, v]) => v).sort(([a], [b]) => a.localeCompare(b)));
    const c = { kinds, y: r.y, yLine: r.y ? r.yLine : 0, x: r.x, xLine: r.x ? r.xLine : 0, hard: (r.y || r.x) && r.hard ? true : false, out: (r.y || r.x) && !r.hard ? r.out : 0, parkLead: r.parkLead, hold: r.hold };
    return JSON.stringify(c) === JSON.stringify({ kinds: {}, y: null, yLine: 0, x: null, xLine: 0, hard: false, out: 0, parkLead: 0, hold: false }) ? null : c;
  };
  return JSON.stringify(p.roles.map((pr) => [canon(pr.auto), canon(pr.teleop), canon(pr.end)]));
}

// ─────────────────────────────── the play search ───────────────────────────────
export interface PlayScore {
  play: Play;
  mean: number;
  ci95: number;
  cvar10: number;
  n: number;
  vsFree: number; // paired, same draws
  rewards: number[];
}
export interface PlaySearchResult {
  partner: PartnerKind | 'none';
  profile: string;
  time: string;
  seconds: number;
  evaluated: number; // plays scored in the search
  generations: number;
  ranked: PlayScore[]; // finalists on fresh draws, best first
  free: { mean: number; cvar10: number };
}
const stats = (v: number[]): { mean: number; ci95: number; cvar10: number } => {
  const n = v.length;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const s = [...v].sort((a, b) => a - b);
  const k = Math.max(1, Math.floor(n / 10));
  return { mean, ci95: (1.96 * sd) / Math.sqrt(n), cvar10: s.slice(0, k).reduce((a, b) => a + b, 0) / k };
};
export interface PlaySearchCfg {
  draws: number; // luck draws every play is scored on (shared)
  gens: number; // generations of mutants
  pop: number; // mutants per generation
  keep: number; // parents kept
  finalists: number;
  finalDraws: number; // fresh draws for the finalists
}
export const PLAY_SEARCH: PlaySearchCfg = { draws: 16, gens: 5, pop: 12, keep: 5, finalists: 6, finalDraws: 32 };
export const PLAY_QUICK: PlaySearchCfg = { draws: 4, gens: 1, pop: 4, keep: 3, finalists: 3, finalDraws: 4 };

/** score plays beside a partner kind (full matches, shared luck), mutate the best, re-score finalists */
export async function searchPlays(
  o: { profile: string; partner: PartnerKind | 'none'; genome: string | null; seed: number },
  pool: WorkerPool,
  cfg: PlaySearchCfg = PLAY_SEARCH,
  log: (s: string) => void = () => {},
  stop: () => boolean = () => false,
  progress: (p: { stage: string; done: number; total: number }) => void = () => {},
): Promise<PlaySearchResult> {
  const t0 = Date.now();
  const solo = o.partner === 'none';
  // live progress: matches played out of the matches the search will play (an upper bound: mutants
  // that play like an earlier play are skipped, and then the total shrinks)
  let done = 0;
  let total = 0;
  let stage = 'starting';
  const tell = (st: string): void => {
    stage = st;
    progress({ stage, done, total });
  };
  const base = (seed: number, play: Play): EpisodeArgs => ({
    genome: o.genome, profile: o.profile, sampleProfile: true, seed, stage: 'full', driver: 'oracle', track: false, record: false,
    ...(solo ? {} : { partner: { kind: o.partner as PartnerKind, genome: o.partner === 'real' ? o.genome : null } }),
    play,
  });
  const job = (a: EpisodeArgs): Job => ({ module: '../train/episode.ts', fn: 'runEpisode', args: a });
  const score = async (plays: Play[], seeds: number[]): Promise<number[][]> => {
    const res = await pool.map<{ reward: number }>(
      plays.flatMap((p) => seeds.map((s) => job(base(s, p)))),
      () => {
        done++;
        progress({ stage, done, total });
      },
    );
    return plays.map((_, i) => res.slice(i * seeds.length, (i + 1) * seeds.length).map((r) => r.reward));
  };
  const seeds = Array.from({ length: cfg.draws }, (_, k) => seedOf(o.seed, 'plays', o.partner, k) % 1_000_000_007);
  const lib = solo ? PLAYS.filter((p) => SOLO_PLAYS.includes(p.id)) : PLAYS;
  total = lib.length * cfg.draws + cfg.gens * cfg.pop * cfg.draws + (cfg.finalists + 1) * cfg.finalDraws;
  const rnd = mulberry32(seedOf(o.seed, 'mutate', o.partner));
  let evaluated = 0;
  const all = new Map<string, { play: Play; r: number[] }>();
  // alone, only our robot's roles matter
  const keyOf = (p: Play): string => (solo ? JSON.stringify((JSON.parse(playKey(p)) as unknown[])[0]) : playKey(p));
  const add = async (plays: Play[]): Promise<void> => {
    const seen = new Set<string>();
    const fresh = plays.filter((p) => {
      const k = keyOf(p);
      if (all.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    total -= (plays.length - fresh.length) * seeds.length; // the same play is scored once
    if (!fresh.length) return progress({ stage, done, total });
    const r = await score(fresh, seeds);
    fresh.forEach((p, i) => all.set(keyOf(p), { play: p, r: r[i] }));
    evaluated += fresh.length;
  };
  log(`${lib.length} plays beside ${o.partner === 'none' ? 'no partner' : o.partner}, ${cfg.draws} shared luck draws each`);
  tell(`the library: ${lib.length} plays × ${cfg.draws} matches on shared luck`);
  await add(lib);
  const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;
  const top = (): { play: Play; r: number[] }[] => [...all.values()].sort((a, b) => mean(b.r) - mean(a.r));
  let n = 0;
  for (let g = 0; g < cfg.gens && !stop(); g++) {
    const parents = top().slice(0, cfg.keep).map((x) => x.play);
    tell(`generation ${g + 1} of ${cfg.gens}: ${cfg.pop} mutants and crossbreeds of the best ${parents.length}`);
    const kids: Play[] = [];
    for (let k = 0; k < cfg.pop; k++) {
      n++;
      kids.push(rnd() < 0.3 && parents.length > 1 ? cross(pick(rnd, parents), pick(rnd, parents), rnd, n) : mutate(pick(rnd, parents), rnd, n));
      if (rnd() < 0.35) kids[kids.length - 1] = mutate(kids[kids.length - 1], rnd, n); // sometimes two changes
    }
    await add(kids);
    const best = top()[0];
    log(`generation ${g + 1}: best ${best.play.label} ${mean(best.r).toFixed(1)} (${all.size} plays scored)`);
  }
  // finalists (and free play) on fresh draws: the numbers shown are not the search's own luck
  const free = PLAYS[0];
  const fin = [...top().slice(0, cfg.finalists).map((x) => x.play)];
  if (!fin.some((p) => p.id === 'free')) fin.push(free);
  const fresh = Array.from({ length: cfg.finalDraws }, (_, k) => seedOf(o.seed, 'plays-final', o.partner, k) % 1_000_000_007);
  total = done + fin.length * fresh.length;
  tell(`finalists: the best ${fin.length - 1} and free play on ${fresh.length} fresh luck draws`);
  const fr = await score(fin, fresh);
  const fi = fin.findIndex((p) => p.id === 'free');
  const ranked: PlayScore[] = fin
    .map((play, i) => ({ play, ...stats(fr[i]), n: fr[i].length, vsFree: mean(fr[i].map((x, k) => x - fr[fi][k])), rewards: fr[i] }))
    .sort((a, b) => b.mean - a.mean);
  const fs = stats(fr[fi]);
  return { partner: o.partner, profile: o.profile, time: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, evaluated, generations: cfg.gens, ranked, free: { mean: fs.mean, cvar10: fs.cvar10 } };
}
