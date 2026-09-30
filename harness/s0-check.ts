// S0 GATE (PLAN.md §8): the harness is trustworthy before anything is built on it.
// Run: dsim-main/node_modules/.bin/tsx harness/s0-check.ts [--matches N]
import { readFileSync } from 'node:fs';
import { readPin, treeHash } from './pin';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bb, cmd, DT, init, newMatch, runMatch, snapshot, verifyReplay, worldResult, type RobotCommand, type Seat, type World } from './dsim';
import { loadProfile, resolve, type Limits } from './profiles';
import { makeFilter, ORACLE, HUMAN, RULES_CONSERVATIVE, RULES_NONE, hpDropZone } from './filters';
import { makePerturb, type ShotLog } from './perturb';
import { Guards } from './guards';
import { goTo } from './control';
import { exportReplay } from './export';
import { runPool } from './pool';
import { mulberry32, seedOf } from './rng';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

await init();
const REAL = loadProfile(join(root, 'profiles/real-v0.json'));
const DREAM = loadProfile(join(root, 'profiles/dream.json'));
const real = resolve(REAL);
const dream = resolve(DREAM);
const IDEAL: Limits = dream.limits; // every gate off
const seat = (spec = real.spec, startIndex = 0): Seat => ({ id: 0, alliance: 'blue', spec, startIndex });
const one = (c: RobotCommand) => () => new Map([[0, c]]);

// ---- 1. pin -----------------------------------------------------------------------------------
{
  const now = treeHash();
  const pin = readPin();
  check('1 pin: dsim-main source unchanged since pinning', now.treeSha256 === pin.treeSha256 && now.files === pin.files, `${now.files} files, ${now.treeSha256.slice(0, 12)}…`);
}

// ---- 2. profiles ------------------------------------------------------------------------------
check('2 REAL-v0 nominal: DSIM built exactly what was asked', real.expectFails.length === 0 && real.clamped.length === 0, [...real.expectFails, ...real.clamped].join('; '));
check('2 DREAM: DSIM built exactly the builder robot', dream.expectFails.length === 0 && dream.clamped.length === 0, [...dream.expectFails, ...dream.clamped].join('; '));
{
  let bad = 0;
  let first = '';
  for (let i = 0; i < 300; i++) {
    const s = resolve(REAL, mulberry32(seedOf(i, 'profile-sample')));
    if (s.expectFails.length || s.clamped.length) {
      bad++;
      first ||= [...s.expectFails, ...s.clamped].join('; ');
    }
  }
  check('2 REAL-v0 envelope: 300 samples, every one built as asked (no silent clamps)', bad === 0, bad ? `${bad} bad, e.g. ${first}` : '');
}

// ---- 3. assists -------------------------------------------------------------------------------
{
  const r = newMatch(1, [seat()]).robots[0];
  check('3 robot assists: robot-centric, aim assist on, auto-intake off, auto-fire off', r.fieldCentric === false && r.aimAssist === true && r.autoIntake === false && r.autoFire === false);
}

// scripted exercise controller: fire through AUTO, then roam with intake + fire + HP presses
const exercise = (w: World): Map<number, RobotCommand> => {
  const r = w.robots[0];
  const t = w.tick;
  if (w.match.phase === 'auto') return new Map([[0, t % 900 < 200 ? cmd({ fire: true }) : goTo(r, 30, 40 - (t % 600) / 20, undefined)]]);
  const tgt = [[40, -40], [55, -35], [30, 30], [45, 50]][Math.floor(t / 400) % 4];
  return new Map([[0, { ...goTo(r, tgt[0], tgt[1], Math.PI / 2), intake: true, fire: true, bbNectar: w.match.phase === 'teleop' && t % 300 === 0 }]]);
};

// ---- 4. DREAM limits are a true identity --------------------------------------------------------
{
  const a = runMatch(3, [seat(real.spec)], exercise, {}, { record: false }).world;
  const b = runMatch(3, [seat(real.spec)], exercise, { filter: makeFilter(3, new Map([[0, IDEAL]]), ORACLE, RULES_NONE) }, { record: false }).world;
  check('4 layer B with ideal limits changes nothing (full-JSON identical)', JSON.stringify(a) === JSON.stringify(b));
}

// ---- 5. filtered runs replay exactly in DSIM ----------------------------------------------------
{
  const run = runMatch(5, [seat()], exercise, { filter: makeFilter(5, new Map([[0, real.limits]]), HUMAN, RULES_CONSERVATIVE) });
  const live = worldResult(run.world);
  const rep = verifyReplay(JSON.parse(JSON.stringify(run.replay)));
  check('5 REAL-v0 + human driver model: replay reproduces score, hash, ticks', rep.hash === live.hash && rep.score.blue === live.score.blue && rep.ticks === live.ticks, `score ${live.score.blue}, hash ${live.hash}`);
  exportReplay(join(root, 'outputs/s0/real-v0-exercise'), run.replay!, { title: 'S0 exercise run', profile: 'REAL-v0 nominal, human tier', score: live.score.blue, replayExact: run.replayExact });
  const back = JSON.parse(readFileSync(join(root, 'outputs/s0/real-v0-exercise.replay.json'), 'utf8'));
  const rep2 = verifyReplay(back.replay);
  check('5 exported replay file re-verifies identically', rep2.hash === live.hash);
}

// ---- 6. layer B unit behaviour, on a real world object -------------------------------------------
function inAuto(spec = real.spec): World {
  const w = newMatch(9, [seat(spec)]);
  const z = new Map([[0, cmd()]]);
  while (w.match.phase !== 'auto') runMatch(9, [seat(spec)], () => z, {}, { record: false, from: w, maxTicks: 1 });
  return w;
}
function drive(w: World, L: Partial<Limits>, frames: { c: RobotCommand; setup?: (w: World) => void }[], rules = RULES_CONSERVATIVE, driver = ORACLE): RobotCommand[] {
  const f = makeFilter(1, new Map([[0, { ...IDEAL, ...L }]]), driver, rules);
  return frames.map((fr) => {
    fr.setup?.(w);
    const out = f(w, new Map([[0, fr.c]])).get(0)!;
    w.time += DT;
    w.tick += 1;
    return out;
  });
}
const rep = <T,>(n: number, x: T): T[] => Array.from({ length: n }, () => x);
{
  const w = inAuto();
  const r = w.robots[0];
  const fast = drive(w, { vIntake: 10, tSecure: 0.15 }, rep(60, { c: cmd({ intake: true }), setup: () => (r.vel = { x: 50, y: 0 }) }));
  check('6 intake blocked above vIntake', fast.every((c) => !c.intake));
  const slow = drive(w, { vIntake: 10, tSecure: 0.15 }, rep(30, { c: cmd({ intake: true }), setup: () => (r.vel = { x: 5, y: 0 }) }));
  const firstOn = slow.findIndex((c) => c.intake);
  check('6 intake passes only after tSecure of slow driving', firstOn >= Math.round(0.15 / DT) - 1 && firstOn <= Math.round(0.15 / DT) + 1, `first at tick ${firstOn}`);
  const failing = drive(w, { vIntake: 100, tSecure: 0, intakeSuccess: 0, intakeRetry: 0.4 }, rep(40, { c: cmd({ intake: true }), setup: () => (r.vel = { x: 0, y: 0 }) }));
  const on2 = failing.findIndex((c) => c.intake);
  check('6 failed intake attempt costs intakeRetry', on2 >= 23 && on2 <= 25, `first at tick ${on2} (0.4 s = 24)`);

  const moving = drive(w, { vFire: 20, aimSettle: 0.3 }, rep(40, { c: cmd({ fire: true }), setup: () => (r.vel = { x: 30, y: 0 }) }));
  check('6 fire blocked above vFire', moving.every((c) => !c.fire));
  const settling = drive(w, { vFire: 20, aimSettle: 0.3 }, rep(40, { c: cmd({ fire: true }), setup: () => (r.vel = { x: 0, y: 0 }) }));
  const f1 = settling.findIndex((c) => c.fire);
  check('6 fire waits aimSettle after slowing', f1 >= 17 && f1 <= 19, `first at tick ${f1} (0.3 s = 18)`);
  const rate = drive(w, { fireRate: 2 }, [
    { c: cmd({ fire: true }), setup: (w) => (w.robots[0].lastFireAt = w.time - 0.3) },
    { c: cmd({ fire: true }), setup: (w) => (w.robots[0].lastFireAt = w.time - 0.5) },
  ]);
  check('6 fire-rate cap: 0.3 s after a shot blocked, 0.5 s allowed at 2/s', !rate[0].fire && rate[1].fire);

  // turret travel: required yaw 150° off home with 180° of travel is unreachable; 60° is fine after slewing
  const aimAt = (deg: number) => (w: World) => {
    const rr = w.robots[0];
    rr.vel = { x: 0, y: 0 };
    rr.turretHeading = rr.heading + (deg * Math.PI) / 180;
    rr.hopper = ['yellow'];
  };
  const behind = drive(w, { turretYawRange: 180, turretSlew: 4 }, rep(120, { c: cmd({ fire: true }), setup: aimAt(150) }));
  check('6 turret: target outside travel never fires', behind.every((c) => !c.fire));
  const side = drive(w, { turretYawRange: 180, turretSlew: 4 }, rep(60, { c: cmd({ fire: true }), setup: aimAt(60) }));
  const f2 = side.findIndex((c) => c.fire);
  const expect = Math.ceil(((60 * Math.PI) / 180 - (2 * Math.PI) / 180) / 4 / DT);
  check('6 turret: reachable target fires after slewing at turretSlew', Math.abs(f2 - expect) <= 1, `first at tick ${f2}, expected ~${expect}`);
}
{
  // human player: delay, AUTO hold (conservative rule), and G427 C drop-zone hold
  const w = inAuto();
  const press = [{ c: cmd({ bbNectar: true }) }, ...rep(100, { c: cmd() })];
  const autoOut = drive(w, { hpDelay: 1.0 }, press);
  check('6 HP: press during AUTO is held while hpInAuto=forbid', autoOut.every((c) => !c.bbNectar));
  const w2 = inAuto();
  w2.match.phase = 'teleop';
  const out2 = drive(w2, { hpDelay: 1.0 }, press);
  const at = out2.findIndex((c) => c.bbNectar);
  check('6 HP: TELEOP press arrives after hpDelay, exactly once', at === 60 && out2.filter((c) => c.bbNectar).length === 1, `at tick ${at}`);
  const w3 = inAuto();
  w3.match.phase = 'teleop';
  const zone = hpDropZone('blue');
  const cx = (zone[0].x + zone[2].x) / 2;
  const cy = (zone[0].y + zone[2].y) / 2;
  const out3 = drive(w3, { hpDelay: 0 }, [{ c: cmd({ bbNectar: true }), setup: (w) => (w.robots[0].pos = { x: cx - 3, y: cy }) }, ...rep(20, { c: cmd() })]);
  check('6 HP: press held while a robot covers the drop zone (G427 C)', out3.every((c) => !c.bbNectar));
  // a robot about to cross into the zone this tick also holds the press (judged before the step)
  const w4 = inAuto();
  w4.match.phase = 'teleop';
  const edge = zone[0].x - 10.5; // footprint front ~1 in short of the zone, closing at 90 in/s
  const out4 = drive(w4, { hpDelay: 0 }, [{ c: cmd({ bbNectar: true }), setup: (w) => { const rr = w.robots[0]; rr.pos = { x: edge, y: cy }; rr.heading = 0; rr.vel = { x: 90, y: 0 }; rr.angVel = 0; } }]);
  check('6 HP: press held for a robot about to enter the drop zone this tick', !out4[0].bbNectar);
}
{
  // driver model: 0.25 s reaction, 10 Hz decisions, a one-tick button press never lost
  const w = inAuto();
  const seq = [...rep(5, { c: cmd() }), { c: cmd({ driveY: 1, bbNectar: true }) }, ...rep(40, { c: cmd({ driveY: 1 }) })];
  w.match.phase = 'teleop';
  const out = drive(w, { hpDelay: 0 }, seq, RULES_NONE, HUMAN);
  const firstDrive = out.findIndex((c) => c.driveY > 0);
  check('6 driver: input reaches the robot 0.25 s late, on the 10 Hz grid', firstDrive >= 20 && firstDrive <= 26, `tick ${firstDrive}`);
  check('6 driver: one-tick human-player press survives the hold window', out.filter((c) => c.bbNectar).length === 1);
}

// ---- 7. layer C: forced misses really miss, and runs are flagged not-exact ---------------------
{
  const fireAuto = (w: World) => new Map([[0, cmd({ fire: w.match.phase === 'auto' })]]);
  const hit = runMatch(11, [seat()], fireAuto, { perturb: makePerturb(11, { blue: { shotAccuracy: 1 } }) }, { record: false, maxTicks: 2600 });
  const log: ShotLog = { launched: 0, forcedMiss: 0 };
  const miss = runMatch(11, [seat()], fireAuto, { perturb: makePerturb(11, { blue: { shotAccuracy: 0 } }, log) }, { record: false, maxTicks: 2600 });
  check('7 accuracy 1.0: preloads tip the HIVE in AUTO', bb(hit.world).hives.blue.tips >= 1, `tips ${bb(hit.world).hives.blue.tips}`);
  check('7 accuracy 0.0: every launched element misses (no TIP, CELL untouched)', log.launched >= 3 && log.forcedMiss === log.launched && bb(miss.world).hives.blue.tips === 0 && bb(miss.world).hives.blue.contents.length === 3, `launched ${log.launched}, cell holds ${bb(miss.world).hives.blue.contents.length}`);
  check('7 a perturbed run is flagged replay-inexact', miss.replayExact === false && hit.replayExact === true);
}

// ---- 8. guards --------------------------------------------------------------------------------
{
  const g = new Guards(RULES_CONSERVATIVE);
  runMatch(13, [seat()], (w) => new Map([[0, goTo(w.robots[0], 26, 0)]]), { after: (w, a) => g.observe(w, a) }, { record: false, maxTicks: 900 });
  check('8 G417: driving into the HIVE frame is flagged', (g.report().violations['G417-hive-frame-contact'] ?? 0) >= 1);
  const g0 = new Guards(RULES_CONSERVATIVE);
  runMatch(13, [seat()], one(cmd()), { after: (w, a) => g0.observe(w, a) }, { record: false, maxTicks: 900 });
  check('8 a robot that never moves has no violations', Object.keys(g0.report().violations).length === 0, JSON.stringify(g0.report().violations));

  // G409 on a synthetic spill → capture sequence using a real world's element
  const w = newMatch(1, [seat()]);
  const gs = new Guards(RULES_CONSERVATIVE);
  const ball = w.balls.find((b) => b.state.kind === 'element' && (b.state as { el: string }).el === 'hive:blue')!;
  const none = new Map<number, RobotCommand>();
  gs.observe(w, none);
  w.tick++;
  ball.state = { kind: 'ground' };
  gs.observe(w, none);
  w.tick += 10;
  ball.state = { kind: 'held', robot: 0, slot: 0, lx: 0, ly: 0, side: 1 };
  gs.observe(w, none);
  check('8 G409: capture 10 ticks after a spill is flagged', (gs.report().violations['G409-spill-catch'] ?? 0) === 1);
  // anomalies
  const wa = snapshot(w);
  const ga = new Guards(RULES_CONSERVATIVE);
  const gb = wa.balls.find((b) => b.state.kind === 'ground')!;
  ga.observe(wa, none); // at rest: seen once so the next tick is a strike
  wa.tick++;
  gb.vel = { x: 100, y: 0 };
  ga.observe(wa, none);
  check('8 anomaly: an unexplained 100 in/s ground element is flagged', (ga.report().anomalies['fast-ground-element'] ?? 0) === 1);
  gb.vel = { x: 0, y: 0 };
  gb.pos = { ...wa.robots[0].pos };
  for (let i = 0; i < 40; i++) {
    wa.tick++;
    ga.observe(wa, none);
  }
  check('8 anomaly: an element buried in the chassis for 0.5 s is flagged once', (ga.report().anomalies['element-embedded-in-robot'] ?? 0) === 1);
  // a ball pushed along at robot speed is ordinary play, not the struck-element oddity
  const wp = snapshot(w);
  const gp = new Guards(RULES_CONSERVATIVE);
  const pb = wp.balls.find((b) => b.state.kind === 'ground')!;
  gp.observe(wp, none);
  wp.tick++;
  wp.robots[0].vel = { x: 95, y: 0 };
  pb.vel = { x: 100, y: 0 };
  gp.observe(wp, none);
  // and a ball already rolling at 60 in/s after its robot stopped is not a strike
  wp.tick++;
  wp.robots[0].vel = { x: 0, y: 0 };
  pb.vel = { x: 60, y: 0 };
  gp.observe(wp, none);
  check('8 anomaly: a ball pushed at robot speed, or rolling on after the robot stops, is NOT flagged', (gp.report().anomalies['fast-ground-element'] ?? 0) === 0);
  // catching your own landed miss is legal (G409 covers HIVE releases only)
  const wl = snapshot(w);
  const gl = new Guards(RULES_CONSERVATIVE);
  const lb = wl.balls.find((b) => b.state.kind === 'ground')!;
  lb.state = { kind: 'flight', target: 'blue', by: 'blue' };
  gl.observe(wl, none);
  wl.tick++;
  lb.state = { kind: 'ground' };
  gl.observe(wl, none);
  wl.tick += 5;
  lb.state = { kind: 'held', robot: 0, slot: 0, lx: 0, ly: 0, side: 1 };
  gl.observe(wl, none);
  check('8 G409: catching a landed missed shot is NOT flagged', (gl.report().violations['G409-spill-catch'] ?? 0) === 0);
  // HP presses as DSIM received them
  const wh = newMatch(1, [seat()]);
  wh.match.phase = 'auto';
  const gh = new Guards(RULES_CONSERVATIVE);
  gh.observe(wh, new Map([[0, cmd({ bbNectar: true })]]));
  check('8 G426 (conservative): a press that reached DSIM in AUTO is flagged', (gh.report().violations['G426-hp-entry-in-auto'] ?? 0) === 1);
  wh.events.push('WARNING - BLUE (G407 CONTROL of 5+ elements)');
  gh.observe(wh, new Map());
  gh.observe(wh, new Map()); // (DSIM keeps the event in world.events: read once, not every tick)
  wh.events.push('MAJOR FOUL - RED +15 (G407 STRATEGIC CONTROL of 5+ elements)');
  gh.observe(wh, new Map());
  check('8 G407: each DSIM warning is counted once as a violation (DSIM scores its own MAJOR)', (gh.report().violations['G407-control-over-4'] ?? 0) === 1 && (gh.report().byAlliance.blue?.['G407-control-over-4'] ?? 0) === 1);
}

// ---- 9. determinism with every layer on ----------------------------------------------------------
{
  const go = () =>
    runMatch(21, [seat()], exercise, {
      filter: makeFilter(21, new Map([[0, real.limits]]), HUMAN, RULES_CONSERVATIVE),
      perturb: makePerturb(21, { blue: real.perturb }),
    }, { record: false }).world;
  check('9 same seed, every layer on → identical world (full JSON)', JSON.stringify(go()) === JSON.stringify(go()));
}

// ---- 10. crash test across the envelope (parallel) ------------------------------------------------
{
  const n = Number(process.argv[process.argv.indexOf('--matches') + 1]) || 800;
  const t0 = performance.now();
  type R = Awaited<ReturnType<typeof import('./jobs').randomMatch>>;
  const res = await runPool<R>(Array.from({ length: n }, (_, i) => ({ module: 'jobs.ts', fn: 'randomMatch', args: { seed: 100000 + i, profile: 'profiles/real-v0.json', sample: true } })), 8);
  const wall = (performance.now() - t0) / 1000;
  const bad = res.filter((r) => !r.settled || r.phase !== 'post' || r.elements !== 56 || !r.finite || r.anomalies['invalid-state'] || r.anomalies['element-count'] || r.expectFails.length || r.clamped.length);
  check(`10 crash test: ${n} random-agent matches on sampled REAL-v0 robots, all settle with every invariant`, bad.length === 0, bad.length ? `first bad seed ${bad[0].seed}` : '');
  const launched = res.reduce((s, r) => s + r.shots.launched, 0);
  const missed = res.reduce((s, r) => s + r.shots.forcedMiss, 0);
  const expMiss = res.reduce((s, r) => s + r.shots.launched * (1 - r.point['perturb.shotAccuracy']), 0);
  const sd = Math.sqrt(res.reduce((s, r) => s + r.shots.launched * r.point['perturb.shotAccuracy'] * (1 - r.point['perturb.shotAccuracy']), 0));
  check('10 forced-miss count matches the sampled accuracies (within 3 sigma)', launched > 100 && Math.abs(missed - expMiss) <= 3 * sd, `${missed} missed of ${launched}, expected ${expMiss.toFixed(0)} ± ${(3 * sd).toFixed(0)}`);
  const sum = (k: string, src: 'violations' | 'anomalies') => res.reduce((s, r) => s + ((r[src] as Record<string, number>)[k] ?? 0), 0);
  const scores = res.map((r) => r.score).sort((a, b) => a - b);
  console.log(`      ${n} matches in ${wall.toFixed(0)} s = ${((n / wall) * 3600).toFixed(0)} matches/hour on 8 workers`);
  console.log(`      random-agent score: median ${scores[n >> 1]}, max ${scores[n - 1]}; tips/match ${(res.reduce((s, r) => s + r.tips, 0) / n).toFixed(2)}`);
  console.log(`      random agent's rule hits (expected, it is random): G417 ${sum('G417-hive-frame-contact', 'violations')}, G409 ${sum('G409-spill-catch', 'violations')}, G407 ${sum('G407-control-over-4', 'violations')}, G426 ${sum('G426-hp-entry-in-auto', 'violations')}, G427C ${sum('G427C-drop-zone-occupied', 'violations')}`);
  console.log(`      DSIM oddities seen: fast element ${sum('fast-ground-element', 'anomalies')}, embedded element ${sum('element-embedded-in-robot', 'anomalies')}`);
  check('10 filters never let a conservative-rule HP violation through (G426, G427C = 0)', sum('G426-hp-entry-in-auto', 'violations') === 0 && sum('G427C-drop-zone-occupied', 'violations') === 0);
}

console.log(fails === 0 ? '\nS0 GATE: ALL PASS' : `\nS0 GATE: ${fails} FAIL`);
process.exit(fails ? 1 : 0);
