// S-1 feasibility check (PLAN.md §14.2, steps d–h). Imports DSIM read-only; edits nothing in it.
// Run: dsim-main/node_modules/.bin/tsx harness/s1-check.ts [--bench N]
import type { RobotCommand, RobotSpec, World } from '../dsim-main/src/types';
import * as C from '../dsim-main/src/config';
import { initPhysics } from '../dsim-main/src/sim/physicsEngine';
import { coerceSpec, DEFAULT_ASSISTS, type RobotSetup } from '../dsim-main/src/sim/spawn';
import { BB_DEFAULT_SPEC } from '../dsim-main/src/games/biobuzz/coerce';
import { createBiobuzzWorld } from '../dsim-main/src/games/biobuzz/spawn';
import { biobuzzStep } from '../dsim-main/src/games/biobuzz/step';
import { bbSettled } from '../dsim-main/src/games/biobuzz/settle';
import { newSettleClock, settleStep } from '../dsim-main/src/sim/settle';
import { ReplayRecorder, verifyReplay, worldResult } from '../dsim-main/src/sim/replay';
import { localizeCommand } from '../dsim-main/src/net/protocol';
import { ZERO_CMD } from '../dsim-main/src/sim/goal';

let fails = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// REAL-v0 concept (PLAN.md §1.1). Unknown performance values sit at a mid-envelope point here;
// S0 moves this into profiles/.
const RAW_REAL_V0: Partial<RobotSpec> = {
  name: 'REAL-v0',
  drivetrain: 'mecanum',
  driveRpm: 435,
  length: 15,
  width: 15,
  massLb: 30,
  ballStorage: 4,
  intakeMount: 'back',
  scoreMode: 'twinturret',
  shooterMount: 'front',
  bbMech: { launcher: { kind: 'twinturret', mount: 'front', mount2: 'back', hoodDeg: 75 }, lift: null },
} as Partial<RobotSpec>;

const cmd = (p: Partial<RobotCommand>): RobotCommand => ({ ...ZERO_CMD, ...p });

function setups(spec: RobotSpec): RobotSetup[] {
  return [
    {
      id: 0,
      alliance: 'blue',
      spec,
      assists: { ...DEFAULT_ASSISTS, fieldCentric: false, aimAssist: true, autoIntake: false, autoFire: false },
      startIndex: 0,
    },
  ];
}

// Scripted source: AUTO — hold fire 3 s (turrets pitch up, shoot preloads), then back off the
// wall to LEAVE; TELEOP — human-player press each 5 s, intake on, slow drive. Only exercises
// every channel; it is not a strategy.
function scripted(tick: number, w: World): Map<number, RobotCommand> {
  const ph = w.match.phase;
  const t = tick * C.SIM_DT;
  let c = cmd({});
  if (ph === 'auto') {
    const left = w.match.phaseTimeLeft;
    const into = C.AUTO_DURATION - left;
    c = into < 3 ? cmd({ fire: true }) : into < 3.6 ? cmd({ driveY: 0.6, fire: true }) : cmd({ fire: true });
  } else if (ph === 'teleop') {
    const hp = Math.floor(t * 60) % 300 === 0;
    c = cmd({ intake: true, fire: true, driveY: Math.sin(t) * 0.4, rotate: 0.2, bbNectar: hp });
  }
  return new Map([[0, c]]);
}

type Run = { world: World; replay: ReturnType<ReplayRecorder['finish']>; ticks: number };

// One full match exactly as DSIM solo practice finalizes it: step through `post` until the
// settle clock decides (game.ts frameLogic + harvestPracticeRun), recording every tick.
function runMatch(seed: number, spec: RobotSpec, src = scripted, from?: World): Run {
  const su = setups(spec);
  const world = from ?? createBiobuzzWorld('match', seed, su);
  if (!from) world.match.preCountdown = C.PRE_COUNTDOWN;
  const rec = new ReplayRecorder(seed, su, 'match', 'biobuzz');
  const clock = newSettleClock();
  for (let guard = 0; guard < 20000; guard++) {
    const tick = world.tick + 1;
    const raw = src(tick, world).get(0);
    const local = new Map([[0, raw ? localizeCommand(raw) : { ...ZERO_CMD }]]);
    biobuzzStep(world, C.SIM_DT, local);
    rec.record(tick, local);
    if (settleStep(clock, world, bbSettled)) break;
  }
  return { world, replay: rec.finish(), ticks: world.tick };
}

await initPhysics();

// ---- bench mode (child process) -------------------------------------------------------------
const bi = process.argv.indexOf('--bench');
if (bi > 0) {
  const n = Number(process.argv[bi + 1] ?? 3);
  const spec = coerceSpec(RAW_REAL_V0, BB_DEFAULT_SPEC, 'biobuzz');
  const t0 = performance.now();
  let ticks = 0;
  for (let i = 0; i < n; i++) ticks += runMatch(1000 + i, spec).ticks;
  console.log(JSON.stringify({ n, ms: performance.now() - t0, ticks }));
  process.exit(0);
}

// ---- export mode: one scripted match's replay + result, for the step-i viewer test -----------
const xi = process.argv.indexOf('--export');
if (xi > 0) {
  const { writeFileSync } = await import('node:fs');
  // piecewise-constant teleop (changes every 2 s) keeps the hold-last replay small
  const calm = (tick: number, w: World): Map<number, RobotCommand> => {
    if (w.match.phase !== 'teleop') return scripted(tick, w);
    const seg = Math.floor(tick / 120) % 4;
    const drive = [0.5, 0, -0.5, 0][seg];
    return new Map([[0, cmd({ intake: true, fire: true, driveY: drive, rotate: seg === 1 ? 0.5 : 0, bbNectar: tick % 600 === 0 })]]);
  };
  const r = runMatch(7, coerceSpec(RAW_REAL_V0, BB_DEFAULT_SPEC, 'biobuzz'), calm);
  writeFileSync(process.argv[xi + 1], JSON.stringify({ replay: r.replay, result: worldResult(r.world) }));
  console.log(`exported ${r.ticks} ticks, blue=${r.world.match.scores.blue.total}`);
  process.exit(0);
}

// ---- e: coerced spec ------------------------------------------------------------------------
const spec = coerceSpec(RAW_REAL_V0, BB_DEFAULT_SPEC, 'biobuzz');
const mech = (spec as { bbMech?: { launcher: { kind: string; mount: string; mount2?: string }; lift: unknown } }).bbMech;
check('e: launcher is a double turret', mech?.launcher.kind === 'twinturret', JSON.stringify(mech?.launcher));
check('e: POLLEN turret front, NECTAR turret back', mech?.launcher.mount === 'front' && mech?.launcher.mount2 === 'back');
check('e: no Box Tube', mech?.lift === null, JSON.stringify(mech?.lift));
check('e: intake at the back only', spec.intakeMount === 'back', String(spec.intakeMount));
check('e: hopper 4', spec.ballStorage === 4, String(spec.ballStorage));
check('e: mecanum', spec.drivetrain === 'mecanum');
console.log(`      coerced: rpm=${spec.driveRpm} L=${spec.length} W=${spec.width} mass=${spec.massLb} intake=${spec.intake}`);

// ---- d: one headless match ------------------------------------------------------------------
const t0 = performance.now();
const run = runMatch(7, spec);
const ms = performance.now() - t0;
const w = run.world;
const bb = (w as unknown as { biobuzz: { hives: Record<string, { tips: number; up: string }> } }).biobuzz;
const s = w.match.scores.blue;
check('d: match reached post and settled', w.match.phase === 'post', `phase=${w.match.phase} tick=${w.tick}`);
check('d: scored something (preload tip expected)', s.total > 0, `blue total=${s.total}, tips=${bb.hives.blue.tips}`);
check('d: no fouls against blue', w.match.scores.red.foulPoints === 0, `red.foulPoints=${w.match.scores.red.foulPoints}`);
console.log(`      match: ${w.tick} ticks in ${ms.toFixed(0)} ms = ${((w.tick * C.SIM_DT * 1000) / ms).toFixed(1)}x real time`);

// ---- f: replay reproduces bit-for-bit -------------------------------------------------------
const live = worldResult(w);
const rep = verifyReplay(JSON.parse(JSON.stringify(run.replay)));
check('f: replay score identical', rep.score.blue === live.score.blue && rep.score.red === live.score.red, `${rep.score.blue} vs ${live.score.blue}`);
check('f: replay world hash identical', rep.hash === live.hash, `${rep.hash} vs ${live.hash}`);
check('f: replay tick count identical', rep.ticks === live.ticks, `${rep.ticks} vs ${live.ticks}`);

// ---- g: clone mid-match and continue both ---------------------------------------------------
{
  const su = setups(spec);
  const a = createBiobuzzWorld('match', 11, su);
  a.match.preCountdown = C.PRE_COUNTDOWN;
  for (let i = 0; i < 4000; i++) {
    const tick = a.tick + 1;
    biobuzzStep(a, C.SIM_DT, new Map([[0, localizeCommand(scripted(tick, a).get(0)!)]]));
  }
  const b = structuredClone(a);
  const phaseAtClone = a.match.phase;
  const ra = runMatch(11, spec, scripted, a);
  const rb = runMatch(11, spec, scripted, b);
  check('g: clone at tick 4000 continues identically (full JSON)', JSON.stringify(ra.world) === JSON.stringify(rb.world), `cloned in ${phaseAtClone}`);
  // and the clone matches a straight-through run with no clone at all
  const straight = runMatch(11, spec);
  check('g: clone+continue equals uninterrupted run', JSON.stringify(ra.world.match.scores) === JSON.stringify(straight.world.match.scores) && worldResult(ra.world).hash === worldResult(straight.world).hash);
}

// ---- determinism across seeds sanity: seeds only differ after the first spill ---------------
{
  const r1 = runMatch(1, spec);
  const r2 = runMatch(1, spec);
  check('determinism: same seed twice → identical world', JSON.stringify(r1.world) === JSON.stringify(r2.world));
}

console.log(fails === 0 ? '\nS-1 d–g: ALL PASS' : `\nS-1 d–g: ${fails} FAIL`);
process.exit(fails ? 1 : 0);
