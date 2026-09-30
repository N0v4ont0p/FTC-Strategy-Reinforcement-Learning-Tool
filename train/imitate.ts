// LEARNING FROM THE TEAM'S REPLAYS — the DSIM replays in "Training data/" (world-record level runs)
// turned into demonstrations of WHAT TO DO NEXT. They are used three ways:
//   1. a network fitted to them (below) seeds generation 0;
//   2. every generation, a share of the population are STUDENTS: a parent that took a short lesson
//      on these demonstrations (+ the champion's own decisions) — train/algos.ts;
//   3. they are the probe decisions that prove a behaviour mutation changed behaviour.
//
// How a replay becomes demonstrations: DSIM's own ReplayPlayer re-simulates it bit-exactly. Every
// time the human starts something — takes elements from a GROUP, pulls from a FLOWER, starts
// shooting, enters a human-player NECTAR — that is one decision. The state it was decided in is the
// world at the end of the previous decision, where train/skills.ts lists the options our robot
// would have had; the option matching what the human did is the label. Two refinements follow the
// skills: the next element of the SAME group is the same decision (a sweep), and a shot only counts
// as "went to shoot" when no pickup follows within a second (the replays shoot while sweeping,
// which our robot does on its own).
//
// A DATA SET is the demonstrations of the included replays, cached under outputs/imitation/sets/
// by a key over the files and the skills version, and never deleted: a run records the key it
// learns from, so rewinding a run re-learns from exactly the same demonstrations.
//
// Honest limits: the replays drove a different build (front+back intake, 520 RPM, DSIM's ideal
// launcher). Only the ORDER of choices transfers, and it is a starting point, never the target:
// fitness is still the DSIM score of our own robot.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BB, C, PHYSICS, bb, coerce, init, type Replay } from '../harness/dsim';
import { loadProfile, resolve, type Resolved } from '../harness/profiles';
import { ReplayPlayer } from '../dsim-main/src/sim/replay';
import { mulberry32, seedOf } from '../harness/rng';
import { fromB64, initParams, paramCount, styleOffset, toB64 } from './net';
import { VALUE_SHAPE, fitValue, type ValueSet } from './value';
import { N_OBS, encode } from './obs';
import { SHAPE, STYLE_DEFAULT_GENES, THINK_TICKS } from './policy';
import { F_CURRENT, N_OPT_FEATS, Pilot, SKILLS_VERSION, options } from './skills';
import { Adam, choose, evaluate, lossAndGrad, pack, unpack, type Packed, type Sample } from './bc';
import { runEpisode } from './episode';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'Training data');
export const OUT = join(ROOT, 'outputs', 'imitation');
const SETS = join(OUT, 'sets');
const EXCLUDE = join(OUT, 'exclude.json');

type Pick = { kind: 'ball'; id: number } | { kind: 'flower'; i: number } | { kind: 'shoot' } | { kind: 'hp' };
type Ident = { kind: string; balls?: Set<number>; flower?: number };
const isSame = (o: { kind: string; balls?: number[]; flower?: number }, cur: Ident | null): boolean =>
  !!cur && (cur.balls ? !!o.balls?.some((id) => cur.balls!.has(id)) : o.kind === cur.kind && (o.kind !== 'flower' || o.flower === cur.flower));
const matches = (o: { kind: string; balls?: number[]; flower?: number }, pick: Pick): boolean =>
  pick.kind === 'ball' ? !!o.balls?.includes(pick.id) : pick.kind === 'flower' ? o.flower === pick.i : o.kind === pick.kind;

/**
 * A replay → demonstrations, SAMPLED THE WAY THE ROBOT THINKS: every THINK_TICKS ticks the world is
 * put through train/skills.ts `options`, the option the human's NEXT action reveals is the label,
 * and what they were already doing is flagged 'current'.
 *
 * ⚠️ Labelling only the MOMENTS THE HUMAN CHANGED (what this did first) teaches the exact opposite
 * of what is wanted: in every such example the current job is the one being abandoned, so a network
 * fitted to them never keeps doing anything. Measured: the seeded network switched 147 times in 158
 * decisions and scored 47 where the greedy baseline scored 178. Dense labels contain both the
 * "carry on" and the "change now" cases, in the proportion the human produced them.
 *
 * Two passes: the first collects what the human did and when (a shot counts as "went to shoot" only
 * when no pickup follows within a second — the replays shoot while sweeping, which the robot does on
 * its own); the second re-simulates and labels.
 */
export function demonstrations(file: string, base: Resolved): { samples: Sample[]; score: number; events: number; unmatched: number; stay: number } {
  const rep = JSON.parse(readFileSync(file, 'utf8')) as Replay & { setups: { spec: Parameters<typeof coerce>[0]; alliance: 'red' | 'blue'; id: number }[] };
  const setup = rep.setups[0];
  const spec = coerce(setup.spec);
  const prof: Resolved = { ...base, spec };
  const pilot = new Pilot(spec, base.limits);
  const cap = BB.bbHopperCap(spec);

  // PASS 1 — what the human did, and when
  const evs: { tick: number; pick: Pick }[] = [];
  {
    const p = new ReplayPlayer(rep);
    const prevKind = new Map<number, string>();
    const prevEl = new Map<number, string>();
    let shooting = false;
    let pendingShot: number | null = null;
    const hpBefore = { ...bb(p.world).nectarStock };
    while (p.stepOnce()) {
      const w = p.world;
      const r = w.robots.find((q) => q.id === setup.id)!;
      for (const b of w.balls) {
        const k = b.state.kind;
        const pk = prevKind.get(b.id);
        if (pk !== undefined && pk !== k) {
          if (k === 'held' && (b.state as { robot: number }).robot === r.id) {
            shooting = false;
            pendingShot = null; // a pickup right after a shot: that shot was part of the sweep
            const el = prevEl.get(b.id) ?? '';
            if (pk === 'element' && el.startsWith('flower:')) evs.push({ tick: w.tick, pick: { kind: 'flower', i: Number(el.slice(7)) } });
            else if (pk === 'ground') evs.push({ tick: w.tick, pick: { kind: 'ball', id: b.id } });
          } else if (k === 'flight' && pk === 'held' && !shooting) {
            shooting = true;
            pendingShot = w.tick;
          }
        }
        prevKind.set(b.id, k);
        prevEl.set(b.id, k === 'element' ? String((b.state as { el?: string }).el ?? '') : '');
      }
      if (pendingShot !== null && w.tick - pendingShot >= 60) {
        evs.push({ tick: pendingShot, pick: { kind: 'shoot' } });
        pendingShot = null;
      }
      const stock = bb(w).nectarStock[setup.alliance];
      if (stock < hpBefore[setup.alliance]) evs.push({ tick: w.tick, pick: { kind: 'hp' } });
      hpBefore[setup.alliance] = stock;
    }
    evs.sort((a, b) => a.tick - b.tick);
  }

  // PASS 2 — one demonstration every THINK_TICKS: "from here, this is what I went for next"
  const samples: Sample[] = [];
  let unmatched = 0;
  let stay = 0;
  {
    const p = new ReplayPlayer(rep);
    const obs = new Float32Array(N_OBS);
    let ei = 0;
    let cur = null as Ident | null;
    while (p.stepOnce()) {
      const w = p.world;
      while (ei < evs.length && evs[ei].tick <= w.tick) ei++;
      const ph = w.match.phase;
      if (w.tick % THINK_TICKS !== 0 || (ph !== 'auto' && ph !== 'teleop') || ei >= evs.length) continue;
      const r = w.robots.find((q) => q.id === setup.id)!;
      const was = cur;
      const opts = options(w, r, pilot, cap, new Map(), (o) => isSame(o, was));
      const y = opts.findIndex((o) => matches(o, evs[ei].pick));
      if (y < 0) {
        unmatched++;
        continue;
      }
      if (opts.length > 1) {
        encode(w, r, prof, obs);
        samples.push({ obs: new Float32Array(obs), feats: Float32Array.from(opts.flatMap((o) => o.feats)), k: opts.length, y });
        if (opts[y].feats[F_CURRENT] === 1) stay++;
      }
      cur = { kind: opts[y].kind, balls: opts[y].balls ? new Set(opts[y].balls) : undefined, flower: opts[y].flower };
    }
    return { samples, score: p.world.match.scores[setup.alliance].total, events: evs.length, unmatched, stay };
  }
}

// ─────────────────────────────── the data set ───────────────────────────────
export interface DataFile {
  name: string;
  size: number;
  included: boolean;
  /** does it re-simulate exactly in this DSIM: recorded in its version and its physics. A replay from
   * before DSIM Act 2 (its 2D pipeline, an older sim version) replays as DRIFT — the team's own
   * 730–819-point runs re-simulate to 56–151 — so it can be neither a demonstration nor a benchmark */
  replayable: boolean;
  why?: string;
}
const replayCheck = new Map<string, { replayable: boolean; why?: string }>();
/** read a replay's header: the sim version and physics it was recorded in (cached per file size and time) */
function replayableHere(name: string, size: number, mtime: number): { replayable: boolean; why?: string } {
  const k = `${name}:${size}:${mtime}`;
  const hit = replayCheck.get(k);
  if (hit) return hit;
  let out: { replayable: boolean; why?: string };
  try {
    const r = JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as { sim?: number; physics?: string };
    const phys = r.physics ?? '2d';
    out =
      r.sim === C.SIM_VERSION && phys === PHYSICS
        ? { replayable: true }
        : { replayable: false, why: `recorded in DSIM sim ${r.sim ?? '?'} (${phys === '2d' ? 'the 2D physics' : phys}), this DSIM is sim ${C.SIM_VERSION} (${PHYSICS}): it no longer re-simulates` };
  } catch (e) {
    out = { replayable: false, why: `not a readable replay: ${(e as Error).message.slice(0, 80)}` };
  }
  replayCheck.set(k, out);
  return out;
}
export interface SetFile {
  name: string;
  score: number;
  events: number;
  samples: number;
  stay: number; // demonstrations where the human carried on with what they were doing
  unmatched: number;
  error?: string;
}
export interface DemoSet {
  key: string;
  files: SetFile[];
  fileOf: number[]; // sample → file index
  packed: Packed;
}

export function excluded(): string[] {
  try {
    return JSON.parse(readFileSync(EXCLUDE, 'utf8')) as string[];
  } catch {
    return [];
  }
}
export function setExcluded(names: string[]): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(EXCLUDE, JSON.stringify([...new Set(names)].sort()));
}
/** every replay in "Training data/", and whether it is in the data set */
export function dataFiles(): DataFile[] {
  if (!existsSync(DATA_DIR)) return [];
  const ex = new Set(excluded());
  return readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const st = statSync(join(DATA_DIR, f));
      const rc = replayableHere(f, st.size, st.mtimeMs);
      return { name: f, size: st.size, included: rc.replayable && !ex.has(f), ...rc };
    });
}
/** which data set the included replays make (changes with the files, the exclusions and the skills) */
export function currentKey(): string {
  const inc = dataFiles().filter((f) => f.included);
  if (!inc.length) return '';
  return createHash('sha1')
    .update(`${N_OBS}:${N_OPT_FEATS}:${SKILLS_VERSION}|` + inc.map((f) => `${f.name}:${f.size}`).join('|'))
    .digest('hex')
    .slice(0, 16);
}
const setPath = (key: string): string => {
  if (!/^[0-9a-f]{16}$/.test(key)) throw new Error('bad data set key');
  return join(SETS, `${key}.json.gz`);
};
export const hasSet = (key: string): boolean => !!key && existsSync(setPath(key));

/** re-simulate every included replay and cache the demonstrations (≈ 2–3 s per replay) */
export function buildSet(log: (s: string) => void = () => {}): DemoSet | null {
  const key = currentKey();
  if (!key) return null;
  const base = resolve(loadProfile(join(ROOT, 'profiles/real-v0.json')));
  const files: SetFile[] = [];
  const all: Sample[] = [];
  const fileOf: number[] = [];
  for (const f of dataFiles().filter((q) => q.included)) {
    try {
      const d = demonstrations(join(DATA_DIR, f.name), base);
      files.push({ name: f.name, score: d.score, events: d.events, samples: d.samples.length, stay: d.stay, unmatched: d.unmatched });
      for (const s of d.samples) {
        all.push(s);
        fileOf.push(files.length - 1);
      }
      log(`${f.name}: DSIM score ${d.score}, ${d.events} actions, ${d.samples.length} demonstrations (${((100 * d.stay) / Math.max(1, d.samples.length)).toFixed(0)}% carry on, ${d.unmatched} unmatched)`);
    } catch (e) {
      files.push({ name: f.name, score: 0, events: 0, samples: 0, stay: 0, unmatched: 0, error: (e as Error).message.slice(0, 200) });
      log(`${f.name}: could not be re-simulated (${(e as Error).message.slice(0, 120)}) — left out`);
    }
  }
  const set: DemoSet = { key, files, fileOf, packed: pack(all) };
  mkdirSync(SETS, { recursive: true });
  writeFileSync(setPath(key) + '.tmp', gzipSync(JSON.stringify(set)));
  renameSync(setPath(key) + '.tmp', setPath(key));
  return set;
}
export function loadSet(key: string): DemoSet {
  if (!hasSet(key)) throw new Error(`data set ${key} is not on disk (outputs/imitation/sets/)`);
  return JSON.parse(gunzipSync(readFileSync(setPath(key))).toString('utf8')) as DemoSet;
}
export const setSamples = (s: DemoSet): Sample[] => (s.packed.n ? unpack(s.packed, N_OBS, N_OPT_FEATS) : []);

// ─────────────────────────────── the fit ───────────────────────────────
export interface ImitationReport {
  files: SetFile[];
  train: { samples: number; loss: number; agree: number };
  holdout: { file: string; samples: number; loss: number; agree: number; chance: number; switchAgree: number; switchN: number; stayShare: number };
  epochs: number;
  keptEpoch: number;
  params: number;
  dataKey: string; // the data set it was fitted on
  genome: string;
}

/** listwise behaviour cloning of SHAPE's network on `train`, early-stopped on `test` (the style genes
 * keep their defaults: they are not the network's) */
function trainNet(train: Sample[], test: Sample[], epochs: number, seed: number, log: (s: string) => void): { p: Float32Array; bestEp: number } {
  const n = paramCount(SHAPE);
  const rng = mulberry32(seedOf(seed, 'imitate'));
  const gauss = (): number => {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
  const p = initParams(SHAPE, gauss, STYLE_DEFAULT_GENES);
  const opt = new Adam(n, 0.003);
  const g = new Float32Array(n);
  const batch = 32;
  const order = train.map((_, i) => i);
  const best = new Float32Array(p);
  let bestLoss = Infinity;
  let bestEp = 0;
  for (let ep = 0; ep < epochs && train.length; ep++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let b0 = 0; b0 < order.length; b0 += batch) {
      g.fill(0);
      const idx = order.slice(b0, b0 + batch);
      for (const i of idx) lossAndGrad(SHAPE, p, train[i], g);
      opt.step(p, g, 1 / idx.length, styleOffset(SHAPE));
    }
    // EARLY STOPPING on the held-out part (it overfits after a few dozen epochs)
    const h = evaluate(SHAPE, p, test);
    if (test.length && h.loss < bestLoss) {
      bestLoss = h.loss;
      best.set(p);
      bestEp = ep;
    }
    if (ep % 25 === 0 || ep === epochs - 1) log(`epoch ${ep}: train agree ${(100 * evaluate(SHAPE, p, train).agree).toFixed(1)}% · held-out agree ${(100 * h.agree).toFixed(1)}%`);
  }
  if (test.length) p.set(best);
  log(`kept epoch ${bestEp} (lowest held-out loss)`);
  return { p, bestEp };
}

/** agreement at the moments the demonstrator CHANGED job (most quarter-seconds are "carry on",
 * which is easy) — the honest number */
function switchAgreement(p: Float32Array, test: Sample[]): { switchAgree: number; switchN: number; stayShare: number } {
  let stayN = 0;
  let swN = 0;
  let swHit = 0;
  for (const s of test) {
    if (s.feats[s.y * N_OPT_FEATS + F_CURRENT] === 1) stayN++;
    else {
      swN++;
      if (choose(SHAPE, p, s) === s.y) swHit++;
    }
  }
  return { switchAgree: swN ? swHit / swN : 0, switchN: swN, stayShare: test.length ? stayN / test.length : 0 };
}

export function fit(set: DemoSet, epochs = 150, seed = 1, log: (s: string) => void = () => {}): ImitationReport {
  const S = setSamples(set);
  const usable = set.files.map((f, i) => ({ f, i })).filter((q) => q.f.samples > 0);
  const hold = usable.length > 1 ? usable[usable.length - 1].i : -1; // the last replay is held out
  const train = S.filter((_, k) => set.fileOf[k] !== hold);
  const test = S.filter((_, k) => set.fileOf[k] === hold);
  const { p, bestEp } = trainNet(train, test, epochs, seed, log);
  const tr = evaluate(SHAPE, p, train);
  const ho = evaluate(SHAPE, p, test);
  const chance = test.length ? test.reduce((a, s) => a + 1 / s.k, 0) / test.length : 0;
  return {
    files: set.files,
    train: { samples: train.length, ...tr },
    holdout: { file: hold >= 0 ? set.files[hold].name : '', samples: test.length, ...ho, chance, ...switchAgreement(p, test) },
    epochs,
    keptEpoch: bestEp,
    params: paramCount(SHAPE),
    dataKey: set.key,
    genome: toB64(p),
  };
}

// ─────────────────────────────── the greedy order, as a network ───────────────────────────────
/**
 * THE NO-LEARNING ROBOT, DISTILLED. The greedy baseline (train/policy.ts greedyScore) plays
 * GREEDY_MATCHES matches recording every quarter-second decision, and the policy network is fitted
 * to them. Generation 0 then contains a network that plays about as well as the bar evolution has
 * to clear, so training starts AT the bar instead of below it. Cached in outputs/imitation/greedy.json
 * by a key over everything it depends on.
 */
const GREEDY_FILE = join(OUT, 'greedy.json');
const GREEDY_MATCHES = 24;
const GREEDY_HELD = 4;
export interface GreedyReport {
  key: string;
  matches: number;
  samples: number;
  holdout: { samples: number; agree: number; chance: number; switchAgree: number; switchN: number };
  keptEpoch: number;
  genome: string;
}
export const greedyKey = (): string => `g1:${N_OBS}:${N_OPT_FEATS}:${SKILLS_VERSION}:${THINK_TICKS}:${paramCount(SHAPE)}`;
export function greedyReport(): GreedyReport | null {
  try {
    const r = JSON.parse(readFileSync(GREEDY_FILE, 'utf8')) as GreedyReport;
    return r.key === greedyKey() ? r : null;
  } catch {
    return null;
  }
}
/** the distilled greedy network, building it first if needed (~2 min, once) */
export function ensureGreedy(log: (s: string) => void = () => {}): GreedyReport {
  const r0 = greedyReport();
  if (r0) return r0;
  log(`distilling the no-learning robot into a network: ${GREEDY_MATCHES} matches, then a fit (once, ~2 min)…`);
  const per: Sample[][] = [];
  for (let k = 0; k < GREEDY_MATCHES; k++) {
    const r = runEpisode({ genome: null, profile: 'profiles/real-v0.json', sampleProfile: true, seed: seedOf(9, 'distill', k) % 1_000_000_007, stage: 'full', driver: 'oracle', track: false, record: false, samples: true });
    per.push(r.samples ? unpack(r.samples, N_OBS, N_OPT_FEATS) : []);
  }
  const train = per.slice(0, GREEDY_MATCHES - GREEDY_HELD).flat();
  const test = per.slice(GREEDY_MATCHES - GREEDY_HELD).flat();
  const { p, bestEp } = trainNet(train, test, 60, 2, log);
  const ho = evaluate(SHAPE, p, test);
  const sw = switchAgreement(p, test);
  const out: GreedyReport = {
    key: greedyKey(),
    matches: GREEDY_MATCHES,
    samples: train.length + test.length,
    holdout: { samples: test.length, agree: ho.agree, chance: test.length ? test.reduce((a, s) => a + 1 / s.k, 0) / test.length : 0, switchAgree: sw.switchAgree, switchN: sw.switchN },
    keptEpoch: bestEp,
    genome: toB64(p),
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(GREEDY_FILE + '.tmp', JSON.stringify(out, null, 1));
  renameSync(GREEDY_FILE + '.tmp', GREEDY_FILE);
  log(`greedy network: picks what the no-learning robot picks ${(100 * ho.agree).toFixed(1)}% of the time on matches it never saw (${(100 * sw.switchAgree).toFixed(0)}% of its job changes)`);
  return out;
}

/**
 * THE STARTING REST-OF-MATCH PREDICTOR (train/value.ts): the distilled no-learning network plays
 * VALUE_MATCHES matches recording (observation, points still to come) twice a second; the
 * predictor is fitted to them (the last few matches held out). Every run starts with it; each
 * generation refits it on the champion's own matches. Cached in outputs/imitation/value.json.
 */
const VALUE_FILE = join(OUT, 'value.json');
const VALUE_MATCHES = 48;
export interface ValueReport {
  key: string;
  matches: number;
  samples: number;
  rmse: number; // points, on held-out matches
  spread: number; // rmse of always predicting the mean (what the predictor beats)
  genome: string;
}
export const valueKey = (): string => `v2:${greedyKey()}:${paramCount(VALUE_SHAPE)}`;
export function valueReport(): ValueReport | null {
  try {
    const r = JSON.parse(readFileSync(VALUE_FILE, 'utf8')) as ValueReport;
    return r.key === valueKey() ? r : null;
  } catch {
    return null;
  }
}
export function ensureValue(log: (s: string) => void = () => {}): ValueReport {
  const r0 = valueReport();
  if (r0) return r0;
  const g = ensureGreedy(log).genome;
  log(`fitting the rest-of-match predictor: ${VALUE_MATCHES} matches of the no-learning network (once, ~2 min)…`);
  const obs: number[][] = [];
  const ys: number[][] = [];
  for (let k = 0; k < VALUE_MATCHES; k++) {
    const r = runEpisode({ genome: g, profile: 'profiles/real-v0.json', sampleProfile: true, seed: seedOf(9, 'value', k) % 1_000_000_007, stage: 'full', driver: 'oracle', track: false, record: false, returns: 30 });
    obs.push(Array.from(fromB64(r.values!.obs)));
    ys.push(r.values!.y);
  }
  const hold = 8;
  const set = (a: number, b: number): ValueSet => ({ obs: new Float32Array(obs.slice(a, b).flat()), y: new Float32Array(ys.slice(a, b).flat()) });
  const train = set(0, VALUE_MATCHES - hold);
  const test = set(VALUE_MATCHES - hold, VALUE_MATCHES);
  const f = fitValue(train, test, { epochs: 60, seed: 3 });
  const mean = train.y.reduce((a, b) => a + b, 0) / train.y.length;
  const spread = Math.sqrt(test.y.reduce((a, b) => a + (b - mean) ** 2, 0) / test.y.length);
  const out: ValueReport = { key: valueKey(), matches: VALUE_MATCHES, samples: train.y.length + test.y.length, rmse: f.rmse, spread, genome: toB64(f.p) };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(VALUE_FILE + '.tmp', JSON.stringify(out, null, 1));
  renameSync(VALUE_FILE + '.tmp', VALUE_FILE);
  log(`rest-of-match predictor: off by ${f.rmse.toFixed(1)} points on matches it never saw (guessing the average: ${spread.toFixed(1)})`);
  return out;
}

export function imitationReport(): ImitationReport | null {
  const f = join(OUT, 'policy.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as ImitationReport) : null;
}
const fresh = (r: ImitationReport | null, key: string): r is ImitationReport => !!r && r.params === paramCount(SHAPE) && r.dataKey === key;

/** make sure the data set and the fitted network match the included replays (rebuilding them if
 * not) — in this process; the studio runs `refreshJob` in a worker instead */
export function ensureData(log?: (s: string) => void): { key: string; report: ImitationReport } | null {
  const key = currentKey();
  if (!key) return null;
  const r0 = imitationReport();
  if (hasSet(key) && fresh(r0, key)) return { key, report: r0 };
  const set = hasSet(key) ? loadSet(key) : buildSet(log);
  if (!set) return null;
  const r = fit(set, 150, 1, log);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'policy.json'), JSON.stringify(r, null, 1));
  return { key, report: r };
}
/** the fitted genome for the current replays (fits first if needed); null without replays */
export function imitationGenome(log?: (s: string) => void): string | null {
  return ensureData(log)?.report.genome ?? null;
}
/** worker job (harness/pool.ts): rebuild the data set from scratch and refit — "Refresh" */
export function refreshJob(a: { rebuild?: boolean } = {}): { key: string; report: Omit<ImitationReport, 'genome'>; log: string[] } | null {
  const lines: string[] = [];
  const log = (s: string): void => void lines.push(s);
  const key = currentKey();
  if (!key) {
    ensureGreedy(log); // every new run needs these, replays or not
    ensureValue(log);
    return null;
  }
  const set = !a.rebuild && hasSet(key) ? loadSet(key) : buildSet(log);
  if (!set) return null;
  const r = fit(set, 150, 1, log);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'policy.json'), JSON.stringify(r, null, 1));
  ensureGreedy(log);
  ensureValue(log);
  const { genome: _g, ...report } = r;
  void _g;
  return { key, report, log: lines };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await init();
  const t0 = performance.now();
  const set = buildSet((s) => console.log(s));
  if (!set) {
    console.log(`no replays in ${DATA_DIR}`);
    process.exit(1);
  }
  const r = fit(set, 150, 1, (s) => console.log(s));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'policy.json'), JSON.stringify(r, null, 1));
  console.log(
    `held-out ${r.holdout.file}: agreement ${(100 * r.holdout.agree).toFixed(1)}% (chance ${(100 * r.holdout.chance).toFixed(1)}%), of which the ${r.holdout.switchN} moments they CHANGED job: ${(100 * r.holdout.switchAgree).toFixed(1)}% · ${((performance.now() - t0) / 1000).toFixed(0)} s → outputs/imitation/policy.json`,
  );
}
