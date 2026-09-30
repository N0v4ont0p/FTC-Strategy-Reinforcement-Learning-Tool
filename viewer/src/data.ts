// Shapes the server sends, and small helpers. Types come from the engine itself (type-only import).
import type { ArenaEntry, CheckpointMeta, EvalResult, ExamResult, GenSummary, Lineage, MeanCi, Preset, RunConfig, RunInfo } from '../../train/engine';
import type { Death, Frames, Inspected, Mistakes, Parts } from '../../train/episode';
import type { GapRow } from '../../train/gap';
export type { ArenaEntry, CheckpointMeta, EvalResult, ExamResult, GenSummary, Lineage, MeanCi, Preset, RunConfig, RunInfo, Death, Frames, Inspected, Mistakes, Parts, GapRow };

export type RunSummary = RunInfo;
export interface RunData {
  key: string;
  onDisk: boolean;
  latest: string;
}
export interface Champion {
  id: number;
  op: Lineage['op'];
  born: number;
  race: { score: number; ci95: number; n: number } | null; // its rewards on fresh race matches
  exam: ExamResult | null;
  parts: Parts | null;
  style: { key: string; label: string; value: number; def: number }[];
}
export interface RunState {
  name: string;
  config: RunConfig;
  gen: number;
  totals: { matches: number; simSeconds: number; wallSeconds: number; lessons: number; deaths: Record<Death, number> };
  running: boolean;
  paused: boolean;
  phase: 'idle' | 'generation' | 'evaluating' | 'paused';
  lastGenAt: string | null;
  progress: Progress | null;
  champion: Champion;
  arena: { id: number; op: string; since: number; n: number }[];
  history: GenSummary[];
  exams: ExamResult[];
  events: { time: string; gen: number; text: string }[];
  checkpoints: CheckpointMeta[];
  evals: EvalResult[];
  data: RunData;
  search: { k: number; horizon: number; rounds: number; margin: number };
}
export interface DataInfo {
  dir: string;
  /** replayable: it re-simulates exactly in this DSIM (recorded in its version and physics); why: when not */
  files: { name: string; size: number; included: boolean; replayable?: boolean; why?: string; info?: { score: number; events: number; samples: number; unmatched: number; error?: string } }[];
  latest: string;
  built: boolean;
  fitted: { agree: number; chance: number; holdout: string; samples: number } | null;
  refreshing: boolean;
}
export interface State {
  run: RunState | null;
  runs: RunSummary[];
  reference: { files: { name: string; score: number }[]; holdoutAgree: number; chance: number } | null;
  defaults: RunConfig;
  presets: Preset[];
  data: DataInfo;
}
export interface Status {
  running: boolean;
  paused: boolean;
  phase: RunState['phase'];
  gen: number;
  config: RunConfig;
  data: RunData;
  lastGenAt: string | null;
  progress: Progress | null;
}
export interface Progress {
  gen: number;
  done: number;
  total: number;
  stage?: string;
  eval?: string;
}

export interface Individual extends Lineage {
  i: number;
  fitness: number; // the reward
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
  inspect?: Inspected[]; // the champion's showcase: its what-if values at each decision
  search?: boolean; // it was thinking ahead (the what-if values chose)
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
export const bytes = (n: number): string => (n < 1e6 ? `${Math.max(1, Math.round(n / 1e3))} KB` : n < 1e9 ? `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB` : `${(n / 1e9).toFixed(1)} GB`);
export const TRACK_STRIDE = 3; // ticks between swarm samples (train/episode.ts)
export const TRACK_FIELDS = 7; // x, y, heading, turret, turret2, hopper, option kind
export const AUTO_START = 240; // DSIM's 4 s pre-match countdown, in ticks

/** what the robot chose to do — the six options (train/skills.ts OPTION_KINDS order), each with a
 * colour from the validated dark categorical palette (dataviz check: all pass on #1d1813) */
export const OPTIONS = [
  { key: 'field', label: 'sweep a group on the field', color: '#3987e5' },
  { key: 'lz', label: 'sweep the loading zone', color: '#d95926' },
  { key: 'flower', label: 'pull POLLEN from a FLOWER', color: '#199e70' },
  { key: 'shoot', label: 'shoot', color: '#c98500' },
  { key: 'hp', label: 'human player NECTAR', color: '#d55181' },
  { key: 'park', label: 'park', color: '#9085e9' },
  // not an action: waiting in the right place (neutral ink, not a categorical hue)
  { key: 'position', label: 'get in position', color: '#8a8176' },
  // the tip cycle (your replays' loop): ≥ 15 OKLab ΔE from every hue above, normal and all three CVD simulations
  { key: 'cycle', label: 'the tip cycle by the HIVE', color: '#4fcdce' },
  // the Box Tube: a NECTAR into a FLOWER after the 1:00 cue
  { key: 'place', label: 'place a NECTAR on a FLOWER', color: '#a4c639' },
] as const;

/** the AUTO playbook (train/playbook.ts) as the studio gets it */
export interface PlanStepV {
  kind: string;
  label: string;
  anchor?: number;
  flower?: number;
}
export interface TakenStepV extends PlanStepV {
  robot: number;
  tick: number;
  end?: number;
  matched: boolean;
}
export interface MeanTailV {
  mean: number;
  ci95: number;
  cvar10: number;
  n: number;
}
export interface PlaybookEntryV {
  key: string;
  at: string;
  problem: { profile: string; start: string; partner: string; partnerStart?: string; mode: 'best' | 'joint' };
  plan: PlanStepV[][];
  taken: TakenStepV[];
  nominal: MeanTailV;
  sampled: MeanTailV;
  baseline: MeanTailV;
  style: number[] | null;
  explored: number;
  seconds: number;
  stale?: boolean; // planned under older AUTO rules or another shooting zone
}
export interface PlaybookStatusV {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
  log: string[];
  stage?: string | null;
  frac?: number;
  sims?: number;
  totalSims?: number;
  startedAt?: string | null;
  entryAt?: string | null;
  entryS?: number | null;
  estimated?: boolean;
  beat?: string | null;
}
export interface PlaybookV {
  profile: string;
  name: string;
  status: PlaybookStatusV;
  entries: PlaybookEntryV[];
  profiles: string[];
}

/** where a robot came from, in words */
export const OP_LABEL: Record<string, string> = {
  baseline: 'the no-learning robot (a network)',
  replays: 'fitted to your replays',
  lessons: 'learned from what-if lessons',
  skills: 'tuned skill settings (CMA-ES)',
  champion: 'the champion',
};

/** the continuous engine (train/continuous.ts) as the Home page gets it */
export interface MeanCiV {
  mean: number;
  ci95: number;
  n: number;
}
export interface HomeStatusV {
  name: string;
  profile: string;
  running: boolean;
  champion: { id: number; born: string; learned: boolean; exam: (MeanCiV & { vsBase: MeanCiV; cvar10: number; byPartner: Record<string, number>; byOpponents: Record<string, number> }) | null };
  base: number | null;
  trend: number | null;
  improving: 'improving' | 'flat' | null;
  history: { time: string; hours: number; labels: number; champion: number; exam: number; vsBase: number }[];
  candidates: { time: string; id: number; lr: number; verdict: 'promoted' | 'rejected'; n: number; diff: MeanCiV; learn: { agree: number; regret: number; train: number } }[];
  learner: { lr: number; runs: number; last: { agree: number; regret: number; train: number; test: number } | null; before: { agree: number; regret: number } | null };
  totals: { matches: number; labels: number; examMatches: number; hours: number; promotions: number; rejections: number };
  labelsPerHour: number | null;
  nextLearnIn: number;
  cpu: number;
  activity: { actors: number; learning: boolean; evaluating: { id: number; done: number; total: number } | null };
  lastPromotion: string | null;
  searchExam: { time: string; champion: number; n: number; alone: number; search: number; gain: MeanCiV } | null;
  /** a run made by an older version (another sim), kept under `from`; this run's learner began from its champion */
  carried: { from: string; version: number; champion: number; exam: number | null; seeded: boolean; time: string } | null;
  problems: string[];
  log: string[];
}
export interface HomeV {
  profile: string;
  profiles: string[];
  runs: { name: string; profile: string; running: boolean; champion: number; exam: number | null; updated: string }[];
  status: HomeStatusV | null;
  busy: { v1: string | null; playbook: string | null };
}

/** the mistake audit (train/continuous.ts) */
export type { Audit as AuditV, AuditEntry as AuditEntryV, AuditPoint as AuditPointV } from '../../train/continuous';
/** the route library (train/routes.ts) */
export type { RouteLibrary as RouteLibraryV, RouteStat as RouteStatV } from '../../train/routes';
