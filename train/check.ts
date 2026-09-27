// TRAINING PLATFORM GATE — everything the studio and the trainer rest on, proven before a real run.
// Run: npm run check:train   (a few minutes: it plays real DSIM matches)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { BB, bb, bbEvalStart, coerce, footprintCorners, footprintExtents, init, newMatch, worldResult } from '../harness/dsim';
import { loadProfile, profileProblems, resolve } from '../harness/profiles';
import { polysOverlap, rect } from '../harness/geom';
import { mulberry32 } from '../harness/rng';
import { fromB64, paramCount, skipOffset, styleOffset, toB64 } from './net';
import { SHAPE, STYLE, STYLE_DEFAULT_GENES, decodeStyle, optKey } from './policy';
import { N_OBS } from './obs';
import { F_CURRENT, F_EST, N_OPT_FEATS, OPTION_KINDS, OPT_FEATS, groupsOf, spawnPose, targetCell } from './skills';
import { Episode, runEpisode, type EpisodeArgs, type EpisodeResult } from './episode';
import { STARTS, legalPair, type PartnerKind } from './team';
import { ensureEnvelopes, envelopeOf } from './envelope';
import { planPath } from './skills';
import { Store } from './store';
import { LABEL, plist } from './service';
import { AUTO_QUICK, autoArgs, nextChoice, planAuto, playPlan, showPlan, type AutoProblem } from './auto';
import { Playbook, problems } from './playbook';
import { WorkerPool } from '../harness/pool';
import { Perturber } from '../harness/perturb';
import { shootingColumn } from '../harness/s1/lab';
import { Engine, PRESETS, ROOT, SEARCH, Z_PROMOTE, checkRun, defaultConfig, type RunConfig } from './engine';
import { startServer } from './server';
import { DATA_DIR, currentKey, demonstrations, ensureData, ensureGreedy, ensureValue, loadSet, setSamples } from './imitate';
import { pack, scoreAll, unpack, type Sample } from './bc';
import { deepClone } from './fork';
import { cmaAsk, cmaInit, cmaTell } from './cma';
import { fitLessons, judge } from './learn';
import { VALUE_SHAPE, fitValue } from './value';
import { DatabaseSync } from 'node:sqlite';
import { SEARCH2, type Search2Spec } from './episode';
import { EntNet, entInit, layout, type EntShape } from './entnet';
import { ENT_PREFIX, ENT_SHAPE, decodeGenome, genomeStyle } from './policy';
import { N_ENT, N_OPT_IN } from './obs';
import { entEval, entFit, entGenome, labelRows, learnJob, toLabels } from './entlearn';
import { Continuous, V2_DIR, examList, sameMistake, sprt, v2Defaults, type AuditEntry } from './continuous';
import { mineRoutes } from './routes';
import { OPPONENT_KINDS } from './team';
import { describeBuild, draftFrom, floorsOf, inspectRobot, listRobots, replayRobots, saveRobot, shapeProblems, specsIn } from './robots';
import { notify } from './notify';

process.env.BIOBUZZ_NO_NOTIFY = '1'; // the gate never posts macOS notifications
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

// ---- 1b. every profile builds as written over its whole range (a clamped draw throws mid-run) ---------------
{
  const files = readdirSync(join(ROOT, 'profiles')).filter((f) => f.endsWith('.json'));
  const bad = files.flatMap((f) => profileProblems(loadProfile(join(ROOT, 'profiles', f)), true).slice(0, 1).map((x) => `${f}: ${x}`));
  check(`1 profiles: every robot a run can draw from the ${files.length} profiles is the one its file describes`, files.length >= 3 && bad.length === 0, bad.join('; '));
  const tooLight = JSON.parse(readFileSync(join(ROOT, 'profiles/real-v1.json'), 'utf8'));
  tooLight.spec.massLb.min = 22; // under DSIM's floor for a double turret + Box Tube
  check('1 profiles: a range DSIM cannot build is caught before a run starts', profileProblems(tooLight, true).some((x) => x.startsWith('massLb')) && checkRun({ ...defaultConfig('x'), profile: 'profiles/none.json' }) === 'unknown profile');
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
  check('2 skills: every robot lives the whole match and never goes 20 s without progress', R.every((r) => r.death === 'survived' && r.mistakes.stalls === 0), R.map((r) => `${r.death}/${r.mistakes.stalls}`).join(','));
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
  // (48 matches: 1.47 before the alliance skills, 1.41 after — which score more, 221 vs 216; one
  // decision per element, what this guards against, sits near 1.0. Six matches vary ±0.1.)
  check('2 skills: a GROUP decision sweeps several elements, not one', groupPickups / groupDecisions >= 1.35, `${(groupPickups / groupDecisions).toFixed(2)} elements per group decision`);
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
  check('3 reward = DSIM score minus the foul points of the rules DSIM does not enforce (no hints)', R.every((r) => r.reward <= r.score && (r.parts.violations || r.parts.strikesScored ? r.reward < r.score : r.reward === r.score) && r.mistakes.fouls >= r.score - r.reward), R.map((r) => `${r.reward}/${r.score}`).join(', '));
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
  check('3b tip cycle: taken whenever possible it never crashes into the HIVE frame and rarely stalls', cycN > 20 && cyc.every((r) => r.death !== 'crash') && cyc.filter((r) => r.mistakes.stalls > 0).length <= 1 && cyc.every((r) => r.parts.shotsIn > 10), `${cycN} tip cycles in 6 matches, ${cyc.map((r) => `${r.reward}${r.death === 'survived' ? '' : ` ${r.death}`}${r.mistakes.stalls ? ` ${r.mistakes.stalls} stall` : ''}`).join(', ')}`);
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

// ---- 10. the alliance: two robots, partners, starts, Box Tube, envelopes, paths, store, service -----------
{
  const V1 = 'profiles/real-v1.json';
  const v1 = resolve(loadProfile(join(ROOT, V1))).spec;
  const presets = [0, 1, 2].map((i) => coerce({ ...BB.BB_PRESETS[i] }));
  await ensureEnvelopes([v1, ...presets]);
  const duo = (seed: number, kind: PartnerKind | 'none', extra: Partial<EpisodeArgs> = {}): EpisodeArgs => ({
    genome: null, profile: V1, sampleProfile: true, seed, stage: 'full', driver: 'oracle', track: false, record: false, ...(kind === 'none' ? {} : { partner: { kind } }), ...extra,
  });
  // starts
  const pairs = STARTS.flatMap((a) => STARTS.filter((b) => legalPair(v1, a, v1, b)).map((b) => [a, b]));
  check('10 starts: two REAL-v1s have 16 legal start pairs of 20; the two that overlap (F3/top side, bottom audience/bottom side) are refused', pairs.length === 16 && !legalPair(v1, 'F3', v1, 'TOP_SIDE') && !legalPair(v1, 'BOTTOM_AUD', v1, 'BOTTOM_SIDE') && !legalPair(v1, 'F3', v1, 'F3') && presets.every((p) => STARTS.flatMap((a) => STARTS.filter((b) => legalPair(v1, a, p, b))).length === 16));
  // determinism and exact copies with two robots
  const A = runEpisode(duo(31, 'sniper', { frames: true }));
  const B = runEpisode(duo(31, 'sniper', { frames: true }));
  check("10 alliance: a match with a partner is deterministic — score, frames (the partner's pose in every one), the partner's own play", A.reward === B.reward && JSON.stringify(A.frames) === JSON.stringify(B.frames) && JSON.stringify(A.partner) === JSON.stringify(B.partner) && A.frames!.f.every((q) => q.p?.length === 8) && !!A.frames!.spec2);
  const E = new Episode(duo(32, 'real'));
  while (E.w.tick < 3000) E.step();
  const F = E.fork();
  const G = E.fork();
  (G.brains[1] as unknown as { mode: string }).mode = 'idle'; // a branch played differently
  while (E.step());
  while (F.step());
  while (G.step());
  check('10 alliance: a copy of a two-robot match played on finishes bit-identical; a branch played differently leaves it untouched', worldResult(E.w).hash === worldResult(F.w).hash && E.reward() === F.reward() && worldResult(G.w).hash !== worldResult(E.w).hash);
  // every partner plays its part
  const kinds: PartnerKind[] = ['real', 'sniper', 'hauler', 'skimmer', 'parker', 'idle'];
  const seeds = [41, 42, 43, 44];
  const solo = seeds.map((sd) => runEpisode(duo(sd, 'none')));
  const R = Object.fromEntries(kinds.map((k) => [k, seeds.map((sd) => runEpisode(duo(sd, k)))])) as Record<PartnerKind, EpisodeResult[]>;
  const mean = (rs: EpisodeResult[], f: (r: EpisodeResult) => number): number => rs.reduce((a, r) => a + f(r), 0) / rs.length;
  const pk = (k: PartnerKind): number => mean(R[k], (r) => r.partner!.parts.pickups);
  check('10 partners: every partner type plays a whole match; the players collect (REAL-v1, Sniper, Skimmer > 30 a match, Hauler > 8), the others never do', kinds.every((k) => R[k].every((r) => r.partner?.kind === k)) && pk('real') > 30 && pk('sniper') > 30 && pk('skimmer') > 30 && pk('hauler') > 8 && pk('parker') === 0 && pk('idle') === 0, kinds.map((k) => `${k} ${pk(k).toFixed(0)}`).join(', '));
  const all = [...solo, ...Object.values(R).flat()];
  check('10 partners: our robot never crashes into the HIVE frame beside any partner (28 matches), and rarely goes 20 s without progress', all.every((r) => r.death === 'survived') && mean(all, (r) => r.mistakes.stalls) <= 0.3, `${all.filter((r) => r.death !== 'survived').length} crashes, ${mean(all, (r) => r.mistakes.stalls).toFixed(2)} stalls a match`);
  check('10 partners: a playing partner adds points (a second REAL-v1: +40 a match or more over our robot alone, same seeds)', mean(R.real, (r) => r.reward) > mean(solo, (r) => r.reward) + 40, `${mean(solo, (r) => r.reward).toFixed(0)} alone, ${mean(R.real, (r) => r.reward).toFixed(0)} with a second REAL-v1`);
  // the weak partners: LEAVE + PARK, and nothing
  const PK = new Episode(duo(45, 'parker'));
  const p0 = { ...PK.w.robots[1].pos };
  while (PK.step());
  const pr = PK.w.robots[1];
  const lz = BB.BB_LZ.blue;
  const inLz = polysOverlap(footprintCorners(pr.spec, pr.pos, pr.heading), rect(lz.x0, lz.y0, lz.x1, lz.y1));
  const ID = new Episode(duo(45, 'idle'));
  const i0 = { ...ID.w.robots[1].pos };
  while (ID.step());
  const offWall = pr.pos.y - footprintExtents(pr.spec).half > -BB.BB_HALF_Y + 2; // it started on the audience wall
  check('10 partners: "parks only" drives off its wall (LEAVE) and ends the match parked in the loading zone; "does nothing" never drives (a brush from our robot may nudge it)', inLz && offWall && Math.hypot(pr.pos.x - p0.x, pr.pos.y - p0.y) > 5 && Math.hypot(ID.w.robots[1].pos.x - i0.x, ID.w.robots[1].pos.y - i0.y) < 3);
  // the Box Tube
  const TB = [51, 52, 53].map((sd) => {
    const ep = new Episode(duo(sd, 'none'));
    const r = ep.run();
    const owned = bb(ep.w).flowers.filter((f) => {
      const cols = f.stack.map((id) => ep.w.balls.find((q) => q.id === id)?.color);
      return [...cols].reverse().find((c) => c !== 'yellow') === 'blue';
    }).length;
    const g410 = (ep as unknown as { guards: { report(): { events: { detail: string }[] } } }).guards.report().events.some((e) => e.detail.includes('G410'));
    return { owned, g410, places: r.parts, reward: r.reward };
  });
  check('10 Box Tube: REAL-v1 places its NECTAR into FLOWERs after the 1:00 cue — it owns FLOWERs at the end of every match — and never draws G410', TB.every((t) => t.owned >= 1 && !t.g410), TB.map((t) => `${t.owned} FLOWERs`).join(', '));
  // strikes: reported, fined only when they score
  check('10 strikes: an element knocked faster than a robot is reported; it is fined only if it then scores for us', all.some((r) => r.parts.strikes > 0) && all.every((r) => (r.parts.strikesScored ?? 0) <= r.parts.strikes && r.score - r.reward <= 15 * r.parts.violations + 5 * (r.parts.strikesScored ?? 0) + 1e-9));
  // per-robot misses
  {
    const w = newMatch(5, [{ id: 0, alliance: 'blue', spec: v1, startIndex: 0 }, { id: 1, alliance: 'blue', spec: v1, startIndex: 1 }]);
    const [b0, b1] = w.balls;
    b0.state = { kind: 'held', robot: 0 } as unknown as typeof b0.state;
    b1.state = { kind: 'held', robot: 1 } as unknown as typeof b1.state;
    const P = new Perturber(1, { blue: { shotAccuracy: 1 } }, undefined, new Map([[1, { shotAccuracy: 0 }]]));
    P.apply(w);
    for (const b of [b0, b1]) {
      b.state = { kind: 'flight', target: 'blue', by: 'blue' } as unknown as typeof b.state;
      b.z = 10;
      b.vz = 100;
    }
    P.apply(w);
    check('10 misses: two robots of one alliance miss at their own rates (the launcher is the robot that held the element)', b0.vz === 100 && b1.vz < 100);
  }
  // shooting envelopes per build
  {
    const env = envelopeOf(v1);
    const rng = mulberry32(7);
    const pick = Array.from({ length: 8 }, () => env.spots.north[Math.floor(rng() * env.spots.north.length)]);
    const ok = pick.filter((sp) => [0, Math.PI / 2].every((h) => shootingColumn({ spec: v1, side: 'north', x: sp.x, ys: [sp.y], heading: h })[0].entered)).length;
    check("10 envelopes: each build has its own measured shooting envelope (REAL-v1's is not REAL-v0's); its spots score from any heading", env.key !== 'real-v0-s1' && presets.every((p) => envelopeOf(p).key !== 'real-v0-s1') && ok === pick.length, `${ok}/${pick.length} re-measured spots score`);
  }
  // paths around the frame
  {
    const path = [{ x: -24, y: 57 }, ...planPath({ x: -24, y: 57 }, { x: -10, y: -20 }, 14), { x: -10, y: -20 }];
    const red = { x0: -BB.BB_FRAME_BAR_OUT - 8, y0: -BB.BB_FRAME_Y - 8, x1: -BB.BB_FRAME_BAR_IN + 8, y1: BB.BB_FRAME_Y + 8 };
    let through = false;
    for (let i = 0; i + 1 < path.length; i++)
      for (let k = 0; k <= 200; k++) {
        const x = path[i].x + ((path[i + 1].x - path[i].x) * k) / 200;
        const y = path[i].y + ((path[i + 1].y - path[i].y) * k) / 200;
        if (x > red.x0 && x < red.x1 && y > red.y0 && y < red.y1) through = true;
      }
    check('10 paths: a goal near the HIVE frame is still reached AROUND it (the S1 planner went straight through)', !through && path.length > 2);
  }
  // the store
  {
    const st = new Store(':memory:');
    const m = st.addMatch({ gen: 0, kind: 'selfplay', seed: 1, partner: 'real', start: 'F3', reward: 1, score: 1 });
    st.tx(() => st.addDecisions(Array.from({ length: 50 }, (_, i) => ({ match: m, gen: i % 3, tick: i, robot: 0, chosen: 0, best: 1, obs: new Float32Array([i]), feats: new Float32Array([1, 2]), q: new Float32Array([1, NaN]), se: new Float32Array([0.1, NaN]), n: new Float32Array([2, 0]), source: 'search' }))));
    const d = st.decisions({ fromGen: 2, limit: 3 });
    st.addState({ gen: 0, tag: 't', args: { a: 1 }, forces: [[5, 'k']], tick: 9 });
    check('10 store: matches, decisions (float arrays exact, NaN kept), states and plans round-trip; pruning keeps the newest', d.length === 3 && d[0].tick === 47 && Number.isNaN(d[0].q[1]) && st.pickStates('t', 1)[0].forces[0][1] === 'k' && st.pruneDecisions(10) === 40 && st.decisions({})[9].tick === 40);
    st.close();
  }
  // the service
  {
    const pl = plist();
    check('10 service: the LaunchAgent restarts the studio after a crash but not after Quit, and resumes where the run was', pl.includes(LABEL) && pl.includes('--supervise') && /<key>SuccessfulExit<\/key><false\/>/.test(pl) && pl.includes(ROOT));
  }
}

// ---- 11. the AUTO planner and playbook (MASTERPLAN phase 2) --------------------------------------------------
{
  const V1 = 'profiles/real-v1.json';
  const P0: AutoProblem = { profile: V1, start: 'F3', partner: 'none', mode: 'best', seed: 1 };
  // a plan is followed step by step, and each step is recorded with when it was taken
  const nx = nextChoice({ args: autoArgs(P0, 0), plans: [[]] });
  const alt = nx ? [...nx.opts].sort((a, b) => a.prior - b.prior)[0] : null; // its LEAST favourite option
  const shown = alt ? showPlan({ args: autoArgs(P0, 0), plans: [[alt.step]] }) : null;
  check('11 plan: the planner sees a robot\'s options at its next job start, and a plan makes it take one it would not (recorded, run to its end)', !!nx && nx.robot === 0 && nx.opts.length >= 2 && !!shown && shown.taken[0]?.kind === alt!.step.kind && shown.taken[0].matched && shown.taken[0].end !== undefined);
  const again = playPlan({ args: [autoArgs(P0, 3), autoArgs(P0, 3)], plans: [[alt!.step]] });
  check('11 plan: playing a plan is deterministic (the same draw twice → the same AUTO points)', again[0] === again[1]);
  // the search beats the robot's own AUTO, on fresh draws
  const pool = new WorkerPool(12);
  const solo = await planAuto(P0, pool, AUTO_QUICK);
  const joint = await planAuto({ profile: V1, start: 'F3', partner: 'real', partnerStart: 'BOTTOM_AUD', mode: 'joint', seed: 1 }, pool, AUTO_QUICK);
  const best = await planAuto({ profile: V1, start: 'F3', partner: 'skimmer', partnerStart: 'BOTTOM_AUD', mode: 'best', seed: 1 }, pool, AUTO_QUICK);
  pool.close();
  check('11 planner: a searched AUTO beats the robot\'s own AUTO on fresh draws (alone, and planned jointly with a second REAL-v1)', solo.nominal.mean > solo.baseline.mean + 5 && joint.nominal.mean > joint.baseline.mean + 5, `alone ${solo.nominal.mean.toFixed(1)} vs ${solo.baseline.mean.toFixed(1)}, joint ${joint.nominal.mean.toFixed(1)} vs ${joint.baseline.mean.toFixed(1)} (quick budget)`);
  check('11 planner: a joint plan plans both robots; a best response only ours (the partner runs its own AUTO)', joint.plan[1].length > 0 && best.plan[1].length === 0 && best.taken.every((q) => q.robot === 0) && joint.taken.some((q) => q.robot === 1));
  check('11 planner: every result carries its worst tenth, robots drawn from the range, and an exact replay of AUTO', [solo, joint, best].every((r) => r.nominal.cvar10 <= r.nominal.mean && r.sampled.n > 0 && !!r.frames && r.frames.f.length > 800 && r.frames.f.every((q) => q.m[0] === 'pre' || q.m[0] === 'auto' || q.m[0] === 'transition')));
  // the playbook: its grid, a build, storage, the studio's endpoints
  const grid = problems(V1);
  check('11 playbook: it covers every partner type from every legal pair of starts, in both modes where the partner plays (165 entries for REAL-v1)', grid.length === 165 && grid[0].start === 'F3' && grid[0].partner === 'none' && grid.every((P) => P.partner === 'none' || P.partnerStart !== P.start));
  const tmp = join(ROOT, 'runs', '_check-playbook');
  rmSync(tmp, { recursive: true, force: true });
  const pb = new Playbook(V1, tmp);
  await pb.build({ budget: 'quick', starts: ['F3'], partners: ['none', 'parker'], modes: ['best'], workers: 12 });
  const keys = pb.entries().map((e) => e.key);
  const rep = pb.replay(keys[0] ?? '');
  check('11 playbook: a build plans each entry once and keeps it with its replay (a second build has nothing to do)', keys.length === 1 + 3 && !!rep && rep.frames.f.length > 800 && pb.status.done === 4);
  await pb.build({ budget: 'quick', starts: ['F3'], partners: ['none', 'parker'], modes: ['best'], workers: 12 });
  check('11 playbook: …and continues where it stopped', pb.status.total === 0 && pb.entries().length === 4);
  pb.store.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ---- 12. thinking ahead v2: sequential halving on shared luck (MASTERPLAN phase 3) --------------------------
const QUICK2: Search2Spec = { rounds: [{ draws: 2, horizon: 300 }, { draws: 3, horizon: 600 }], margin: 2, z: 1 };
const V1P = 'profiles/real-v1.json';
const s2args = (genome: string | null, o: Partial<EpisodeArgs> = {}): EpisodeArgs => ({ genome, profile: V1P, sampleProfile: true, seed: 12, stage: 'full', driver: 'oracle', track: false, record: false, search2: QUICK2, keepSearched: true, searchWindow: [1800, 3000], ...o });
const s2a = runEpisode(s2args(null));
{
  const s2b = runEpisode(s2args(null));
  const L = s2a.labels ?? [];
  check('12 search v2: deterministic (the same match twice → the same score and the same searched values)', L.length >= 3 && s2a.reward === s2b.reward && JSON.stringify(L) === JSON.stringify(s2b.labels));
  const shape = L.every((l) => l.rq.length === QUICK2.rounds.length && l.rq[0].every((v) => v !== null) && l.rq.every((row, r) => r === 0 || row.every((v, i) => v === null || l.rq[r - 1][i] !== null)) && l.depth[l.net] === QUICK2.rounds.length - 1);
  check('12 search v2: round 1 plays every option, each later round a subset, and the network\'s own choice is always played to the last round', shape);
  check('12 search v2: the network is overruled only by a clear winner of the last round (more than the margin on the same draws)', L.every((l) => l.chosen === l.net || l.q[l.chosen]! - l.q[l.net]! > QUICK2.margin) && s2a.searched!.changed === L.filter((l) => l.chosen !== l.net).length);
  check('12 search v2: only decisions inside the search window are searched; each keeps what the networks saw', L.every((l) => l.tick >= 1800 && l.tick < 3000 && !!l.x && l.x.n >= 1 && Buffer.from(l.x.o, 'base64').length === 4 * l.q.length * N_OPT_IN && Number.isFinite(l.sofar)));
  check('12 search v2: the full budget is the measured one (259 vs v1 look-ahead 231 on 24 paired exam matches, TRAINING.md)', SEARCH2.rounds.length === 3 && SEARCH2.rounds[2].draws === 8 && SEARCH2.margin === 2);
}

// ---- 13. the entity network, the learner and the continuous engine (MASTERPLAN phase 4) ----------------------
{
  // the backward pass against finite differences (float64 parameters; float32 inside, hence the tolerance)
  const sh: EntShape = { G: 7, F: 5, O: 4, D: 6, A: 3, H: 5, style: 2 };
  const r = mulberry32(3);
  const gauss = (): number => Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
  const P = new Float64Array(entInit(sh, gauss)).map((v) => v + 0.3 * gauss());
  const x = { g: Float64Array.from({ length: 7 }, gauss) as unknown as Float32Array, e: Float64Array.from({ length: 20 }, gauss) as unknown as Float32Array, n: 4, o: Float64Array.from({ length: 12 }, gauss) as unknown as Float32Array, k: 3 };
  const W = [0.7, -1.3, 0.4];
  const lossAt = (pp: Float64Array): number => {
    const t = new EntNet(sh, pp as unknown as Float32Array).forward(x);
    return t.q.reduce((a, q, j) => a + W[j] * q, 0) + 0.9 * t.v;
  };
  const net = new EntNet(sh, P as unknown as Float32Array);
  const g = new Float64Array(P.length) as unknown as Float32Array;
  net.backward(x, net.forward(x), W, 0.9, g);
  let worst = 0;
  for (let i = 0; i < layout(sh).style; i++) {
    const a = new Float64Array(P);
    const b = new Float64Array(P);
    a[i] += 1e-3;
    b[i] -= 1e-3;
    const fd = (lossAt(a) - lossAt(b)) / 2e-3;
    if (Math.abs(fd) < 1e-3 && Math.abs(g[i]) < 1e-3) continue;
    worst = Math.max(worst, Math.abs(fd - g[i]) / Math.max(1e-6, Math.abs(fd) + Math.abs(g[i])));
  }
  check('13 entity network: its hand-written gradients match finite differences (every weight, attention included)', worst < 0.02, `worst relative error ${worst.toExponential(1)}`);
  // a set: the order of the entities does not matter
  const L = s2a.labels ?? [];
  const f32 = (b: string): Float32Array => new Float32Array(new Uint8Array(Buffer.from(b, 'base64')).buffer);
  const l0 = L[0];
  const g0 = decodeGenome(entGenome(5)) as { ent: Float32Array };
  const en = new EntNet(ENT_SHAPE, g0.ent);
  const xin = { g: f32(l0.x!.g), e: f32(l0.x!.e), n: l0.x!.n, o: f32(l0.x!.o), k: l0.q.length };
  const rev = new Float32Array(xin.e.length);
  for (let i = 0; i < xin.n; i++) rev.set(xin.e.subarray(i * N_ENT, (i + 1) * N_ENT), (xin.n - 1 - i) * N_ENT);
  const q1 = en.forward(xin).q;
  const q2 = en.forward({ ...xin, e: rev }).q;
  check('13 entity network: it reads the field as a SET (the entities in any order → the same values); every robot and element in play is one', q1.every((v, i) => Math.abs(v - q2[i]) < 1e-4) && xin.n >= 20 && xin.e[0] === 1);
  // it drives the robot; a drill's hand-over
  const gA = entGenome(5);
  const gB = entGenome(6);
  const argsE = (genome: string, o: Partial<EpisodeArgs> = {}): EpisodeArgs => ({ genome, profile: V1P, sampleProfile: true, seed: 3, stage: 'full', driver: 'oracle', track: false, record: false, ...o });
  const eA = runEpisode(argsE(gA));
  const eA2 = runEpisode(argsE(gA));
  const eB = runEpisode(argsE(gB));
  const eAB = runEpisode(argsE(gA, { handover: { tick: 0, genome: gB } }));
  check('13 entity network: it plays a whole match (deterministic); its skill genes are read like v1\'s', eA.reward === eA2.reward && eA.ticks > 9000 && genomeStyle(gA).length === STYLE.length && genomeStyle(gA).every((v, i) => Math.abs(v - STYLE_DEFAULT_GENES[i]) < 1e-6));
  check('13 drills: a hand-over switches the network mid-match (on tick 0 it plays exactly as the new one)', eAB.reward === eB.reward && eAB.ticks === eB.ticks);
  // labels through the Store, an older store upgraded in place
  const tmpDb = join(ROOT, 'runs', '_check-store.db');
  rmSync(tmpDb, { force: true });
  const old = new DatabaseSync(tmpDb);
  old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('version', '1');
    CREATE TABLE decisions (id INTEGER PRIMARY KEY, match INT, gen INT, tick INT, robot INT, k INT, chosen INT, best INT, obs BLOB, feats BLOB, q BLOB, se BLOB, n BLOB, ents BLOB, source TEXT);`);
  old.close();
  const st = new Store(tmpDb);
  const rows = labelRows(s2a, 7, 0, QUICK2);
  st.tx(() => st.addDecisions(rows));
  const back = toLabels(st.decisions({ source: 'search2' }));
  st.close();
  check('13 store: searched decisions keep every round\'s values, the draws, the entity view and the points still to come (an older store gains the columns)', back.length === L.length && back.every((b) => b.rq.length === QUICK2.rounds.length * b.x.k && b.rd[1] === 3 && Number.isFinite(b.v) && b.x.o.length === b.x.k * N_OPT_IN) && back.some((b) => b.rq.some(Number.isNaN)));
  // the learner fits them
  const before = entEval(g0.ent, back);
  const fit = entFit(g0.ent, back, back, { epochs: 40, lr: 0.003, batch: 4, seed: 1 });
  check('13 learner: fitting the searched values lowers the loss on them (and never touches the skill genes)', fit.report.lossTest < before.lossTest * 0.8 && fit.p.subarray(layout(ENT_SHAPE).style).every((v, i) => v === g0.ent[layout(ENT_SHAPE).style + i]), `loss ${before.lossTest.toFixed(3)} → ${fit.report.lossTest.toFixed(3)}`);
  const lj = learnJob({ store: tmpDb, start: gA, lrs: [0.001, 0.002, 0.004], epochs: 2, window: 1000, seed: 1 });
  check('13 learner: as a worker job it reads the Store, tries each learning rate and keeps the best on held-out decisions', lj.genome.startsWith(ENT_PREFIX) && lj.tried.length === 3 && lj.tried.some((t) => t.lr === lj.lr));
  rmSync(tmpDb, { force: true });
  for (const sfx of ['-wal', '-shm']) rmSync(tmpDb + sfx, { force: true });
  // the pool's queue: evaluator work jumps the actors
  const pool = new WorkerPool(1);
  await pool.map([]); // (the worker up: while it starts, the queue simply orders by priority)
  const order: string[] = [];
  const sp = (tag: string, pri: number): Promise<void> => pool.submit<string>({ module: 'jobs.ts', fn: 'spin', args: { ms: 150, tag } }, pri).then((t) => void order.push(t));
  await Promise.all([sp('a', 0), sp('b', 0), sp('c', 2)]);
  pool.close();
  check('13 pool: a higher-priority job takes the next free worker (the evaluator before queued actors)', order.join('') === 'acb', order.join(''));
  // promotion by SPRT
  const rr = mulberry32(11);
  const nrm = (m: number): number => m + 20 * Math.sqrt(-2 * Math.log(Math.max(1e-12, rr()))) * Math.cos(2 * Math.PI * rr());
  const S = v2Defaults(V1P).sprt;
  const up = Array.from({ length: 400 }, () => nrm(12));
  const dn = Array.from({ length: 400 }, () => nrm(-6));
  const firstDecision = (d: number[]): [string | null, number] => {
    for (let n = S.minN; n <= d.length; n += 12) {
      const v = sprt(d.slice(0, n), S);
      if (v) return [v, n];
    }
    return [null, d.length];
  };
  const [vu, nu] = firstDecision(up);
  const [vd, nd] = firstDecision(dn);
  check('13 promotion: the sequential test promotes a clearly better network and rejects a worse one, stopping early', vu === 'H1' && vd === 'H0' && sprt(up.slice(0, S.minN - 1), S) === null, `better: ${vu} after ${nu}, worse: ${vd} after ${nd}`);
  check('13 exam: fixed forever, every partner kind in every stretch of it', JSON.stringify(examList(v2Defaults(V1P))) === JSON.stringify(examList(v2Defaults(V1P))) && examList(v2Defaults(V1P)).slice(0, 6).map((e) => e.partner).join() === v2Defaults(V1P).partners.join());
  // the whole engine, small: baseline exam → actors → learner → a candidate on the exam → a verdict; pause; reopen
  const name = '_check-v2';
  rmSync(join(V2_DIR, name), { recursive: true, force: true });
  const cfg = { ...v2Defaults(V1P), workers: 6, search: QUICK2, window: 600, learnEvery: 12, learnWindow: 5000, epochs: 3, examSeeds: 1, partners: ['none', 'parker'] as ('none' | 'parker')[], sprt: { ...S, minN: 2, chunk: 2 } };
  const c = new Continuous(name, cfg);
  const t0 = Date.now();
  let peak = 0;
  c.start();
  while (!c.st.candidates.length && Date.now() - t0 < 400_000) {
    await new Promise((res) => setTimeout(res, 1000));
    peak = Math.max(peak, c.status().activity.actors);
  }
  const sNow = c.status();
  c.stop('paused');
  const c2 = new Continuous(name);
  check('13 continuous: the no-learning robot takes the exam first, actors store searched decisions, the learner makes a candidate, the evaluator gives a verdict', !!c.st.base && c.st.base.length === 2 && c.st.totals.labels >= 12 && c.st.candidates.length >= 1 && c.st.candidates[0].n >= 2 && c.problems.length === 0, `${((Date.now() - t0) / 1000).toFixed(0)} s, ${c.st.totals.labels} labels, verdict ${c.st.candidates[0]?.verdict}${c.problems.length ? `, problems: ${c.problems.join(' | ')}` : ''}`);
  check('13 continuous: every worker kept busy with actors between exams; paused, it reopens where it was (not training)', peak === cfg.workers && !c2.st.running && c2.st.candidates.length === c.st.candidates.length && c2.st.totals.labels === c.st.totals.labels && sNow.champion.exam !== null);
  c.store.close();
  c2.store.close();
  rmSync(join(V2_DIR, name), { recursive: true, force: true });
  // the studio's Home page
  const srv = startServer(4797, undefined, { noResume: true });
  const h = await fetch('http://127.0.0.1:4797/api/home');
  const hj = (await h.json()) as { profiles: string[]; runs: unknown[] };
  const pz = await fetch('http://127.0.0.1:4797/api/home/pause', { method: 'POST', body: '{}' });
  await srv.close();
  check('13 studio: the Home page lists the robots and runs; Pause with nothing training is harmless', h.status === 200 && hj.profiles.includes(V1P) && Array.isArray(hj.runs) && pz.status === 200);
}

// ---- 14. opponents and the route library (MASTERPLAN phase 5) ----------------------------------------------------
{
  const a2 = (seed: number, o: Partial<EpisodeArgs> = {}): EpisodeArgs => ({ genome: null, profile: V1P, sampleProfile: true, seed, stage: 'full', driver: 'oracle', track: false, record: false, routes: true, ...o });
  const vs = Object.fromEntries((['presets', 'mirror', 'defense'] as const).map((k) => [k, runEpisode(a2(21, { opponents: k, frames: true }))]));
  const ok2 = Object.values(vs).every((r) => r.death !== 'crash' && r.parts.shotsIn > 10 && (r.opponents?.score ?? 0) > 30 && r.frames!.oppSpecs?.length === 2 && r.frames!.f.every((f) => f.opp?.length === 2));
  check('14 opponents: a red alliance plays full 2v2 matches (DSIM presets, two copies of our robot, a defender): both alliances score, the frames carry every robot', ok2, Object.entries(vs).map(([k, r]) => `${k}: us ${r.reward}, red ${r.opponents!.score}`).join(', '));
  const again = runEpisode(a2(21, { opponents: 'defense', frames: true }));
  check('14 opponents: a 2v2 match is deterministic', again.reward === vs.defense.reward && again.ticks === vs.defense.ticks && again.frames!.f.length === vs.defense.frames!.f.length);
  let close = 0;
  let minD = Infinity;
  for (const f of vs.defense.frames!.f)
    if (f.m[0] === 'teleop' && f.opp) {
      const d = Math.hypot(f.opp[0][0] - f.r[0], f.opp[0][1] - f.r[1]);
      minD = Math.min(minD, d);
      if (d < 36) close++;
    }
  check('14 opponents: the defender shadows our robot in TELEOP (close to it, between it and its HIVE)', (close * 2) / 60 >= 10, `${((close * 2) / 60).toFixed(0)} s within 36 in, closest ${minD.toFixed(0)} in`);
  const tiles = (r: EpisodeResult): boolean => !!r.cycles && r.cycles.length > 10 && r.cycles.every((c, i) => c.t1 >= c.t0 && (i === 0 || c.t0 >= r.cycles![i - 1].t1)) && r.cycles.reduce((x, c) => x + c.mine, 0) === r.parts.shotsIn;
  check('14 routes: cycles run volley to volley and tile the match; every one of our shots that went in is credited to exactly one (in 2v2 too: only our own shots count)', Object.values(vs).every(tiles) && tiles(runEpisode(a2(22))));
  const ms = [22, 23, 24].map((seed, i) => {
    const r = runEpisode(a2(seed, { opponents: OPPONENT_KINDS[i + 1] }));
    return { match: i, partner: 'none', opponents: OPPONENT_KINDS[i + 1], reward: r.reward, cycles: r.cycles!, teleopStart: Math.round((4 + 30 + 8) * 60), end: Math.round((4 + 158) * 60) };
  });
  const lib = mineRoutes(ms, 0);
  const shares = lib.routes.reduce((x, r) => x + r.share, 0);
  check('14 route library: every cycle in exactly one route; each route with its rate, when it is used and an exam moment to watch', Math.abs(shares - 1) < 1e-9 && lib.cycles === ms.reduce((x, m) => x + m.cycles.length, 0) && lib.routes.every((r) => r.example.match >= 0 && r.example.match < 3 && ms[r.example.match].cycles.some((c) => c.t0 === r.example.t0) && r.when.auto + r.when.teleop + r.when.endgame === r.n) && lib.openings.length > 0, `${lib.routes.length} routes from ${lib.cycles} cycles`);
  const ex = examList(v2Defaults(V1P));
  const pairs = new Set(ex.map((e) => `${e.partner}|${e.opponents}`));
  check('14 exam: every partner kind meets every opponent kind, the same matches forever', pairs.size === v2Defaults(V1P).partners.length * v2Defaults(V1P).opponents.length && ex.length === 144);
  const srv = startServer(4796, undefined, { noResume: true });
  const rt = await fetch('http://127.0.0.1:4796/api/routes');
  const rj = (await rt.json()) as { library: unknown };
  await srv.close();
  check('14 studio: the route library is served (none before a run has taken its exam)', rt.status === 200 && 'library' in rj);
}

// ---- 15. the mistake audit and drills (MASTERPLAN phase 6) --------------------------------------------------------
{
  const a3 = (seed: number, o: Partial<EpisodeArgs> = {}): EpisodeArgs => ({ genome: null, profile: V1P, sampleProfile: true, seed, stage: 'full', driver: 'oracle', track: false, record: false, audit: true, ...o });
  const R = [31, 32, 33, 34].map((s) => runEpisode(a3(s, s === 34 ? { opponents: 'defense' } : {})));
  const kinds = new Set(['empty-trip', 'blocked-shot', 'idle', 'foul', 'stall', 'crash', 'judgement']);
  const consistent = R.every((r) => {
    const A = r.audit ?? [];
    const n = (k: string): number => A.filter((x) => x.kind === k).length;
    return A.every((x, i) => kinds.has(x.kind) && (i === 0 || x.tick >= A[i - 1].tick)) && n('empty-trip') === r.mistakes.emptyTrips && n('blocked-shot') === r.mistakes.blockedShots && n('stall') === r.mistakes.stalls && n('crash') === (r.death === 'crash' ? 1 : 0) && A.filter((x) => x.kind === 'idle').every((x) => x.cost >= 3);
  });
  check('15 audit: every mistake of a match with its moment and cost — empty trips, blocked shots, stalls and crashes agree with the match\'s own counts; idle spells are 3 s or more', consistent && R.some((r) => (r.audit ?? []).length > 0), R.map((r) => `${(r.audit ?? []).length}`).join(', ') + ' mistakes');
  // a search's changes replayed as forced choices rebuild its match exactly (a judgement drill's recipe)
  const sm = runEpisode(s2args(null, { searchWindow: undefined, seed: 12 }));
  const forces: [number, string][] = (sm.labels ?? []).filter((l) => l.change).map((l) => [l.tick, l.change!.key]);
  const rp = runEpisode({ ...s2args(null, { seed: 12 }), search2: undefined, keepSearched: false, searchWindow: undefined, forces });
  check('15 drills: a thought-through match is rebuilt exactly from its forced choices (a state\'s recipe), without searching', forces.length >= 2 && rp.reward === sm.reward && rp.ticks === sm.ticks, `${forces.length} changes, ${sm.reward} vs ${rp.reward}`);
  // a drill: the recipe up to a moment, then the champion, thinking ahead
  const dtick = forces[1][0] + 1;
  const dr = runEpisode({ ...s2args(null, { seed: 12 }), forces: forces.slice(0, 2), handover: { tick: dtick, genome: entGenome(9) }, searchWindow: [dtick, dtick + 600] });
  check('15 drills: a drill replays the recipe to its moment, hands over and searches only from there', (dr.labels ?? []).length >= 1 && (dr.labels ?? []).every((l) => l.tick >= dtick && l.tick < dtick + 600));
  const e = (o: Partial<AuditEntry>): AuditEntry => ({ tick: 1000, kind: 'empty-trip', cost: 2, detail: 'x', x: 10, y: 10, match: 3, repeat: false, ...o });
  check('15 repeats: the same kind of mistake in the same exam match, within 5 s and 24 in, is a repeat; elsewhere or later it is not', sameMistake(e({}), e({ tick: 1200, x: 20 })) && !sameMistake(e({}), e({ match: 4 })) && !sameMistake(e({}), e({ tick: 1400 })) && !sameMistake(e({}), e({ x: 60 })) && !sameMistake(e({ kind: 'foul', detail: 'G417' }), e({ kind: 'foul', detail: 'G409' })));
  // the engine: an audited champion, its drills, drill matches among the actors'
  const name = '_check-v2d';
  rmSync(join(V2_DIR, name), { recursive: true, force: true });
  const cfg = { ...v2Defaults(V1P), workers: 6, search: QUICK2, window: 600, learnEvery: 1e9, examSeeds: 1, partners: ['none', 'parker'] as ('none' | 'parker')[] };
  const c = new Continuous(name, cfg);
  const t0 = Date.now();
  c.start();
  while (!(c.st.totals.drills ?? 0) && Date.now() - t0 < 300_000) await new Promise((res) => setTimeout(res, 1000));
  c.stop('paused');
  const au = c.audit();
  const drillRows = Number((c.store.db.prepare("SELECT COUNT(*) AS n FROM matches WHERE kind = 'drill'").get() as { n: number }).n);
  const ds = c.store.countStates('drill:');
  let replayOk = false;
  if (au?.items.length) {
    const m = c.mistakeArgs(0);
    const rr = runEpisode({ ...m.args, audit: true, frames: false });
    replayOk = (rr.audit ?? []).some((x) => x.kind === au.items[0].kind && x.tick === au.items[0].tick);
  }
  check('15 continuous: the no-learning champion\'s exam is audited, its mistakes become drills, and actors play them', !!au && au.champion === 0 && au.items.every((x) => x.match >= 0 && x.match < 2 && !x.repeat) && ds.n > 0 && drillRows >= 1 && c.st.audits.length === 1, `${au?.items.length ?? 0} mistakes, ${ds.n} drills, ${drillRows} drill matches, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  check('15 continuous: a mistake replays exactly where the audit found it (the Mistakes page\'s "watch")', !au?.items.length || replayOk);
  c.store.close();
  rmSync(join(V2_DIR, name), { recursive: true, force: true });
  const srv = startServer(4795, undefined, { noResume: true });
  const mk = await fetch('http://127.0.0.1:4795/api/mistakes');
  await srv.close();
  check('15 studio: the Mistakes page is served', mk.status === 200 && 'audit' in ((await mk.json()) as object));
}

// ---- 16. the robot lab, notifications, the printable playbook ----------------------------------------------------
{
  const robots = listRobots();
  check('16 robots: every profile is listed with its build in words and validated over its whole range', robots.length >= 3 && robots.every((r) => r.ok && r.build.includes('·')), robots.map((r) => `${r.id}: ${r.build}`).join(' | '));
  const v1 = loadProfile(join(ROOT, 'profiles/real-v1.json'));
  const ins = inspectRobot(v1);
  check('16 robots: DSIM\'s own floors and ceilings (REAL-v1: mass ≥ 23.3 lb), its smallest and largest robot, its measured envelope and start', ins.floors['spec.massLb'].min === 23.3 && ins.small.length === 13.5 && ins.big.width === 17 && ins.envelope.quality === 'measured' && ins.envelope.spots.north.length > 100 && ins.start.x > 55);
  const bad = JSON.parse(JSON.stringify(v1));
  bad.limits.fireRate.min = 20;
  bad.spec.massLb.min = 10;
  check('16 robots: a range DSIM cannot build or that is upside down is caught before anything is saved', shapeProblems(bad).some((x) => x.includes('Fire rate')) && profileProblems({ ...bad, limits: v1.limits }, true).some((x) => x.startsWith('massLb')));
  const reps = replayRobots();
  const settings = JSON.stringify({ game: 'biobuzz', spec: reps[0]?.spec ?? v1.spec, savedRobots: [{ name: 'x', spec: reps[0]?.spec ?? v1.spec }] });
  const cands = specsIn(settings);
  let notJson = false;
  try {
    specsIn('not json');
  } catch {
    notJson = true;
  }
  check('16 import: DSIM\'s settings (its robot and saved robots) and replays are read; anything else is refused with a reason', cands.length === 2 && notJson && reps.length > 0);
  const draft = draftFrom(cands[0].spec, v1);
  const dp = inspectRobot(draft).problems;
  check('16 import: a draft keeps the build exactly, puts mass and motor speed in a range inside DSIM\'s floors, takes the rest from a template — and validates', dp.length === 0 && typeof draft.spec.massLb === 'object' && describeBuild(resolve(draft).spec) === describeBuild(coerce(cands[0].spec as Parameters<typeof coerce>[0])) && JSON.stringify(draft.limits) === JSON.stringify(v1.limits), dp.join('; '));
  const tmpId = 'zz check robot';
  const f = saveRobot({ ...draft, id: tmpId }, false);
  let dup = false;
  try {
    saveRobot({ ...draft, id: tmpId }, false);
  } catch {
    dup = true;
  }
  const back = loadProfile(join(ROOT, f));
  rmSync(join(ROOT, f), { force: true });
  check('16 save: a robot is saved as profiles/<name>.json, never over another by accident', f === 'profiles/zz-check-robot.json' && dup && back.id === tmpId && floorsOf(resolve(back).spec)['spec.width'].min > 0);
  check('16 notifications: none are posted while switched off (the gate runs with them off)', notify('champion', 'x', 'y') === false);
  const srv = startServer(4794, undefined, { noResume: true });
  const get = async (p: string): Promise<{ status: number; text: string }> => {
    const r = await fetch(`http://127.0.0.1:4794${p}`);
    return { status: r.status, text: await r.text() };
  };
  const [rb, su, nt, pr, ins2] = [await get('/api/robots'), await get('/api/setup?profile=profiles/real-v1.json'), await get('/api/notify'), await get('/print.html'), await fetch('http://127.0.0.1:4794/api/robots/inspect', { method: 'POST', body: JSON.stringify({ profile: bad }) })];
  await srv.close();
  const suj = JSON.parse(su.text) as { robot: { ok: boolean }; envelope: string };
  check('16 studio: the Robot page, the setup checklist, notification settings and the printable playbook are served; a bad robot is explained, not crashed on', rb.status === 200 && JSON.parse(rb.text).robots.length >= 3 && su.status === 200 && suj.robot.ok && suj.envelope === 'measured' && nt.status === 200 && 'settings' in JSON.parse(nt.text) && pr.status === 200 && pr.text.includes('Print') && ins2.status === 400);
}

console.log(fails === 0 ? '\nTRAINING PLATFORM GATE: ALL PASS' : `\nTRAINING PLATFORM GATE: ${fails} FAIL`);
process.exit(fails ? 1 : 0);
