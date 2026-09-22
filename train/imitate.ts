// IMITATION WARM START — the team's own DSIM replays ("Training data/", world-record level runs)
// turned into demonstrations of WHAT TO DO NEXT, and a policy network fitted to them. Evolution then
// starts from that network instead of from random weights ("feed it"), and keeps improving.
//
// How a replay becomes demonstrations: DSIM's own ReplayPlayer re-simulates it bit-exactly. Every
// time the human starts something — takes a loose element, pulls from a FLOWER, starts shooting,
// enters a human-player NECTAR — that is one decision. The state it was decided in is the world at
// the end of the previous decision, where train/skills.ts lists the options our robot would have
// had; the option matching what the human did is the label. Listwise softmax cross-entropy fits the
// same network train/policy.ts runs (SHAPE), with Adam; one replay is held out to report agreement.
//
// Honest limits: the replays drove a different build (front+back intake, 600 RPM, DSIM's ideal
// launcher). Only the ORDER of choices transfers, and it is a starting point, never the target:
// fitness is still the DSIM score of our own robot.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BB, bb, coerce, init, snapshot, type Replay, type World } from '../harness/dsim';
import { loadProfile, resolve, type Resolved } from '../harness/profiles';
import { ReplayPlayer } from '../dsim-main/src/sim/replay';
import { mulberry32, seedOf } from '../harness/rng';
import { initParams, paramCount, toB64 } from './net';
import { N_OBS, encode } from './obs';
import { SHAPE } from './policy';
import { Pilot, options } from './skills';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'Training data');
export const OUT = join(ROOT, 'outputs', 'imitation');

type Pick = { kind: 'ball'; id: number } | { kind: 'flower'; i: number } | { kind: 'shoot' } | { kind: 'hp' };
interface Sample {
  x: Float32Array[]; // one input row per option (global obs ++ option features)
  y: number; // index of the human's choice
  replay: string;
}

/** replay → demonstrations */
export function demonstrations(file: string, base: Resolved): { samples: Sample[]; score: number; events: number; unmatched: number } {
  const rep = JSON.parse(readFileSync(file, 'utf8')) as Replay & { setups: { spec: Parameters<typeof coerce>[0]; alliance: 'red' | 'blue'; id: number }[] };
  const setup = rep.setups[0];
  const spec = coerce(setup.spec);
  const prof: Resolved = { ...base, spec };
  const pilot = new Pilot(spec);
  const cap = BB.bbHopperCap(spec);
  const p = new ReplayPlayer(rep);
  const prevKind = new Map<number, string>();
  const prevEl = new Map<number, string>();
  let decision: World | null = null; // world at the end of the previous human decision
  let shooting = false;
  const samples: Sample[] = [];
  let events = 0;
  let unmatched = 0;
  const obs = new Float32Array(N_OBS);
  const label = (w: World, pick: Pick): void => {
    events++;
    const d = decision;
    decision = snapshot(w);
    if (!d) return;
    const r = d.robots.find((q) => q.id === setup.id)!;
    if (d.match.phase !== 'auto' && d.match.phase !== 'teleop') return;
    const opts = options(d, r, pilot, cap, new Map());
    const y = opts.findIndex((o) =>
      pick.kind === 'ball' ? o.ball === pick.id : pick.kind === 'flower' ? o.flower === pick.i : o.kind === pick.kind,
    );
    if (y < 0 || opts.length < 2) {
      if (y < 0) unmatched++;
      return;
    }
    encode(d, r, prof, obs);
    samples.push({
      x: opts.map((o) => {
        const row = new Float32Array(N_OBS + o.feats.length);
        row.set(obs, 0);
        row.set(o.feats, N_OBS);
        return row;
      }),
      y,
      replay: file,
    });
  };
  const hpBefore = { ...bb(p.world).nectarStock };
  while (p.stepOnce()) {
    const w = p.world;
    const r = w.robots.find((q) => q.id === setup.id)!;
    if (!decision && (w.match.phase === 'auto')) decision = snapshot(w);
    for (const b of w.balls) {
      const k = b.state.kind;
      const pk = prevKind.get(b.id);
      if (pk !== undefined && pk !== k) {
        if (k === 'held' && (b.state as { robot: number }).robot === r.id) {
          shooting = false;
          const el = prevEl.get(b.id) ?? '';
          if (pk === 'element' && el.startsWith('flower:')) label(w, { kind: 'flower', i: Number(el.slice(7)) });
          else if (pk === 'ground') label(w, { kind: 'ball', id: b.id });
        } else if (k === 'flight' && pk === 'held' && !shooting) {
          shooting = true;
          label(w, { kind: 'shoot' });
        }
      }
      prevKind.set(b.id, k);
      prevEl.set(b.id, k === 'element' ? String((b.state as { el?: string }).el ?? '') : '');
    }
    const stock = bb(w).nectarStock[setup.alliance];
    if (stock < hpBefore[setup.alliance]) label(w, { kind: 'hp' });
    hpBefore[setup.alliance] = stock;
  }
  return { samples, score: p.world.match.scores[setup.alliance].total, events, unmatched };
}

// ─────────────────────────────── the fit ───────────────────────────────
/** forward + backward of SHAPE's MLP (tanh hidden, linear out), same parameter layout as net.ts */
function scores(p: Float32Array, rows: Float32Array[], H: number[][]): number[] {
  const [nin, nh] = SHAPE.sizes;
  const b1 = nin * nh;
  const w2 = b1 + nh;
  const b2 = w2 + nh;
  return rows.map((x, r) => {
    const h = (H[r] ??= new Array<number>(nh));
    let out = p[b2];
    for (let j = 0; j < nh; j++) {
      let v = p[b1 + j];
      const o = j * nin;
      for (let i = 0; i < nin; i++) v += p[o + i] * x[i];
      h[j] = Math.tanh(v);
      out += p[w2 + j] * h[j];
    }
    return out;
  });
}

function lossAndGrad(p: Float32Array, s: Sample, g: Float32Array | null): { loss: number; hit: boolean } {
  const [nin, nh] = SHAPE.sizes;
  const b1 = nin * nh;
  const w2 = b1 + nh;
  const b2 = w2 + nh;
  const H: number[][] = [];
  const z = scores(p, s.x, H);
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const Z = e.reduce((a, b) => a + b, 0);
  const loss = -(z[s.y] - m - Math.log(Z));
  const hit = z.indexOf(m) === s.y;
  if (g) {
    for (let r = 0; r < s.x.length; r++) {
      const dz = e[r] / Z - (r === s.y ? 1 : 0); // d loss / d score_r
      if (dz === 0) continue;
      g[b2] += dz;
      const x = s.x[r];
      for (let j = 0; j < nh; j++) {
        g[w2 + j] += dz * H[r][j];
        const dh = dz * p[w2 + j] * (1 - H[r][j] * H[r][j]);
        g[b1 + j] += dh;
        const o = j * nin;
        for (let i = 0; i < nin; i++) g[o + i] += dh * x[i];
      }
    }
  }
  return { loss, hit };
}

export interface ImitationReport {
  files: { name: string; score: number; events: number; samples: number; unmatched: number }[];
  train: { samples: number; loss: number; agree: number };
  holdout: { file: string; samples: number; loss: number; agree: number; chance: number };
  epochs: number;
  keptEpoch: number;
  params: number;
  dataKey: string; // which replays it was fitted on (refit when "Training data/" changes)
  genome: string;
}

export function fit(epochs = 300, seed = 1, log: (s: string) => void = () => {}): ImitationReport {
  const base = resolve(loadProfile(join(ROOT, 'profiles/real-v0.json')));
  const files = readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) throw new Error(`no replays in ${DATA_DIR}`);
  const per = files.map((f) => ({ f, ...demonstrations(join(DATA_DIR, f), base) }));
  for (const d of per) log(`${d.f}: DSIM score ${d.score}, ${d.events} human decisions, ${d.samples.length} usable (${d.unmatched} had no matching option)`);
  const hold = per.length > 1 ? per[per.length - 1] : null;
  const train = per.filter((d) => d !== hold).flatMap((d) => d.samples);
  const test = hold ? hold.samples : [];
  const n = paramCount(SHAPE);
  const rng = mulberry32(seedOf(seed, 'imitate'));
  const gauss = (): number => {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
  const p = initParams(SHAPE, gauss);
  const m = new Float32Array(n);
  const v = new Float32Array(n);
  const g = new Float32Array(n);
  const lr = 0.003;
  const batch = 32;
  let t = 0;
  const order = train.map((_, i) => i);
  const best = new Float32Array(p);
  let bestLoss = Infinity;
  let bestEp = 0;
  const evalOn = (S: Sample[]): { loss: number; agree: number } => {
    let L = 0;
    let A = 0;
    for (const s of S) {
      const r = lossAndGrad(p, s, null);
      L += r.loss;
      A += r.hit ? 1 : 0;
    }
    return { loss: S.length ? L / S.length : 0, agree: S.length ? A / S.length : 0 };
  };
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let b0 = 0; b0 < order.length; b0 += batch) {
      g.fill(0);
      const idx = order.slice(b0, b0 + batch);
      for (const i of idx) lossAndGrad(p, train[i], g);
      t++;
      for (let k = 0; k < n; k++) {
        const gk = g[k] / idx.length + 1e-4 * p[k];
        m[k] = 0.9 * m[k] + 0.1 * gk;
        v[k] = 0.999 * v[k] + 0.001 * gk * gk;
        p[k] -= (lr * (m[k] / (1 - 0.9 ** t))) / (Math.sqrt(v[k] / (1 - 0.999 ** t)) + 1e-8);
      }
    }
    // EARLY STOPPING on the held-out replay (it overfits the five others after ~50 epochs)
    const h = evalOn(test);
    if (h.loss < bestLoss) {
      bestLoss = h.loss;
      best.set(p);
      bestEp = ep;
    }
    if (ep % 25 === 0 || ep === epochs - 1) log(`epoch ${ep}: train agree ${(100 * evalOn(train).agree).toFixed(1)}% · held-out agree ${(100 * h.agree).toFixed(1)}%`);
  }
  if (test.length) p.set(best);
  log(`kept epoch ${bestEp} (lowest held-out loss)`);
  const tr = evalOn(train);
  const ho = evalOn(test);
  const chance = test.length ? test.reduce((a, s) => a + 1 / s.x.length, 0) / test.length : 0;
  return {
    files: per.map((d) => ({ name: d.f, score: d.score, events: d.events, samples: d.samples.length, unmatched: d.unmatched })),
    train: { samples: train.length, ...tr },
    holdout: { file: hold?.f ?? '', samples: test.length, ...ho, chance },
    epochs,
    keptEpoch: bestEp,
    params: n,
    dataKey: dataKey(),
    genome: toB64(p),
  };
}

export function dataKey(): string {
  if (!existsSync(DATA_DIR)) return '';
  return readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => `${f}:${statSync(join(DATA_DIR, f)).size}`)
    .join('|');
}

export function imitationReport(): ImitationReport | null {
  const f = join(OUT, 'policy.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as ImitationReport) : null;
}

/** the fitted genome, fitting (and caching) it on first use; refitted when the replays change */
export function imitationGenome(log?: (s: string) => void): string {
  const f = join(OUT, 'policy.json');
  const r0 = imitationReport();
  if (r0 && r0.params === paramCount(SHAPE) && r0.dataKey === dataKey()) return r0.genome;
  const r = fit(150, 1, log);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(f, JSON.stringify(r, null, 1));
  return r.genome;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await init();
  const t0 = performance.now();
  const r = fit(150, 1, (s) => console.log(s));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'policy.json'), JSON.stringify(r, null, 1));
  console.log(`held-out ${r.holdout.file}: agreement ${(100 * r.holdout.agree).toFixed(1)}% (chance ${(100 * r.holdout.chance).toFixed(1)}%) · ${((performance.now() - t0) / 1000).toFixed(0)} s → outputs/imitation/policy.json`);
}
