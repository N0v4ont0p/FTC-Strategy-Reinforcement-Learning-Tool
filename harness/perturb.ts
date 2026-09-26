// LAYER C (PLAN.md §2.2): effects commands cannot express. DSIM never releases a shot that will
// miss, so a real launcher's misses are made here. Edits world state ⇒ the run's replay no longer
// reproduces it (runMatch flags it).
//
// HOW A MISS IS MADE: the just-launched element's vertical speed is cut so its apex stays below
// the CELL opening (BB_HIVE_OPEN_Z[0] minus DSIM's 2 in accept margin, minus 1 in). A CELL only
// accepts an element inside that height window (hive.ts hiveAccepts), so the miss is certain at
// any range. Scaling horizontal speed was tried first and FAILED: the descending window is long
// enough that a ±25% shot still lands inside the opening at mid range (s0-check caught it).
// ponytail: every miss lands SHORT (between robot and HIVE). Real misses also bounce off the
// rim; add a rim-bounce distribution if S5's sensitivity shows landing spot matters.
import { BB, C, type Alliance, type World } from './dsim';
import type { Perturb } from './profiles';
import { mulberry32, seedOf, type Stream } from './rng';

export interface ShotLog {
  launched: number;
  forcedMiss: number;
}

const APEX_CAP_Z = BB.BB_HIVE_OPEN_Z[0] - 2 - 1;

/** `perAlliance` accuracy; an alliance absent or at 1.0 is untouched. `perRobot` (by robot id)
 * overrides it for the robot that launched the element — two robots of one alliance can miss at
 * different rates. DSIM's flight state names only the alliance, so the launcher is the robot that
 * HELD the element the tick before. A class, so a running match can be forked (train/fork.ts). */
export class Perturber {
  private rng: Stream;
  private seen = new Set<number>(); // ball ids currently in a flight already judged
  private holder = new Map<number, number>(); // ball id → the robot holding it (last seen)
  constructor(
    seed: number,
    private perAlliance: Partial<Record<Alliance, Perturb>>,
    private log?: ShotLog,
    private perRobot?: Map<number, Perturb>,
  ) {
    this.rng = mulberry32(seedOf(seed, 'perturb'));
  }
  /** new luck from here on (what-if branches) */
  reseed(seed: number): void {
    this.rng.reseed(seedOf(seed, 'perturb'));
  }
  apply(w: World): boolean {
    let changed = false;
    for (const b of w.balls) {
      const s = b.state;
      if (s.kind === 'held') this.holder.set(b.id, (s as { robot: number }).robot);
      if (s.kind !== 'flight') {
        this.seen.delete(b.id);
        continue;
      }
      if (this.seen.has(b.id)) continue;
      this.seen.add(b.id);
      const by = (s as { by?: Alliance }).by;
      const who = this.holder.get(b.id);
      this.holder.delete(b.id);
      const p = (who !== undefined ? this.perRobot?.get(who) : undefined) ?? (by ? this.perAlliance[by] : undefined);
      if (!p) continue;
      if (this.log) this.log.launched++;
      if (p.shotAccuracy >= 1 || this.rng() < p.shotAccuracy) continue;
      const vzCap = Math.sqrt(2 * C.GRAVITY * Math.max(0, APEX_CAP_Z - b.z));
      b.vz = Math.min(b.vz, vzCap) * (0.8 + 0.15 * this.rng());
      if (this.log) this.log.forcedMiss++;
      changed = true;
    }
    return changed;
  }
}

export function makePerturb(seed: number, perAlliance: Partial<Record<Alliance, Perturb>>, log?: ShotLog) {
  const p = new Perturber(seed, perAlliance, log);
  return (w: World): boolean => p.apply(w);
}
