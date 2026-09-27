// ONE EPISODE = one robot's life: a solo BIOBUZZ match (or just its AUTO) in unmodified DSIM, with
// the REAL profile's limits (layer B), misses (layer C) and the rule guards all on. The robot plays
// with its skills (train/skills.ts); the network picks WHAT TO DO NEXT (train/policy.ts).
// A robot can still DIE early — a crash into the HIVE frame (G417) or 20 s without progress.
//
// THE REWARD is one number, the same everywhere: DSIM's own score for the match, minus the foul
// points a referee would give for the rules DSIM does not enforce (harness/guards.ts), counted as
// if deliberate: G417 / G407 / G409 / G426 a MAJOR FOUL (15), G427 C a MINOR FOUL (5), and 5 per
// physics exploit (an element struck faster than any robot moves). Nothing else — no hints.
//
// The episode is an object whose whole state can be FORKED (train/fork.ts). That is what lets the
// robot learn from every decision: at a decision it copies the match, plays every option out for a
// few seconds on the copies (all with the same fresh luck, never the real match's future), and the
// points each option really made become the lesson (`lessons`). The same machinery thinks ahead
// during a match (`search`). A worker job: plain JSON in and out.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { C, DT, Match, bb, coerce, recordScore, verifyReplay, worldResult, type RobotCommand, type RobotSpec, type Seat, type World } from '../harness/dsim';
import { loadProfile, resolve, type Resolved } from '../harness/profiles';
import { MatchFilter, HUMAN, ORACLE, RULES_CONSERVATIVE } from '../harness/filters';
import { Perturber } from '../harness/perturb';
import { Guards } from '../harness/guards';
import { mulberry32, seedOf, type Stream } from '../harness/rng';
import { Mlp, fromB64 } from './net';
import { Brain, decodeGenome, optKey, type Decision, type DecisionPoint } from './policy';
import { pack, type Packed, type Sample } from './bc';
import { OPTION_KINDS } from './skills';
import { N_OBS, encode } from './obs';
import { deepClone, share } from './fork';
import { VALUE_SHAPE, VALUE_SCALE } from './value';
import { Tally, type Activity, type Loads, type Parts } from './gap';
import { AllianceBoard, OPPONENTS, OPP_FIRST_START, PARTNERS, defaultPartnerStart, legalPair, partnerProfile, seatStart, type OpponentKind, type PartnerKind, type StartId } from './team';
import type { OptionKind } from './skills';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export type Stage = 'auto' | 'full';
export type Death = 'survived' | 'crash' | 'stall';
/** no progress for this long is a STALL: counted as a mistake (the audit's), not the end of the
 * match — v1 ended the match there, which threw away the end-game (PARK, FLOWERs) of a robot that
 * was busy but unlucky, and taught nothing the lost time does not already cost. ('stall' deaths
 * exist only in runs made before.) */
export const STALL_S = 20;
export const TRACK_STRIDE = 3; // ticks between swarm samples (20 per second)
export const FRAME_STRIDE = 2; // ticks between exact frames (30 per second)
/** a swarm sample: x, y, heading, turret 1, turret 2, hopper count, option kind (-1 = none) */
export const TRACK_FIELDS = 7;

/** foul points for the rules DSIM does not enforce (manual: G417/G407 MAJOR FOUL if strategic; a
 * learning robot repeating one is strategic by definition — G409/G426 are scored the same, G427 C
 * is a MINOR FOUL per NECTAR) and for exploiting a physics oddity */
export const FOUL = { major: 15, minor: 5, exploit: 5 } as const;
const MINOR_RULES = new Set(['G427C-drop-zone-occupied']);

export interface EpisodeArgs {
  genome: string | null; // base64 Float32 parameters; null = the greedy baseline
  profile: string; // profile file under the project root, or 'replay:<file in Training data/>' (that replay's build, ideal limits, no misses)
  sampleProfile: boolean; // domain randomization across the profile's envelope
  seed: number; // match seed (DSIM spills/HP jitter) and our layer B/C streams
  stage: Stage;
  driver: 'human' | 'oracle';
  track: boolean; // return a downsampled path + decisions for the swarm view
  frames?: boolean; // return exact frames for the focus view
  record: boolean; // return a DSIM replay (champion showcase / DSIM snippet)
  samples?: boolean; // return every decision (observation, options, choice) — the robot's own experience
  value?: string | null; // the rest-of-match predictor (train/value.ts), for lessons and search
  lessons?: LessonSpec; // learn from decisions: what-if every option
  search?: SearchSpec; // think ahead during the match: what-if the best few options, take the best
  search2?: Search2Spec; // think ahead v2: sequential halving over every option (phase 3)
  keepSearched?: boolean; // return every searched decision (the learner's labels)
  searchWindow?: [number, number]; // search only decisions on ticks in [from, to) (the continuous engine's actors: sim spent where it teaches)
  handover?: { tick: number; genome: string | null }; // on this tick our robot's network becomes this one (a drill: a state reached by one network, played on by another)
  returns?: number; // every this many ticks, record (observation, points still to come) for the predictor
  inspect?: boolean; // keep every what-if result per decision (the studio's decision inspector)
  verify?: boolean; // with record: re-simulate the replay in DSIM and compare (verified)
  start?: StartId; // where our robot starts (default: F3, the team's start)
  partner?: PartnerArgs; // an alliance partner (default: none — the solo game)
  opponents?: OpponentKind; // a red alliance (phase 5; default: none)
  opponentGenome?: string | null; // the red copies of our robot play this network ('mirror': self-play); default: the no-learning order
  routes?: boolean; // record our robot's scoring cycles (the route library, train/routes.ts)
  audit?: boolean; // record every mistake with its moment (the mistake audit, MASTERPLAN §7)
  forces?: [number, string][]; // (tick, option key): choices made for our robot on the way (a Store state's recipe: a search's changes)
}
/** THE MISTAKE AUDIT (phase 6): what went wrong in a match, when and where, and what it cost */
export type MistakeKind = 'empty-trip' | 'blocked-shot' | 'idle' | 'foul' | 'stall' | 'crash' | 'judgement';
export interface AuditItem {
  tick: number;
  kind: MistakeKind;
  cost: number; // seconds (trips, shots, idle, stall), foul points, or points (judgement)
  detail: string;
  x: number;
  y: number;
}
/** standing still this long, holding no job that waits (parking), is a mistake */
export const IDLE_S = 3;
/** a search that beats the network's choice by more than this many points marks a judgement mistake */
export const JUDGE_PTS = 5;
interface AuditRec {
  items: AuditItem[];
  still: number; // tick a still spell began (-1: moving)
  stillJob: string; // …and the job it was doing then
  lastAct: number; // tick of our last pickup or shot
  rules: Record<string, number>; // our alliance's violations so far, by rule
}
/** one scoring CYCLE of our robot — volley to volley, from its actual pickups and shots (it fires on
 * the move, so jobs do not mark them): it starts when the previous volley ended (the first one when
 * AUTO or TELEOP starts) and ends when its hopper is empty again after shooting. Where it picked up,
 * doing what; where its first shot left from; how many of its shots went in; the alliance's points
 * in that stretch (measured LAND_TICKS after each last shot, so consecutive cycles tile the match).
 * The route library's raw material (train/routes.ts) */
export interface Cycle {
  t0: number; // tick it started (the previous volley's end)
  t1: number; // tick of its last shot
  collect: { kind: OptionKind; x: number; y: number; label: string }[]; // one per pickup: the job it was doing, where
  shoot: { x: number; y: number };
  points: number; // the alliance's reward gained in the stretch
  mine: number; // its shots that went into the HIVE
}
const LAND_TICKS = 90; // a shot has landed by then
const AUTO_TICK = Math.round(C.PRE_COUNTDOWN / DT);
const TELEOP_TICK = Math.round((C.PRE_COUNTDOWN + C.AUTO_DURATION + C.TRANSITION_DURATION) / DT);
interface RouteRec {
  out: Cycle[];
  cur: Cycle | null;
  shooting: boolean;
  from: number; // where the next cycle starts: the last volley's end (the first: when AUTO starts)
  mark: number; // the reward when the last cycle was measured
  pending: Cycle[]; // closed, measured at t1 + LAND_TICKS
}
export interface PartnerArgs {
  kind: PartnerKind;
  genome?: string | null; // its network (default: the no-learning order)
  start?: StartId; // default: the first legal anchor beside ours
}
export interface LessonSpec {
  thinkRate: number; // share of think decisions that become lessons (every job start does)
  horizon: number; // ticks each option is played out before the predictor takes over
  rounds: number; // luck draws: round 1 plays every option, each next round the better half
}
export interface SearchSpec {
  k: number; // options tried (the network's best k)
  horizon: number; // ticks
  rounds: number; // luck draws per option
  thinkEvery: number; // search a think decision at most this often (ticks); every job start is searched
  margin: number; // switch away from the network's choice only for more than this many points
}
/** THINKING AHEAD v2 (MASTERPLAN §6, phase 3): SEQUENTIAL HALVING over EVERY option at a job start.
 * Round r plays each surviving option `draws` times `horizon` ticks ahead, all on the same fresh luck
 * draws (common random numbers — the comparison measures the options, not the dice); the better
 * half go on to the next, longer, better-sampled round. The network's own choice is always kept to
 * the end, and it is overruled only by an option that beats it by more than `margin` points AND by
 * `z` standard errors of their paired difference. A one-step deviation, like v1's: the robot keeps
 * thinking afterwards exactly as the look-ahead assumed. */
export interface Search2Spec {
  rounds: { draws: number; horizon: number }[];
  margin: number;
  z: number;
  thinkEvery?: number; // also search a quarter-second re-think at most this often (ticks); default: job starts only
}
/** Measured (phase 3 exam: REAL-v1, the no-learning order as the network, no predictor, 24 paired
 * exam matches): 259.1 ± 25.6 vs v1's look-ahead 231.3 ± 21.2 (+27.8 ± 12.7) and no search 221.2
 * (+37.9 ± 12.6); it changes 18% of job starts; ~7 s of simulation per decision (v1: ~0.5 s). Stopping
 * after the second round agrees with the full search only 72% of the time: the long round matters */
export const SEARCH2: Search2Spec = { rounds: [{ draws: 2, horizon: 600 }, { draws: 4, horizon: 1200 }, { draws: 8, horizon: 1800 }], margin: 2, z: 1 };
/** one searched decision, as the learner will take it (phase 4): each option's value at the deepest
 * round it reached, its standard error, and how many play-outs stand behind it */
export interface Searched {
  tick: number;
  at: 'think' | 'begin';
  chosen: number; // what the robot did
  net: number; // what its network alone would have done
  q: (number | null)[];
  se: (number | null)[];
  n: number[];
  depth: number[]; // the round each option reached (0-based)
  rq: (number | null)[][]; // per round: each option's mean on that round's shared draws (null: out by then) — the learner centres within a round
  sofar?: number; // the reward when it was decided (with the match's final reward: the points still to come)
  x?: LabelInput; // with keepSearched: what the networks saw
  change?: { key: string; from: string; to: string }; // the search overruled the network: the option it took (key), the network's and its labels
}
/** a label's inputs, base64 Float32: the v1 observation, the entity rows (n × N_ENT), the options'
 * entity-network rows (k × N_OPT_IN) and their v1 features (k × N_OPT_FEATS) */
export interface LabelInput {
  g: string;
  e: string;
  n: number;
  o: string;
  f: string;
}

export type { Parts, Activity, Loads } from './gap';
/** what went wrong, and roughly what it cost (seconds are priced at the robot's own points per second) */
export interface Mistakes {
  missedShots: number;
  emptyTrips: number; // collecting jobs that got nothing
  emptyTripS: number;
  blockedShots: number; // shoot jobs that could not fire
  blockedShotS: number;
  idleS: number; // stopped, doing nothing, during AUTO/TELEOP
  fouls: number; // foul points (DSIM's + the guards')
  regret: number; // what-if lessons: points the chosen option lost against the best one, summed
  regretN: number; // …over this many lesson decisions
  stalls: number; // spells of STALL_S without progress
}
export interface Inspected {
  t: number;
  at: 'think' | 'begin';
  chosen: number; // what the robot did
  net: number; // what its network alone would have done
  gain: number | null; // thinking ahead: what-if points of the chosen option over the network's (unrounded)
  current: number;
  opts: { kind: number; label: string; x: number; y: number; s: number; q: number | null }[];
}

export interface EpisodeResult {
  reward: number; // DSIM score − fouls DSIM does not call (FOUL)
  score: number;
  parts: Parts;
  ticks: number;
  death: Death;
  deathTick: number;
  point: Record<string, number>;
  mistakes: Mistakes;
  activity: Activity;
  loads: Loads;
  verified?: { exact: boolean; ok: boolean; detail: string }; // DSIM re-simulated the recorded replay (exact only without misses)
  track?: string; // base64 Float32 TRACK_FIELDS per sample, every TRACK_STRIDE ticks from tick 0
  events?: [number, string][]; // [tick, kind]
  decisions?: [number, number, number, number, number][]; // [tick, kind index, x, y, 1 = done / 0 = failed / 2 = switched to something better]
  frames?: Frames;
  replay?: unknown;
  replayExact?: boolean;
  samples?: Packed;
  lessons?: Packed; // decisions with every option's what-if value (q)
  values?: { n: number; obs: string; y: number[] }; // (observation, points to come) pairs
  inspect?: Inspected[];
  searched?: { n: number; changed: number }; // decisions searched, and how many the search changed
  labels?: Searched[]; // with keepSearched: every searched decision, with its inputs
  partner?: { kind: PartnerKind; start: StartId; parts: Parts }; // the partner's own play (the score is the alliance's)
  start?: StartId;
  opponents?: { kind: OpponentKind; score: number }; // the red alliance and its DSIM score
  cycles?: Cycle[]; // with routes
  audit?: AuditItem[]; // with audit: its mistakes, in time order
}

/** exact frames — what DSIM's renderers need to redraw this life exactly as it was trained */
export interface Frames {
  stride: number;
  spec: unknown;
  spec2?: unknown; // the partner's build (frames with a partner)
  oppSpecs?: unknown[]; // the red robots' builds (frames with opponents)
  alliance: string;
  meta: [number, string, number | null][]; // ball id, colour, radius (world.balls order)
  f: Frame[];
}
export interface Frame {
  t: number;
  r: number[]; // x, y, heading, turret, turret2, pitch, pitch2, intake
  h: string; // hopper, one letter per element (y/r/b)
  b: number[]; // x, y, z per ball (0.01 in)
  s?: [number, unknown][]; // ball index → new state
  g?: unknown; // world.biobuzz when it changed
  m: [string, number, number, number]; // phase, phase time left, own total, fouls against
  o?: [number, string, number, number]; // current option: kind index, label, target x, y
  p?: number[]; // the partner: x, y, heading, turret, turret2, pitch, pitch2, intake
  ph?: string; // the partner's hopper
  opp?: number[][]; // each red robot: x, y, heading, turret, turret2, pitch, pitch2
  oh?: string[]; // …its hopper
}

const kindIdx = (k: string | undefined): number => (k ? OPTION_KINDS.indexOf(k as (typeof OPTION_KINDS)[number]) : -1);
const b64 = (a: Float32Array): string => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

/** the robot for a job: a profile file (sampled or nominal), or a replay's own build with ideal
 * limits and no misses (the build check: our brain on the team's robot) */
export function robotFor(profile: string, sample: boolean, seed: number): Resolved {
  if (profile.startsWith('replay:')) {
    const f = profile.slice(7);
    if (!/^[A-Za-z0-9_.-]+\.json$/.test(f)) throw new Error('bad replay name');
    const rep = JSON.parse(readFileSync(join(root, 'Training data', f), 'utf8')) as { setups: { spec: Parameters<typeof coerce>[0] }[] };
    const ideal = resolve(loadProfile(join(root, 'profiles/dream.json')));
    return { ...ideal, id: `replay-build:${f}`, spec: coerce(rep.setups[0].spec) };
  }
  const prof = resolve(loadProfile(join(root, profile)), sample ? mulberry32(seedOf(seed, 'profile')) : undefined);
  if (prof.expectFails.length || prof.clamped.length) throw new Error(`profile: ${[...prof.expectFails, ...prof.clamped].join('; ')}`);
  return prof;
}

/** what a match being played remembers beyond the state (detached from forks) */
interface Outputs {
  path: number[] | null;
  events: [number, string][] | null;
  decisions: Decision[];
  frames: Frames | null;
  lastState: string[];
  lastBb: string;
  samples: Sample[] | null;
  lessons: Sample[] | null;
  values: { obs: number[]; at: number[]; score: number[] } | null;
  inspect: Inspected[] | null;
  route: RouteRec | null; // routes: our robot's cycles
  audit: AuditRec | null; // audit: our robot's mistakes
}

export class Episode {
  readonly prof: Resolved;
  readonly m: Match;
  readonly brain: Brain;
  /** every seat's brain: ours first (the one that learns), then the partner's */
  readonly brains: Brain[];
  readonly partnerProf: Resolved | null = null;
  readonly start: StartId;
  readonly partnerStart: StartId | null = null;
  private partnerTally: Tally | null = null;
  private filter: MatchFilter;
  private perturb: Perturber;
  private guards = new Guards(RULES_CONSERVATIVE);
  private tally = new Tally();
  private fouls = 0; // foul points from the guards (DSIM's own are in its score)
  private lastProgress = 0;
  private prevScore = 0;
  death: Death = 'survived';
  deathTick = 0;
  private prevViol = 0;
  regret = 0;
  regretN = 0;
  private stalls = 0;
  private out: Outputs | null;

  constructor(readonly a: EpisodeArgs) {
    this.prof = robotFor(a.profile, a.sampleProfile, a.seed);
    share(this.prof);
    const o: Outputs = {
      path: a.track ? [] : null,
      events: a.track || a.frames ? [] : null,
      decisions: [],
      frames: a.frames ? { stride: FRAME_STRIDE, spec: null, alliance: 'blue', meta: [], f: [] } : null,
      lastState: [],
      lastBb: '',
      samples: a.samples ? [] : null,
      lessons: a.lessons ? [] : null,
      values: a.returns ? { obs: [], at: [], score: [] } : null,
      inspect: a.inspect ? [] : null,
      route: a.routes ? { out: [], cur: null, shooting: false, from: AUTO_TICK, mark: 0, pending: [] } : null,
      audit: a.audit ? { items: [], still: -1, stillJob: '', lastAct: 0, rules: {} } : null,
    };
    this.out = o;
    this.start = a.start ?? 'F3';
    const duo = !!a.partner && a.partner.kind !== 'none';
    const board = duo ? new AllianceBoard() : null;
    this.brain = new Brain(decodeGenome(a.genome), this.prof, 0, o.decisions, o.samples ?? undefined, { board, parkSlot: duo ? 1 : 0 });
    this.brain.wantObs = !!(a.lessons || a.search || a.search2 || a.returns);
    this.brain.wantEnts = !!a.keepSearched;
    this.brains = [this.brain];
    const seats: Seat[] = [{ id: 0, alliance: 'blue', spec: this.prof.spec, ...seatStart(this.prof.spec, this.start) }];
    const limits = new Map([[0, this.prof.limits]]);
    const perRobot = new Map([[0, this.prof.perturb]]);
    if (duo) {
      const P = a.partner!;
      if (a.profile.startsWith('replay:')) throw new Error('a partner plays beside a profile robot, not a replay build');
      const pp = partnerProfile(P.kind, join(root, a.profile), a.seed, a.sampleProfile);
      share(pp);
      const ps = P.start ?? defaultPartnerStart(this.prof.spec, this.start, pp.spec);
      if (!legalPair(this.prof.spec, this.start, pp.spec, ps)) throw new Error(`our robot at ${this.start} and a ${P.kind} partner at ${ps} cannot start together`);
      seats.push({ id: 1, alliance: 'blue', spec: pp.spec, ...seatStart(pp.spec, ps) });
      this.brains.push(new Brain(decodeGenome(P.genome), pp, 1, undefined, undefined, { mode: PARTNERS[P.kind].mode, board, parkSlot: 2 }));
      limits.set(1, pp.limits);
      perRobot.set(1, pp.perturb);
      this.partnerProf = pp;
      this.partnerStart = ps;
      this.partnerTally = new Tally();
    }
    const opp = a.opponents && a.opponents !== 'none' ? OPPONENTS[a.opponents] : null;
    if (opp) {
      if (a.profile.startsWith('replay:')) throw new Error('opponents play against a profile robot, not a replay build');
      const redBoard = new AllianceBoard();
      let first: { spec: RobotSpec; start: StartId } | null = null;
      opp.robots.forEach((o, i) => {
        const id = 2 + i;
        const pp = partnerProfile(o.build, join(root, a.profile), seedOf(a.seed, 'opponent', i), a.sampleProfile);
        share(pp);
        const start: StartId = first ? defaultPartnerStart(first.spec, first.start, pp.spec) : OPP_FIRST_START;
        seats.push({ id, alliance: 'red', spec: pp.spec, ...seatStart(pp.spec, start) });
        this.brains.push(new Brain(o.build === 'real' ? decodeGenome(a.opponentGenome) : null, pp, id, undefined, undefined, { mode: o.mode, board: redBoard, parkSlot: i + 1 }));
        limits.set(id, pp.limits);
        perRobot.set(id, pp.perturb);
        first ??= { spec: pp.spec, start };
      });
    }
    this.m = new Match(a.seed, seats, { record: a.record });
    this.filter = new MatchFilter(a.seed, limits, a.driver === 'human' ? HUMAN : ORACLE, RULES_CONSERVATIVE);
    this.perturb = new Perturber(a.seed, { blue: this.prof.perturb }, undefined, perRobot);
  }

  /** every seat's command this tick (ours first: it posts its job on the board before the partner looks) */
  private act(w: World): Map<number, RobotCommand> {
    if (this.brains.length === 1) return this.brain.act(w);
    const out = new Map<number, RobotCommand>();
    for (const b of this.brains) for (const [k, v] of b.act(w)) out.set(k, v);
    return out;
  }

  get w(): World {
    return this.m.w;
  }
  get parts(): Parts {
    return this.tally.parts;
  }
  get done(): boolean {
    return this.m.done;
  }
  /** the reward so far: DSIM's score (the solo record score) minus the guards' foul points */
  reward(): number {
    const w = this.w;
    const s = this.a.stage === 'auto' ? Math.max(0, w.match.scores.blue.total - w.match.scores.red.foulPoints) : recordScore(w, 'blue');
    return s - this.fouls;
  }

  /** a copy of the match as it is now, without any of the outputs (a what-if branch) */
  fork(): Episode {
    const keep = this.out;
    const rec = this.m.rec;
    const log = this.brain.log;
    const samples = this.brain.samples;
    this.out = null;
    this.m.rec = null;
    this.brain.log = undefined;
    this.brain.samples = undefined;
    try {
      return deepClone(this);
    } finally {
      this.out = keep;
      this.m.rec = rec;
      this.brain.log = log;
      this.brain.samples = samples;
    }
  }
  /** fresh luck from here on — DSIM's own draws, intake failures and misses — never the real future */
  reseed(seed: number): void {
    this.w.rngState = seedOf(seed, 'dsim') >>> 0 || 1;
    this.filter.reseed(seed);
    this.perturb.reseed(seed);
  }

  /** one tick; false once the life is over. The hooks are made per call, never stored: a stored
   * closure would tie a fork to the match it was copied from */
  step(): boolean {
    return this.m.step((w) => this.act(w), {
      filter: (w, i) => this.filter.apply(w, i),
      perturb: (w) => this.perturb.apply(w),
      after: (w, applied) => {
        this.guards.observe(w, applied);
        this.after(w, applied.get(0)?.intake ?? false);
      },
      // AUTO-only: stop the moment AUTO ends (LEAVE / PARK are latched at that instant)
      stop: (w) => this.death !== 'survived' || (this.a.stage === 'auto' && w.match.phase !== 'pre' && w.match.phase !== 'auto'),
    });
  }

  private ev(t: number, k: string): void {
    const e = this.out?.events;
    if (e && e.length < 2000) e.push([t, k]);
  }

  private after(w: World, intake: boolean): void {
    const t = w.tick;
    const r = w.robots.find((q) => q.id === 0)!;
    const o = this.out;
    if (this.partnerTally) this.partnerTally.observe(w, w.robots.find((q) => q.id === 1)!);
    if (o?.path && t % TRACK_STRIDE === 0) o.path.push(r.pos.x, r.pos.y, r.heading, r.turretHeading ?? r.heading, r.bbTurret2Heading ?? r.heading + Math.PI, r.hopper.length, kindIdx(this.brain.current()?.kind));
    if (o?.frames && t % FRAME_STRIDE === 0) this.frame(w, intake);
    if (o?.values && t % this.a.returns! === 0 && (w.match.phase === 'auto' || w.match.phase === 'teleop')) {
      const obs = new Float32Array(N_OBS);
      encode(w, r, this.prof, obs);
      o.values.obs.push(...obs);
      o.values.at.push(t);
      o.values.score.push(this.reward());
    }
    const parts = this.parts;
    const seen = this.tally.observe(w, r);
    for (const k of seen.ev) this.ev(t, k);
    if (o?.route) this.route(o.route, t, r, seen.ev);
    let progress = seen.progress;
    const sc = w.match.scores[r.alliance].total;
    if (sc !== this.prevScore) {
      progress = true;
      this.prevScore = sc;
    }
    const ph = w.match.phase;
    if (progress || (ph !== 'auto' && ph !== 'teleop')) this.lastProgress = t;
    const rep = this.guards.report();
    let viol = 0;
    let fouls = 0;
    // our alliance's violations only (a red robot's fouls are the other alliance's)
    for (const [k, v] of Object.entries(rep.byAlliance.blue ?? {})) {
      if (k === 'DSIM-foul' || !v) continue;
      viol += v;
      fouls += v * (MINOR_RULES.has(k) ? FOUL.minor : FOUL.major);
    }
    if (viol > this.prevViol) {
      this.ev(t, 'violation');
      this.prevViol = viol;
      if (o?.audit)
        for (const [k, v] of Object.entries(rep.byAlliance.blue ?? {})) {
          if (k === 'DSIM-foul' || !v || v <= (o.audit.rules[k] ?? 0)) continue;
          o.audit.items.push({ tick: t, kind: 'foul', cost: (v - (o.audit.rules[k] ?? 0)) * (MINOR_RULES.has(k) ? FOUL.minor : FOUL.major), detail: k, x: Math.round(r.pos.x), y: Math.round(r.pos.y) });
          o.audit.rules[k] = v;
        }
    }
    parts.violations = viol;
    parts.strikes = rep.anomalies['fast-ground-element'] ?? 0;
    // a strike is fined only when the struck element scored for us (harness/guards.ts STRIKE_PROFIT_S)
    parts.strikesScored = rep.strikeProfit.blue ?? 0;
    this.fouls = fouls + FOUL.exploit * parts.strikesScored;
    // only OUR robot touching the HIVE frame ends its life (a partner's crash is its own foul)
    if ((rep.byRobot[0]?.['G417-hive-frame-contact'] ?? 0) > 0) {
      this.death = 'crash';
      this.deathTick = t;
      o?.audit?.items.push({ tick: t, kind: 'crash', cost: 0, detail: 'touched the HIVE frame (G417): its match ended there', x: Math.round(r.pos.x), y: Math.round(r.pos.y) });
    } else if ((t - this.lastProgress) * DT > STALL_S) {
      this.stalls++;
      this.lastProgress = t;
      this.ev(t, 'stall');
      o?.audit?.items.push({ tick: t, kind: 'stall', cost: STALL_S, detail: `no progress for ${STALL_S} s${this.brain.current() ? ` (${this.brain.current()!.label})` : ''}`, x: Math.round(r.pos.x), y: Math.round(r.pos.y) });
    }
    if (o?.audit) this.idleWatch(o.audit, t, r, seen.ev, ph === 'auto' || ph === 'teleop');
  }

  /** a still spell of IDLE_S or more, not parking and neither picking up nor shooting, is an idle mistake */
  private idleWatch(A: AuditRec, t: number, r: World['robots'][number], ev: string[], playing: boolean): void {
    if (ev.includes('pickup') || ev.includes('shot')) A.lastAct = t;
    const job = this.brain.current();
    const still = playing && Math.hypot(r.vel.x, r.vel.y) < 3 && Math.abs(r.angVel) < 0.3 && t - A.lastAct > 60 && job?.kind !== 'park';
    if (still && A.still < 0) {
      A.still = t;
      A.stillJob = job ? `still during "${job.label}"` : 'still, no job';
    }
    if (!still && A.still >= 0) {
      const secs = (t - A.still) * DT;
      if (secs >= IDLE_S) A.items.push({ tick: A.still, kind: 'idle', cost: secs, detail: A.stillJob, x: Math.round(r.pos.x), y: Math.round(r.pos.y) });
      A.still = -1;
    }
  }

  /** the cycle recorder */
  private route(R: RouteRec, t: number, r: World['robots'][number], ev: string[]): void {
    for (const e of ev) {
      if (e === 'shotIn') {
        // a shot going in belongs to the cycle that shot it: the open one while it shoots, else the one just closed
        const last = R.out[R.out.length - 1];
        if (R.cur && R.shooting) R.cur.mine++;
        else if (last && t - last.t1 <= LAND_TICKS) last.mine++;
        else if (R.cur) R.cur.mine++;
        continue;
      }
      if (e !== 'pickup' && e !== 'shot') continue;
      if (!R.cur) R.cur = { t0: Math.min(R.from, t), t1: t, collect: [], shoot: { x: 0, y: 0 }, points: 0, mine: 0 };
      if (e === 'pickup') {
        const job = this.brain.current();
        R.cur.collect.push({ kind: job?.kind ?? 'field', x: Math.round(r.pos.x), y: Math.round(r.pos.y), label: job?.label ?? '' });
      } else {
        if (!R.shooting) R.cur.shoot = { x: Math.round(r.pos.x), y: Math.round(r.pos.y) };
        R.shooting = true;
        R.cur.t1 = t;
      }
    }
    // the volley is over when the hopper is empty again
    if (R.cur && R.shooting && r.hopper.length === 0) this.closeCycle(R);
    while (R.pending.length && R.pending[0].t1 + LAND_TICKS <= t) {
      R.pending.shift()!.points = this.reward() - R.mark;
      R.mark = this.reward();
    }
    // TELEOP starts the clock again (the transition is nobody's cycle; AUTO's end bonuses are not a TELEOP route's)
    if (t === TELEOP_TICK) {
      if (R.cur) R.cur.t0 = Math.max(R.cur.t0, t);
      else R.from = t;
      if (!R.pending.length) R.mark = this.reward();
    }
  }
  private closeCycle(R: RouteRec): void {
    if (!R.cur) return;
    R.out.push(R.cur);
    R.pending.push(R.cur);
    R.from = R.cur.t1;
    R.cur = null;
    R.shooting = false;
  }

  private frame(w: World, intake = false): void {
    const o = this.out!;
    const fr = o.frames!;
    const r = w.robots.find((q) => q.id === 0)!;
    const p2 = w.robots.find((q) => q.id === 1);
    const reds = w.robots.filter((q) => q.alliance !== r.alliance);
    if (!fr.spec) {
      fr.spec = r.spec;
      fr.alliance = r.alliance;
      if (p2) fr.spec2 = p2.spec;
      if (reds.length) fr.oppSpecs = reds.map((x) => x.spec);
    }
    if (fr.meta.length !== w.balls.length) fr.meta = w.balls.map((b) => [b.id, b.color, (b as { r?: number }).r ?? null]);
    const q = (v: number): number => Math.round(v * 100) / 100;
    const s: [number, unknown][] = [];
    const b: number[] = [];
    w.balls.forEach((x, i) => {
      b.push(q(x.pos.x), q(x.pos.y), q(x.z ?? 0));
      const st = JSON.stringify(x.state);
      if (st !== o.lastState[i]) {
        o.lastState[i] = st;
        s.push([i, x.state]);
      }
    });
    const g = JSON.stringify(bb(w));
    const cur = this.brain.current();
    const f: Frame = {
      t: w.tick,
      r: [q(r.pos.x), q(r.pos.y), r.heading, r.turretHeading ?? r.heading, r.bbTurret2Heading ?? r.heading + Math.PI, r.bbTurretPitch ?? 0, r.bbTurret2Pitch ?? 0, intake ? 1 : 0],
      h: r.hopper.map((c) => c[0]).join(''),
      b,
      m: [w.match.phase, w.match.phaseTimeLeft, w.match.scores[r.alliance].total, w.match.scores[r.alliance === 'blue' ? 'red' : 'blue'].foulPoints],
    };
    if (s.length) f.s = s;
    if (g !== o.lastBb) {
      o.lastBb = g;
      f.g = JSON.parse(g);
    }
    if (cur) f.o = [kindIdx(cur.kind), cur.label, q(cur.x), q(cur.y)];
    if (p2) {
      f.p = [q(p2.pos.x), q(p2.pos.y), p2.heading, p2.turretHeading ?? p2.heading, p2.bbTurret2Heading ?? p2.heading + Math.PI, p2.bbTurretPitch ?? 0, p2.bbTurret2Pitch ?? 0, 0];
      f.ph = p2.hopper.map((c) => c[0]).join('');
    }
    if (reds.length) {
      f.opp = reds.map((x) => [q(x.pos.x), q(x.pos.y), x.heading, x.turretHeading ?? x.heading, x.bbTurret2Heading ?? x.heading + Math.PI, x.bbTurretPitch ?? 0, x.bbTurret2Pitch ?? 0]);
      f.oh = reds.map((x) => x.hopper.map((c) => c[0]).join(''));
    }
    fr.f.push(f);
  }

  // ─────────────────────────────── what-if ───────────────────────────────
  /** the points option `key` makes from this (pre-decision) state: a fork takes it on tick `tick`,
   * plays on with the same brain for `horizon` ticks under fresh luck `luck`, and the predictor
   * values what is left of the match (a match that ends, or a robot that dies, is valued as it is) */
  whatIf(key: string, tick: number, luck: number, horizon: number, value: Mlp | null, commit: boolean): number {
    const b = this.fork();
    b.reseed(luck);
    b.brain.force = { key, tick, commit };
    const r0 = b.reward();
    const end = b.w.tick + horizon;
    // after the buzzer nothing is decided any more, but points still land: play the settle out
    while ((b.w.tick < end || b.w.match.phase === 'post') && b.step());
    let q = b.reward() - r0;
    if (!b.done && value) q += b.valueNow(value);
    return q;
  }
  /** the predictor's points still to come from here */
  valueNow(value: Mlp): number {
    const w = this.w;
    const ph = w.match.phase;
    if (ph === 'post') return 0; // (whatIf plays the settle out)
    const obs = new Float32Array(N_OBS);
    encode(w, w.robots[0], this.prof, obs);
    return value.forward(obs)[0] * VALUE_SCALE;
  }

  /** every option of decision `d` (taken on tick d.tick from this state) valued by successive
   * halving: round 1 plays them all, each further round the better half, every round under one
   * fresh luck draw shared by all options (common random numbers). `commit`: see Brain.force */
  valueOptions(d: DecisionPoint, idx: number[], rounds: number, horizon: number, value: Mlp | null, luckBase: number, commit: boolean): (number | null)[] {
    const sum = new Array<number>(d.opts.length).fill(0);
    const n = new Array<number>(d.opts.length).fill(0);
    let alive = [...idx];
    for (let k = 0; k < rounds && alive.length; k++) {
      const luck = seedOf(luckBase, d.tick, k);
      for (const i of alive) {
        sum[i] += this.whatIf(optKey(d.opts[i]), d.tick, luck, horizon, value, commit);
        n[i]++;
      }
      if (alive.length <= 2) continue;
      alive = [...alive].sort((p, q) => sum[q] / n[q] - sum[p] / n[p]).slice(0, Math.max(2, Math.ceil(alive.length / 2)));
    }
    return sum.map((s, i) => (n[i] ? s / n[i] : null));
  }

  /** SEQUENTIAL HALVING (Search2Spec) over decision `d` taken on tick d.tick from this state */
  searchHalving(d: DecisionPoint, S: Search2Spec, value: Mlp | null, luckBase: number): Searched {
    const m = d.opts.length;
    const q: (number | null)[] = new Array(m).fill(null);
    const se: (number | null)[] = new Array(m).fill(null);
    const n = new Array<number>(m).fill(0);
    const depth = new Array<number>(m).fill(-1);
    const rq: (number | null)[][] = [];
    let alive = d.opts.map((_, i) => i);
    let last: number[][] = [];
    for (let r = 0; r < S.rounds.length && alive.length; r++) {
      const R = S.rounds[r];
      const vals = alive.map(() => [] as number[]);
      for (let k = 0; k < R.draws; k++) {
        const luck = seedOf(luckBase, d.tick, r, k);
        alive.forEach((i, j) => vals[j].push(this.whatIf(optKey(d.opts[i]), d.tick, luck, R.horizon, value, false)));
      }
      rq.push(new Array(m).fill(null));
      alive.forEach((i, j) => {
        const v = vals[j];
        const mean = v.reduce((a, b) => a + b, 0) / v.length;
        const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : NaN;
        q[i] = mean;
        rq[r][i] = mean;
        se[i] = Number.isFinite(sd) ? sd / Math.sqrt(v.length) : null;
        n[i] += v.length;
        depth[i] = r;
      });
      last = vals;
      if (r === S.rounds.length - 1) break; // the final comparison is on this round's draws
      if (alive.length <= 2) continue; // two left: both go on to the longer, better-sampled round
      // the better half go on; the network's own choice always does (it is what gets overruled)
      const keep = Math.max(2, Math.ceil(alive.length / 2));
      const order = alive.map((i, j) => [i, j] as const).sort((a, b) => q[b[0]]! - q[a[0]]! || a[0] - b[0]);
      const next = order.slice(0, keep).map(([i]) => i);
      if (!next.includes(d.chosen) && alive.includes(d.chosen)) next[next.length - 1] = d.chosen;
      alive = alive.filter((i) => next.includes(i));
    }
    // overrule the network only for a clear winner of the final comparison (paired, same draws)
    let best = d.chosen;
    const ci = alive.indexOf(d.chosen);
    if (ci >= 0) {
      for (const [j, i] of alive.entries()) {
        if (i === d.chosen) continue;
        const diff = last[j].map((v, k) => v - last[ci][k]);
        const md = diff.reduce((a, b) => a + b, 0) / diff.length;
        const sdd = diff.length > 1 ? Math.sqrt(diff.reduce((a, b) => a + (b - md) ** 2, 0) / (diff.length - 1)) : 0;
        const z = sdd > 0 ? md / (sdd / Math.sqrt(diff.length)) : md > 0 ? Infinity : 0;
        if (md > S.margin && z > S.z && (best === d.chosen || q[i]! > q[best]!)) best = i;
      }
    }
    return { tick: d.tick, at: d.at, chosen: best, net: d.chosen, q, se, n, depth, rq };
  }

  /** the whole life, with lessons / search at the decisions when asked */
  run(): EpisodeResult {
    const a = this.a;
    const value = a.value ? new Mlp(VALUE_SHAPE, share(fromB64(a.value))) : null;
    const pick: Stream = mulberry32(seedOf(a.seed, 'lesson-pick'));
    const watch = !!(a.lessons || a.search || a.search2);
    const win = a.searchWindow ?? [0, Infinity];
    const handover = a.handover ? decodeGenome(a.handover.genome) : null;
    const forces = a.forces ?? [];
    let fi = 0;
    const labels: Searched[] = [];
    let lastSearch = -1e9;
    let searched = 0;
    let changed = 0;
    for (;;) {
      const ph = this.w.match.phase;
      if (a.handover && this.w.tick === a.handover.tick) this.brain.setNet(handover);
      while (fi < forces.length && forces[fi][0] < this.w.tick) fi++;
      if (fi < forces.length && forces[fi][0] === this.w.tick) this.brain.force = { key: forces[fi][1], tick: forces[fi++][0], commit: false };
      if (watch && (ph === 'auto' || ph === 'teleop') && this.w.tick >= win[0] && this.w.tick < win[1]) {
        // will the brain decide on this tick? A fork steps once to find out (a job can end at any tick)
        const t = this.w.tick;
        const probe = this.fork();
        probe.step();
        const d = probe.brain.last;
        if (d && d.tick === t) {
          const L = a.lessons;
          if (L && (d.at === 'begin' || pick() < L.thinkRate)) {
            const q = this.valueOptions(d, d.opts.map((_, i) => i), L.rounds, L.horizon, value, seedOf(a.seed, 'lesson'), true);
            const best = Math.max(...q.map((v) => v ?? -Infinity));
            const took = q[d.chosen];
            if (took !== null) {
              this.regret += best - took;
              this.regretN++;
            }
            this.out?.lessons?.push({ obs: d.obs!, feats: Float32Array.from(d.opts.flatMap((o) => o.feats)), k: d.opts.length, y: d.chosen, q: Float32Array.from(q.map((v) => v ?? NaN)) });
            if (a.inspect) this.inspectPush(d, q);
          } else if (a.search2 && (d.at === 'begin' || t - lastSearch >= (a.search2.thinkEvery ?? Infinity))) {
            lastSearch = t;
            const res = this.searchHalving(d, a.search2, value, seedOf(a.seed, 'search2'));
            searched++;
            if (res.chosen !== d.chosen) {
              changed++;
              this.brain.force = { key: optKey(d.opts[res.chosen]), tick: t, commit: false };
              res.change = { key: optKey(d.opts[res.chosen]), from: d.opts[d.chosen].label, to: d.opts[res.chosen].label };
            }
            if (a.keepSearched && d.ent) {
              res.sofar = this.reward();
              res.x = { g: b64(d.ent.g), e: b64(d.ent.e), n: d.ent.n, o: b64(d.ent.o), f: b64(Float32Array.from(d.opts.flatMap((o) => o.feats))) };
              labels.push(res);
            }
            if (a.inspect) this.inspectPush(d, res.q, res.chosen);
          } else if (a.search && (d.at === 'begin' || t - lastSearch >= a.search.thinkEvery)) {
            const S = a.search;
            lastSearch = t;
            const order = d.scores.map((s, i) => [s, i] as const).sort((p, q) => q[0] - p[0] || p[1] - q[1]);
            const top = order.slice(0, S.k).map(([, i]) => i);
            if (!top.includes(d.chosen)) top.push(d.chosen);
            const q = this.valueOptions(d, top, S.rounds, S.horizon, value, seedOf(a.seed, 'search'), false);
            let best = d.chosen;
            for (const i of top) if ((q[i] ?? -Infinity) > (q[best] ?? -Infinity) + S.margin) best = i;
            searched++;
            if (best !== d.chosen) {
              changed++;
              this.brain.force = { key: optKey(d.opts[best]), tick: t, commit: false };
            }
            if (a.inspect) this.inspectPush(d, q, best);
          } else if (a.inspect && !a.lessons) this.inspectPush(d, d.opts.map(() => null));
        }
      }
      if (!this.step()) break;
    }
    const res = this.result(searched, changed);
    if (a.keepSearched) res.labels = labels;
    return res;
  }

  private inspectPush(d: DecisionPoint, q: (number | null)[], chosen = d.chosen): void {
    const r = (v: number, k = 10): number => Math.round(v * k) / k;
    const gain = chosen !== d.chosen && q[chosen] !== null && q[d.chosen] !== null ? q[chosen]! - q[d.chosen]! : null;
    this.out?.inspect?.push({ t: d.tick, at: d.at, chosen, net: d.chosen, gain, current: d.current, opts: d.opts.map((o, i) => ({ kind: kindIdx(o.kind), label: o.label, x: r(o.x), y: r(o.y), s: r(d.scores[i], 1000), q: q[i] === null ? null : r(q[i]!) })) });
  }

  private result(searched: number, changed: number): EpisodeResult {
    const w = this.w;
    const o = this.out!;
    const run = this.m.result();
    if (o.frames) this.frame(w);
    if (this.death === 'survived') this.deathTick = w.tick;
    const reward = this.reward();
    const score = reward + this.fouls;
    const dec = o.decisions;
    const mistakes: Mistakes = { missedShots: this.parts.wasted, emptyTrips: 0, emptyTripS: 0, blockedShots: 0, blockedShotS: 0, idleS: this.tally.activity.idle, fouls: this.fouls + w.match.scores.red.foulPoints, regret: this.regret, regretN: this.regretN, stalls: this.stalls };
    for (const d of dec) {
      if (d.outcome !== 'failed' || d.endTick === undefined) continue;
      const s = (d.endTick - d.tick) * DT;
      if (d.kind === 'shoot') {
        mistakes.blockedShots++;
        mistakes.blockedShotS += s;
      } else if (d.kind === 'field' || d.kind === 'lz' || d.kind === 'flower') {
        mistakes.emptyTrips++;
        mistakes.emptyTripS += s;
      }
    }
    const res: EpisodeResult = { reward, score, parts: this.parts, ticks: w.tick, death: this.death, deathTick: this.deathTick, point: this.prof.point, mistakes, activity: this.tally.activity, loads: this.tally.loads, start: this.start };
    if (this.partnerTally && this.a.partner) res.partner = { kind: this.a.partner.kind, start: this.partnerStart!, parts: this.partnerTally.parts };
    if (this.a.opponents && this.a.opponents !== 'none') res.opponents = { kind: this.a.opponents, score: recordScore(w, 'red') };
    if (o.audit) {
      const A = o.audit;
      for (const d of dec) {
        if (d.outcome !== 'failed' || d.endTick === undefined) continue;
        const kind = d.kind === 'shoot' ? 'blocked-shot' : d.kind === 'field' || d.kind === 'lz' || d.kind === 'flower' ? 'empty-trip' : null;
        if (kind) A.items.push({ tick: d.tick, kind, cost: (d.endTick - d.tick) * DT, detail: d.label, x: Math.round(d.x), y: Math.round(d.y) });
      }
      if (A.still >= 0 && (w.tick - A.still) * DT >= IDLE_S) A.items.push({ tick: A.still, kind: 'idle', cost: (w.tick - A.still) * DT, detail: A.stillJob, x: Math.round(w.robots[0].pos.x), y: Math.round(w.robots[0].pos.y) });
      res.audit = A.items.sort((p, q) => p.tick - q.tick);
    }
    if (o.route) {
      if (o.route.shooting) this.closeCycle(o.route);
      for (const c of o.route.pending) {
        c.points = reward - o.route.mark; // the match ended first
        o.route.mark = reward;
      }
      res.cycles = o.route.out;
    }
    if (o.path) {
      res.track = b64(new Float32Array(o.path));
      res.events = o.events!;
      res.decisions = dec.map((d) => [d.tick, kindIdx(d.kind), Math.round(d.x), Math.round(d.y), d.outcome === 'failed' ? 0 : d.outcome === 'switched' ? 2 : 1]);
    }
    if (o.frames) {
      res.frames = o.frames;
      res.events = o.events!;
    }
    if (o.samples) res.samples = pack(o.samples);
    if (o.lessons) res.lessons = pack(o.lessons);
    if (o.values) {
      const final = reward;
      res.values = { n: o.values.at.length, obs: b64(new Float32Array(o.values.obs)), y: o.values.score.map((s) => final - s) };
    }
    if (o.inspect) res.inspect = o.inspect;
    if (this.a.search || this.a.search2) res.searched = { n: searched, changed };
    if (this.a.record && run.replay) {
      res.replay = run.replay;
      res.replayExact = run.replayExact;
      if (this.a.verify) {
        // DSIM itself re-simulates the recorded commands: without misses (layer C) it must land on
        // the very same world — score, state hash and tick count
        const live = worldResult(w);
        if (!run.replayExact) res.verified = { exact: false, ok: false, detail: 'misses were simulated: DSIM replays the commands only' };
        else {
          const re = verifyReplay(JSON.parse(JSON.stringify(run.replay)));
          const ok = re.hash === live.hash && re.score.blue === live.score.blue && re.ticks === live.ticks;
          res.verified = { exact: true, ok, detail: `live ${live.score.blue} pts / ${live.ticks} ticks / ${live.hash}, DSIM replay ${re.score.blue} / ${re.ticks} / ${re.hash}` };
        }
      }
    }
    return res;
  }
}

export function runEpisode(a: EpisodeArgs): EpisodeResult {
  return new Episode(a).run();
}

export const MATCH_TICKS = Math.round((C.PRE_COUNTDOWN + C.AUTO_DURATION + C.TRANSITION_DURATION + C.TELEOP_DURATION) / DT);
