// POLICY: observation → network → RobotCommand, deciding every ACTION_REPEAT ticks (10 Hz, the
// human decision rate of PLAN.md §3) and holding that command in between.
import { cmd, type Controller, type RobotCommand, type World } from '../harness/dsim';
import type { Resolved } from '../harness/profiles';
import { Mlp, type NetShape } from './net';
import { N_OBS, encode } from './obs';

export const ACT_NAMES = ['driveX', 'driveY', 'rotate', 'intake', 'fire', 'humanPlayer'] as const;
export const N_ACT = ACT_NAMES.length;
export const SHAPE: NetShape = { sizes: [N_OBS, 64, 64, N_ACT] };
export const ACTION_REPEAT = 6;

/** decode network outputs: sticks through tanh; buttons pressed when the output is positive.
 * The human-player button is EDGE-triggered in DSIM, so a press lasts one decision. */
export function decode(y: Float32Array, prevHp: boolean): { c: RobotCommand; hp: boolean } {
  const hp = y[5] > 0;
  return {
    c: cmd({ driveX: Math.tanh(y[0]), driveY: Math.tanh(y[1]), rotate: Math.tanh(y[2]), intake: y[3] > 0, fire: y[4] > 0, bbNectar: hp && !prevHp }),
    hp,
  };
}

export function policyController(params: Float32Array, prof: Resolved, robotId = 0): Controller {
  const net = new Mlp(SHAPE, params);
  const obs = new Float32Array(N_OBS);
  let held = cmd();
  let prevHp = false;
  let k = 0;
  return (w: World) => {
    if (k++ % ACTION_REPEAT === 0) {
      const r = w.robots.find((q) => q.id === robotId)!;
      const d = decode(net.forward(encode(w, r, prof, obs)), prevHp);
      prevHp = d.hp;
      held = d.c;
    } else held = { ...held, bbNectar: false }; // an edge button is pressed for one tick only
    return new Map([[robotId, held]]);
  };
}
