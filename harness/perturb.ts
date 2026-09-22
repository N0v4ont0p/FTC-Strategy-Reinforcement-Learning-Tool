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
import { mulberry32, seedOf } from './rng';

export interface ShotLog {
  launched: number;
  forcedMiss: number;
}

const APEX_CAP_Z = BB.BB_HIVE_OPEN_Z[0] - 2 - 1;

/** `perAlliance` accuracy; an alliance absent or at 1.0 is untouched. */
export function makePerturb(seed: number, perAlliance: Partial<Record<Alliance, Perturb>>, log?: ShotLog) {
  const rng = mulberry32(seedOf(seed, 'perturb'));
  const seen = new Set<number>(); // ball ids currently in a flight already judged
  return (w: World): boolean => {
    let changed = false;
    for (const b of w.balls) {
      const s = b.state;
      if (s.kind !== 'flight') {
        seen.delete(b.id);
        continue;
      }
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      const by = (s as { by?: Alliance }).by;
      const p = by ? perAlliance[by] : undefined;
      if (!p) continue;
      if (log) log.launched++;
      if (p.shotAccuracy >= 1 || rng() < p.shotAccuracy) continue;
      const vzCap = Math.sqrt(2 * C.GRAVITY * Math.max(0, APEX_CAP_Z - b.z));
      b.vz = Math.min(b.vz, vzCap) * (0.8 + 0.15 * rng());
      if (log) log.forcedMiss++;
      changed = true;
    }
    return changed;
  };
}
