// POLICY = WHAT TO DO NEXT. The skills (train/skills.ts) already drive, sweep groups, retrieve and
// shoot as well as the S1 motion lab knows how; the evolved network only SCORES each option
// available right now (the global observation + that option's own features → one number) and the
// robot takes the best one. So evolution learns the ORDER — which group, FLOWER, loading zone,
// shoot, human player, park — and every robot, even in generation 0, actually plays the game.
// Fire is held whenever it can score (skills.ts fireGate): shooting is never something to unlearn.
// The genome also carries three STYLE genes the skills read (how they execute, not what).
import { BB, cmd, type Controller, type RobotCommand, type World } from '../harness/dsim';
import type { Resolved } from '../harness/profiles';
import { Mlp, type NetShape } from './net';
import { N_OBS, encode } from './obs';
import type { Sample } from './bc';
import { Executor, F_CURRENT, F_EST, N_OPT_FEATS, Pilot, fireGate, options, type Option, type OptionKind, type Style } from './skills';

export const HIDDEN = 16;
/** STYLE genes: raw gene g → lo + (hi − lo)·sigmoid(g); `def` is the default value */
export const STYLE = [
  { key: 'fireHold', lo: 0, hi: 5, def: 2, label: 'slow down to fire while collecting once holding' },
  { key: 'fireMinV', lo: 0, hi: 60, def: 15, label: '…on robots allowed to fire at this speed (in/s) or more' },
  { key: 'stick', lo: 0, hi: 3, def: 0.3, label: 'switch to another option only when it scores this much more' },
] as const;
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
/** the longest a robot may wait in position before it has to do something else */
export const POSITION_MAX_TICKS = 180;
export const SHAPE: NetShape = { sizes: [N_OBS + N_OPT_FEATS, HIDDEN, 1], skip: true, style: STYLE.length };
export type PolicyKind = 'net' | 'greedy';

export function decodeStyle(g: ArrayLike<number> | null): Style {
  const v = STYLE.map((s, i) => (g ? s.lo + (s.hi - s.lo) / (1 + Math.exp(-g[i])) : s.def));
  return { fireHold: v[0], fireMinV: v[1], stick: v[2] };
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
  if (o.kind === 'hp') return 50;
  if (o.kind === 'position') return -100;
  if (o.kind === 'shoot') return hopperFull ? 10 : -est - 1;
  return -est;
}

export function policyController(
  params: Float32Array | null,
  prof: Resolved,
  robotId = 0,
  log?: Decision[],
  samples?: Sample[],
): Controller & { current: () => Decision | null } {
  const net = params ? new Mlp(SHAPE, params) : null;
  const style = decodeStyle(net ? net.style() : null);
  const obs = new Float32Array(N_OBS);
  const x = new Float32Array(N_OBS + N_OPT_FEATS);
  let pilot: Pilot | null = null;
  let cap = 4;
  let ex: Executor | null = null;
  let cur: Decision | null = null;
  let phase = '';
  let lastThink = -1e9;
  const banned = new Map<string, number>();
  // G409: an element that just left a HIVE cell is still falling in the real game — catching it in
  // the first SPILL_GUARD_TICKS is a violation (harness/guards.ts flags it at 0.4 s)
  const prevKind = new Map<number, string>();
  const prevEl = new Map<number, string>();
  const spilled = new Map<number, number>(); // element id → tick it spilled
  const score = (w: World, r: World['robots'][number], opts: Option[]): number[] => {
    if (net || samples) encode(w, r, prof, obs);
    return opts.map((o) => {
      if (!net) return greedyScore(o, r.hopper.length >= cap);
      x.set(obs, 0);
      x.set(o.feats, N_OBS);
      return net.forward(x)[0];
    });
  };
  let hpNow = false;
  /** the human player's button needs nothing from the robot: pressing it is done ALONGSIDE the job
   * (it used to be a job of its own and cut sweeps in two) */
  const pressHp = (w: World, o: Option, of: number): void => {
    hpNow = true;
    banned.set('hp', w.tick + 90); // the human player needs a moment
    log?.push({ tick: w.tick, kind: 'hp', label: o.label, x: o.x, y: o.y, of, outcome: 'done', endTick: w.tick });
  };
  const begin = (w: World, r: World['robots'][number], opts: Option[], i: number, sc: number[]): void => {
    if (samples && opts.length > 1) samples.push({ obs: new Float32Array(obs), feats: Float32Array.from(opts.flatMap((q) => q.feats)), k: opts.length, y: i });
    if (opts[i].kind === 'hp') {
      pressHp(w, opts[i], opts.length);
      i = argmaxWhere(sc, (k) => opts[k].kind !== 'hp');
      if (i < 0) return;
    }
    const o = opts[i];
    ex = new Executor(o, pilot!, w, r, banned, style);
    cur = { tick: w.tick, kind: o.kind, label: o.label, x: o.x, y: o.y, of: opts.length };
    log?.push(cur);
    lastThink = w.tick;
  };
  const argmaxWhere = (v: number[], ok: (i: number) => boolean): number => v.reduce((b, s, i) => (ok(i) && (b < 0 || s > v[b]) ? i : b), -1);
  const argmax = (v: number[]): number => argmaxWhere(v, () => true);
  const ctl = ((w: World) => {
    const r = w.robots.find((q) => q.id === robotId)!;
    if (!pilot) {
      pilot = new Pilot(r.spec, prof.limits);
      cap = BB.bbHopperCap(r.spec);
    }
    const ph = w.match.phase;
    if (ph !== phase) {
      phase = ph;
      if (cur && ex) finish('done', w.tick); // phase boundaries re-decide
    }
    let c: RobotCommand | null = null;
    if (ph === 'auto' || ph === 'teleop') {
      if (ex) {
        const s = ex.step(w, r, cap);
        c = s.c;
        if (s.out !== 'running') {
          finish(s.out, w.tick);
          c = null; // this tick's command comes from the next decision: no dead tick between jobs
        }
      }
      // THINKING ON THE GO: four times a second the robot lists everything it could do now — its
      // current job included, flagged 'current' — and switches when something else scores clearly
      // higher (STYLE stick). A spill landing, a tip starting, a NECTAR arriving, a closer group:
      // it reacts within a quarter second instead of finishing the old plan first.
      // waiting is never a plan: after POSITION_MAX_TICKS in position, position is off the list for
      // a while, so the robot must go and do something (no evolved network can stand still forever)
      if (ex && cur && cur.kind === 'position' && w.tick - cur.tick >= POSITION_MAX_TICKS) {
        banned.set('position', w.tick + 3 * POSITION_MAX_TICKS);
        finish('done', w.tick);
        c = null;
      }
      if (ex && cur && cur.kind !== 'park' && w.tick - lastThink >= THINK_TICKS) {
        lastThink = w.tick;
        const held = ex;
        const opts = options(w, r, pilot, cap, banned, (o) => held.holds(o));
        const ci = opts.findIndex((o) => o.feats[F_CURRENT] === 1);
        if (ci >= 0 && opts.length > 1) {
          const sc = score(w, r, opts);
          const hp = opts.findIndex((o) => o.kind === 'hp');
          if (hp >= 0 && sc[hp] > sc[ci] + style.stick) pressHp(w, opts[hp], opts.length);
          const best = argmaxWhere(sc, (k) => opts[k].kind !== 'hp');
          if (best >= 0 && best !== ci && sc[best] > sc[ci] + style.stick) {
            finish('switched', w.tick);
            begin(w, r, opts, best, sc);
            c = null;
          } else if (samples) {
            // carrying on is a decision too: recorded, so what students learn from the robot's own
            // play has the same "carry on" / "change now" mix as the replays (sparse records taught dithering)
            samples.push({ obs: new Float32Array(obs), feats: Float32Array.from(opts.flatMap((q) => q.feats)), k: opts.length, y: ci });
          }
        }
      }
      if (!ex) {
        const opts = options(w, r, pilot, cap, banned);
        if (opts.length) {
          const sc = score(w, r, opts);
          begin(w, r, opts, argmax(sc), sc);
        }
      }
      if (ex && !c) {
        const s = ex.step(w, r, cap);
        c = s.c;
        if (s.out !== 'running') finish(s.out, w.tick);
      }
    }
    c ??= cmd();
    for (const b of w.balls) {
      const k = b.state.kind;
      if (prevKind.get(b.id) === 'element' && (prevEl.get(b.id) ?? '').startsWith('hive:') && k === 'ground') spilled.set(b.id, w.tick);
      prevKind.set(b.id, k);
      prevEl.set(b.id, k === 'element' ? String((b.state as { el?: string }).el ?? '') : '');
    }
    let spillNear = false;
    for (const [id, t0] of spilled) {
      if (w.tick - t0 > SPILL_GUARD_TICKS) {
        spilled.delete(id);
        continue;
      }
      const b = w.balls.find((q) => q.id === id);
      if (b && b.state.kind === 'ground' && Math.hypot(b.pos.x - r.pos.x, b.pos.y - r.pos.y) < SPILL_REACH) spillNear = true;
    }
    if (spillNear) c.intake = false;
    if (hpNow) {
      c.bbNectar = true;
      hpNow = false;
    }
    // like a driver's auto-intake: the roller runs whenever there is room (sweeps up whatever it
    // passes), and fire is held whenever a shot can score
    if ((ph === 'auto' || ph === 'teleop') && r.hopper.length < cap && !spillNear) c.intake = true;
    if (fireGate(w, r)) c.fire = true;
    return new Map([[robotId, c]]);
  }) as Controller & { current: () => Decision | null };
  function finish(out: 'done' | 'failed' | 'switched', t: number): void {
    const o = ex?.opt;
    if (o && out === 'failed' && o.flower !== undefined) banned.set(`f${o.flower}`, t + 300);
    if (o && out === 'failed' && o.balls) for (const id of o.balls) banned.set(`b${id}`, t + 300); // a group it could not take: something else first
    if (o?.kind === 'hp') banned.set('hp', t + 90); // the human player needs a moment
    if (o?.kind === 'shoot' && out === 'failed') banned.set('shoot', t + 90); // blocked: do something else first
    if (cur) {
      cur.outcome = out;
      cur.endTick = t;
    }
    ex = null;
    cur = null;
  }
  ctl.current = () => cur;
  return ctl;
}
