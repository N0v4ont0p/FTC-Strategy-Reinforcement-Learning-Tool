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
import { BB, bb, coerce, init, snapshot, type Replay, type World } from '../harness/dsim';
import { loadProfile, resolve, type Resolved } from '../harness/profiles';
import { ReplayPlayer } from '../dsim-main/src/sim/replay';
import { mulberry32, seedOf } from '../harness/rng';
import { initParams, paramCount, styleOffset, toB64 } from './net';
import { N_OBS, encode } from './obs';
import { SHAPE, STYLE_DEFAULT_GENES } from './policy';
import { N_OPT_FEATS, Pilot, SKILLS_VERSION, options } from './skills';
import { Adam, evaluate, lossAndGrad, pack, unpack, type Packed, type Sample } from './bc';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'Training data');
export const OUT = join(ROOT, 'outputs', 'imitation');
const SETS = join(OUT, 'sets');
const EXCLUDE = join(OUT, 'exclude.json');

type Pick = { kind: 'ball'; id: number } | { kind: 'flower'; i: number } | { kind: 'shoot' } | { kind: 'hp' };

/** replay → demonstrations */
export function demonstrations(file: string, base: Resolved): { samples: Sample[]; score: number; events: number; unmatched: number } {
  const rep = JSON.parse(readFileSync(file, 'utf8')) as Replay & { setups: { spec: Parameters<typeof coerce>[0]; alliance: 'red' | 'blue'; id: number }[] };
  const setup = rep.setups[0];
  const spec = coerce(setup.spec);
  const prof: Resolved = { ...base, spec };
  const pilot = new Pilot(spec, base.limits);
  const cap = BB.bbHopperCap(spec);
  const p = new ReplayPlayer(rep);
  const prevKind = new Map<number, string>();
  const prevEl = new Map<number, string>();
  let decision: World | null = null; // world at the end of the previous human decision
  let group = null as Set<number> | null; // the group the last pick came from (the same sweep); `as`: assigned inside label()
  let pendingShot: { tick: number; at: World; now: World } | null = null;
  let shooting = false;
  const samples: Sample[] = [];
  let events = 0;
  let unmatched = 0;
  const obs = new Float32Array(N_OBS);
  const label = (d: World | null, pick: Pick): void => {
    events++;
    group = null;
    if (!d) return;
    const r = d.robots.find((q) => q.id === setup.id)!;
    if (d.match.phase !== 'auto' && d.match.phase !== 'teleop') return;
    const opts = options(d, r, pilot, cap, new Map());
    const y = opts.findIndex((o) =>
      pick.kind === 'ball' ? !!o.balls?.includes(pick.id) : pick.kind === 'flower' ? o.flower === pick.i : o.kind === pick.kind,
    );
    if (y >= 0 && pick.kind === 'ball') group = new Set(opts[y].balls);
    if (y < 0 || opts.length < 2) {
      if (y < 0) unmatched++;
      return;
    }
    encode(d, r, prof, obs);
    samples.push({ obs: new Float32Array(obs), feats: Float32Array.from(opts.flatMap((o) => o.feats)), k: opts.length, y });
  };
  const hpBefore = { ...bb(p.world).nectarStock };
  while (p.stepOnce()) {
    const w = p.world;
    const r = w.robots.find((q) => q.id === setup.id)!;
    if (!decision && w.match.phase === 'auto') decision = snapshot(w);
    for (const b of w.balls) {
      const k = b.state.kind;
      const pk = prevKind.get(b.id);
      if (pk !== undefined && pk !== k) {
        if (k === 'held' && (b.state as { robot: number }).robot === r.id) {
          shooting = false;
          pendingShot = null; // a pickup right after a shot: that shot was part of the sweep
          const el = prevEl.get(b.id) ?? '';
          if (pk === 'element' && el.startsWith('flower:')) {
            label(decision, { kind: 'flower', i: Number(el.slice(7)) });
            decision = snapshot(w);
          } else if (pk === 'ground') {
            const cont = group?.has(b.id) ?? false;
            if (!cont) label(decision, { kind: 'ball', id: b.id });
            else events++;
            decision = snapshot(w);
          }
        } else if (k === 'flight' && pk === 'held' && !shooting) {
          shooting = true;
          pendingShot = { tick: w.tick, at: decision ?? snapshot(w), now: snapshot(w) };
        }
      }
      prevKind.set(b.id, k);
      prevEl.set(b.id, k === 'element' ? String((b.state as { el?: string }).el ?? '') : '');
    }
    if (pendingShot && w.tick - pendingShot.tick >= 60) {
      label(pendingShot.at, { kind: 'shoot' });
      decision = pendingShot.now;
      pendingShot = null;
    }
    const stock = bb(w).nectarStock[setup.alliance];
    if (stock < hpBefore[setup.alliance]) {
      label(decision, { kind: 'hp' });
      decision = snapshot(w);
    }
    hpBefore[setup.alliance] = stock;
  }
  return { samples, score: p.world.match.scores[setup.alliance].total, events, unmatched };
}

// ─────────────────────────────── the data set ───────────────────────────────
export interface DataFile {
  name: string;
  size: number;
  included: boolean;
}
export interface SetFile {
  name: string;
  score: number;
  events: number;
  samples: number;
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
    .map((f) => ({ name: f, size: statSync(join(DATA_DIR, f)).size, included: !ex.has(f) }));
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
      files.push({ name: f.name, score: d.score, events: d.events, samples: d.samples.length, unmatched: d.unmatched });
      for (const s of d.samples) {
        all.push(s);
        fileOf.push(files.length - 1);
      }
      log(`${f.name}: DSIM score ${d.score}, ${d.events} human decisions, ${d.samples.length} usable (${d.unmatched} had no matching option)`);
    } catch (e) {
      files.push({ name: f.name, score: 0, events: 0, samples: 0, unmatched: 0, error: (e as Error).message.slice(0, 200) });
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
  holdout: { file: string; samples: number; loss: number; agree: number; chance: number };
  epochs: number;
  keptEpoch: number;
  params: number;
  dataKey: string; // the data set it was fitted on
  genome: string;
}

export function fit(set: DemoSet, epochs = 150, seed = 1, log: (s: string) => void = () => {}): ImitationReport {
  const S = setSamples(set);
  const usable = set.files.map((f, i) => ({ f, i })).filter((q) => q.f.samples > 0);
  const hold = usable.length > 1 ? usable[usable.length - 1].i : -1; // the last replay is held out
  const train = S.filter((_, k) => set.fileOf[k] !== hold);
  const test = S.filter((_, k) => set.fileOf[k] === hold);
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
      opt.step(p, g, 1 / idx.length, styleOffset(SHAPE)); // the style genes are not the network's
    }
    // EARLY STOPPING on the held-out replay (it overfits the others after ~50 epochs)
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
  const tr = evaluate(SHAPE, p, train);
  const ho = evaluate(SHAPE, p, test);
  const chance = test.length ? test.reduce((a, s) => a + 1 / s.k, 0) / test.length : 0;
  return {
    files: set.files,
    train: { samples: train.length, ...tr },
    holdout: { file: hold >= 0 ? set.files[hold].name : '', samples: test.length, ...ho, chance },
    epochs,
    keptEpoch: bestEp,
    params: n,
    dataKey: set.key,
    genome: toB64(p),
  };
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
  if (!key) return null;
  const set = !a.rebuild && hasSet(key) ? loadSet(key) : buildSet(log);
  if (!set) return null;
  const r = fit(set, 150, 1, log);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'policy.json'), JSON.stringify(r, null, 1));
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
  console.log(`held-out ${r.holdout.file}: agreement ${(100 * r.holdout.agree).toFixed(1)}% (chance ${(100 * r.holdout.chance).toFixed(1)}%) · ${((performance.now() - t0) / 1000).toFixed(0)} s → outputs/imitation/policy.json`);
}
