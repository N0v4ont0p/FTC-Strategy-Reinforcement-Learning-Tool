// Shapes the server sends, and small helpers. Types come from the engine itself (type-only import).
import type { GenSummary, RunConfig } from '../../train/engine';
import type { Death } from '../../train/episode';
export type { GenSummary, RunConfig, Death };

export interface State {
  config: RunConfig;
  gen: number;
  stage: 'auto' | 'full';
  totals: { spawned: number; matches: number; simSeconds: number; wallSeconds: number; deaths: Record<Death, number> };
  running: boolean;
  paused: boolean;
  bestEver: { fitness: number; score: number; gen: number; parts: Record<string, number> } | null;
  history: GenSummary[];
}

export interface Individual {
  i: number;
  fitness: number;
  score: number;
  death: Death;
  deathTick: number;
  track: string;
  events: [number, string][];
  point: Record<string, number>;
}
export interface GenFile {
  gen: number;
  stage: 'auto' | 'full';
  individuals: Individual[]; // best first
}

/** base64 Float32 → numbers (x, y, heading every 6 ticks) */
export function decodeTrack(b64: string): Float32Array {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Float32Array(u.buffer);
}

export const getJSON = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
};

export const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
export const TRACK_STRIDE = 6; // ticks between samples (train/episode.ts)
export const AUTO_START = 240; // DSIM's 4 s pre-match countdown, in ticks
