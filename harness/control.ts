// Basic controllers: a drive-to-pose P-controller (robot-centric, DSIM's stick convention) and
// the random agent used by the crash test. Real skills arrive in S2.
import { cmd, type Controller, type RobotCommand, type RobotState, type World } from './dsim';
import { mulberry32, seedOf } from './rng';

const clamp = (v: number, a = 1): number => Math.max(-a, Math.min(a, v));
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** DSIM robot-centric mapping (sim/robot.ts): stick → robot-local {x: driveY, y: -driveX}, x
 * forward, y left; rotate is CCW-positive. So a wanted robot-frame move (fwd, left) is
 * driveY = fwd, driveX = -left. */
export function toRobotStick(r: RobotState, fieldX: number, fieldY: number): { driveX: number; driveY: number } {
  const c = Math.cos(r.heading);
  const s = Math.sin(r.heading);
  const fwd = fieldX * c + fieldY * s;
  const left = -fieldX * s + fieldY * c;
  return { driveX: -left, driveY: fwd };
}

export function goTo(r: RobotState, x: number, y: number, heading?: number, gain = 0.08): RobotCommand {
  const ex = x - r.pos.x;
  const ey = y - r.pos.y;
  const d = Math.hypot(ex, ey);
  const k = d > 1e-9 ? Math.min(1, gain * d) / d : 0;
  const st = toRobotStick(r, ex * k, ey * k);
  const rot = heading === undefined ? 0 : clamp(1.5 * wrap(heading - r.heading));
  return cmd({ driveX: clamp(st.driveX), driveY: clamp(st.driveY), rotate: rot });
}

/** random intents held for 0.1–1.5 s, every button included (bbPlace/bbPlaceNectar are refused
 * by DSIM on a robot with no Box Tube — pressing them anyway is part of the test) */
export function randomController(seed: number, ids: number[]): Controller {
  const rng = mulberry32(seedOf(seed, 'random-agent'));
  const cur = new Map<number, { c: RobotCommand; until: number }>();
  return (w: World) => {
    const out = new Map<number, RobotCommand>();
    for (const id of ids) {
      let e = cur.get(id);
      if (!e || w.tick >= e.until) {
        const b = (p: number): boolean => rng() < p;
        e = {
          c: cmd({
            driveX: rng() * 2 - 1,
            driveY: rng() * 2 - 1,
            rotate: b(0.5) ? rng() * 2 - 1 : 0,
            intake: b(0.6),
            fire: b(0.6),
            bbNectar: b(0.15),
            bbPlace: b(0.05),
            bbPlaceNectar: b(0.05),
          }),
          until: w.tick + 6 + Math.floor(rng() * 84),
        };
        cur.set(id, e);
      }
      out.set(id, e.c);
    }
    return out;
  };
}
