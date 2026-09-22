// TRAINING PLATFORM GATE — everything the studio and the trainer rest on, proven before a real run.
// Run: npm run check:train   (a few minutes: it plays real DSIM matches)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { BB, bb, bbEvalStart, coerce, footprintCorners, init, newMatch } from '../harness/dsim';
import { loadProfile, resolve } from '../harness/profiles';
import { polysOverlap, rect } from '../harness/geom';
import { ES, GA, MACRO_MIN_CHANGE, centeredRanks, DEFAULTS, validate, type AlgoConfig, type Teacher } from './algos';
import { fromB64, paramCount, skipOffset } from './net';
import { SHAPE, STYLE_DEFAULT_GENES, decodeStyle } from './policy';
import { N_OBS } from './obs';
import { N_OPT_FEATS, OPTION_KINDS, groupsOf, spawnPose, targetCell } from './skills';
import { runEpisode, type EpisodeArgs } from './episode';
import { Engine, PRESETS, ROOT, checkRun, defaultConfig, type RunConfig } from './engine';
import { startServer } from './server';
import { DATA_DIR, currentKey, demonstrations, ensureData, loadSet, setSamples } from './imitate';
import { choose, disagreement, unpack } from './bc';

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
  const mean = R.reduce((a, r) => a + r.score, 0) / R.length;
  check('2 skills: no robot crashes into the HIVE frame (6 full matches, sampled robots)', crashes === 0, `${crashes} crashes`);
  check('2 skills: it SHOOTS and SCORES — shots go in and the HIVE tips in every match', R.every((r) => r.parts.shotsIn > 10 && r.parts.tips >= 3), `${R.map((r) => `${r.score} pts/${r.parts.tips} tips`).join(', ')} · mean ${mean.toFixed(0)}`);
  check('2 skills: misses stay near the launcher accuracy (fire only when a shot can land)', wasted <= 0.3 * (shotsIn + wasted), `${wasted} missed of ${shotsIn + wasted}`);
  check('2 skills: every option kind is used (field, loading zone or FLOWER, shoot, human player, park)', [0, 3, 4, 5].every((k) => kinds.has(k)) && (kinds.has(1) || kinds.has(2)), [...kinds].sort().join(','));
  check('2 skills: every robot lives the whole match (no stalls)', R.every((r) => r.death === 'survived'), R.map((r) => r.death).join(','));
  // a group decision takes the whole load: pickups per field / loading-zone decision
  let groupDecisions = 0;
  let groupPickups = 0;
  for (const r of R) {
    const d = r.decisions ?? [];
    const picks = (r.events ?? []).filter((e) => e[1] === 'pickup').map((e) => e[0]);
    d.forEach((q, i) => {
      if (q[1] !== 0 && q[1] !== 1) return;
      const end = d[i + 1]?.[0] ?? Infinity;
      groupDecisions++;
      groupPickups += picks.filter((t) => t >= q[0] && t < end).length;
    });
  }
  check('2 skills: a GROUP decision sweeps several elements, not one', groupPickups / groupDecisions >= 1.5, `${(groupPickups / groupDecisions).toFixed(2)} elements per group decision`);
  // groups: single linkage
  const w = newMatch(1, [{ id: 0, alliance: 'blue', spec: prof.spec, startIndex: 0 }]);
  const three = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 60, y: 60 }].map((p, i) => ({ ...w.balls[i], id: 900 + i, pos: p }));
  const G = groupsOf(three);
  check('2 skills: groups are chains of elements closer than 16 in', G.length === 2 && G.some((g) => g.length === 3));
  // the moment a CELL starts to tip, shots go to the other one
  const h = bb(w).hives.blue;
  const up = h.up;
  const before = targetCell(w, 'blue');
  h.tipping = 3.5;
  const during = targetCell(w, 'blue');
  h.tipping = 0;
  check('2 skills: at a tip the target switches to the other CELL at once (the robot crosses during the swing)', before === up && during !== up);
}

// ---- 3. episodes: determinism and exact frames -------------------------------------------------------------
const data = ensureData();
{
  const g = data?.report.genome ?? null;
  const a = runEpisode(base(21, { genome: g, frames: true, samples: true }));
  const b = runEpisode(base(21, { genome: g, frames: true, samples: true }));
  check('3 episode: same network + seed → identical life (score, path, decisions, frames, samples)', a.fitness === b.fitness && a.track === b.track && JSON.stringify(a.decisions) === JSON.stringify(b.decisions) && JSON.stringify(a.frames) === JSON.stringify(b.frames) && JSON.stringify(a.samples) === JSON.stringify(b.samples));
  const S = a.samples ? unpack(a.samples, N_OBS, N_OPT_FEATS) : [];
  check("3 experience: the robot's own decisions come back and replay its choices exactly", S.length > 10 && !!g && S.filter((s) => choose(SHAPE, fromB64(g), s) === s.y).length >= 0.98 * S.length, `${S.length} decisions`);
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
  const st = decodeStyle(STYLE_DEFAULT_GENES);
  check('3 style genes: the defaults decode to the measured-best skill settings', Math.abs(st.fireHold - 2) < 1e-6 && Math.abs(st.fireMinV - 15) < 1e-6 && st.tipReact === false);
}

// ---- 4. learning from the team's replays ------------------------------------------------------------------
let teacher: Teacher = { demos: [], exp: [], probes: [] };
if (data) {
  const file = readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort()[0];
  const d = demonstrations(join(DATA_DIR, file), prof);
  check('4 imitation: a replay re-simulates in DSIM and yields demonstrations', d.score > 0 && d.samples.length > 40, `${file.slice(0, 32)}…: ${d.score} pts, ${d.samples.length} decisions (a sweep of one group is one)`);
  const r = data.report;
  check('4 imitation: the fitted network agrees with a HELD-OUT replay well above chance', r.holdout.agree > 2 * r.holdout.chance, `${(100 * r.holdout.agree).toFixed(1)}% vs chance ${(100 * r.holdout.chance).toFixed(1)}%`);
  check('4 imitation: same network shape as the policy', r.params === paramCount(SHAPE) && SHAPE.sizes[0] === N_OBS + N_OPT_FEATS);
  const demos = setSamples(loadSet(currentKey()));
  check('4 data set: cached by a key over the included replays and the skills version', data.key === currentKey() && demos.length === r.train.samples + r.holdout.samples, `${demos.length} demonstrations, key ${data.key}`);
  teacher = { demos, exp: [], probes: demos.filter((_, i) => i % Math.max(1, Math.floor(demos.length / 200)) === 0).slice(0, 256) };
} else console.log('SKIP  4 imitation: no replays in "Training data/"');

// ---- 5. algorithms ----------------------------------------------------------------------------------------
{
  const cfg = (algo: 'ga' | 'es', pop: number, x: Partial<AlgoConfig> = {}): AlgoConfig => ({ ...DEFAULTS[algo], algo, pop, seed: 5, ...x });
  const pref = OPTION_KINDS.map((_, k) => skipOffset(SHAPE) + N_OBS + k);
  const ga = new GA(cfg('ga', 12), SHAPE, undefined, undefined, pref);
  const L0 = ga.lineage();
  ga.tell(ga.ask().map((_, i) => i)); // fitness = index: the last is best
  const L1 = ga.lineage();
  const ids = new Set(L1.map((l) => l.id));
  const elites = L1.filter((l) => l.op === 'elite');
  check('5 GA: elites survive with their own id; the rest are new, unique ids', ids.size === L1.length && elites.length === 4 && elites.every((e) => L0.some((l) => l.id === e.id)) && elites[0].id === L0[11].id);
  check('5 GA: children name their parents (mutant, behaviour mutation: 1; cross: 2; random: none)', L1.filter((l) => l.op === 'mutant' || l.op === 'macro').every((l) => l.parents.length === 1 && l.muts > 0) && L1.filter((l) => l.op === 'cross').every((l) => l.parents.length === 2) && L1.filter((l) => l.op === 'random').every((l) => l.parents.length === 0));
  const again = new GA(cfg('ga', 12), SHAPE, JSON.parse(JSON.stringify(ga.state())), undefined, pref);
  const f = ga.ask().map((_, i) => (i * 7) % 5);
  ga.tell(f);
  again.tell(f);
  check('5 GA: state round trip continues bit-exactly', JSON.stringify(ga.state()) === JSON.stringify(again.state()));
  ga.setConfig({ pop: 20 });
  ga.tell(ga.ask().map((_, i) => i));
  check('5 GA: a population change takes effect at the next generation', ga.ask().length === 20);
  const seed = data ? fromB64(data.report.genome) : new Float32Array(paramCount(SHAPE)).fill(0.01);
  const seeded = new GA(cfg('ga', 40), SHAPE, undefined, seed, pref, teacher);
  const sl = seeded.lineage();
  check('5 GA: generation 0 = the seed network, its mutants, behaviour mutations and random robots (AUTO order not fixed)', sl[0].op === 'seed' && seeded.ask()[0].every((v, k) => v === seed[k]) && sl.some((l) => l.op === 'mutant') && sl.some((l) => l.op === 'random') && sl.filter((l) => l.op === 'random').length >= 8, Object.entries(sl.reduce<Record<string, number>>((a, l) => ((a[l.op] = (a[l.op] ?? 0) + 1), a), {})).map(([k, v]) => `${v} ${k}`).join(', '));

  // behaviour mutations: 15 % of children, and each one really changes what the robot chooses
  const big = new GA(cfg('ga', 400), SHAPE, undefined, seed, pref, teacher);
  big.tell(big.ask().map((_, i) => (i * 37) % 101));
  const kids = big.lineage().filter((l) => l.op !== 'elite' && l.op !== 'champion');
  const macro = kids.filter((l) => l.op === 'macro');
  const share = macro.length / kids.length;
  check('5 behaviour mutations: about 15% of every generation (the setting)', share > 0.1 && share < 0.2, `${(100 * share).toFixed(1)}% of ${kids.length} children`);
  if (teacher.probes.length) {
    const changed = macro.filter((l) => l.style || (l.changed ?? 0) >= MACRO_MIN_CHANGE).length / macro.length;
    const mut = kids.filter((l) => l.op === 'mutant');
    const pop = big.ask();
    const lin = big.lineage();
    const plain = mut.slice(0, 20).map((l) => {
      const i = lin.indexOf(l);
      const parent = seed; // generation-0 parents are near the seed; compare the child with the seed's choices
      return disagreement(SHAPE, parent, pop[i], teacher.probes);
    });
    check('5 behaviour mutations: each one changes the chosen option on ≥ 10% of probe decisions (or a skill style setting)', changed >= 0.95, `${(100 * changed).toFixed(0)}% of behaviour mutations did (for comparison, plain mutants differ from the seed on ${(100 * plain.reduce((a, b) => a + b, 0) / Math.max(1, plain.length)).toFixed(1)}%)`);
    // students: a lesson on the replays moves the parent's choices toward them
    const stu = new GA(cfg('ga', 60, { imitRate: 0.3, imitMax: 0.5 }), SHAPE, undefined, seed, pref, teacher);
    stu.tell(stu.ask().map((_, i) => (i * 13) % 17));
    const students = stu.lineage().filter((l) => l.op === 'student');
    check('5 students: a share of each generation learns from the replays (a lesson changes its choices)', students.length >= 10 && students.every((l) => l.muts > 0) && students.some((l) => (l.changed ?? 0) > 0), `${students.length} students of ${stu.lineage().length}`);
    // adaptive share: follows whether students reach the parent set more often than plain mutants
    const adapt = (favour: 'student' | 'mutant'): number => {
      const a = new GA(cfg('ga', 60), SHAPE, undefined, seed, pref, teacher);
      for (let g = 0; g < 4; g++) {
        const L = a.lineage();
        a.tell(L.map((l, i) => (l.op === favour ? 1000 : 0) + i * 1e-3));
      }
      return a.stats().imitShare;
    }
    const up = adapt('student');
    const down = adapt('mutant');
    check('5 adaptive share: grows when students do better, shrinks when they do worse ("other generations know")', up > DEFAULTS.ga.imitRate && down < DEFAULTS.ga.imitRate, `${(100 * DEFAULTS.ga.imitRate).toFixed(0)}% → ${(100 * up).toFixed(0)}% / ${(100 * down).toFixed(0)}%`);
    const r1 = new GA(cfg('ga', 30), SHAPE, undefined, seed, pref, teacher);
    const r2 = new GA(cfg('ga', 30), SHAPE, JSON.parse(JSON.stringify(r1.state())), undefined, pref, teacher);
    const ff = r1.ask().map((_, i) => (i * 11) % 7);
    r1.tell(ff);
    r2.tell(ff);
    check('5 GA with students and behaviour mutations: still bit-exact from a saved state', JSON.stringify(r1.state()) === JSON.stringify(r2.state()));
  }
  const hof = new GA(cfg('ga', 12), SHAPE, undefined, undefined, pref);
  const champ = new Float32Array(paramCount(SHAPE)).fill(0.25);
  hof.tell(hof.ask().map((_, i) => i), { genome: champ, id: 99999 });
  const cl = hof.lineage().findIndex((l) => l.op === 'champion');
  check('5 hall of fame: the validated champion is always in the next population', cl >= 0 && hof.lineage()[cl].id === 99999 && hof.ask()[cl].every((v) => v === 0.25));
  const es = new ES(cfg('es', 8), SHAPE);
  const c = es.ask();
  check('5 ES: mirrored pairs around the mean', c.length === 8 && c[0].every((v, k) => Math.abs(v + c[1][k] - 2 * es.current()[k]) < 1e-6));
  check('5 centered ranks: in [-0.5, 0.5], ties averaged', centeredRanks([3, 1, 3, 2]).every((v, i) => Math.abs(v - [1 / 3, -0.5, 1 / 3, -1 / 6][i]) < 1e-12));
  check('5 settings: bad values rejected with a reason', validate(cfg('ga', 3)) !== null && validate(cfg('es', 7)) !== null && validate(cfg('ga', 12, { macroRate: 0.7, imitMax: 0.5 })) !== null && validate(cfg('ga', 12)) === null);
  const bad = PRESETS.filter((p) => {
    const c2 = { ...defaultConfig('x'), ...p.change } as RunConfig;
    return validate(c2) !== null || checkRun(c2) !== null;
  });
  check('5 presets: every preset is a valid, complete setting', !bad.length && PRESETS.length >= 6, bad.map((p) => p.id).join(', '));
}

// ---- 6. the engine: checkpoints, rewind (bit-exact), fork, abort, settings, evaluation -----------------------
const small = (name: string): RunConfig => ({ ...defaultConfig(name, 'ga'), pop: 8, elite: 2, workers: 4, seed: 3, ckEvery: 2, init: 'imitation', validateTop: 2, valEpisodes: 2, preset: '' });
for (const n of ['_check-a', '_check-f', '_check-g', '_check-h']) rmSync(join(ROOT, 'runs', n), { recursive: true, force: true });
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
  const h = e.history();
  const be = e.bestEver;
  check('6 champion: chosen by its mean over the validation matches, with a confidence interval', !!be?.val && be.val.n === 2 && h.every((g) => g.validated.length >= 1 && g.champScore === g.bestEverScore) && h[1].bestEver >= h[0].bestEver, `${be?.score.toFixed(1)} ± ${be?.val?.ci95.toFixed(1)}`);
  check('6 generation summary: operator success rates and the students\' share are recorded', h.every((g) => typeof g.imitShare === 'number' && typeof g.opRates === 'object'));
  const ck = e.checkpoint('mark')!;
  check('6 checkpoints: an automatic one at generation 2 (every 2) plus the named one', e.listCheckpoints().some((m) => m.auto && m.gen === 2) && ck.gen === 2);
  await stepRun(2);
  const first = e.history().slice(2).map((g) => [g.gen, g.best, g.mean, g.bestScore, g.ops, g.champScore, g.imitShare]);
  const stateAt4 = JSON.parse(readFileSync(join(e.dir, 'checkpoint.json'), 'utf8'));
  await e.rewind(ck.id);
  check('6 rewind: back to generation 2 — history and generation files trimmed, the present kept as a pinned checkpoint', e.gen === 2 && e.history().length === 2 && !existsSync(join(e.dir, 'gens', '2.json')) && e.listCheckpoints().some((m) => m.pinned && m.label.startsWith('before rewind') && m.gen === 4));
  await stepRun(2);
  const again = e.history().slice(2).map((g) => [g.gen, g.best, g.mean, g.bestScore, g.ops, g.champScore, g.imitShare]);
  const stateAgain = JSON.parse(readFileSync(join(e.dir, 'checkpoint.json'), 'utf8'));
  check('6 rewind is exact: the same generations again give identical results, champion, experience and algorithm state', JSON.stringify(first) === JSON.stringify(again) && JSON.stringify(stateAt4.algoState) === JSON.stringify(stateAgain.algoState) && JSON.stringify(stateAt4.bestEver) === JSON.stringify(stateAgain.bestEver) && JSON.stringify(stateAt4.experience) === JSON.stringify(stateAgain.experience));
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
  e.applyPreset('quick');
  const q = PRESETS.find((p) => p.id === 'quick')!;
  const presetOk = e.config.preset === 'quick' && Object.entries(q.change).every(([k, v]) => JSON.stringify((e.config as unknown as Record<string, unknown>)[k]) === JSON.stringify(v));
  e.setConfig({ sigma: 0.03 });
  check('6 presets: one click sets every strategy setting; a hand edit makes it "custom"', presetOk && e.config.preset === '' && e.config.sigma === 0.03);
  const ids = e.listCheckpoints();
  e.renameCheckpoint(ids[0].id, 'renamed');
  const autos = e.listCheckpoints().filter((m) => m.auto && !m.pinned).length;
  const deleted = e.deleteCheckpoints('auto');
  check('6 checkpoints: rename, and delete every automatic one at once (pinned and named kept)', e.listCheckpoints().some((m) => m.label === 'renamed' && !m.auto) && deleted === autos && e.listCheckpoints().every((m) => !m.auto) && e.listCheckpoints().some((m) => m.pinned));
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
  check('6 data: the run pins the data set its students learn from', !data || (e.data.key === data.key && e.data.onDisk));

  // ---- 7. server --------------------------------------------------------------------------------------------
  let quitCalled = false;
  const srv = startServer(4798, e, { onQuit: () => (quitCalled = true) });
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
  const dup = await req('/api/runs/duplicate', { name: '_check-f', to: '_check-g' });
  const ren = await req('/api/runs/rename', { name: '_check-g', to: '_check-h' });
  const runs = JSON.parse((await req('/api/runs')).text) as { name: string; bytes: number }[];
  const dataList = await req('/api/data');
  const junk = await req('/api/data/upload', { name: 'x.json', content: '{"game":"decode"}' });
  const preset = await req('/api/presets/apply', { id: 'balanced' });
  const quit = await req('/api/quit', {});
  await new Promise((r) => setTimeout(r, 200));
  await srv.close();
  const S = JSON.parse(st.text);
  check('7 server: state with history, checkpoints, evaluations, presets and training data; exact frames served', st.status === 200 && S.run.history.length === 4 && S.run.checkpoints.length >= 3 && S.presets.length >= 6 && Array.isArray(S.data.files) && frames.status === 200);
  check('7 server: path traversal and bad ids refused', trav.status === 404 && trav2.status === 404 && badCk.status >= 400, `${trav.status}, ${trav2.status}, ${badCk.status}`);
  check('7 server: unknown actions rejected; deleting a run needs its name typed back', bad.status === 400 && del.status === 400 && existsSync(join(ROOT, 'runs', '_check-f')));
  if (legacy) check('7 server: a run from an older version is refused with a reason, files untouched', legacy.status === 404 && legacy.text.includes('first training version') && existsSync(join(ROOT, 'runs', '_ui-test', 'checkpoint.json')));
  check('7 server: runs can be duplicated and renamed (sizes listed)', dup.status === 200 && ren.status === 200 && runs.some((r) => r.name === '_check-h' && r.bytes > 0) && !runs.some((r) => r.name === '_check-g') && Engine.open('_check-h').config.name === '_check-h');
  check('7 server: training data listed; a file that is not a DSIM BIOBUZZ replay is refused', dataList.status === 200 && junk.status === 400 && !existsSync(join(DATA_DIR, 'x.json')));
  check('7 server: presets apply from the studio', preset.status === 200 && e.config.preset === 'balanced');
  check('7 server: the Quit button shuts the studio down', quit.status === 200 && quitCalled);
  check('7 server: metrics export', csv.status === 200 && csv.text.split('\n').length === 5);
}
for (const n of ['_check-a', '_check-f', '_check-g', '_check-h']) rmSync(join(ROOT, 'runs', n), { recursive: true, force: true });

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
