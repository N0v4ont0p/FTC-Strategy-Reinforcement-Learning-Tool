// POLICY = WHAT TO DO NEXT. The skills (train/skills.ts) already drive, sweep groups, retrieve and
// shoot as well as the S1 motion lab knows how; the evolved network only SCORES each option
// available right now (the global observation + that option's own features → one number) and the
// robot takes the best one. So evolution learns the ORDER — which group, FLOWER, loading zone,
// shoot, human player, park — and every robot, even in generation 0, actually plays the game.
// Fire is held whenever it can score (skills.ts fireGate): shooting is never something to unlearn.
// The genome also carries three STYLE genes the skills read (how they execute, not what).
import { BB, cmd, type Controller, type RobotCommand, type World } from '../harness/dsim';
import type { Resolved } from '../harness/profiles';
import { Mlp, fromB64, styleOffset, type NetShape } from './net';
import { N_ENT, N_OBS, N_OPT_IN, encode, encodeEnts, optInput } from './obs';
import { EntNet, layout, type EntInput, type EntShape } from './entnet';
import type { Sample } from './bc';
import { share } from './fork';
import { Executor, F_CURRENT, F_EST, N_OPT_FEATS, Pilot, STYLE, fireGate, options, parkGoal, type Option, type OptionKind, type Style } from './skills';
import { NO_AVOID, type AllianceBoard, type BrainMode } from './team';
import { matchStep, type PlanStep, type TakenStep } from './plan';

export const HIDDEN = 16;
export { STYLE };
export const STYLE_DEFAULT_GENES: number[] = STYLE.map((s) => {
  const f = (s.def - s.lo) / (s.hi - s.lo);
  return Math.log(f / (1 - f));
});
/** the robot re-thinks this often while it acts (ticks; 15 = four times a second) */
export const THINK_TICKS = 15;
/** G409: no capture of an element this soon after it spilled (0.45 s: the guard's 0.4 s + margin) */
const SPILL_GUARD_TICKS = 27;
/** …within this distance of the robot's centre (in): anything its intake could reach in that time */
const SPILL_REACH = 30;
export const SHAPE: NetShape = { sizes: [N_OBS + N_OPT_FEATS, HIDDEN, 1], skip: true, style: STYLE.length };
export type PolicyKind = 'net' | 'greedy';
/** THE ENTITY NETWORK (phase 4, train/entnet.ts): the v1 observation as its global input, every
 * robot and element as a set, each option with where it goes. A genome is "ent1:" + base64 */
export const ENT_SHAPE: EntShape = { G: N_OBS, F: N_ENT, O: N_OPT_IN, D: 32, A: 16, H: 32, style: STYLE.length };
export const ENT_PREFIX = 'ent1:';
export type NetParams = Float32Array | { ent: Float32Array };
export const isEnt = (g: string | null | undefined): boolean => !!g && g.startsWith(ENT_PREFIX);
/** a genome string (v1 MLP or entity network) → what a Brain takes */
export function decodeGenome(g: string | null | undefined): NetParams | null {
  if (!g) return null;
  return isEnt(g) ? { ent: fromB64(g.slice(ENT_PREFIX.length)) } : fromB64(g);
}
/** a genome's skill-setting genes (raw), or the defaults for none */
export function genomeStyle(g: string | null | undefined): number[] {
  const p = decodeGenome(g);
  if (!p) return [...STYLE_DEFAULT_GENES];
  const [arr, at] = p instanceof Float32Array ? [p, styleOffset(SHAPE)] : [p.ent, layout(ENT_SHAPE).style];
  return Array.from(arr.subarray(at, at + STYLE.length));
}

export function decodeStyle(g: ArrayLike<number> | null): Style {
  return Object.fromEntries(STYLE.map((s, i) => [s.key, g ? s.lo + (s.hi - s.lo) / (1 + Math.exp(-g[i])) : s.def])) as Style;
}

export interface Decision {
  tick: number;
  kind: OptionKind;
  label: string;
  x: number;
  y: number;
  of: number; // how many options there were to choose from
  outcome?: 'done' | 'failed' | 'switched';
  endTick?: number;
}

/** GREEDY baseline (no learning): shoot when full, human player when possible, park when it is
 * time, else the group it reaches first; get in position only when there is nothing else. The bar
 * evolution has to clear. It thinks on the go like every robot. */
function greedyScore(o: Option, hopperFull: boolean): number {
  const est = o.feats[F_EST];
  if (o.kind === 'park') return 100;
  if (o.kind === 'place') return 60 - est; // a NECTAR into a FLOWER after the 1:00 cue: ~15 points
  if (o.kind === 'hp') return 50;
  if (o.kind === 'position' || o.kind === 'cycle') return -100; // (the tip cycle is for learners to discover: the bar stays as it was)
  if (o.kind === 'shoot') return hopperFull ? 10 : -est - 1;
  return -est;
}

/** an option's identity within one decision: a forced choice is found again by it in a fork */
export const optKey = (o: Option): string => `${o.kind}:${o.balls ? o.balls.join(',') : ''}:${o.flower ?? ''}`;

/** a decision the brain just made with at least two options (what the what-if machinery reads) */
export interface DecisionPoint {
  tick: number;
  at: 'think' | 'begin';
  opts: Option[];
  scores: number[];
  chosen: number; // the option it went for (hp: pressed alongside)
  current: number; // index of the job it was doing (think), -1 at a begin
  obs: Float32Array | null; // the observation, when asked for (lessons, search)
  ent: EntInput | null; // the entity view, when asked for (the entity network's labels)
}

/**
 * THE BRAIN: the network (or the greedy order) choosing among the skills' options, re-thinking four
 * times a second while a skill runs. A class with all its state in fields, so a running match can
 * be forked (train/fork.ts): the what-if branches of a lesson or a search copy it mid-match.
 * `force` makes the next decision take a given option (by optKey) instead of the best-scored one.
 */
export class Brain {
  private net: Mlp | null;
  private ent: EntNet | null = null;
  private entIn: EntInput | null = null;
  private style: Style;
  private obs = new Float32Array(N_OBS);
  private x = new Float32Array(N_OBS + N_OPT_FEATS);
  private pilot: Pilot | null = null;
  private cap = 4;
  private ex: Executor | null = null;
  private cur: Decision | null = null;
  private phase = '';
  private lastThink = -1e9;
  private banned = new Map<string, number>();
  // G409: an element that just left a HIVE cell is still falling in the real game — catching it in
  // the first SPILL_GUARD_TICKS is a violation (harness/guards.ts flags it at 0.4 s)
  private prevKind = new Map<number, string>();
  private prevEl = new Map<number, string>();
  private spilled = new Map<number, number>(); // element id → tick it spilled
  private hpNow = false;
  /** the next decision takes this option (a what-if branch); must be used on tick `tick`.
   * `commit`: the option then runs to completion before the brain re-thinks — the options framework
   * (Sutton, Precup & Singh 1999: Q(s, o) = do o until it ends, then play on). LESSONS commit: then
   * "carry on with o" at a re-think is worth what "start o" is worth at a job start, so what the
   * network learns at job starts carries over to its re-thinks (without it, a what-if of an option the
   * brain dislikes measured "start it, drop it a quarter-second later", and the network learned to pick
   * and keep an option it had never seen played out: −31.5 ± 16.4). THINKING AHEAD does not commit:
   * it is a one-step deviation, and the robot re-thinks afterwards exactly as the what-if assumed
   * (+40 ± 19; committed: +13 ± 14) */
  force: { key: string; tick: number; commit: boolean } | null = null;
  private committed = false;
  /** the last decision with ≥ 2 options */
  last: DecisionPoint | null = null;
  /** record the observation at decisions (lessons and search need it) */
  wantObs = false;
  /** …and the entity view (labels for the entity network) */
  wantEnts = false;
  /** 'play' = the skills in the network's (or the greedy) order; 'park' = drive off the wall and park
   * (a LEAVE + PARK partner); 'idle' = never moves */
  readonly mode: BrainMode;
  /** the alliance's shared board (train/team.ts): partners do not chase the same elements */
  private board: AllianceBoard | null;
  private parkSlot: number;
  /** an AUTO PLAN being followed (train/auto.ts): at each job start the next step is taken — found
   * by what it is (train/plan.ts) — and run to its end; past the plan the brain chooses itself */
  private plan: PlanStep[] | null = null;
  /** the plan's steps as they were taken, and when (the timing sheet) */
  taken: TakenStep[] = [];
  /** the planner's look-ahead: at the first job start past the plan, keep the options in `free` */
  stopAtFree = false;
  free: { tick: number; opts: Option[]; scores: number[] } | null = null;

  constructor(
    params: NetParams | null,
    private prof: Resolved,
    private robotId = 0,
    public log?: Decision[],
    public samples?: Sample[],
    o: { mode?: BrainMode; board?: AllianceBoard | null; parkSlot?: number } = {},
  ) {
    this.net = params instanceof Float32Array ? new Mlp(SHAPE, share(params)) : null;
    if (params && !(params instanceof Float32Array)) this.ent = share(new EntNet(ENT_SHAPE, share(params.ent)));
    this.style = decodeStyle(this.net ? this.net.style() : this.ent ? this.ent.style() : null);
    share(prof);
    this.mode = o.mode ?? 'play';
    this.board = o.board ?? null;
    this.parkSlot = o.parkSlot ?? 0;
  }
  /** the robot this brain drives */
  get id(): number {
    return this.robotId;
  }
  /** a different network from now on (a drill's hand-over); the skill settings stay */
  setNet(params: NetParams | null): void {
    this.net = params instanceof Float32Array ? new Mlp(SHAPE, share(params)) : null;
    this.ent = params && !(params instanceof Float32Array) ? share(new EntNet(ENT_SHAPE, share(params.ent))) : null;
  }
  follow(steps: PlanStep[]): void {
    this.plan = steps;
  }
  /** skill settings (genes) instead of the network's own — before the match starts */
  setStyle(genes: ArrayLike<number>): void {
    if (this.pilot) throw new Error('skill settings are set before the match starts');
    this.style = decodeStyle(genes);
  }

  current(): Decision | null {
    return this.cur;
  }

  private score(w: World, r: World['robots'][number], opts: Option[]): number[] {
    if (this.net || this.ent || this.samples || this.wantObs) encode(w, r, this.prof, this.obs);
    this.entIn = null;
    if (this.ent || this.wantEnts) {
      const { e, n } = encodeEnts(w, r);
      this.entIn = { g: this.obs, e, n, o: optInput(r, opts), k: opts.length };
    }
    if (this.ent) return Array.from(this.ent.forward(this.entIn!).q);
    return opts.map((o) => {
      if (!this.net) return greedyScore(o, r.hopper.length >= this.cap);
      this.x.set(this.obs, 0);
      this.x.set(o.feats, N_OBS);
      return this.net.forward(this.x)[0];
    });
  }
  /** the human player's button needs nothing from the robot: pressing it is done ALONGSIDE the job
   * (it used to be a job of its own and cut sweeps in two) */
  private pressHp(w: World, o: Option, of: number): void {
    this.hpNow = true;
    this.banned.set('hp', w.tick + 90); // the human player needs a moment
    this.log?.push({ tick: w.tick, kind: 'hp', label: o.label, x: o.x, y: o.y, of, outcome: 'done', endTick: w.tick });
  }
  private begin(w: World, r: World['robots'][number], opts: Option[], i: number, sc: number[]): void {
    if (this.samples && opts.length > 1) this.samples.push({ obs: new Float32Array(this.obs), feats: Float32Array.from(opts.flatMap((q) => q.feats)), k: opts.length, y: i });
    if (opts[i].kind === 'hp') {
      this.pressHp(w, opts[i], opts.length);
      i = argmaxWhere(sc, (k) => opts[k].kind !== 'hp');
      if (i < 0) return;
    }
    const o = opts[i];
    this.ex = new Executor(o, this.pilot!, w, r, this.banned);
    this.cur = { tick: w.tick, kind: o.kind, label: o.label, x: o.x, y: o.y, of: opts.length };
    this.board?.set(this.robotId, { kind: o.kind, balls: o.balls ?? [], flower: o.flower ?? null, spot: o.kind === 'shoot' ? { x: o.x, y: o.y } : null });
    this.log?.push(this.cur);
    this.lastThink = w.tick;
  }
  /** the forced option's index in this decision's list (a fork replays the same list exactly) */
  private forced(w: World, opts: Option[]): number {
    const f = this.force!;
    if (f.tick !== w.tick) throw new Error(`forced decision expected on tick ${f.tick}, reached one on ${w.tick}`);
    this.force = null;
    const i = opts.findIndex((o) => optKey(o) === f.key);
    if (i < 0) throw new Error(`forced option ${f.key} is not among this decision's options`);
    return i;
  }
  private note(w: World, at: 'think' | 'begin', opts: Option[], sc: number[], chosen: number, current: number): void {
    if (opts.length > 1) this.last = { tick: w.tick, at, opts, scores: sc, chosen, current, obs: this.wantObs ? new Float32Array(this.obs) : null, ent: this.wantEnts && this.entIn ? { ...this.entIn, g: new Float32Array(this.obs) } : null };
    this.entIn = null;
  }

  act(w: World): Map<number, RobotCommand> {
    const r = w.robots.find((q) => q.id === this.robotId)!;
    if (!this.pilot) {
      this.pilot = new Pilot(r.spec, this.prof.limits, this.style);
      this.pilot.parkSlot = this.parkSlot;
      this.cap = BB.bbHopperCap(r.spec);
    }
    if (this.mode === 'idle') return new Map([[this.robotId, cmd()]]);
    if (this.mode === 'park') {
      // a LEAVE + PARK partner: off the wall to its park spot at once, and it stays there
      const ph = w.match.phase;
      this.pilot.others = w.robots.filter((q) => q.id !== this.robotId).map((q) => ({ pos: { x: q.pos.x, y: q.pos.y }, heading: q.heading, spec: q.spec }));
      if (ph !== 'auto' && ph !== 'teleop') return new Map([[this.robotId, cmd()]]);
      const g = parkGoal(r.alliance, this.pilot, this.parkSlot);
      return new Map([[this.robotId, this.pilot.drive(r, w.tick, g, g.h, { vCap: 18 })]]);
    }
    if (this.mode === 'defend') {
      // A DEFENDER (phase 5): in AUTO it only leaves (to its park spot: no AUTO interference, G402);
      // in TELEOP it shadows the nearest opposing robot 24 in toward that robot's HIVE — in the way of
      // its shots and of its path home — and it parks for the last 15 s
      const ph = w.match.phase;
      this.pilot.others = w.robots.filter((q) => q.id !== this.robotId).map((q) => ({ pos: { x: q.pos.x, y: q.pos.y }, heading: q.heading, spec: q.spec }));
      if (ph !== 'auto' && ph !== 'teleop') return new Map([[this.robotId, cmd()]]);
      const park = parkGoal(r.alliance, this.pilot, this.parkSlot);
      const foe = w.robots.filter((q) => q.alliance !== r.alliance).sort((a, b) => Math.hypot(a.pos.x - r.pos.x, a.pos.y - r.pos.y) - Math.hypot(b.pos.x - r.pos.x, b.pos.y - r.pos.y))[0];
      if (ph === 'auto' || !foe || w.match.phaseTimeLeft < 15) return new Map([[this.robotId, this.pilot.drive(r, w.tick, park, park.h, { vCap: 18 })]]);
      const hx = foe.alliance === 'blue' ? BB.BB_HIVE_X : -BB.BB_HIVE_X;
      const dx = hx - foe.pos.x;
      const dy = -foe.pos.y;
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(24, d / 2);
      // on a 6 in grid: the path is re-planned when the goal moves, not every tick
      const g = { x: Math.round((foe.pos.x + (k * dx) / d) / 6) * 6, y: Math.round((foe.pos.y + (k * dy) / d) / 6) * 6 };
      return new Map([[this.robotId, this.pilot.drive(r, w.tick, g, null, { vMax: 45 })]]);
    }
    const avoid = this.board ? this.board.avoidFor(this.robotId) : NO_AVOID;
    this.pilot.avoidSpots = avoid.spots;
    this.pilot.others = w.robots.length > 1 ? w.robots.filter((q) => q.id !== this.robotId).map((q) => ({ pos: { x: q.pos.x, y: q.pos.y }, heading: q.heading, spec: q.spec })) : [];
    const style = this.style;
    const ph = w.match.phase;
    if (ph !== this.phase) {
      this.phase = ph;
      if (this.cur && this.ex) this.finish('done', w.tick); // phase boundaries re-decide
    }
    let c: RobotCommand | null = null;
    if (ph === 'auto' || ph === 'teleop') {
      if (this.ex) {
        const s = this.ex.step(w, r, this.cap);
        c = s.c;
        if (s.out !== 'running') {
          this.finish(s.out, w.tick);
          c = null; // this tick's command comes from the next decision: no dead tick between jobs
        }
      }
      // THINKING ON THE GO: four times a second the robot lists everything it could do now — its
      // current job included, flagged 'current' — and switches when something else scores clearly
      // higher (STYLE stick). A spill landing, a tip starting, a NECTAR arriving, a closer group:
      // it reacts within a quarter second instead of finishing the old plan first.
      // waiting is never a plan: after POSITION_MAX_TICKS in position, position is off the list for
      // a while, so the robot must go and do something (no evolved network can stand still forever)
      const posMax = Math.round(60 * style.positionMaxS);
      if (this.ex && this.cur && this.cur.kind === 'position' && w.tick - this.cur.tick >= posMax) {
        this.banned.set('position', w.tick + 3 * posMax);
        this.finish('done', w.tick);
        c = null;
      }
      if (this.ex && this.cur && this.cur.kind !== 'park' && !this.committed && w.tick - this.lastThink >= THINK_TICKS) {
        this.lastThink = w.tick;
        const held = this.ex;
        const opts = options(w, r, this.pilot, this.cap, this.banned, (o) => held.holds(o), avoid);
        const ci = opts.findIndex((o) => o.feats[F_CURRENT] === 1);
        if (ci >= 0 && opts.length > 1) {
          const sc = this.score(w, r, opts);
          if (this.force) {
            const commit = this.force.commit;
            const fi = this.forced(w, opts);
            this.note(w, 'think', opts, sc, fi, ci);
            if (opts[fi].kind === 'hp') this.pressHp(w, opts[fi], opts.length);
            else if (fi !== ci) {
              this.finish('switched', w.tick);
              this.begin(w, r, opts, fi, sc);
              c = null;
            }
            this.committed = commit; // carry on / switch / press: the job now runs to its end
          } else {
            const hp = opts.findIndex((o) => o.kind === 'hp');
            const pressed = hp >= 0 && sc[hp] > sc[ci] + style.stick;
            if (pressed) this.pressHp(w, opts[hp], opts.length);
            const best = argmaxWhere(sc, (k) => opts[k].kind !== 'hp');
            if (best >= 0 && best !== ci && sc[best] > sc[ci] + style.stick) {
              this.note(w, 'think', opts, sc, best, ci);
              this.finish('switched', w.tick);
              this.begin(w, r, opts, best, sc);
              c = null;
            } else {
              this.note(w, 'think', opts, sc, pressed ? hp : ci, ci);
              // carrying on is a decision too: recorded, so what students learn from the robot's own
              // play has the same "carry on" / "change now" mix as the replays (sparse records taught dithering)
              if (this.samples) this.samples.push({ obs: new Float32Array(this.obs), feats: Float32Array.from(opts.flatMap((q) => q.feats)), k: opts.length, y: ci });
            }
          }
        }
      }
      if (!this.ex) {
        const opts = options(w, r, this.pilot, this.cap, this.banned, () => false, avoid);
        if (opts.length) {
          const sc = this.score(w, r, opts);
          let commit = !!this.force?.commit;
          let i: number;
          if (this.force) i = this.forced(w, opts);
          else if (this.plan?.length) {
            // the plan's next step, run to its end; if it is not there any more, the robot chooses
            const step = this.plan.shift()!;
            const k = matchStep(opts, step);
            this.taken.push({ ...step, robot: this.robotId, tick: w.tick, matched: k >= 0 });
            i = k >= 0 ? k : argmaxWhere(sc, () => true);
            commit = true;
          } else {
            if (this.plan && this.stopAtFree && !this.free) this.free = { tick: w.tick, opts, scores: sc };
            i = argmaxWhere(sc, () => true);
          }
          this.note(w, 'begin', opts, sc, i, -1);
          this.begin(w, r, opts, i, sc);
          if (commit && this.ex) this.committed = true;
        }
      }
      if (this.ex && !c) {
        const s = this.ex.step(w, r, this.cap);
        c = s.c;
        if (s.out !== 'running') this.finish(s.out, w.tick);
      }
    }
    if (this.force && this.force.tick <= w.tick) throw new Error(`forced decision on tick ${this.force.tick} never came`);
    c ??= cmd();
    for (const b of w.balls) {
      const k = b.state.kind;
      if (this.prevKind.get(b.id) === 'element' && (this.prevEl.get(b.id) ?? '').startsWith('hive:') && k === 'ground') this.spilled.set(b.id, w.tick);
      this.prevKind.set(b.id, k);
      this.prevEl.set(b.id, k === 'element' ? String((b.state as { el?: string }).el ?? '') : '');
    }
    let spillNear = false;
    for (const [id, t0] of this.spilled) {
      if (w.tick - t0 > SPILL_GUARD_TICKS) {
        this.spilled.delete(id);
        continue;
      }
      const b = w.balls.find((q) => q.id === id);
      if (b && b.state.kind === 'ground' && Math.hypot(b.pos.x - r.pos.x, b.pos.y - r.pos.y) < SPILL_REACH) spillNear = true;
    }
    if (spillNear) c.intake = false;
    if (this.hpNow) {
      c.bbNectar = true;
      this.hpNow = false;
    }
    // like a driver's auto-intake: the roller runs whenever there is room (sweeps up whatever it
    // passes), and fire is held whenever a shot can score
    if ((ph === 'auto' || ph === 'teleop') && r.hopper.length < this.cap && !spillNear) c.intake = true;
    // (a dumper holds fire only at its shooting spot: DSIM's aim assist turns its whole chassis)
    if (fireGate(w, r) && (!this.pilot.dumper || this.ex?.firing)) c.fire = true;
    return new Map([[this.robotId, c]]);
  }

  private finish(out: 'done' | 'failed' | 'switched', t: number): void {
    const o = this.ex?.opt;
    const banned = this.banned;
    const ban = Math.round(60 * this.style.failBanS);
    if (o && out === 'failed' && o.flower !== undefined) banned.set(`${o.kind === 'place' ? 'p' : 'f'}${o.flower}`, t + ban);
    if (o && out === 'failed' && o.balls) for (const id of o.balls) banned.set(`b${id}`, t + ban); // a group it could not take: something else first
    if (o?.kind === 'hp') banned.set('hp', t + 90); // the human player needs a moment
    if (o?.kind === 'shoot' && out === 'failed') banned.set('shoot', t + 90); // blocked: do something else first
    if (o?.kind === 'cycle' && out === 'failed') banned.set('cycle', t + ban); // the tip cycle stopped working: something else first
    if (this.cur) {
      this.cur.outcome = out;
      this.cur.endTick = t;
      const last = this.taken[this.taken.length - 1];
      if (last && last.end === undefined && last.tick === this.cur.tick) last.end = t;
    }
    this.ex = null;
    this.cur = null;
    this.committed = false;
    this.board?.set(this.robotId, null);
  }
}

const argmaxWhere = (v: number[], ok: (i: number) => boolean): number => v.reduce((b, s, i) => (ok(i) && (b < 0 || s > v[b]) ? i : b), -1);

/** the brain as a plain controller function (callers that never fork) */
export function policyController(params: NetParams | null, prof: Resolved, robotId = 0, log?: Decision[], samples?: Sample[]): Controller & { current: () => Decision | null } {
  const b = new Brain(params, prof, robotId, log, samples);
  const ctl = ((w: World) => b.act(w)) as Controller & { current: () => Decision | null };
  ctl.current = () => b.current();
  return ctl;
}
