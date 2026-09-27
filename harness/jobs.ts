// Functions the worker pool runs (harness/pool.ts). Each takes plain JSON and returns plain JSON.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bb, recordScore, runMatch, type Seat } from './dsim';
import { loadProfile, resolve } from './profiles';
import { makeFilter, ORACLE, RULES_CONSERVATIVE } from './filters';
import { makePerturb, type ShotLog } from './perturb';
import { Guards, violationCount } from './guards';
import { randomController } from './control';
import { mulberry32, seedOf } from './rng';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** One full solo match: random agent on a (sampled) profile, every layer on. The crash test. */
export function randomMatch(a: { seed: number; profile: string; sample: boolean }) {
  const t0 = performance.now();
  const prof = resolve(loadProfile(join(root, a.profile)), a.sample ? mulberry32(seedOf(a.seed, 'sample')) : undefined);
  const seat: Seat = { id: 0, alliance: 'blue', spec: prof.spec, startIndex: a.seed % 4 };
  const guards = new Guards(RULES_CONSERVATIVE);
  const shots: ShotLog = { launched: 0, forcedMiss: 0 };
  const run = runMatch(a.seed, [seat], randomController(a.seed, [0]), {
    filter: makeFilter(a.seed, new Map([[0, prof.limits]]), ORACLE, RULES_CONSERVATIVE),
    perturb: makePerturb(a.seed, { blue: prof.perturb }, shots),
    after: (w, applied) => guards.observe(w, applied),
  }, { record: false });
  const w = run.world;
  const g = guards.report();
  const finite = w.balls.every((b) => Number.isFinite(b.pos.x) && Number.isFinite(b.pos.y) && Number.isFinite(b.z));
  return {
    seed: a.seed,
    point: prof.point,
    clamped: prof.clamped,
    expectFails: prof.expectFails,
    settled: run.settled,
    phase: w.match.phase,
    ticks: w.tick,
    score: recordScore(w, 'blue'),
    tips: bb(w).hives.blue.tips,
    foulsAgainstUs: w.match.scores.red.foulPoints,
    elements: w.balls.length,
    finite,
    shots,
    violations: g.violations,
    violationTotal: violationCount(g),
    anomalies: g.anomalies,
    ms: performance.now() - t0,
  };
}

/** busy for `ms`, then its tag (the gate's pool-scheduling check) */
export function spin(a: { ms: number; tag: string }): string {
  const t = Date.now();
  while (Date.now() - t < a.ms);
  return a.tag;
}
