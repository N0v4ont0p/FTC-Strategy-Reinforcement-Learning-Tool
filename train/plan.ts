// A PLAN (MASTERPLAN §5) — what a robot does at each of its job starts, in order: "shoot the
// preloads", "the group at element 23", "FLOWER F3", "park". A step is remembered by WHAT it is,
// not by its place in an option list, so a plan found under one luck draw still applies under
// another: a group is found again by the element it went for first (or, if that one is gone, the
// group sharing the most of its elements), a FLOWER by its index, everything else by its kind.
import type { Option, OptionKind } from './skills';

export interface PlanStep {
  kind: OptionKind;
  anchor?: number; // a group: its first element
  balls?: number[]; // a group: its elements when planned
  flower?: number; // FLOWER retrieval / placement
  label: string;
}
/** a step as it was taken in a match (the timing sheet) */
export interface TakenStep extends PlanStep {
  robot: number;
  tick: number;
  end?: number; // tick the job ended
  matched: boolean; // false: the planned option was not there, the robot chose itself
}

export function stepOf(o: Option): PlanStep {
  const s: PlanStep = { kind: o.kind, label: o.label };
  if (o.anchor !== undefined) s.anchor = o.anchor;
  if (o.balls) s.balls = [...o.balls];
  if (o.flower !== undefined) s.flower = o.flower;
  return s;
}

/** the option in this list that carries out `step`, or -1 */
export function matchStep(opts: Option[], step: PlanStep): number {
  const same = opts.map((o, i) => [o, i] as const).filter(([o]) => o.kind === step.kind || (isGroup(o.kind) && isGroup(step.kind)));
  if (!same.length) return -1;
  if (step.flower !== undefined) return same.find(([o]) => o.flower === step.flower)?.[1] ?? -1;
  if (isGroup(step.kind)) {
    const byAnchor = same.find(([o]) => step.anchor !== undefined && (o.anchor === step.anchor || o.balls?.includes(step.anchor)));
    if (byAnchor) return byAnchor[1];
    let best = -1;
    let bestN = 0;
    for (const [o, i] of same) {
      const n = (o.balls ?? []).filter((b) => step.balls?.includes(b)).length;
      if (n > bestN) {
        bestN = n;
        best = i;
      }
    }
    return best;
  }
  return same[0][1];
}
const isGroup = (k: OptionKind): boolean => k === 'field' || k === 'lz';

/** a plan's identity (search dedupe, storage) */
export const planId = (p: PlanStep[][]): string =>
  p.map((steps) => steps.map((s) => `${s.kind}${s.anchor ?? s.flower ?? ''}`).join('>')).join('|');
