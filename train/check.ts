// TRAINING PLATFORM GATE — everything the studio and the trainer rest on, proven before a real run.
// Run: npm run check:train   (a few minutes: it plays real DSIM matches)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { BB, bbEvalStart, coerce, footprintCorners, init } from '../harness/dsim';
import { loadProfile, resolve } from '../harness/profiles';
import { polysOverlap, rect } from '../harness/geom';
import { ES, GA, centeredRanks, DEFAULTS, validate, type AlgoConfig } from './algos';
import { paramCount } from './net';
import { SHAPE } from './policy';
import { N_OBS } from './obs';
import { N_OPT_FEATS, spawnPose } from './skills';
import { runEpisode, type EpisodeArgs } from './episode';
import { Engine, ROOT, defaultConfig, type RunConfig } from './engine';
import { startServer } from './server';
import { DATA_DIR, demonstrations, imitationGenome, imitationReport } from './imitate';

let fails = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
await init();
const prof = resolve(loadProfile(join(ROOT, 'profiles/real-v0.json')));

// ---- 1. the start pose ------------------------------------------------------------------------------------
{
  const corners = [13.5, 15].flatMap((L) => [14.5, 17].map((W) => coerce({ ...prof.spec, length: L, width: W })));
  const poses = [prof.spec, ...corners].map((s) => ({ s, p: spawnPose(s) }));
  const legal = poses.every(({ s, p }) => bbEvalStart(s, p, 'blue').legal);
  const f3 = BB.BB_FLOWERS[2];
  const beside = poses.every(({ p }) => p.x > 55 && p.y > f3.y + BB.BB_FLOWER_FOOT.along / 2 && p.y < f3.y + 16 && p.headingDeg === 180);
  check('1 spawn: G304-legal for the nominal robot and all 4 size corners of REAL-v0', legal);
  check('1 spawn: against the blue wall just right of FLOWER F3 (bottom right of the view), facing the field', beside, poses.map(({ p }) => `(${p.x}, ${p.y})`).join(' '));
}

// ---- 2. the skills play the game (greedy baseline, full real-robot limits, rule guards on) ------------------
const base = (seed: number, extra: Partial<EpisodeArgs> = {}): EpisodeArgs => ({ genome: null, profile: 'profiles/real-v0.json', sampleProfile: true, seed, stage: 'full', shaping: 0, driver: 'oracle', track: true, record: false, ...extra });
{
  const R = [11, 12, 13, 14, 15, 16].map((s) => runEpisode(base(s)));
  const crashes = R.filter((r) => r.death === 'crash').length;
  const shotsIn = R.reduce((a, r) => a + r.parts.shotsIn, 0);
  const wasted = R.reduce((a, r) => a + r.parts.wasted, 0);
  const kinds = new Set(R.flatMap((r) => (r.decisions ?? []).map((d) => d[1])));
  check('2 skills: no robot crashes into the HIVE frame (6 full matches, sampled robots)', crashes === 0, `${crashes} crashes`);
  check('2 skills: it SHOOTS and SCORES — shots go in and the HIVE tips in every match', R.every((r) => r.parts.shotsIn > 10 && r.parts.tips >= 1), R.map((r) => `${r.score} pts/${r.parts.tips} tips`).join(', '));
  check('2 skills: misses stay near the launcher accuracy (fire only when a shot can land)', wasted <= 0.3 * (shotsIn + wasted), `${wasted} missed of ${shotsIn + wasted}`);
  check('2 skills: every option kind is used (field, loading zone or FLOWER, shoot, human player, park)', [0, 3, 4, 5].every((k) => kinds.has(k)) && (kinds.has(1) || kinds.has(2)), [...kinds].sort().join(','));
  check('2 skills: robots mostly live the whole match', R.filter((r) => r.death === 'survived').length >= 5, R.map((r) => r.death).join(','));
}

// ---- 3. episodes: determinism and exact frames -------------------------------------------------------------
{
  const g = imitationGenome();
  const a = runEpisode(base(21, { genome: g, frames: true }));
  const b = runEpisode(base(21, { genome: g, frames: true }));
  check('3 episode: same network + seed → identical life (score, path, decisions, frames)', a.fitness === b.fitness && a.track === b.track && JSON.stringify(a.decisions) === JSON.stringify(b.decisions) && JSON.stringify(a.frames) === JSON.stringify(b.frames));
  const f = a.frames!.f;
  const last = f[f.length - 1];
  check('3 frames: one frame every 2 ticks for the whole life, every element in every frame', f.length >= Math.floor(a.ticks / 2) && f.every((q) => q.b.length === 3 * a.frames!.meta.length));
  check('3 frames: the last frame shows the final DSIM score', Math.max(0, last.m[2] - last.m[3]) === a.score, `${last.m[2] - last.m[3]} vs ${a.score}`);
  const shaped = runEpisode(base(21, { genome: g, shaping: 1, weights: { shaping: { pickup: 1, shotIn: 2, hpEntry: 3 }, penalty: { violation: 10, wastedShot: 1, strike: 2, crash: 5 } } }));
  const p = shaped.parts;
  const want = shaped.score + p.pickups + 2 * p.shotsIn + 3 * p.hp - (10 * p.violations + p.wasted + 2 * p.strikes + (shaped.death === 'crash' ? 5 : 0));
  check("3 fitness = DSIM score + hints − penalties, with the run's own weights", Math.abs(shaped.fitness - want) < 1e-9);
  const auto = runEpisode(base(22, { stage: 'auto', track: false }));
  check('3 episode: AUTO-only stops at the end of AUTO', auto.ticks <= 240 + 30 * 60 + 2 && auto.ticks >= 240 + 30 * 60 - 2, `${auto.ticks} ticks`);
  const wr = runEpisode(base(23, { profile: 'profiles/dream.json', sampleProfile: false }));
  check('3 skills: a front+back intake build (DREAM) plays too', wr.parts.shotsIn > 10 && wr.death !== 'crash', `${wr.score} pts`);
}

// ---- 4. imitation of the team's replays ------------------------------------------------------------------
if (existsSync(DATA_DIR) && readdirSync(DATA_DIR).some((f) => f.endsWith('.json'))) {
  const file = readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort()[0];
  const d = demonstrations(join(DATA_DIR, file), prof);
  check('4 imitation: a replay re-simulates in DSIM and yields demonstrations', d.score > 0 && d.samples.length > 100, `${file.slice(0, 32)}…: ${d.score} pts, ${d.samples.length} decisions`);
  const r = imitationReport()!;
  check('4 imitation: the fitted network agrees with a HELD-OUT replay well above chance', r.holdout.agree > 2 * r.holdout.chance, `${(100 * r.holdout.agree).toFixed(1)}% vs chance ${(100 * r.holdout.chance).toFixed(1)}%`);
  check('4 imitation: same network shape as the policy', r.params === paramCount(SHAPE) && SHAPE.sizes[0] === N_OBS + N_OPT_FEATS);
} else console.log('SKIP  4 imitation: no replays in "Training data/"');

// ---- 5. algorithms ----------------------------------------------------------------------------------------
{
  const cfg = (algo: 'ga' | 'es', pop: number): AlgoConfig => ({ ...DEFAULTS[algo], algo, pop, seed: 5 });
  const ga = new GA(cfg('ga', 12), SHAPE);
  const L0 = ga.lineage();
  ga.tell(ga.ask().map((_, i) => i)); // fitness = index: the last is best
  const L1 = ga.lineage();
  const ids = new Set(L1.map((l) => l.id));
  const elites = L1.filter((l) => l.op === 'elite');
  check('5 GA: elites survive with their own id; the rest are new, unique ids', ids.size === L1.length && elites.length === 4 && elites.every((e) => L0.some((l) => l.id === e.id)) && elites[0].id === L0[11].id);
  check('5 GA: children name their parents (mutant: 1, cross: 2) and count mutated genes', L1.filter((l) => l.op === 'mutant').every((l) => l.parents.length === 1 && l.muts > 0) && L1.filter((l) => l.op === 'cross').every((l) => l.parents.length === 2));
  const again = new GA(cfg('ga', 12), SHAPE, JSON.parse(JSON.stringify(ga.state())));
  const f = ga.ask().map((_, i) => (i * 7) % 5);
  ga.tell(f);
  again.tell(f);
  check('5 GA: state round trip continues bit-exactly', JSON.stringify(ga.state()) === JSON.stringify(again.state()));
  ga.setConfig({ pop: 20 });
  ga.tell(ga.ask().map((_, i) => i));
  check('5 GA: a population change takes effect at the next generation', ga.ask().length === 20);
  const seeded = new GA(cfg('ga', 6), SHAPE, undefined, new Float32Array(paramCount(SHAPE)).fill(0.5));
  check('5 GA: a seeded population = the seed network + its mutants', seeded.lineage()[0].op === 'seed' && seeded.ask()[0].every((v) => v === 0.5) && seeded.lineage().slice(1).every((l) => l.op === 'mutant'));
  const es = new ES(cfg('es', 8), SHAPE);
  const c = es.ask();
  check('5 ES: mirrored pairs around the mean', c.length === 8 && c[0].every((v, k) => Math.abs(v + c[1][k] - 2 * es.current()[k]) < 1e-6));
  check('5 centered ranks: in [-0.5, 0.5], ties averaged', centeredRanks([3, 1, 3, 2]).every((v, i) => Math.abs(v - [1 / 3, -0.5, 1 / 3, -1 / 6][i]) < 1e-12));
  check('5 settings: bad values rejected with a reason', validate(cfg('ga', 3)) !== null && validate(cfg('es', 7)) !== null && validate(cfg('ga', 12)) === null);
}

// ---- 6. the engine: checkpoints, rewind (bit-exact), fork, abort, settings, evaluation -----------------------
const small = (name: string): RunConfig => ({ ...defaultConfig(name, 'ga'), pop: 8, workers: 4, seed: 3, ckEvery: 2, init: 'imitation' });
for (const n of ['_check-a', '_check-f']) rmSync(join(ROOT, 'runs', n), { recursive: true, force: true });
{
  const e = Engine.create(small('_check-a'));
  /** run n generations with the "+n" control and wait until it has paused, then stop the loop */
  const stepRun = async (n: number): Promise<void> => {
    const target = e.gen + n;
    const stopped = new Promise<void>((r) => e.once('stopped', () => r()));
    e.start(n);
    await new Promise<void>((r) => {
      const t = setInterval(() => {
        if (e.paused && e.gen === target) {
          clearInterval(t);
          r();
        }
      }, 100);
    });
    await e.halt();
    await stopped;
  };
  await stepRun(2);
  check('6 engine: "+2 generations" runs exactly two, then pauses', e.gen === 2 && e.history().length === 2);
  const ck = e.checkpoint('mark')!;
  check('6 checkpoints: an automatic one at generation 2 (every 2) plus the named one', e.listCheckpoints().some((m) => m.auto && m.gen === 2) && ck.gen === 2);
  await stepRun(2);
  const first = e.history().slice(2).map((g) => [g.gen, g.best, g.mean, g.bestScore, g.ops]);
  const stateAt4 = JSON.parse(readFileSync(join(e.dir, 'checkpoint.json'), 'utf8')).algoState;
  await e.rewind(ck.id);
  check('6 rewind: back to generation 2 — history and generation files trimmed, the present kept as a pinned checkpoint', e.gen === 2 && e.history().length === 2 && !existsSync(join(e.dir, 'gens', '2.json')) && e.listCheckpoints().some((m) => m.pinned && m.label.startsWith('before rewind') && m.gen === 4));
  await stepRun(2);
  const again = e.history().slice(2).map((g) => [g.gen, g.best, g.mean, g.bestScore, g.ops]);
  check('6 rewind is exact: the same two generations again give identical results and algorithm state', JSON.stringify(first) === JSON.stringify(again) && JSON.stringify(stateAt4) === JSON.stringify(JSON.parse(readFileSync(join(e.dir, 'checkpoint.json'), 'utf8')).algoState));
  const undo = e.listCheckpoints().find((m) => m.label.startsWith('before rewind'))!;
  e.fork(undo.id, '_check-f', { sigma: 0.1 });
  const f = Engine.open('_check-f');
  check('6 fork: a new run at the checkpoint, with the changed setting, the source untouched', f.gen === 4 && f.config.sigma === 0.1 && e.config.sigma === DEFAULTS.ga.sigma && f.history().length === 4);
  let threw = '';
  try {
    e.setConfig({ algo: 'es' });
  } catch (x) {
    threw = (x as Error).message;
  }
  const changed = e.setConfig({ sigma: 0.07, crossRate: 0.5 });
  check('6 settings: live changes applied and logged; run-defining ones refused', changed.sigma === 0.07 && e.config.crossRate === 0.5 && threw.includes('cannot change') && e.events().some((x) => x.text.includes('sigma')));
  const before = readFileSync(join(e.dir, 'checkpoint.json'), 'utf8');
  const stopped = new Promise<void>((r) => e.once('stopped', () => r()));
  e.start();
  await new Promise<void>((r) => e.once('progress', () => setTimeout(r, 1500)));
  e.abort();
  await stopped;
  check('6 abort: the generation in progress is discarded; the run is exactly as before', readFileSync(join(e.dir, 'checkpoint.json'), 'utf8') === before && e.gen === 4);
  const ev = await e.evaluate('greedy', 4);
  const ev2 = await e.evaluate('greedy', 4);
  check('6 evaluation: held-out matches, reproducible, logged', ev.n === 4 && JSON.stringify(ev.scores) === JSON.stringify(ev2.scores) && e.evals().length === 2);
  check('6 files: exact frames per generation, champion frames, replay and DSIM snippet', existsSync(join(e.dir, 'gens', '3.frames.json.gz')) && JSON.parse(gunzipSync(readFileSync(join(e.dir, 'best.frames.json.gz'))).toString()).frames.f.length > 100 && existsSync(join(e.dir, 'best.inject.js')));

  // ---- 7. server --------------------------------------------------------------------------------------------
  const srv = startServer(4798, e);
  const req = async (p: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:4798${p}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };
  const st = await req('/api/state');
  const frames = await req('/api/gen/3/frames');
  const trav = await req('/../package.json');
  const trav2 = await req('/%2e%2e/%2e%2e/package.json');
  const bad = await req('/api/control', { action: 'explode' });
  const badCk = await req('/api/checkpoints/..%2f..%2fx/rewind', {});
  const del = await req('/api/runs/delete', { name: '_check-f', confirm: 'nope' });
  const legacy = existsSync(join(ROOT, 'runs', '_ui-test')) ? await req('/api/runs/open', { name: '_ui-test' }) : null;
  const csv = await req('/api/export/metrics.csv');
  await srv.close();
  check('7 server: state with history, checkpoints and evaluations; exact frames served', st.status === 200 && JSON.parse(st.text).run.history.length === 4 && JSON.parse(st.text).run.checkpoints.length >= 3 && frames.status === 200);
  check('7 server: path traversal and bad ids refused', trav.status === 404 && trav2.status === 404 && badCk.status >= 400, `${trav.status}, ${trav2.status}, ${badCk.status}`);
  check('7 server: unknown actions rejected; deleting a run needs its name typed back', bad.status === 400 && del.status === 400 && existsSync(join(ROOT, 'runs', '_check-f')));
  if (legacy) check('7 server: a run from the first (raw joystick) version is refused with a reason, files untouched', legacy.status === 404 && legacy.text.includes('first training version') && existsSync(join(ROOT, 'runs', '_ui-test', 'checkpoint.json')));
  check('7 server: metrics export', csv.status === 200 && csv.text.split('\n').length === 5);
}
for (const n of ['_check-a', '_check-f']) rmSync(join(ROOT, 'runs', n), { recursive: true, force: true });

// ---- 8. geometry --------------------------------------------------------------------------------------------
{
  const bars = [rect(BB.BB_FRAME_BAR_IN, -BB.BB_FRAME_Y, BB.BB_FRAME_BAR_OUT, BB.BB_FRAME_Y), rect(-BB.BB_FRAME_BAR_OUT, -BB.BB_FRAME_Y, -BB.BB_FRAME_BAR_IN, BB.BB_FRAME_Y)];
  const p = spawnPose(prof.spec);
  check('8 geometry: the start pose is clear of the HIVE frame', !bars.some((b) => polysOverlap(footprintCorners(prof.spec, { x: p.x, y: p.y }, Math.PI), b, 0)));
}

// ---- 9. the studio ------------------------------------------------------------------------------------------
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
  check('9 studio: whole project type-checks (strict) and the viewer builds', ok && existsSync(join(ROOT, 'train/public/index.html')), msg);
}

console.log(fails === 0 ? '\nTRAINING PLATFORM GATE: ALL PASS' : `\nTRAINING PLATFORM GATE: ${fails} FAIL`);
process.exit(fails ? 1 : 0);
