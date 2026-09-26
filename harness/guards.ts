// RULE GUARDS + ANOMALY DETECTORS (PLAN.md §7.2, §7.4) — the rules DSIM does not enforce, and
// DSIM physics oddities a policy must not profit from. Observe-only: never edits the world.
import { BB, DT, footprintCorners, footprintExtents, type Alliance, type RobotCommand, type World } from './dsim';
import { polysOverlap, rect, pointDepthInside } from './geom';
import { hpDropZone } from './filters';
import type { RuleOpts } from './filters';

export type GuardRule =
  | 'G417-hive-frame-contact'
  | 'G409-spill-catch'
  | 'G407-control-over-4'
  | 'G426-hp-entry-in-auto'
  | 'G427C-drop-zone-occupied'
  | 'DSIM-foul';
export type AnomalyKind = 'fast-ground-element' | 'strike-scored' | 'element-embedded-in-robot' | 'invalid-state' | 'element-count';

export interface GuardEvent {
  tick: number;
  rule: GuardRule | AnomalyKind;
  robot?: number;
  detail: string;
}
export interface GuardReport {
  violations: Partial<Record<GuardRule, number>>;
  anomalies: Partial<Record<AnomalyKind, number>>;
  /** struck elements that went on to score (PROFIT from the oddity), by the alliance they scored for */
  strikeProfit: Partial<Record<Alliance, number>>;
  /** rule violations by the robot that committed them (the rules that name one) */
  byRobot: Record<number, Partial<Record<GuardRule, number>>>;
  events: GuardEvent[];
}

const SPILL_CATCH_S = 0.4; // a 25 in drop takes ~0.36 s (PLAN.md §7.2); DSIM grounds spill at once
// feedback 000 #3: a struck element can leave FASTER than the robot that hit it. Flag a ground
// element being ACCELERATED this tick (a strike) to faster than every robot's fastest point by this margin, outside
// its spill/landing window (spills leave at ≤ 62 in/s; a landed shot keeps its horizontal speed).
// Pushing at robot speed is not flagged, nor is a kicked ball rolling on after its robot brakes.
const FAST_MARGIN = 10; // in/s
const EMBED_DEPTH = 1.0; // in — deeper than DSIM's own ~2.1 in residual is the reported oddity; 1.0 flags early
const EMBED_HOLD_S = 0.5;
/** A strike is an ANOMALY, not a foul: a ball knocked faster than the robot that hit it is ordinary
 * elastic physics (a ball bounces off a moving chassis at up to twice its speed), and fining every
 * one taught the robot to avoid elements (~23 points a match on REAL-v1). What a policy must not do
 * is PROFIT from it: a struck element that scores — enters a HIVE cell, or lies in a GARDEN once this
 * window has passed — is counted in `strikeProfit`, and only that is fined. */
const STRIKE_PROFIT_S = 3;
const inRectXY = (p: { x: number; y: number }, z: { x0: number; x1: number; y0: number; y1: number }): boolean => p.x >= z.x0 && p.x <= z.x1 && p.y >= z.y0 && p.y <= z.y1;

function chassisCorners(r: World['robots'][number]): { x: number; y: number }[] {
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const c = Math.cos(r.heading);
  const s = Math.sin(r.heading);
  return [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]].map(([x, y]) => ({ x: r.pos.x + x * c - y * s, y: r.pos.y + x * s + y * c }));
}

const frameBars = (): number[][] => [
  [BB.BB_FRAME_BAR_IN, -BB.BB_FRAME_Y, BB.BB_FRAME_BAR_OUT, BB.BB_FRAME_Y],
  [-BB.BB_FRAME_BAR_OUT, -BB.BB_FRAME_Y, -BB.BB_FRAME_BAR_IN, BB.BB_FRAME_Y],
];

export class Guards {
  private rep: GuardReport = { violations: {}, anomalies: {}, strikeProfit: {}, byRobot: {}, events: [] };
  private struck = new Map<number, number>(); // element id → tick of its latest strike
  private prevKind = new Map<number, string>();
  private prevEl = new Map<number, string>();
  private spillTick = new Map<number, number>();
  private landTick = new Map<number, number>();
  private frameContact = new Set<number>();
  private lastG407 = -10;
  private lastFast = new Map<number, number>();
  private prevSpeed = new Map<number, number>();
  private embedSince = new Map<string, number>();
  private readonly bars = frameBars().map(([a, b, c, d]) => rect(a, b, c, d));

  constructor(private rules: RuleOpts, private totalElements = 56) {}

  private add(tick: number, rule: GuardRule | AnomalyKind, detail: string, robot?: number, anomaly = false): void {
    const bucket = anomaly ? this.rep.anomalies : this.rep.violations;
    (bucket as Record<string, number>)[rule] = ((bucket as Record<string, number>)[rule] ?? 0) + 1;
    if (!anomaly && robot !== undefined) {
      const mine = (this.rep.byRobot[robot] ??= {}) as Record<string, number>;
      mine[rule] = (mine[rule] ?? 0) + 1;
    }
    if (this.rep.events.length < 500) this.rep.events.push({ tick, rule, robot, detail });
  }

  /** call once per tick, after the step, with the commands that were applied */
  observe(w: World, applied: Map<number, RobotCommand>): void {
    const t = w.tick;
    // DSIM's own fouls/warnings, logged for the report (DSIM already scores them)
    for (const e of w.events) if (/G\d{3}/.test(e)) this.add(t, 'DSIM-foul', e);

    for (const r of w.robots) {
      const fp = footprintCorners(r.spec, r.pos, r.heading);
      // G417: any contact with the HIVE frame (DSIM's own check is disabled, BB_G417_ENABLED)
      const touching = this.bars.some((bar) => polysOverlap(fp, bar, 0.25));
      if (touching && !this.frameContact.has(r.id)) this.add(t, 'G417-hive-frame-contact', `robot at (${r.pos.x.toFixed(1)},${r.pos.y.toFixed(1)})`, r.id);
      if (touching) this.frameContact.add(r.id);
      else this.frameContact.delete(r.id);

      if (!Number.isFinite(r.pos.x) || !Number.isFinite(r.pos.y) || Math.abs(r.pos.x) > 80 || Math.abs(r.pos.y) > 80)
        this.add(t, 'invalid-state', `robot ${r.id} pos ${r.pos.x},${r.pos.y}`, r.id, true);

      // G426 (conservative reading) / G427 C: judge the press that DSIM actually received
      const c = applied.get(r.id);
      if (c?.bbNectar) {
        if (w.match.phase === 'auto' && this.rules.hpInAuto === 'forbid') this.add(t, 'G426-hp-entry-in-auto', 'press during AUTO', r.id);
        if (w.robots.some((o) => polysOverlap(footprintCorners(o.spec, o.pos, o.heading), hpDropZone(r.alliance))))
          this.add(t, 'G427C-drop-zone-occupied', 'a robot covers the NECTAR drop area', r.id);
      }
    }

    // G407 as a violation (DSIM only warns): the warning event names the offender's alliance
    for (const e of w.events)
      if (e.includes('G407')) {
        if (t - this.lastG407 > 1) this.add(t, 'G407-control-over-4', e); // one per episode
        this.lastG407 = t;
      }

    if (w.balls.length !== this.totalElements) this.add(t, 'element-count', `${w.balls.length} elements`, undefined, true);

    // fastest POINT on any robot: a spinning corner moves at |v| + |ω|·(half-diagonal), which is
    // what really strikes a ball — the centre's speed alone flags ordinary spin hits
    const fastestRobot = Math.max(0, ...w.robots.map((r) => {
      const e = footprintExtents(r.spec);
      return Math.hypot(r.vel.x, r.vel.y) + Math.abs(r.angVel) * Math.hypot(Math.max(e.front, e.rear), e.half);
    }));
    for (const b of w.balls) {
      const kind = b.state.kind;
      const el = kind === 'element' ? (b.state as { el: string }).el : '';
      const pk = this.prevKind.get(b.id);
      // spill: an element leaving a HIVE cell onto the ground
      if (pk === 'element' && (this.prevEl.get(b.id) ?? '').startsWith('hive:') && kind === 'ground') this.spillTick.set(b.id, t);
      if (pk === 'flight' && kind === 'ground') this.landTick.set(b.id, t); // landed shot: exempt from the fast check only (G409 is HIVE releases only)
      const lt = this.landTick.get(b.id);
      if (lt !== undefined && (t - lt) * DT > 1.5) this.landTick.delete(b.id);
      const st = this.spillTick.get(b.id);
      if (kind === 'held' && pk !== 'held' && st !== undefined && (t - st) * DT < SPILL_CATCH_S)
        this.add(t, 'G409-spill-catch', `element ${b.id} captured ${((t - st) * DT).toFixed(2)} s after spilling`, (b.state as { robot: number }).robot);
      if (st !== undefined && (t - st) * DT > 1.5) this.spillTick.delete(b.id);

      if (kind === 'ground') {
        if (!Number.isFinite(b.pos.x) || !Number.isFinite(b.pos.y) || Math.abs(b.pos.x) > 73 || Math.abs(b.pos.y) > 73)
          this.add(t, 'invalid-state', `element ${b.id} at ${b.pos.x},${b.pos.y}`, undefined, true);
        const sp = Math.hypot(b.vel.x, b.vel.y);
        const accel = sp - (this.prevSpeed.get(b.id) ?? sp);
        this.prevSpeed.set(b.id, sp);
        if (accel > 5 && sp > fastestRobot + FAST_MARGIN && this.spillTick.get(b.id) === undefined && !this.landTick.has(b.id)) {
          if (t - (this.lastFast.get(b.id) ?? -1e9) > 60) this.add(t, 'fast-ground-element', `element ${b.id} at ${sp.toFixed(0)} in/s`, undefined, true);
          this.lastFast.set(b.id, t);
          this.struck.set(b.id, t);
        }
        for (const r of w.robots) {
          const key = `${b.id}:${r.id}`;
          // the CHASSIS box is DSIM's solid (artifactSolids chassis: ±L/2 × ±W/2); the intake
          // mouth lies outside it and is open by design, so it is not counted
          const depth = pointDepthInside(b.pos, chassisCorners(r));
          if (depth > EMBED_DEPTH) {
            const since = this.embedSince.get(key) ?? t;
            this.embedSince.set(key, since);
            if ((t - since) * DT >= EMBED_HOLD_S && (t - since) * DT < EMBED_HOLD_S + DT / 2)
            {
              const dx = b.pos.x - r.pos.x, dy = b.pos.y - r.pos.y, c = Math.cos(r.heading), s = Math.sin(r.heading);
              this.add(t, 'element-embedded-in-robot', `element ${b.id} ${depth.toFixed(1)} in inside robot ${r.id} at local (${(dx * c + dy * s).toFixed(1)}, ${(-dx * s + dy * c).toFixed(1)}) of ±${(r.spec.length / 2).toFixed(2)}×±${(r.spec.width / 2).toFixed(2)}`, r.id, true);
            }
          } else this.embedSince.delete(key);
        }
      }
      // did a struck element PROFIT: into a HIVE cell within the window, or lying in a GARDEN after it
      const sk = this.struck.get(b.id);
      if (sk !== undefined) {
        if (kind === 'element' && pk !== 'element' && el.startsWith('hive:')) {
          this.profit(t, el.slice(5) as Alliance, `struck element ${b.id} entered ${el}`);
          this.struck.delete(b.id);
        } else if ((t - sk) * DT > STRIKE_PROFIT_S) {
          if (kind === 'ground')
            for (const a of ['blue', 'red'] as const)
              if (inRectXY(b.pos, BB.BB_GARDEN[a])) this.profit(t, a, `struck element ${b.id} lies in the ${a} GARDEN`);
          this.struck.delete(b.id);
        }
      }
      this.prevKind.set(b.id, kind);
      this.prevEl.set(b.id, el);
    }
  }

  private profit(t: number, a: Alliance, detail: string): void {
    this.rep.strikeProfit[a] = (this.rep.strikeProfit[a] ?? 0) + 1;
    this.add(t, 'strike-scored', detail, undefined, true);
  }

  report(): GuardReport {
    return this.rep;
  }
}

export const violationCount = (g: GuardReport): number =>
  Object.entries(g.violations).reduce((n, [k, v]) => n + (k === 'DSIM-foul' ? 0 : (v ?? 0)), 0);
export type { Alliance };
