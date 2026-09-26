// THE GAP REPORT — where the time goes, the robot next to the team's world-record replays, measured
// the same way for both: one Tally reads the world tick by tick (DSIM state only) for a training
// match (train/episode.ts) and for a replay re-simulated by DSIM's own ReplayPlayer.
//   · points, tips and seconds per tip; pickups, shots and accuracy per minute;
//   · LOADS: a load starts with the first shot after a pickup — elements per load and seconds
//     from one load to the next (the replays' loop is a load every ~4 s, one per tip);
//   · where every second of AUTO + TELEOP went: collecting (a pickup in the last third of a
//     second), shooting (a shot in the last third of a second), driving, idle (stopped).
// And the BUILD CHECK: the champion on each replay's own robot (its spec, ideal limits, no misses)
// and on that replay's own match seed — the same field luck as the human — so the gap splits into
// what the robot build costs and what the brain costs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DT, bb, type World } from '../harness/dsim';
import { ReplayPlayer } from '../dsim-main/src/sim/replay';
import type { Replay } from '../harness/dsim';

export interface Parts {
  pickups: number;
  shotsIn: number;
  wasted: number;
  hp: number;
  tips: number;
  violations: number;
  strikes: number; // elements struck faster than any robot moves (an anomaly, reported)
  strikesScored?: number; // …of which scored for us within the window (fined as an exploit)
}
/** seconds of AUTO + TELEOP by what the robot was physically doing */
export interface Activity {
  collect: number;
  shoot: number;
  drive: number;
  idle: number;
}
export interface Loads {
  n: number;
  shots: number;
  first: number; // tick the first load started (-1: none)
  last: number; // tick the last load started
}

export const ACT_WINDOW = 20; // ticks: a pickup / shot this recent is what the robot is doing

/** counts a robot's play from world state, one tick at a time. Plain fields: forkable. */
export class Tally {
  parts: Parts = { pickups: 0, shotsIn: 0, wasted: 0, hp: 0, tips: 0, violations: 0, strikes: 0 };
  activity: Activity = { collect: 0, shoot: 0, drive: 0, idle: 0 };
  loads: Loads = { n: 0, shots: 0, first: -1, last: -1 };
  lastShot = -1e9;
  lastPickup = -1e9;
  private prevKind = new Map<number, string>();
  private pickedSinceShot = true;

  /** read this tick; returns whether the robot made progress and what happened ([kind] events) */
  observe(w: World, r: World['robots'][number]): { progress: boolean; ev: string[] } {
    const t = w.tick;
    const parts = this.parts;
    const ev: string[] = [];
    let progress = false;
    for (const b of w.balls) {
      const pk = this.prevKind.get(b.id);
      const k = b.state.kind;
      if (pk !== undefined && pk !== k) {
        if (k === 'held' && (b.state as { robot: number }).robot === r.id) {
          parts.pickups++;
          progress = true;
          this.lastPickup = t;
          this.pickedSinceShot = true;
          ev.push('pickup');
        } else if (pk === 'held' && k === 'flight') {
          this.lastShot = t;
          this.loads.shots++;
          if (this.pickedSinceShot) {
            this.loads.n++;
            if (this.loads.first < 0) this.loads.first = t;
            this.loads.last = t;
          }
          this.pickedSinceShot = false;
          ev.push('shot');
        } else if (pk === 'flight' && k === 'element' && (b.state as { el: string }).el === `hive:${r.alliance}`) {
          parts.shotsIn++;
          progress = true;
          ev.push('shotIn');
        } else if (pk === 'flight' && k === 'ground') {
          parts.wasted++;
          ev.push('wasted');
        } else if (pk === 'stock' && k === 'ground') {
          parts.hp++;
          progress = true;
          ev.push('hp');
        }
      }
      this.prevKind.set(b.id, k);
    }
    const tips = bb(w).hives[r.alliance].tips;
    if (tips > parts.tips) {
      parts.tips = tips;
      ev.push('tip');
    }
    const ph = w.match.phase;
    if (ph === 'auto' || ph === 'teleop') {
      const a: keyof Activity =
        t - this.lastShot <= ACT_WINDOW ? 'shoot' : t - this.lastPickup <= ACT_WINDOW ? 'collect' : Math.hypot(r.vel.x, r.vel.y) < 3 && Math.abs(r.angVel) < 0.3 ? 'idle' : 'drive';
      this.activity[a] += DT;
    }
    return { progress, ev };
  }
}

/** one row of the report: a player on a build over n matches (means per match) */
export interface GapRow {
  who: string;
  build: string;
  n: number;
  points: number;
  tips: number;
  secPerTip: number;
  pickupsPerMin: number;
  shotsPerMin: number;
  accuracy: number; // shots in / shots
  loadSize: number; // shots per load
  secPerLoad: number; // from one load to the next
  share: Activity; // fractions of AUTO + TELEOP
}
export interface Played {
  points: number;
  parts: Parts;
  activity: Activity;
  loads: Loads;
}

export function gapRow(who: string, build: string, P: Played[]): GapRow {
  const n = Math.max(1, P.length);
  const sum = (f: (p: Played) => number): number => P.reduce((a, p) => a + f(p), 0);
  const playS = sum((p) => p.activity.collect + p.activity.shoot + p.activity.drive + p.activity.idle);
  const shots = sum((p) => p.parts.shotsIn + p.parts.wasted);
  const loads = sum((p) => p.loads.n);
  const loadSpan = sum((p) => (p.loads.n > 1 ? (p.loads.last - p.loads.first) * DT : 0));
  const loadGaps = sum((p) => Math.max(0, p.loads.n - 1));
  const tips = sum((p) => p.parts.tips);
  const frac = (k: keyof Activity): number => (playS ? sum((p) => p.activity[k]) / playS : 0);
  return {
    who,
    build,
    n: P.length,
    points: sum((p) => p.points) / n,
    tips: tips / n,
    secPerTip: tips ? playS / tips : Infinity,
    pickupsPerMin: playS ? (60 * sum((p) => p.parts.pickups)) / playS : 0,
    shotsPerMin: playS ? (60 * shots) / playS : 0,
    accuracy: shots ? sum((p) => p.parts.shotsIn) / shots : 0,
    loadSize: loads ? sum((p) => p.loads.shots) / loads : 0,
    secPerLoad: loadGaps ? loadSpan / loadGaps : Infinity,
    share: { collect: frac('collect'), shoot: frac('shoot'), drive: frac('drive'), idle: frac('idle') },
  };
}

/** re-simulate a replay in DSIM and tally the human's play the robot's way */
export function replayPlay(file: string): Played & { seed: number } {
  const rep = JSON.parse(readFileSync(file, 'utf8')) as Replay & { seed: number; setups: { id: number; alliance: 'red' | 'blue' }[] };
  const setup = rep.setups[0];
  const p = new ReplayPlayer(rep);
  const T = new Tally();
  while (p.stepOnce()) {
    const r = p.world.robots.find((q) => q.id === setup.id)!;
    T.observe(p.world, r);
  }
  return { points: p.world.match.scores[setup.alliance].total, parts: T.parts, activity: T.activity, loads: T.loads, seed: rep.seed };
}

/** worker job: a replay's analysis (plain JSON) */
export function replayJob(a: { dir: string; file: string }): Played & { seed: number; file: string } {
  return { ...replayPlay(join(a.dir, a.file)), file: a.file };
}
