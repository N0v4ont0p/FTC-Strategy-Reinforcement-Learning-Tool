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
import { C, DT, Match, bb, coerce, recordScore, verifyReplay, worldResult, type World } from '../harness/dsim';
import { loadProfile, resolve, type Resolved } from '../harness/profiles';
import { MatchFilter, HUMAN, ORACLE, RULES_CONSERVATIVE } from '../harness/filters';
import { Perturber } from '../harness/perturb';
import { Guards } from '../harness/guards';
import { mulberry32, seedOf, type Stream } from '../harness/rng';
import { Mlp, fromB64 } from './net';
import { Brain, optKey, type Decision, type DecisionPoint } from './policy';
import { pack, type Packed, type Sample } from './bc';
import { OPTION_KINDS, spawnPose } from './skills';
import { N_OBS, encode } from './obs';
import { deepClone, share } from './fork';
import { VALUE_SHAPE, VALUE_SCALE } from './value';
import { Tally, type Activity, type Loads, type Parts } from './gap';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export type Stage = 'auto' | 'full';
export type Death = 'survived' | 'crash' | 'stall';
export const STALL_S = 20; // no progress for this long ⇒ the robot "dies"
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
  returns?: number; // every this many ticks, record (observation, points still to come) for the predictor
  inspect?: boolean; // keep every what-if result per decision (the studio's decision inspector)
  verify?: boolean; // with record: re-simulate the replay in DSIM and compare (verified)
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
}

/** exact frames — what DSIM's renderers need to redraw this life exactly as it was trained */
export interface Frames {
  stride: number;
  spec: unknown;
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
}

export class Episode {
  readonly prof: Resolved;
  readonly m: Match;
  readonly brain: Brain;
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
    };
    this.out = o;
    this.brain = new Brain(a.genome ? fromB64(a.genome) : null, this.prof, 0, o.decisions, o.samples ?? undefined);
    this.brain.wantObs = !!(a.lessons || a.search || a.returns);
    this.m = new Match(a.seed, [{ id: 0, alliance: 'blue', spec: this.prof.spec, startIndex: 0, startPose: spawnPose(this.prof.spec) }], { record: a.record });
    this.filter = new MatchFilter(a.seed, new Map([[0, this.prof.limits]]), a.driver === 'human' ? HUMAN : ORACLE, RULES_CONSERVATIVE);
    this.perturb = new Perturber(a.seed, { blue: this.prof.perturb });
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
    return this.m.step((w) => this.brain.act(w), {
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
    const r = w.robots[0];
    const o = this.out;
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
    for (const [k, v] of Object.entries(rep.violations)) {
      if (k === 'DSIM-foul' || !v) continue;
      viol += v;
      fouls += v * (MINOR_RULES.has(k) ? FOUL.minor : FOUL.major);
    }
    if (viol > this.prevViol) {
      this.ev(t, 'violation');
      this.prevViol = viol;
    }
    parts.violations = viol;
    parts.strikes = rep.anomalies['fast-ground-element'] ?? 0;
    this.fouls = fouls + FOUL.exploit * parts.strikes;
    if ((rep.violations['G417-hive-frame-contact'] ?? 0) > 0) {
      this.death = 'crash';
      this.deathTick = t;
    } else if ((t - this.lastProgress) * DT > STALL_S) {
      this.death = 'stall';
      this.deathTick = t;
    }
  }

  private frame(w: World, intake = false): void {
    const o = this.out!;
    const fr = o.frames!;
    const r = w.robots[0];
    if (!fr.spec) {
      fr.spec = r.spec;
      fr.alliance = r.alliance;
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

  /** the whole life, with lessons / search at the decisions when asked */
  run(): EpisodeResult {
    const a = this.a;
    const value = a.value ? new Mlp(VALUE_SHAPE, share(fromB64(a.value))) : null;
    const pick: Stream = mulberry32(seedOf(a.seed, 'lesson-pick'));
    const watch = !!(a.lessons || a.search);
    let lastSearch = -1e9;
    let searched = 0;
    let changed = 0;
    for (;;) {
      const ph = this.w.match.phase;
      if (watch && (ph === 'auto' || ph === 'teleop')) {
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
    return this.result(searched, changed);
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
    const mistakes: Mistakes = { missedShots: this.parts.wasted, emptyTrips: 0, emptyTripS: 0, blockedShots: 0, blockedShotS: 0, idleS: this.tally.activity.idle, fouls: this.fouls + w.match.scores.red.foulPoints, regret: this.regret, regretN: this.regretN };
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
    const res: EpisodeResult = { reward, score, parts: this.parts, ticks: w.tick, death: this.death, deathTick: this.deathTick, point: this.prof.point, mistakes, activity: this.tally.activity, loads: this.tally.loads };
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
    if (this.a.search) res.searched = { n: searched, changed };
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
