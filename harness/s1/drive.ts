// S1 DRIVE MODEL (PLAN.md §S1). Parameters come from DSIM's OWN driveParams() — not re-derived —
// plus DSIM's power-draw rule (sim/robot.ts). The 1-D motor model below is DSIM's motorStep()
// run tick by tick with Rapier's semi-implicit position update; sysid.ts proves it against DSIM.
import { C, DT, driveParams, type RobotSpec } from '../dsim';

export interface Eff {
  vmax: number; // in/s forward
  strafeMult: number;
  accel: number; // in/s² stall budget (translation)
  maxTurn: number; // rad/s
  turnAccel: number; // rad/s²
  draw: number;
}

/** effective limits exactly as sim/robot.ts computes them for this tick's power draw */
export function effective(spec: RobotSpec, intakeOn = false, hopperLen = 0): Eff {
  const dp = driveParams(spec, false);
  const intakeDraw = intakeOn && hopperLen < C.HOPPER_CAPACITY ? C.POWER_DRAW_INTAKE : 0;
  const driveDraw = C.POWER_DRAW_DRIVE * Math.min(1, Math.max(0, (spec.driveRpm - C.REF_DRIVE_RPM) / (C.POWER_DRAW_DRIVE_TOP_RPM - C.REF_DRIVE_RPM)));
  const draw = Math.min(intakeDraw + driveDraw, C.POWER_DRAW_MAX);
  const slow = 1 - draw;
  return { vmax: dp.maxSpeed * slow, strafeMult: dp.strafeMult, accel: dp.accel * slow, maxTurn: dp.maxTurn * slow, turnAccel: dp.turnAccel * slow, draw };
}

/** DSIM motorStep (sim/drivetrain.ts), verbatim logic */
export function motorStep(v: number, target: number, aStall: number, vFree: number, brake = C.MOTOR_BRAKE_MULT): number {
  const err = target - v;
  if (err === 0) return v;
  const braking = Math.abs(v) > vFree * 1e-3 && Math.sign(err) !== Math.sign(v);
  const frac = braking ? brake : Math.max(1 - C.MOTOR_TORQUE_CURVE * Math.min(Math.abs(v) / vFree, 1), C.MOTOR_MIN_TORQUE_FRAC);
  const d = aStall * frac * DT;
  return v + Math.max(-d, Math.min(d, err));
}

/** 1-D rollout of a target-velocity schedule: returns positions and velocities per tick */
export function roll1d(targets: number[], a: number, vmax: number): { x: number[]; v: number[] } {
  let x = 0;
  let v = 0;
  const xs: number[] = [];
  const vs: number[] = [];
  for (const t of targets) {
    v = motorStep(v, t, a, vmax);
    x += v * DT;
    xs.push(x);
    vs.push(v);
  }
  return { x: xs, v: vs };
}

/**
 * LOWER BOUND, in ticks, to move `dist` from rest and come to rest (speed ≤ vTol) within `tol`.
 *
 * Why it is a valid bound for ANY 2-D path in DSIM free space: the path is at least the straight
 * distance; the speed along it can never exceed `vmax` (the forward limit is DSIM's largest); the
 * motor budget caps |Δv| per tick at accel·max(1−|v|/vmax, 0.06) when not braking and accel·1.4
 * when braking, and a tangential component can't exceed the magnitude; DSIM's other drive forces
 * (lateral grip, wheel slip) act perpendicular to motion or only against slip, so they cannot
 * add tangential speed. Bang-bang (full target, then full brake) is optimal for this 1-D budget,
 * and letting the stop overshoot by `tol` only makes the bound smaller. Empirically re-checked:
 * every DSIM-measured time in the S1 table must be ≥ this (s1-check).
 */
export function lbTicks(dist: number, a: number, vmax: number, tol = 1.0, vTol = 5): number {
  if (dist <= tol) return 0;
  let best = Infinity;
  for (let s = 1; s < 2000; s++) {
    // accelerate s ticks at full target, then brake to rest
    let x = 0;
    let v = 0;
    for (let k = 0; k < s; k++) {
      v = motorStep(v, vmax, a, vmax);
      x += v * DT;
    }
    let n = s;
    while (v > vTol && n < s + 2000) {
      v = motorStep(v, 0, a, vmax);
      x += v * DT;
      n++;
    }
    if (x >= dist - tol) {
      best = n;
      break;
    }
  }
  return best;
}

/** rotational lower bound (same argument, rotation has its own budget in sim/robot.ts) */
export function lbTurnTicks(angle: number, turnAccel: number, maxTurn: number, tol = (3 * Math.PI) / 180, wTol = 0.3): number {
  return lbTicks(Math.abs(angle), turnAccel, maxTurn, tol, wTol);
}
