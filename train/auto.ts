// THE AUTO PLANNER (MASTERPLAN §5, phase 2) — the best 30 s AUTO for our robot beside a partner,
// found by SEARCH in DSIM itself, not learned. AUTO is 0.2 s of simulation, so it can be searched
// exhaustively enough:
//   1. BEAM SEARCH over job choices. A node is a PLAN: each planned robot's job choices so far
//      (train/plan.ts). Its children: under a reference luck draw the plan is played until a planned
//      robot runs out of steps at a job start; each of that robot's options (the most promising
//      `branch` by its brain's own scores) extends the plan by one step. A child is scored by playing
//      the whole AUTO — plan, then the robot's own brain — under `draws` luck draws shared by every
//      child (common random numbers). The best `beam` plans go on.
//   2. FINALISTS on `finalDraws` fresh draws (and on robots drawn from the profile's range), ranked on
//      the mean AND the worst tenth (CVaR): one blown AUTO costs more than a small gain elsewhere.
//   3. CMA-ES on our robot's skill settings (speeds, margins, …) for the winning plan.
// Modes: BEST RESPONSE — the partner plays its own AUTO (its brain), only ours is planned (the case
// at an event); JOINT — both robots' AUTOs are planned together (for a partner that will run ours).
// The score is DSIM's AUTO points for the alliance, minus the guards' fouls (train/episode.ts reward).
import type { WorkerPool } from '../harness/pool';
import { seedOf } from '../harness/rng';
import { Episode, type EpisodeArgs } from './episode';
import { STYLE, genomeStyle } from './policy';
import { planId, stepOf, type PlanStep, type TakenStep } from './plan';
import { PARTNERS, type PartnerKind, type StartId } from './team';
import { cmaAsk, cmaInit, cmaTell } from './cma';
import type { Frames } from './episode';

export interface AutoProblem {
  profile: string;
  start: StartId;
  partner: PartnerKind | 'none';
  partnerStart?: StartId;
  mode: 'best' | 'joint';
  genome?: string | null; // our brain once the plan is done (default: the no-learning order)
  partnerGenome?: string | null;
  seed: number; // the luck draws derive from it
}
export interface AutoCfg {
  beam: number;
  branch: number;
  draws: number;
  maxDepth: number;
  finalists: number;
  finalDraws: number;
  sampledDraws: number; // robots drawn from the profile's range (robustness)
  cma: { pop: number; iters: number; draws: number } | null;
}
export const AUTO_CFG: AutoCfg = { beam: 16, branch: 6, draws: 3, maxDepth: 24, finalists: 6, finalDraws: 64, sampledDraws: 32, cma: { pop: 10, iters: 8, draws: 8 } };
/** a small budget: the gate and quick looks */
export const AUTO_QUICK: AutoCfg = { beam: 4, branch: 3, draws: 2, maxDepth: 8, finalists: 2, finalDraws: 12, sampledDraws: 6, cma: null };

export interface MeanTail {
  mean: number;
  ci95: number;
  cvar10: number; // mean of the worst tenth
  n: number;
}
export interface AutoResult {
  problem: AutoProblem;
  plan: PlanStep[][]; // per robot (the partner's empty in best-response mode)
  taken: TakenStep[]; // what happened on draw 0: who did what, when (the timing sheet)
  nominal: MeanTail; // our nominal robot, `finalDraws` draws
  sampled: MeanTail; // robots drawn from the profile's range
  baseline: MeanTail; // the same draws with no plan (every robot its own brain)
  style: number[] | null; // tuned skill settings (genes), null = the brain's own
  explored: number; // plans scored
  seconds: number;
  frames?: Frames; // draw 0, exact
  events?: [number, string][];
}

const mt = (v: number[]): MeanTail => {
  const n = v.length;
  const mean = v.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const s = [...v].sort((a, b) => a - b);
  const k = Math.max(1, Math.floor(n / 10));
  return { mean, ci95: n > 1 ? (1.96 * sd) / Math.sqrt(n) : 0, cvar10: s.slice(0, k).reduce((a, b) => a + b, 0) / k, n };
};
/** the ranking of finalists: half the mean, half the worst tenth */
const rank = (m: MeanTail): number => 0.5 * m.mean + 0.5 * m.cvar10;

/** the episode for luck draw k (`sample`: our robot drawn from the profile's range) */
export function autoArgs(P: AutoProblem, k: number, sample = false, extra: Partial<EpisodeArgs> = {}): EpisodeArgs {
  return {
    genome: P.genome ?? null,
    profile: P.profile,
    sampleProfile: sample,
    seed: seedOf(P.seed, 'auto', sample ? 'sampled' : 'nominal', k) % 1_000_000_007,
    stage: 'auto',
    driver: 'oracle',
    track: false,
    record: false,
    start: P.start,
    ...(P.partner === 'none' ? {} : { partner: { kind: P.partner, start: P.partnerStart, genome: P.partnerGenome ?? null } }),
    ...extra,
  };
}
/** which robots the plan covers */
export const plannedRobots = (P: AutoProblem): number[] => (P.mode === 'joint' && P.partner !== 'none' && PARTNERS[P.partner].mode === 'play' ? [0, 1] : [0]);

function arm(ep: Episode, plans: (PlanStep[] | null)[], style?: number[] | null): void {
  ep.brains.forEach((b, i) => {
    const p = plans[i];
    if (p) b.follow(p.map((s) => ({ ...s })));
  });
  if (style) ep.brain.setStyle(style);
}

// ─────────────────────────────── worker jobs (plain JSON in and out) ───────────────────────────────
/** play one plan under several draws; the AUTO reward of each */
export function playPlan(a: { args: EpisodeArgs[]; plans: (PlanStep[] | null)[]; style?: number[] | null }): number[] {
  return a.args.map((args) => {
    const ep = new Episode(args);
    arm(ep, a.plans, a.style);
    while (ep.step());
    return ep.reward();
  });
}

/** under the reference draw, play the plan until a planned robot starts a job past its plan: that
 * robot, when, and its options (as plan steps, with its brain's own score of each) — or null when
 * AUTO ends first */
export function nextChoice(a: { args: EpisodeArgs; plans: (PlanStep[] | null)[] }): { robot: number; tick: number; opts: { step: PlanStep; prior: number }[] } | null {
  const ep = new Episode(a.args);
  arm(ep, a.plans);
  ep.brains.forEach((b, i) => (b.stopAtFree = !!a.plans[i]));
  for (;;) {
    for (const b of ep.brains) {
      if (!b.free) continue;
      const f = b.free;
      return { robot: b.id, tick: f.tick, opts: f.opts.map((o, i) => ({ step: stepOf(o), prior: f.scores[i] })) };
    }
    if (!ep.step()) return null;
  }
}

/** play the plan once with exact frames and the timing sheet (the playbook's replay) */
export function showPlan(a: { args: EpisodeArgs; plans: (PlanStep[] | null)[]; style?: number[] | null }): { reward: number; taken: TakenStep[]; frames: Frames; events: [number, string][] } {
  const ep = new Episode({ ...a.args, frames: true });
  arm(ep, a.plans, a.style);
  const r = ep.run();
  return { reward: r.reward, taken: ep.brains.flatMap((b) => b.taken).sort((p, q) => p.tick - q.tick || p.robot - q.robot), frames: r.frames!, events: r.events ?? [] };
}

// ─────────────────────────────── the search ───────────────────────────────
interface Node {
  plans: (PlanStep[] | null)[];
  v: number; // mean reward on the search draws
}

export async function planAuto(P: AutoProblem, pool: WorkerPool, cfg: AutoCfg = AUTO_CFG, log: (s: string) => void = () => {}, stop: () => boolean = () => false): Promise<AutoResult> {
  const t0 = performance.now();
  const robots = plannedRobots(P);
  const nRob = P.partner === 'none' ? 1 : 2;
  const empty = (): (PlanStep[] | null)[] => Array.from({ length: nRob }, (_, i) => (robots.includes(i) ? [] : null));
  const ref = autoArgs(P, 0);
  const draws = Array.from({ length: cfg.draws }, (_, k) => autoArgs(P, 1000 + k));
  const job = (fn: string, args: unknown) => ({ module: '../train/auto.ts', fn, args });
  let explored = 0;

  let frontier: Node[] = [{ plans: empty(), v: -Infinity }];
  const complete: Node[] = [];
  for (let depth = 0; depth < cfg.maxDepth && frontier.length && !stop(); depth++) {
    const nexts = await pool.map<ReturnType<typeof nextChoice>>(frontier.map((n) => job('nextChoice', { args: ref, plans: n.plans })));
    const children: Node[] = [];
    frontier.forEach((n, i) => {
      const nx = nexts[i];
      if (!nx) {
        complete.push(n);
        return;
      }
      const top = nx.opts.map((o, k) => [o, k] as const).sort((p, q) => q[0].prior - p[0].prior || p[1] - q[1]).slice(0, cfg.branch);
      for (const [o] of top) {
        const plans = n.plans.map((p) => (p ? [...p] : null));
        plans[nx.robot]!.push(o.step);
        children.push({ plans, v: 0 });
      }
    });
    if (!children.length) break;
    const seen = new Set<string>();
    const uniq = children.filter((c) => {
      const id = planId(c.plans.map((p) => p ?? []));
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const vals = await pool.map<number[]>(uniq.map((c) => job('playPlan', { args: draws, plans: c.plans })));
    explored += uniq.length;
    uniq.forEach((c, i) => (c.v = vals[i].reduce((a, b) => a + b, 0) / vals[i].length));
    uniq.sort((a, b) => b.v - a.v);
    frontier = uniq.slice(0, cfg.beam);
    log(`depth ${depth + 1}: ${uniq.length} plans scored, best ${frontier[0].v.toFixed(1)} (${frontier[0].plans.map((p) => p?.length ?? '-').join('+')} steps)`);
  }
  complete.push(...frontier);
  const byV = [...new Map(complete.map((n) => [planId(n.plans.map((p) => p ?? [])), n])).values()].sort((a, b) => b.v - a.v).slice(0, cfg.finalists);

  // FINALISTS on fresh draws, and the no-plan baseline on the same draws
  const finals = Array.from({ length: cfg.finalDraws }, (_, k) => autoArgs(P, 5000 + k));
  const sampled = Array.from({ length: cfg.sampledDraws }, (_, k) => autoArgs(P, 9000 + k, true));
  const chunk = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));
  const score = async (plans: (PlanStep[] | null)[], args: EpisodeArgs[], style?: number[] | null): Promise<number[]> =>
    (await pool.map<number[]>(chunk(args, 4).map((c) => job('playPlan', { args: c, plans, style })))).flat();
  // "no plan" (every robot its own brain) is a finalist too: the playbook never recommends a plan
  // that is not better than the robot's own AUTO (an empty plan then says exactly that)
  const noPlan = await score(empty().map(() => null), finals);
  const baseline = mt(noPlan);
  let best: Node = { plans: empty(), v: -Infinity };
  let bestNom = baseline;
  for (const n of byV) {
    if (stop()) break;
    const m = mt(await score(n.plans, finals));
    if (rank(m) > rank(bestNom)) {
      best = n;
      bestNom = m;
    }
  }
  log(`finalists: best ${bestNom.mean.toFixed(1)} ± ${bestNom.ci95.toFixed(1)} (worst tenth ${bestNom.cvar10.toFixed(1)}), no plan ${baseline.mean.toFixed(1)}`);

  // CMA-ES on our robot's skill settings for the winning plan (from the brain's own settings)
  let style: number[] | null = null;
  if (cfg.cma && !stop()) {
    const cd = Array.from({ length: cfg.cma.draws }, (_, k) => autoArgs(P, 3000 + k));
    const own = genomeStyle(P.genome);
    let S = cmaInit(own, 0.4, seedOf(P.seed, 'auto-cma'));
    let bestX: number[] | null = null;
    let bestF = mt(await score(best.plans, cd)).mean;
    for (let it = 0; it < cfg.cma.iters && !stop(); it++) {
      const { x } = cmaAsk(S, cfg.cma.pop);
      // every candidate's draws in ONE batch (the pool balances it; it is not built for parallel calls)
      const res = await pool.map<number[]>(x.map((g) => job('playPlan', { args: cd, plans: best.plans, style: g })));
      const f = res.map((r) => r.reduce((a, b) => a + b, 0) / r.length);
      f.forEach((v, i) => {
        if (v > bestF) {
          bestF = v;
          bestX = x[i];
        }
      });
      S = cmaTell(S, x, f);
    }
    if (bestX) {
      const m = mt(await score(best.plans, finals, bestX));
      if (rank(m) > rank(bestNom)) {
        style = bestX;
        bestNom = m;
        log(`skill settings tuned: ${m.mean.toFixed(1)} (worst tenth ${m.cvar10.toFixed(1)})`);
      }
    }
  }
  const samp = mt(await score(best.plans, sampled, style));
  const show = (await pool.map<ReturnType<typeof showPlan>>([job('showPlan', { args: ref, plans: best.plans, style })]))[0];
  return {
    problem: P,
    plan: best.plans.map((p) => p ?? []),
    taken: show.taken,
    nominal: bestNom,
    sampled: samp,
    baseline,
    style,
    explored,
    seconds: (performance.now() - t0) / 1000,
    frames: show.frames,
    events: show.events,
  };
}

export const STYLE_KEYS = STYLE.map((s) => s.key);
