// TRAINING PLATFORM GATE — everything the unlimited trainer rests on, proven before any real run.
// Run: npm run check:train
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { init, newMatch } from '../harness/dsim';
import { loadProfile, resolve } from '../harness/profiles';
import { ES, GA, centeredRanks, DEFAULTS } from './algos';
import { paramCount, toB64 } from './net';
import { N_OBS, OBS_NAMES, encode } from './obs';
import { ACT_NAMES, SHAPE, decode } from './policy';
import { runEpisode, SHAPING, PENALTY, STALL_S, type EpisodeArgs } from './episode';
import { Engine, ROOT, defaultConfig } from './engine';
import { startServer } from './server';

let fails = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
await init();
const prof = resolve(loadProfile(join(ROOT, 'profiles/real-v0.json')));

// ---- 1. observation --------------------------------------------------------------------------------
{
  check('1 obs: one name per feature', OBS_NAMES.length === N_OBS && new Set(OBS_NAMES).size === N_OBS, `${N_OBS} features`);
  const w = newMatch(1, [{ id: 0, alliance: 'blue', spec: prof.spec, startIndex: 0 }]);
  const o = encode(w, w.robots[0], prof, new Float32Array(N_OBS));
  check('1 obs: finite and within ±4', [...o].every((v) => Number.isFinite(v) && Math.abs(v) <= 4));
  // DSIM's field is point-symmetric: a red robot at red's anchor must see exactly what a blue robot
  // at blue's anchor sees (proves the alliance mirroring)
  const wb = newMatch(1, [{ id: 0, alliance: 'blue', spec: prof.spec, startIndex: 1 }]);
  const wr = newMatch(1, [{ id: 0, alliance: 'red', spec: prof.spec, startIndex: 1 }]);
  const ob = encode(wb, wb.robots[0], prof, new Float32Array(N_OBS));
  const or = encode(wr, wr.robots[0], prof, new Float32Array(N_OBS));
  const diff = OBS_NAMES.filter((_, k) => Math.abs(ob[k] - or[k]) > 1e-4);
  check('1 obs: red and blue at mirrored anchors see identical observations', diff.length === 0, diff.join(', '));
}

// ---- 2. policy decoding --------------------------------------------------------------------------------
{
  check('2 policy: 6 actions', ACT_NAMES.length === 6 && SHAPE.sizes[SHAPE.sizes.length - 1] === 6);
  const y = new Float32Array([0, 0, 0, 1, 1, 1]);
  const a = decode(y, false);
  const b = decode(y, a.hp);
  check('2 policy: human-player button fires on the edge only', a.c.bbNectar === true && b.c.bbNectar === false && a.c.intake && a.c.fire);
}

// genomes with zero weights and chosen output biases (hidden layers output 0, so outputs = biases)
function genome(bias: Partial<Record<(typeof ACT_NAMES)[number], number>>): string {
  const p = new Float32Array(paramCount(SHAPE));
  const o = p.length - ACT_NAMES.length;
  ACT_NAMES.forEach((k, i) => (p[o + i] = bias[k] ?? -1));
  p[o + 0] = bias.driveX ?? 0;
  p[o + 1] = bias.driveY ?? 0;
  p[o + 2] = bias.rotate ?? 0;
  return toB64(p);
}
const base: EpisodeArgs = { genome: '', profile: 'profiles/real-v0.json', sampleProfile: false, seed: 4, stage: 'auto', shaping: 1, driver: 'oracle', track: true, record: false };

// ---- 3. episodes ------------------------------------------------------------------------------------------
{
  const still = genome({});
  const a = runEpisode({ ...base, genome: still });
  const b = runEpisode({ ...base, genome: still });
  check('3 episode: same genome + seed → identical result (fitness, path, events)', JSON.stringify(a) === JSON.stringify(b));
  check(`3 episode: a robot that never acts STALLS after ${STALL_S} s of AUTO`, a.death === 'stall' && Math.abs(a.deathTick - (240 + STALL_S * 60)) <= 2, `death ${a.death} at tick ${a.deathTick}`);
  // drive forward from anchor 0 (facing −y at x≈34) while strafing toward −x: into the blue HIVE frame leg
  const crash = runEpisode({ ...base, genome: genome({ driveY: 3, driveX: 0.35 }) });
  check('3 episode: driving into the HIVE frame is a CRASH death with its penalty', crash.death === 'crash' && crash.parts.violations >= 1, `death ${crash.death}, violations ${crash.parts.violations}, fitness ${crash.fitness.toFixed(1)}`);
  // hold fire at the start anchor: the preloads tip the HIVE (S1: anchor 0 is inside the envelope)
  const shoot = runEpisode({ ...base, genome: genome({ fire: 3 }) });
  const p = shoot.parts;
  const expect = shoot.score + 1 * (SHAPING.pickup * p.pickups + SHAPING.shotIn * p.shotsIn + SHAPING.hpEntry * p.hp) - (PENALTY.violation * p.violations + PENALTY.wastedShot * p.wasted + PENALTY.strike * p.strikes + (shoot.death === 'crash' ? PENALTY.crash : 0));
  check('3 episode: holding fire at the anchor tips the HIVE in AUTO', p.tips >= 1 && p.shotsIn >= 3 && shoot.score >= 20, `score ${shoot.score}, tips ${p.tips}, shots in ${p.shotsIn}`);
  check('3 episode: fitness = DSIM score + shaping − penalties, exactly', Math.abs(shoot.fitness - expect) < 1e-9, `${shoot.fitness} vs ${expect}`);
  const rec = runEpisode({ ...base, genome: genome({ fire: 3 }), record: true });
  check('3 episode: the champion recording is the same life', rec.score === shoot.score && !!rec.replay);
  const full = runEpisode({ ...base, genome: genome({ fire: 3, driveY: 0 }), stage: 'full', seed: 8 });
  check('3 episode: full-match stage runs past AUTO', full.ticks > 240 + 30 * 60 + 8 * 60 || full.death !== 'survived', `ticks ${full.ticks}, death ${full.death}`);
}

// ---- 4. algorithms -------------------------------------------------------------------------------------------
{
  const r = centeredRanks([3, 1, 2, 2]);
  check('4 centered ranks: ties averaged, range ±0.5', JSON.stringify(r) === JSON.stringify([0.5, -0.5, 0, 0]), JSON.stringify(r));
  // a known direction: maximize the mean parameter (linear, so any correct ES/GA must climb it
  // steadily; a 9,350-dim quadratic with 40 samples is too noisy to be a fair unit test)
  const f = (x: Float32Array): number => x.reduce((t, v) => t + v, 0) / x.length;
  const es = new ES({ ...DEFAULTS.es, seed: 5, pop: 40, lr: 0.05, weightDecay: 0 }, SHAPE);
  const f0 = f(es.current());
  for (let g = 0; g < 60; g++) es.tell(es.ask().map(f));
  const f1 = f(es.current());
  // expected climb: per-coordinate gradient SNR ≈ √pop/√n = √40/√9350 ≈ 0.065, so Adam's unit steps
  // drift ≈ lr × gens × 0.065 × ~0.8 ≈ 0.15 — a correct ES must clear 0.05; a broken one wanders at ~0
  check('4 ES climbs a known objective at the rate theory predicts', f1 - f0 > 0.05, `mean parameter ${f0.toFixed(3)} → ${f1.toFixed(3)} (theory ≈ +0.15)`);
  const ga = new GA({ ...DEFAULTS.ga, seed: 5, pop: 30, sigma: 0.02 }, SHAPE);
  const g0 = Math.max(...ga.ask().map(f));
  for (let g = 0; g < 40; g++) ga.tell(ga.ask().map(f));
  const g1 = Math.max(...ga.ask().map(f));
  check('4 GA climbs a known objective', g1 > g0 + 0.005, `best mean parameter ${g0.toFixed(4)} → ${g1.toFixed(4)}`);
  // save / restore: the restored algorithm proposes bit-identical candidates
  const es2 = new ES({ ...DEFAULTS.es, seed: 5, pop: 40, lr: 0.05, weightDecay: 0 }, SHAPE, JSON.parse(JSON.stringify(es.state())));
  const same = es.ask().every((c, i) => toB64(c) === toB64(es2.ask()[i]));
  const ga2 = new GA({ ...DEFAULTS.ga, seed: 5, pop: 30, sigma: 0.02 }, SHAPE, JSON.parse(JSON.stringify(ga.state())));
  const f2 = ga.ask().map(f);
  ga.tell(f2);
  ga2.tell(f2);
  check('4 ES and GA restore bit-exactly from their saved state', same && toB64(ga.current()) === toB64(ga2.current()));
}

// ---- 5. engine: stop and resume = never stopped ------------------------------------------------------------------
{
  const small = (name: string, maxGens: number) => ({ ...defaultConfig(name, 'es'), pop: 8, workers: 4, maxGens, stage: 'auto' as const, sampleProfile: true });
  for (const n of ['_check-a', '_check-b']) rmSync(join(ROOT, 'runs', n), { recursive: true, force: true });
  const a = new Engine(small('_check-a', 4), false);
  await a.run();
  const b1 = new Engine(small('_check-b', 2), false);
  await b1.run();
  const b2 = new Engine(small('_check-b', 4), true);
  await b2.run();
  const ma = a.history().map((g) => [g.gen, g.best, g.mean, g.bestScore, g.deaths]);
  const mb = b2.history().map((g) => [g.gen, g.best, g.mean, g.bestScore, g.deaths]);
  const ca = JSON.parse(readFileSync(join(a.dir, 'checkpoint.json'), 'utf8'));
  const cb = JSON.parse(readFileSync(join(b2.dir, 'checkpoint.json'), 'utf8'));
  check('5 engine: 2 + resume + 2 generations == 4 straight (every metric, the algorithm state, the champion)', JSON.stringify(ma) === JSON.stringify(mb) && JSON.stringify(ca.algoState) === JSON.stringify(cb.algoState) && ca.bestEver?.genome === cb.bestEver?.genome, `${ma.length} vs ${mb.length} generations`);
  check('5 engine: totals add up (spawned = generations × population)', ca.totals.spawned === 4 * 8 && ca.totals.deaths.crash + ca.totals.deaths.stall + ca.totals.deaths.survived === 32);
  check('5 engine: generation files + champion replay + DSIM snippet written', existsSync(join(a.dir, 'gens', '3.json')) && existsSync(join(a.dir, 'best.replay.json')) && existsSync(join(a.dir, 'best.inject.js')));

  // ---- 6. server ---------------------------------------------------------------------------------------------
  const srv = startServer(a, 4799);
  const get = async (p: string, init?: RequestInit) => {
    const r = await fetch(`http://127.0.0.1:4799${p}`, init);
    return { status: r.status, text: await r.text() };
  };
  const st = await get('/api/state');
  const field = await get('/api/field');
  const gens = await get('/api/gens');
  const g0 = await get('/api/gen/0');
  const best = await get('/api/best');
  const trav = await get('/../package.json');
  const trav2 = await get('/%2e%2e/%2e%2e/package.json');
  const ctl = await get('/api/control', { method: 'POST', body: JSON.stringify({ action: 'pause' }) });
  const bad = await get('/api/control', { method: 'POST', body: JSON.stringify({ action: 'explode' }) });
  srv.close();
  check('6 server: state, field, generation list, generation, champion all served', [st, field, gens, g0, best].every((r) => r.status === 200) && JSON.parse(gens.text).length === 4 && JSON.parse(st.text).history.length === 4);
  check('6 server: path traversal refused', trav.status === 404 && trav2.status === 404, `${trav.status}, ${trav2.status}`);
  check('6 server: control accepts pause, rejects unknown actions', ctl.status === 200 && a.paused === true && bad.status === 400);
  for (const n of ['_check-a', '_check-b']) rmSync(join(ROOT, 'runs', n), { recursive: true, force: true });
}

// ---- 7. the viewer ---------------------------------------------------------------------------------------------------
{
  let ok = true;
  let msg = '';
  try {
    execFileSync(join(ROOT, 'dsim-main/node_modules/.bin/tsc'), ['-p', join(ROOT, 'tsconfig.json')], { stdio: 'pipe' });
    execFileSync(join(ROOT, 'dsim-main/node_modules/.bin/vite'), ['build', join(ROOT, 'viewer'), '--config', join(ROOT, 'viewer/vite.config.ts'), '--logLevel', 'error'], { stdio: 'pipe' });
  } catch (e) {
    ok = false;
    msg = String((e as { stdout?: Buffer }).stdout ?? e).slice(0, 400);
  }
  check('7 viewer: whole project type-checks (strict) and the viewer builds', ok && existsSync(join(ROOT, 'train/public/index.html')), msg);
}

console.log(fails === 0 ? '\nTRAINING PLATFORM GATE: ALL PASS' : `\nTRAINING PLATFORM GATE: ${fails} FAIL`);
process.exit(fails ? 1 : 0);
