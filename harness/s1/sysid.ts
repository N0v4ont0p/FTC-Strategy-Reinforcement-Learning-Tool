// S1 SYSTEM IDENTIFICATION: drive the real DSIM robot with step inputs in a clear lab world and
// compare, tick by tick, with the model in drive.ts. The model is only trusted where this agrees.
import { biobuzzStep, cmd, DT, labWorld, type RobotCommand, type RobotSpec, type World } from '../dsim';
import { effective, motorStep } from './drive';

/** DSIM's reported position trails a v_new·dt integration by a constant POS_LAG·Δv (measured
 * 0.0073 s ≈ 0.44 tick, identical at every speed; zero once at rest). Sub-tick; fitted, not guessed:
 * s1-check re-measures it. */
export const POS_LAG = 0.00729;

export interface SysIdCase {
  name: string;
  maxSpeedErr: number; // in/s (or rad/s for turns)
  maxPosErr: number; // in (or rad)
  ticks: number;
}

function place(w: World, x: number, y: number, h: number): void {
  const r = w.robots[0];
  r.pos = { x, y };
  r.heading = h;
  r.vel = { x: 0, y: 0 };
  r.angVel = 0;
}

function drive(w: World, seq: { c: RobotCommand; n: number }[]): { vx: number; vy: number; w: number; x: number; y: number; h: number }[] {
  const out = [];
  for (const { c, n } of seq)
    for (let k = 0; k < n; k++) {
      biobuzzStep(w, DT, new Map([[0, c]]));
      const r = w.robots[0];
      out.push({ vx: r.vel.x, vy: r.vel.y, w: r.angVel, x: r.pos.x, y: r.pos.y, h: r.heading });
    }
  return out;
}

/** 2-D DSIM motorStepVec, robot frame (sim/drivetrain.ts) */
function stepVec(vx: number, vy: number, tx: number, ty: number, a: number, vFree: number): [number, number] {
  const ex = tx - vx;
  const ey = ty - vy;
  const e = Math.hypot(ex, ey);
  if (e === 0) return [vx, vy];
  const sp = Math.hypot(vx, vy);
  const braking = sp > vFree * 1e-3 && ex * vx + ey * vy < 0;
  const frac = braking ? 1.4 : Math.max(1 - Math.min(sp / vFree, 1), 0.06);
  const b = a * frac * DT;
  if (e <= b) return [tx, ty];
  return [vx + (ex / e) * b, vy + (ey / e) * b];
}

export function sysid(spec: RobotSpec): SysIdCase[] {
  const E = effective(spec);
  const cases: SysIdCase[] = [];
  // each case starts where its motion stays clear of walls, the HIVE frame and FLOWER feet
  const lin = (name: string, stick: Partial<RobotCommand>, fwd: number, strafe: number, nOn: number, nOff: number, sx: number, sy: number): void => {
    const w = labWorld(1, [{ id: 0, alliance: 'blue', spec, startIndex: 0 }]);
    place(w, sx, sy, 0);
    const got = drive(w, [{ c: cmd(stick), n: nOn }, { c: cmd(), n: nOff }]);
    // model: robot frame == field frame at heading 0; robot-centric stick → target (sim/robot.ts)
    let vx = 0, vy = 0, x = sx, y = sy, eV = 0, eP = 0;
    got.forEach((g, i) => {
      const on = i < nOn;
      const [ox, oy] = [vx, vy];
      [vx, vy] = stepVec(vx, vy, on ? fwd : 0, on ? strafe : 0, E.accel, E.vmax);
      x += vx * DT - POS_LAG * (vx - ox);
      y += vy * DT - POS_LAG * (vy - oy);
      eV = Math.max(eV, Math.hypot(g.vx - vx, g.vy - vy));
      eP = Math.max(eP, Math.hypot(g.x - x, g.y - y));
    });
    cases.push({ name, maxSpeedErr: eV, maxPosErr: eP, ticks: got.length });
  };
  // stick → target, sum saturation for mecanum: div = max(1, |x|+|y|+|rot|)
  lin('forward full then release', { driveY: 1 }, E.vmax, 0, 54, 60, -60, -45);
  lin('reverse full then release', { driveY: -1 }, -E.vmax, 0, 54, 60, 40, -45);
  lin('strafe full then release', { driveX: 1 }, 0, -E.vmax * E.strafeMult, 54, 60, -45, 40);
  lin('diagonal (sum saturation halves both)', { driveY: 1, driveX: 1 }, E.vmax / 2, (-E.vmax * E.strafeMult) / 2, 54, 60, 5, 58);
  lin('half stick forward', { driveY: 0.5 }, E.vmax * 0.5, 0, 90, 60, -60, -45);
  {
    const w = labWorld(1, [{ id: 0, alliance: 'blue', spec, startIndex: 0 }]);
    place(w, -45, -45, 0);
    const got = drive(w, [{ c: cmd({ rotate: 1 }), n: 40 }, { c: cmd(), n: 40 }]);
    let om = 0, h = 0, eV = 0, eP = 0;
    got.forEach((g, i) => {
      om = motorStep(om, i < 40 ? E.maxTurn : 0, E.turnAccel, E.maxTurn);
      h += om * DT;
      eV = Math.max(eV, Math.abs(g.w - om));
      eP = Math.max(eP, Math.abs(Math.atan2(Math.sin(g.h - h), Math.cos(g.h - h))));
    });
    cases.push({ name: 'rotate full then release (rad/s, rad)', maxSpeedErr: eV, maxPosErr: eP, ticks: got.length });
  }
  return cases;
}
