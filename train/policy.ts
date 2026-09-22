// POLICY = WHAT TO DO NEXT. The skills (train/skills.ts) already drive, collect, retrieve and shoot
// as well as the S1 motion lab knows how; the evolved network only SCORES each option available
// right now (the global observation + that option's own features → one number) and the robot takes
// the best one. So evolution learns the ORDER — field vs FLOWER vs loading zone vs shoot vs human
// player vs park — and every robot, even in generation 0, actually plays the game.
// Fire is held whenever it can score (skills.ts fireGate): shooting is never something to unlearn.
import { BB, cmd, type Controller, type RobotCommand, type World } from '../harness/dsim';
import type { Resolved } from '../harness/profiles';
import { Mlp, type NetShape } from './net';
import { N_OBS, encode } from './obs';
import { Executor, N_OPT_FEATS, Pilot, fireGate, options, type Option, type OptionKind } from './skills';

export const HIDDEN = 16;
export const SHAPE: NetShape = { sizes: [N_OBS + N_OPT_FEATS, HIDDEN, 1] };
export type PolicyKind = 'net' | 'greedy';

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
 * time, else the nearest source. The bar evolution has to clear. */
function greedyScore(o: Option, hopperFull: boolean): number {
  const est = o.feats[6];
  if (o.kind === 'park') return 100;
  if (o.kind === 'hp') return 50;
  if (o.kind === 'shoot') return hopperFull ? 10 : -est - 1;
  return -est;
}

export function policyController(params: Float32Array | null, prof: Resolved, robotId = 0, log?: Decision[]): Controller & { current: () => Decision | null } {
  const net = params ? new Mlp(SHAPE, params) : null;
  const obs = new Float32Array(N_OBS);
  const x = new Float32Array(N_OBS + N_OPT_FEATS);
  let pilot: Pilot | null = null;
  let cap = 4;
  let ex: Executor | null = null;
  let cur: Decision | null = null;
  let phase = '';
  const banned = new Map<string, number>();
  const ctl = ((w: World) => {
    const r = w.robots.find((q) => q.id === robotId)!;
    if (!pilot) {
      pilot = new Pilot(r.spec);
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
        if (s.out !== 'running') finish(s.out, w.tick);
      }
      if (!ex) {
        const opts = options(w, r, pilot, cap, banned);
        if (opts.length) {
          let best = 0;
          let bs = -Infinity;
          if (net) encode(w, r, prof, obs);
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
          ex = new Executor(o, pilot, w, r);
          cur = { tick: w.tick, kind: o.kind, label: o.label, x: o.x, y: o.y, of: opts.length };
          log?.push(cur);
          if (!c) {
            const s = ex.step(w, r, cap);
            c = s.c;
            if (s.out !== 'running') finish(s.out, w.tick);
          }
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
    if (o && out === 'failed' && (o.ball !== undefined || o.flower !== undefined)) banned.set(o.ball !== undefined ? `b${o.ball}` : `f${o.flower}`, t + 300);
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
