// S1 pool jobs (run inside harness/worker.ts). Profiles are named so a job is plain JSON.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadProfile, pinned, resolve, type ProfileFile } from '../profiles';
import { shootingColumn, spill } from './lab';
import { optimizePair, type Params, type Pose } from './paths';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL = (): ProfileFile => loadProfile(join(root, 'profiles/real-v0.json'));

/** the four S1 robots: REAL nominal, DREAM, and REAL's slowest and fastest corners */
export const S1_PROFILES: Record<string, () => ProfileFile> = {
  'REAL-v0': REAL,
  DREAM: () => loadProfile(join(root, 'profiles/dream.json')),
  'REAL-v0-slow': () => pinned(REAL(), { 'spec.driveRpm': 300, 'spec.massLb': 42, 'spec.length': 15, 'spec.width': 17 }, 'REAL-v0-slow'),
  'REAL-v0-fast': () => pinned(REAL(), { 'spec.driveRpm': 600, 'spec.massLb': 22, 'spec.length': 13.5, 'spec.width': 14.5 }, 'REAL-v0-fast'),
};
const specOf = (name: string) => {
  const r = resolve(S1_PROFILES[name]());
  if (r.expectFails.length || r.clamped.length) throw new Error(`${name}: ${[...r.expectFails, ...r.clamped].join('; ')}`);
  return r.spec;
};

export const envelopeColumn = (a: { profile: string; side: 'north' | 'south'; x: number; ys: number[] }) =>
  shootingColumn({ spec: specOf(a.profile), side: a.side, x: a.x, ys: a.ys, heading: 0 });

export const spillRun = (a: { profile: string; side: 'north' | 'south'; seed: number }) => spill({ spec: specOf(a.profile), side: a.side, seed: a.seed });

export const pair = (a: { profile: string; from: Pose; to: Pose; seed: number; iters?: number; pop?: number; extraStarts?: Params[] }) =>
  optimizePair({ spec: specOf(a.profile), from: a.from, to: a.to, seed: a.seed, iters: a.iters, pop: a.pop, extraStarts: a.extraStarts });
