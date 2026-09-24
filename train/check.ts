// TRAINING PLATFORM GATE — everything the studio and the trainer rest on, proven before a real run.
// Run: npm run check:train   (a few minutes: it plays real DSIM matches)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { BB, bb, bbEvalStart, coerce, footprintCorners, init, newMatch } from '../harness/dsim';
import { loadProfile, resolve } from '../harness/profiles';
import { polysOverlap, rect } from '../harness/geom';
import { mulberry32 } from '../harness/rng';
import { fromB64, paramCount, skipOffset, styleOffset, toB64 } from './net';
import { SHAPE, STYLE, STYLE_DEFAULT_GENES, decodeStyle, optKey } from './policy';
import { N_OBS } from './obs';
import { F_CURRENT, F_EST, N_OPT_FEATS, OPTION_KINDS, OPT_FEATS, groupsOf, spawnPose, targetCell } from './skills';
import { Episode, runEpisode, type EpisodeArgs } from './episode';
import { Engine, PRESETS, ROOT, SEARCH, Z_PROMOTE, checkRun, defaultConfig, type RunConfig } from './engine';
import { startServer } from './server';
import { DATA_DIR, currentKey, demonstrations, ensureData, ensureGreedy, ensureValue, loadSet, setSamples } from './imitate';
import { pack, scoreAll, unpack, type Sample } from './bc';
import { deepClone } from './fork';
import { cmaAsk, cmaInit, cmaTell } from './cma';
import { fitLessons, judge } from './learn';
import { VALUE_SHAPE, fitValue } from './value';

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
const base = (seed: number, extra: Partial<EpisodeArgs> = {}): EpisodeArgs => ({ genome: null, profile: 'profiles/real-v0.json', sampleProfile: true, seed, stage: 'full', driver: 'oracle', track: true, record: false, ...extra });
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
  const sw = R.reduce((a, r) => a + (r.decisions ?? []).filter((q) => q[4] === 2).length, 0) / R.length;
  const pos = R.reduce((a, r) => a + (r.decisions ?? []).filter((q) => q[1] === 6).length, 0) / R.length;
  check('2 thinking on the go: the robot re-thinks while it acts and switches when something is better', sw >= 5, `${sw.toFixed(1)} switches and ${pos.toFixed(1)} "get in position" per match`);
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
  check('3 episode: same network + seed → identical life (score, path, decisions, frames, samples)', a.reward === b.reward && a.track === b.track && JSON.stringify(a.decisions) === JSON.stringify(b.decisions) && JSON.stringify(a.frames) === JSON.stringify(b.frames) && JSON.stringify(a.samples) === JSON.stringify(b.samples));
  const S = a.samples ? unpack(a.samples, N_OBS, N_OPT_FEATS) : [];
  // every decision the robot made comes back — carrying on included — and matches its own rule:
  // the best-scoring option, or its current job while nothing beats it by more than its stick gene
  const gp = g ? fromB64(g) : null;
  const stick = gp ? decodeStyle(gp.subarray(styleOffset(SHAPE))).stick : 0;
  const ruleOk = (q: (typeof S)[number]): boolean => {
    const z = scoreAll(SHAPE, gp!, q);
    const top = Math.max(...z);
    const isCur = q.feats[q.y * N_OPT_FEATS + F_CURRENT] === 1;
    return z[q.y] === top || (isCur && top - z[q.y] <= stick + 1e-6);
  };
  const stays = S.filter((q) => q.feats[q.y * N_OPT_FEATS + F_CURRENT] === 1).length;
  check("3 experience: the robot's own decisions come back — carrying on included — and follow its own rule", S.length > 100 && !!gp && stays > 0.5 * S.length && S.filter(ruleOk).length >= 0.98 * S.length, `${S.length} decisions, ${((100 * stays) / Math.max(1, S.length)).toFixed(0)}% carry on`);
  const f = a.frames!.f;
  const last = f[f.length - 1];
  check('3 frames: one frame every 2 ticks for the whole life, every element in every frame', f.length >= Math.floor(a.ticks / 2) && f.every((q) => q.b.length === 3 * a.frames!.meta.length));
  check('3 frames: the last frame shows the final DSIM score', Math.max(0, last.m[2] - last.m[3]) === a.score, `${last.m[2] - last.m[3]} vs ${a.score}`);
  const R = [21, 24, 25, 26].map((sd) => (sd === 21 ? a : runEpisode(base(sd, { genome: g }))));
  check('3 reward = DSIM score minus the foul points of the rules DSIM does not enforce (no hints)', R.every((r) => r.reward <= r.score && (r.parts.violations || r.parts.strikes ? r.reward < r.score : r.reward === r.score) && r.mistakes.fouls >= r.score - r.reward), R.map((r) => `${r.reward}/${r.score}`).join(', '));
  const auto = runEpisode(base(22, { stage: 'auto', track: false }));
  check('3 episode: AUTO-only stops at the end of AUTO', auto.ticks <= 240 + 30 * 60 + 2 && auto.ticks >= 240 + 30 * 60 - 2, `${auto.ticks} ticks`);
  const wr = runEpisode(base(23, { profile: 'profiles/dream.json', sampleProfile: false }));
  check('3 skills: a front+back intake build (DREAM) plays too', wr.parts.shotsIn > 10 && wr.death !== 'crash', `${wr.score} pts`);
  // the network fitted to the replays must play at least about as well as the greedy order and must
  // not dither: a fit on sparse "change" moments once switched job 147 times in 158 and scored 47
  if (g) {
    const seeds = [101, 103, 105, 107, 109, 111];
    const im = seeds.map((sd) => runEpisode(base(sd, { genome: g })));
    const gr = seeds.map((sd) => runEpisode(base(sd)));
    const mi = im.reduce((t, r) => t + r.score, 0) / seeds.length;
    const mg = gr.reduce((t, r) => t + r.score, 0) / seeds.length;
    const swi = im.reduce((t, r) => t + (r.decisions ?? []).filter((q) => q[4] === 2).length, 0) / seeds.length;
    check('3 imitation network: plays about as well as the greedy order and does not dither', mi >= 0.8 * mg && swi <= 40, `${mi.toFixed(0)} vs greedy ${mg.toFixed(0)} points, ${swi.toFixed(0)} switches per match`);
  }
  // the no-learning robot as a network (a generation-0 seed): same choices, same score
  const gr = ensureGreedy();
  const six = [101, 103, 105, 107, 109, 111];
  const gn = six.map((sd) => runEpisode(base(sd, { genome: gr.genome })));
  const gb = six.map((sd) => runEpisode(base(sd)));
  const mn = gn.reduce((t, r) => t + r.score, 0) / six.length;
  const mb = gb.reduce((t, r) => t + r.score, 0) / six.length;
  check('3 greedy network: the no-learning robot distilled — same choices on unseen matches, about the same score', gr.holdout.agree >= 0.9 && mn >= 0.85 * mb, `${(100 * gr.holdout.agree).toFixed(1)}% same choices, ${mn.toFixed(0)} vs ${mb.toFixed(0)} points`);
  const st = decodeStyle(STYLE_DEFAULT_GENES);
  check(`3 skill settings: all ${STYLE.length} default genes decode to the constants the skills used before they were tunable`, STYLE.every((d) => Math.abs(st[d.key] - d.def) < 1e-6 * Math.max(1, d.def)), STYLE.map((d) => d.key).join(', '));
}

// ---- 3b. forking a match, what-if lessons, thinking ahead -----------------------------------------------------
{
  const g = ensureGreedy().genome;
  const args = base(31, { genome: g, track: false });
  const hash = (e: Episode): string => createHash('sha1').update(JSON.stringify(e.w) + JSON.stringify(e.parts) + e.reward()).digest('hex');
  const A = new Episode(args);
  while (A.step());
  const B = new Episode(args);
  for (let i = 0; i < 4000; i++) B.step();
  const F = B.fork();
  const G = B.fork();
  G.reseed(99);
  for (let i = 0; i < 1500; i++) G.step();
  while (F.step());
  while (B.step());
  check('3b fork: a copy of a running match played on finishes bit-identical to the match itself', hash(F) === hash(A) && F.reward() === A.reward(), `${A.reward()} pts`);
  check('3b fork: a copy played differently (other luck) leaves the real match untouched', hash(B) === hash(A) && G.reward() !== A.reward());
  let refused = false;
  try {
    deepClone({ hidden: () => 1 });
  } catch {
    refused = true;
  }
  check('3b fork: state hidden in a closure is refused, never silently shared', refused);
  const plain = runEpisode(base(32, { genome: g }));
  const V = ensureValue().genome;
  const taught = runEpisode(base(32, { genome: g, value: V, lessons: { thinkRate: 0.05, horizon: 300, rounds: 2 }, returns: 30 }));
  check('3b lessons: taking what-if lessons never changes the real match', taught.reward === plain.reward && taught.ticks === plain.ticks && JSON.stringify(taught.decisions) === JSON.stringify(plain.decisions));
  const L = taught.lessons ? unpack(taught.lessons, N_OBS, N_OPT_FEATS) : [];
  const allPlayed = L.every((s) => s.q && Array.from(s.q).every((v) => Number.isFinite(v)));
  check('3b lessons: every job start is a lesson and every option of it was played out (round 1 plays them all)', L.length >= 20 && allPlayed && taught.mistakes.regretN === L.length && taught.mistakes.regret >= 0, `${L.length} lessons, choices lost ${(taught.mistakes.regret / Math.max(1, taught.mistakes.regretN)).toFixed(1)} pts each`);
  check('3b predictor data: (observation, points still to come) twice a second, ending at 0', !!taught.values && taught.values.n > 200 && taught.values.y[taught.values.y.length - 1] >= 0 && taught.values.y[0] >= taught.values.y[taught.values.y.length - 1]);
  // the tip cycle: a network that takes it whenever it can never crashes into the HIVE frame and
  // rarely stalls (a first version stalled every match: its shoot step could not give up)
  const lover = fromB64(g);
  lover[skipOffset(SHAPE) + N_OBS + OPT_FEATS.indexOf('k:cycle')] = 1000;
  const cyc = [41, 42, 43, 44, 45, 46].map((sd) => runEpisode(base(sd, { genome: toB64(lover) })));
  const cycN = cyc.reduce((t, r) => t + (r.decisions ?? []).filter((d) => d[1] === OPTION_KINDS.indexOf('cycle')).length, 0);
  check('3b tip cycle: taken whenever possible it never crashes into the HIVE frame and rarely stalls', cycN > 20 && cyc.every((r) => r.death !== 'crash') && cyc.filter((r) => r.death === 'stall').length <= 1 && cyc.every((r) => r.parts.shotsIn > 10), `${cycN} tip cycles in 6 matches, ${cyc.map((r) => `${r.reward}${r.death === 'survived' ? '' : ` ${r.death}`}`).join(', ')}`);
  // a forced option runs to completion (the options framework): forcing "get in position", which
  // the no-learning robot scores lowest, it must still be doing it 2 s later — not dropped at the
  // next re-think (the first Full push trial learned from exactly such dropped what-ifs)
  {
    const E = new Episode(base(34, { genome: g, track: false }));
    let hit: { tick: number; key: string } | null = null; // (a lesson's forced option: committed)
    for (let n = 0; n < 12000 && !hit; n++) {
      const pr = E.fork();
      pr.step();
      const d = pr.brain.last;
      if (d && d.tick === E.w.tick && d.at === 'begin') {
        const pos = d.opts.findIndex((o) => o.kind === 'position');
        if (pos >= 0 && pos !== d.chosen) hit = { tick: d.tick, key: optKey(d.opts[pos]) };
      }
      if (!hit && !E.step()) break;
    }
    const F = E.fork();
    F.brain.force = hit && { ...hit, commit: true };
    for (let k = 0; k < 120; k++) F.step();
    const N = E.fork();
    for (let k = 0; k < 120; k++) N.step();
    check('3b options framework: a forced option runs to completion, not dropped at the next re-think', !!hit && F.brain.current()?.kind === 'position' && N.brain.current()?.kind !== 'position', hit ? `forced at tick ${hit.tick}: 2 s later the copy is still "${F.brain.current()?.kind}", the real match does "${N.brain.current()?.kind}"` : 'no decision found');
  }
  const sr = runEpisode(base(33, { genome: g, value: V, search: SEARCH, inspect: true }));
  const ins = (sr.inspect ?? []).filter((d) => d.opts.some((o) => o.q !== null)); // the searched ones (re-thinks are listed too, without what-if)
  const byMargin = ins.every((d) => d.chosen === d.net || (d.gain !== null && d.gain > SEARCH.margin));
  check('3b thinking ahead: searches every job start, and overrides the network only for more than the margin', ins.length >= 20 && sr.searched!.n === ins.length && sr.searched!.changed > 0 && byMargin, `${sr.searched!.changed} of ${sr.searched!.n} decisions changed`);
}

// ---- 4. learning from the team's replays ------------------------------------------------------------------
if (data) {
  const file = readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort()[0];
  const d = demonstrations(join(DATA_DIR, file), prof);
  check('4 imitation: a replay re-simulates in DSIM and yields demonstrations', d.score > 0 && d.samples.length > 40, `${file.slice(0, 32)}…: ${d.score} pts, ${d.samples.length} decisions (a sweep of one group is one)`);
  const r = data.report;
  check('4 imitation: the fitted network agrees with a HELD-OUT replay well above chance', r.holdout.agree > 2 * r.holdout.chance, `${(100 * r.holdout.agree).toFixed(1)}% vs chance ${(100 * r.holdout.chance).toFixed(1)}%`);
  check('4 imitation: same network shape as the policy', r.params === paramCount(SHAPE) && SHAPE.sizes[0] === N_OBS + N_OPT_FEATS);
  const demos = setSamples(loadSet(currentKey()));
  check('4 data set: cached by a key over the included replays and the skills version', data.key === currentKey() && demos.length === r.train.samples + r.holdout.samples, `${demos.length} demonstrations, key ${data.key}`);
} else console.log('SKIP  4 imitation: no replays in "Training data/"');

// ---- 5. learning components --------------------------------------------------------------------------------
{
  // CMA-ES maximizes a 17-number problem and asks the same candidates again from a saved state
  const f = (x: number[]): number => -x.reduce((a, v, i) => a + (v - (i % 3)) ** 2, 0);
  let S = cmaInit(new Array(17).fill(0), 0.5, 7);
  const firstAsk = JSON.stringify(cmaAsk(S).x);
  for (let k = 0; k < 150; k++) {
    const { x } = cmaAsk(S);
    S = cmaTell(S, x, x.map(f));
  }
  check('5 CMA-ES: solves a 17-number test problem; a saved state asks the same candidates', f(S.mean) > -1e-3 && JSON.stringify(cmaAsk(cmaInit(new Array(17).fill(0), 0.5, 7)).x) === firstAsk, `f = ${f(S.mean).toExponential(1)} after 150 generations`);
  // lessons: options whose what-if points follow one feature — the network learns to pick by it
  const rng = mulberry32(5);
  const mk = (n: number): Sample[] =>
    Array.from({ length: n }, () => {
      const k = 3 + Math.floor(rng() * 5);
      const feats = Float32Array.from({ length: k * N_OPT_FEATS }, () => rng() * 2 - 1);
      const q = Float32Array.from({ length: k }, (_, r) => -20 * feats[r * N_OPT_FEATS + F_EST] + 4 * (rng() - 0.5));
      return { obs: Float32Array.from({ length: N_OBS }, () => rng() * 2 - 1), feats, k, y: 0, q };
    });
  const start = fromB64(ensureGreedy().genome);
  const fit = fitLessons(SHAPE, start, mk(3000), mk(500), [], { epochs: 30, lr: 0.002, anchor: 0.001, demoWeight: 0, seed: 1 });
  check('5 lessons: the network learns to prefer options by their what-if points (held-out regret falls)', fit.report.regret < 0.5 * fit.report.startRegret && fit.report.hit > 0.6 && fit.report.hit > fit.report.startHit, `regret ${fit.report.startRegret.toFixed(2)} → ${fit.report.regret.toFixed(2)} pts, best option ${(100 * fit.report.startHit).toFixed(0)}% → ${(100 * fit.report.hit).toFixed(0)}%`);
  const j = judge(SHAPE, fit.p, mk(200));
  check('5 lessons: the style genes (skills) are never touched by a gradient', fit.p.subarray(styleOffset(SHAPE)).every((v, i) => v === start[styleOffset(SHAPE) + i]) && j.regret >= 0);
  const L = mk(5);
  const back = unpack(pack(L), N_OBS, N_OPT_FEATS);
  check('5 lessons: packed and unpacked exactly (what-if values included)', back.every((s, i) => s.k === L[i].k && s.q!.every((v, r) => v === L[i].q![r]) && s.feats.every((v, r) => v === L[i].feats[r])));
  // the predictor: points to come as a function of the observation
  const n = 4000;
  const obs = Float32Array.from({ length: n * N_OBS }, () => rng() * 2 - 1);
  const y = Float32Array.from({ length: n }, (_, i) => 80 + 60 * obs[i * N_OBS + 17] + 30 * obs[i * N_OBS + 3]);
  const split = (a: number, b: number) => ({ obs: obs.subarray(a * N_OBS, b * N_OBS), y: y.subarray(a, b) });
  const vf = fitValue(split(0, 3500), split(3500, n), { epochs: 40 });
  check('5 predictor: learns points-to-come from what the robot sees (held-out error far below the spread)', vf.rmse < 10 && vf.p.length === paramCount(VALUE_SHAPE), `${vf.rmse.toFixed(1)} pts off (spread ≈ 47)`);
  const bad = PRESETS.filter((p) => checkRun({ ...defaultConfig('x'), ...p.change } as RunConfig) !== null);
  check('5 presets: every preset is a valid, complete setting', !bad.length && PRESETS.length >= 5, bad.map((p) => p.id).join(', '));
}

// ---- 6. the engine: a generation, rewind (exact), fork, abort, settings, evaluation, auto-resume -----------------
const small = (name: string): RunConfig => ({ ...defaultConfig(name), workers: 4, seed: 3, collect: 3, thinkRate: 0, horizon: 4, rounds: 1, window: 2, epochs: 20, cmaPop: 4, cmaMatches: 2, raceMatches: 3, examMatches: 4, examEvery: 1, searchExam: false, ckEvery: 2, preset: '' });
for (const n of ['_check-a', '_check-f', '_check-g', '_check-h']) rmSync(join(ROOT, 'runs', n), { recursive: true, force: true });
{
  const e = Engine.create(small('_check-a'));
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
  const h = e.history();
  check('6 engine: "+2 generations" runs exactly two, then pauses', e.gen === 2 && h.length === 2);
  check('6 lessons: each generation\'s lessons and predictor data are saved and learned from', h.every((g) => g.lessons > 0 && existsSync(join(e.dir, 'lessons', `${g.gen}.json.gz`)) && !!g.fit && g.fit.held > 0 && !!g.value), h.map((g) => `${g.lessons} lessons, held-out regret ${g.fit?.startRegret.toFixed(1)} → ${g.fit?.regret.toFixed(1)}`).join(' · '));
  const tests = h.filter((g) => g.confirm);
  const fair = tests.every((g) => !g.confirm!.promoted || (g.confirm!.se > 0 && g.confirm!.diff / g.confirm!.se >= Z_PROMOTE));
  const ex = e.exams();
  check('6 champion: starts as the no-learning network; replaced only through the race (paired, sequential boundary, reliable)', h[0].champOp === 'baseline' || h[0].newChamp, `${tests.length} races, ${tests.filter((g) => g.confirm!.promoted).length} promotions`);
  check('6 race: a contender is promoted only past the boundary', fair);
  check('6 skills: CMA-ES tries skill settings against the champion every generation', h.every((g) => !!g.cma && g.cma.gen === g.gen + 1));
  const x = ex[ex.length - 1];
  check('6 exam: the champion and the no-learning robot on the same fixed matches, paired', ex.length >= 2 && x.net.n === 4 && x.vsBase.n === 4 && Number.isFinite(x.vsBase.mean));
  check('6 exam checks: the same match again is identical; DSIM re-simulates the champion\'s replay exactly', x.checks.deterministic && (!ensureData() || !!x.checks.dsim?.ok), x.checks.dsim?.detail ?? 'no replays');
  check('6 gap report: you, the champion on your build and matches, and on the exam robot', !ensureData() || (x.gap.length === 3 && x.gap[0].who === 'you' && x.gap[0].points > 500 && x.gap.every((r) => r.n > 0 && Math.abs(r.share.collect + r.share.shoot + r.share.drive + r.share.idle - 1) < 1e-6)), x.gap.map((r) => `${r.who}: ${r.points.toFixed(0)}`).join(' · '));
  const bf = JSON.parse(gunzipSync(readFileSync(join(e.dir, 'best.frames.json.gz'))).toString()) as { frames: { f: unknown[] }; inspect: { opts: { q: number | null }[] }[] };
  check('6 showcase: exact frames, a DSIM replay and snippet, and the what-if values at its decisions', bf.frames.f.length > 100 && bf.inspect.length > 10 && bf.inspect.every((d) => d.opts.some((o) => o.q !== null)) && existsSync(join(e.dir, 'best.inject.js')));
  const ck = e.checkpoint('mark')!;
  check('6 checkpoints: an automatic one at generation 2 (every 2) plus the named one', e.listCheckpoints().some((m) => m.auto && m.gen === 2) && ck.gen === 2);
  const pick = (g: (typeof h)[number]) => [g.gen, g.meanScore, g.lessons, g.regret, g.fit, g.value, g.cma, g.arena, g.confirm, g.champId, g.champScore, g.exam && { net: g.exam.net, vsBase: g.exam.vsBase, gap: g.exam.gap }];
  await stepRun(2);
  const first = e.history().slice(2).map(pick);
  const learnState = (): string => {
    const c = JSON.parse(readFileSync(join(e.dir, 'checkpoint.json'), 'utf8'));
    const { exam, ...champ } = c.champion; // an exam records when it was taken: compare what it measured
    return JSON.stringify([c.gen, c.nextId, champ, exam && { ...exam, time: 0, hours: 0 }, c.value, c.arena, c.cma, c.baseExam, c.totals.lessons, c.totals.matches]);
  };
  const at4 = learnState();
  await e.rewind(ck.id);
  check('6 rewind: back to generation 2 — history, lessons and generation files trimmed, the present kept as a pinned checkpoint', e.gen === 2 && e.history().length === 2 && !existsSync(join(e.dir, 'gens', '2.json')) && !existsSync(join(e.dir, 'lessons', '2.json.gz')) && e.listCheckpoints().some((m) => m.pinned && m.label.startsWith('before rewind') && m.gen === 4));
  await stepRun(2);
  const again = e.history().slice(2).map(pick);
  check('6 rewind is exact: the same generations again give identical lessons, candidates, races, champion, predictor and skill search', JSON.stringify(first) === JSON.stringify(again) && learnState() === at4);
  const undo = e.listCheckpoints().find((m) => m.label.startsWith('before rewind'))!;
  e.fork(undo.id, '_check-f', { collect: 2 });
  const f = Engine.open('_check-f');
  check('6 fork: a new run at the checkpoint with the changed setting and the lessons it learns from next; the source untouched', f.gen === 4 && f.config.collect === 2 && e.config.collect === 3 && f.history().length === 4 && existsSync(join(f.dir, 'lessons', '3.json.gz')));
  let threw = '';
  try {
    e.setConfig({ seed: 9 });
  } catch (err) {
    threw = (err as Error).message;
  }
  const changed = e.setConfig({ collect: 4 });
  check('6 settings: live changes applied and logged; run-defining ones refused', changed.collect === 4 && threw.includes('cannot change') && e.events().some((q) => q.text.includes('collect')));
  e.applyPreset('quick');
  const q = PRESETS.find((p) => p.id === 'quick')!;
  const presetOk = e.config.preset === 'quick' && Object.entries(q.change).every(([k, v]) => JSON.stringify((e.config as unknown as Record<string, unknown>)[k]) === JSON.stringify(v));
  e.setConfig({ collect: 7 });
  check('6 presets: one click sets every training setting; a hand edit makes it "custom"', presetOk && e.config.preset === '' && e.config.collect === 7);
  e.setConfig(small('_check-a'));
  const ids = e.listCheckpoints();
  e.renameCheckpoint(ids[0].id, 'renamed');
  const autos = e.listCheckpoints().filter((m) => m.auto && !m.pinned).length;
  const deleted = e.deleteCheckpoints('auto');
  check('6 checkpoints: rename, and delete every automatic one at once (pinned and named kept)', e.listCheckpoints().some((m) => m.label === 'renamed' && !m.auto) && deleted === autos && e.listCheckpoints().every((m) => !m.auto) && e.listCheckpoints().some((m) => m.pinned));
  const before = readFileSync(join(e.dir, 'checkpoint.json'), 'utf8');
  let stopped = new Promise<void>((r) => e.once('stopped', () => r()));
  e.start();
  const flagOn = e.wasTraining;
  await new Promise<void>((r) => e.once('progress', () => setTimeout(r, 1500)));
  await e.halt(true, true); // the studio closing: abort, but training resumes next start
  await stopped;
  const kept = e.wasTraining;
  check('6 abort: the generation in progress is discarded; the run is exactly as before', readFileSync(join(e.dir, 'checkpoint.json'), 'utf8') === before && e.gen === 4);
  stopped = new Promise<void>((r) => e.once('stopped', () => r()));
  e.start();
  await new Promise<void>((r) => e.once('progress', () => setTimeout(r, 500)));
  await e.halt(true); // the user stopping
  await stopped;
  check('6 auto-resume: training marks the run; closing the studio keeps the mark (it resumes next start), Stop clears it', flagOn && kept && !e.wasTraining);
  const ev = await e.evaluate('greedy', 4);
  const ev2 = await e.evaluate('greedy', 4);
  check('6 evaluation: held-out matches, reproducible, logged', ev.n === 4 && JSON.stringify(ev.scores) === JSON.stringify(ev2.scores) && e.evals().length === 2);
  check('6 files: the champion\'s lesson matches per generation (swarm) and their best match exactly', existsSync(join(e.dir, 'gens', '3.frames.json.gz')) && JSON.parse(readFileSync(join(e.dir, 'gens', '3.json'), 'utf8')).individuals.length === 3);
  check('6 data: the run pins the replay set it uses', !ensureData() || (e.data.key === ensureData()!.key && e.data.onDisk));

  // ---- 7. server --------------------------------------------------------------------------------------------
  let quitCalled = false;
  const srv = startServer(4798, e, { onQuit: () => (quitCalled = true) });
  const req = async (p: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:4798${p}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };
  const st = await req('/api/state');
  const frames = await req('/api/gen/3/frames');
  const exams = await req('/api/exams');
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
  check('7 server: state with history, exams, the champion (race, exam, skill settings), checkpoints, presets and training data', st.status === 200 && S.run.history.length === 4 && S.run.exams.length >= 4 && S.run.champion.style.length === STYLE.length && S.run.checkpoints.length >= 3 && S.presets.length >= 5 && Array.isArray(S.data.files) && frames.status === 200 && JSON.parse(exams.text).length >= 4);
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
