// Shapes the server sends, and small helpers. Types come from the engine itself (type-only import).
import type { CheckpointMeta, EvalResult, GenSummary, RunConfig } from '../../train/engine';
import type { Death, Frames, Parts } from '../../train/episode';
import type { Lineage } from '../../train/algos';
export type { CheckpointMeta, EvalResult, GenSummary, RunConfig, Death, Frames, Parts, Lineage };

export interface RunSummary {
  name: string;
  gen: number;
  algo: string;
  pop: number;
  bestFitness: number | null;
  bestScore: number | null;
  updated: string;
  legacy?: boolean;
}
export interface RunState {
  name: string;
  config: RunConfig;
  gen: number;
  stage: 'auto' | 'full';
  totals: { spawned: number; matches: number; simSeconds: number; wallSeconds: number; deaths: Record<Death, number> };
  running: boolean;
  paused: boolean;
  phase: 'idle' | 'generation' | 'evaluating' | 'paused';
  bestEver: { fitness: number; score: number; gen: number; parts: Parts; id: number } | null;
  history: GenSummary[];
  events: { time: string; gen: number; text: string }[];
  checkpoints: CheckpointMeta[];
  evals: EvalResult[];
}
export interface State {
  run: RunState | null;
  runs: RunSummary[];
  reference: { files: { name: string; score: number }[]; holdoutAgree: number; chance: number } | null;
  defaults: RunConfig;
}
export interface Status {
  running: boolean;
  paused: boolean;
  phase: RunState['phase'];
  gen: number;
  stage: 'auto' | 'full';
  config: RunConfig;
}

export interface Individual extends Lineage {
  i: number;
  fitness: number;
  score: number;
  death: Death;
  deathTick: number;
  track: string;
  events: [number, string][];
  decisions: [number, number, number, number, number][];
  point: Record<string, number>;
  parts: Parts;
}
export interface GenFile {
  gen: number;
  stage: 'auto' | 'full';
  individuals: Individual[]; // best first
}
export interface FocusFile {
  gen: number;
  fitness: number;
  score: number;
  death: Death;
  parts: Parts;
  lineage: Lineage;
  frames: Frames;
  events: [number, string][];
}

/** base64 Float32 → numbers */
export function decodeTrack(b64: string): Float32Array {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Float32Array(u.buffer);
}

export const getJSON = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `${url}: ${r.status}`);
  return (await r.json()) as T;
};
/** POST JSON; throws the server's own error message */
export async function post<T = { ok: boolean }>(url: string, body: unknown = {}): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `${r.status}`);
  return j;
}

export const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
export const TRACK_STRIDE = 3; // ticks between swarm samples (train/episode.ts)
export const TRACK_FIELDS = 7; // x, y, heading, turret, turret2, hopper, option kind
export const AUTO_START = 240; // DSIM's 4 s pre-match countdown, in ticks

/** what the robot chose to do — the six options (train/skills.ts OPTION_KINDS order), each with a
 * colour from the validated dark categorical palette (dataviz check: all pass on #1d1813) */
export const OPTIONS = [
  { key: 'field', label: 'collect off the field', color: '#3987e5' },
  { key: 'lz', label: 'collect in the loading zone', color: '#d95926' },
  { key: 'flower', label: 'pull POLLEN from a FLOWER', color: '#199e70' },
  { key: 'shoot', label: 'shoot', color: '#c98500' },
  { key: 'hp', label: 'human player NECTAR', color: '#d55181' },
  { key: 'park', label: 'park', color: '#9085e9' },
] as const;
