// POLICY = WHAT TO DO NEXT. The skills (train/skills.ts) already drive, sweep groups, retrieve and
// shoot as well as the S1 motion lab knows how; the evolved network only SCORES each option
// available right now (the global observation + that option's own features → one number) and the
// robot takes the best one. So evolution learns the ORDER — which group, FLOWER, loading zone,
// shoot, human player, park — and every robot, even in generation 0, actually plays the game.
// Fire is held whenever it can score (skills.ts fireGate): shooting is never something to unlearn.
// The genome also carries three STYLE genes the skills read (how they execute, not what).
import { BB, bb, cmd, type Controller, type RobotCommand, type World } from '../harness/dsim';
import type { Resolved } from '../harness/profiles';
import { Mlp, type NetShape } from './net';
import { N_OBS, encode } from './obs';
import type { Sample } from './bc';
import { Executor, N_OPT_FEATS, Pilot, fireGate, nearestSpot, options, type Option, type OptionKind, type Style } from './skills';

export const HIDDEN = 16;
/** STYLE genes: raw gene g → lo + (hi − lo)·sigmoid(g); `def` is the default value */
export const STYLE = [
  { key: 'fireHold', lo: 0, hi: 5, def: 2, label: 'slow down to fire while collecting once holding' },
  { key: 'fireMinV', lo: 0, hi: 60, def: 15, label: '…on robots allowed to fire at this speed (in/s) or more' },
  // default NO: measured on 12 matches, re-deciding mid-sweep lost 7 % (206 vs 220); evolution may flip it
  { key: 'tipReact', lo: 0, hi: 1, def: 0.2, label: 're-decide the moment a CELL starts to tip (≥ 0.5 = yes)' },
] as const;
export const STYLE_DEFAULT_GENES: number[] = STYLE.map((s) => {
  const f = (s.def - s.lo) / (s.hi - s.lo);
  return Math.log(f / (1 - f));
});
export const SHAPE: NetShape = { sizes: [N_OBS + N_OPT_FEATS, HIDDEN, 1], skip: true, style: STYLE.length };
export type PolicyKind = 'net' | 'greedy';

export function decodeStyle(g: ArrayLike<number> | null): Style {
  const v = STYLE.map((s, i) => (g ? s.lo + (s.hi - s.lo) / (1 + Math.exp(-g[i])) : s.def));
  return { fireHold: v[0], fireMinV: v[1], tipReact: v[2] >= 0.5 };
}

export interface Decision {
  tick: number;
  kind: OptionKind;
  label: string;
  x: number;
  y: number;
  of: number; // how many options there were to choose from
  outcome?: 'done' | 'failed';
  endTick?: number;
}

/** GREEDY baseline (no learning): shoot when full, human player when possible, park when it is
 * time, else the group it reaches first. The bar evolution has to clear. */
function greedyScore(o: Option, hopperFull: boolean): number {
  const est = o.feats[6];
  if (o.kind === 'park') return 100;
  if (o.kind === 'hp') return 50;
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
  let tipping = 0;
  const banned = new Map<string, number>();
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
    // a CELL just started to tip: shots now go to the other cell and a spill is coming. A robot
    // with STYLE tipReact re-decides what it is sweeping or shooting (not a FLOWER or park)
    const tp = bb(w).hives[r.alliance].tipping;
    if (tp > 0 && tipping <= 0 && style.tipReact && ex && cur && (cur.kind === 'field' || cur.kind === 'lz' || cur.kind === 'shoot')) finish('done', w.tick);
    tipping = tp;
    let c: RobotCommand | null = null;
    if (ph === 'auto' || ph === 'teleop') {
      if (ex) {
        const s = ex.step(w, r, cap);
        c = s.c;
        if (s.out !== 'running') finish(s.out, w.tick);
      }
      if (!ex) {
        const opts = options(w, r, pilot, cap, banned);
        if (opts.length) {
          let best = 0;
          let bs = -Infinity;
          if (net || samples) encode(w, r, prof, obs);
          opts.forEach((o, i) => {
            let v: number;
            if (net) {
              x.set(obs, 0);
              x.set(o.feats, N_OBS);
              v = net.forward(x)[0];
            } else v = greedyScore(o, r.hopper.length >= cap);
            if (v > bs) {
              bs = v;
              best = i;
            }
          });
          const o = opts[best];
          if (samples && opts.length > 1) samples.push({ obs: new Float32Array(obs), feats: Float32Array.from(opts.flatMap((q) => q.feats)), k: opts.length, y: best });
          ex = new Executor(o, pilot, w, r, banned, style);
          cur = { tick: w.tick, kind: o.kind, label: o.label, x: o.x, y: o.y, of: opts.length };
          log?.push(cur);
          if (!c) {
            const s = ex.step(w, r, cap);
            c = s.c;
            if (s.out !== 'running') finish(s.out, w.tick);
          }
        } else if (!c) {
          // nothing to do right now: wait where the next shots will go from, not where it stands
          c = pilot.drive(r, w.tick, nearestSpot(w, r, pilot), null);
        }
      }
    }
    c ??= cmd();
    // like a driver's auto-intake: the roller runs whenever there is room (sweeps up whatever it
    // passes), and fire is held whenever a shot can score
    if ((ph === 'auto' || ph === 'teleop') && r.hopper.length < cap) c.intake = true;
    if (fireGate(w, r)) c.fire = true;
    return new Map([[robotId, c]]);
  }) as Controller & { current: () => Decision | null };
  function finish(out: 'done' | 'failed', t: number): void {
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
