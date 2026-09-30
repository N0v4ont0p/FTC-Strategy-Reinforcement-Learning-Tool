// WHAT A RUNNING JOB REPORTS on its way (harness/progress.ts) and what the studio's live view is made
// of: a match's clock, the frames of a training match streamed to the field, the search thinking at a
// decision, the learner's epochs — and the continuous engine's picture of everything in flight
// (train/continuous.ts `live`). Types only: the viewer imports them.
import type { Frame } from './episode';

/** the fixed part of a streamed match: the builds and the element list */
export interface LiveHead {
  spec: unknown;
  spec2?: unknown;
  oppSpecs?: unknown[];
  alliance: string;
  meta: [number, string, number | null][];
}
/** a match's clock, a few times a second (every job that plays one and was asked to report) */
export interface MatchProgress {
  k: 'match';
  t: number; // tick
  frac: number; // how far through AUTO + TELEOP (0–1)
  phase: string;
  left: number; // seconds left in the phase
  score: number; // our alliance's DSIM score so far
  thinking: boolean; // stopped at a decision, thinking ahead
  searched: number; // decisions thought through so far
}
/** the streamed match's frames since the last report; the first report carries the head, and its
 * first frame carries every element's state (a keyframe) */
export interface FramesProgress {
  k: 'frames';
  head?: LiveHead;
  f: Frame[];
}
/** thinking ahead at a decision (train/episode.ts searchHalving): every option played out on shared
 * luck, the better half again, the best two longest */
export interface ThinkProgress {
  k: 'think';
  at: 'start' | 'play' | 'round' | 'end';
  tick: number;
  robot: number; // 0: our robot, 1: its partner (a copy of our robot, thinking with it)
  opts?: [number, string][]; // (start) each option: kind index (OPTIONS), label
  net?: number; // (start, end) the network's own choice
  rounds?: number; // (start) how many rounds
  r?: number; // the round
  alive?: number[]; // (round) the options still in
  q?: (number | null)[]; // (round, end) each option's value so far, in points
  done?: number; // (play) what-ifs played in this round …
  total?: number; // … of this many
  best?: number; // (end) what it takes
  changed?: boolean; // (end) the search overruled the network
}
/** the learner fitting a candidate: one fit per learning rate, epochs over the newest decisions */
export interface LearnProgress {
  k: 'learn';
  lr: number; // which learning rate (0-based) …
  lrs: number; // … of this many
  epoch: number; // the epoch (0-based) …
  epochs: number; // … of this many
  frac: number; // how far through the whole job (0–1)
  loss: number | null; // the last epoch's training loss
}
export type JobProgress = MatchProgress | FramesProgress | ThinkProgress | LearnProgress;

/** the continuous engine's work, by kind */
export type JobKind = 'base-exam' | 'exam' | 'actor' | 'drill' | 'learner' | 'search-exam';
/** one job in flight */
export interface LiveJob {
  id: number;
  kind: JobKind;
  label: string; // what it is, in words
  since: number; // when a worker took it (ms since 1970)
  p: MatchProgress | LearnProgress | null; // its last report
  think: { tick: number; opts: number; rounds: number; r: number; done: number; total: number } | null; // thinking at a decision now
  live: boolean; // the match streamed to the field
}
/** everything the continuous engine has in flight, a couple of times a second while it trains */
export interface TrainLive {
  name: string;
  profile: string;
  running: boolean;
  time: number; // when this picture was taken (ms since 1970)
  workers: number;
  cpu: number; // busy share of the workers (smoothed)
  jobs: LiveJob[]; // running now, oldest first
  queued: Partial<Record<JobKind, number>>; // waiting for a worker
  base: { done: number; total: number } | null; // the no-learning robot's exam (the first thing a run does)
  exam: { id: number; done: number; total: number; mean: number | null; llr: number; lo: number; hi: number } | null; // a candidate's exam: paired matches played, the evidence (log-likelihood ratio) between its bounds
  searchExam: { champion: number; done: number; total: number } | null; // the champion thinking ahead vs alone
  learning: boolean;
  lessons: { have: number; need: number; perHour: number | null }; // new lessons toward the next candidate
  matchesPerHour: number | null;
  champion: number;
  next: number; // the next candidate's number
  stream: { id: number; label: string } | null; // the match streamed to the field
}
/** what a studio opening now needs to join the streamed match */
export interface StreamSnap {
  id: number;
  label: string;
  head: LiveHead;
  key: Frame | null; // the state now: the last frame with every element's state
  think: ThinkProgress | null; // the decision it is thinking at, if any (its start, with the latest round)
}
/** the engine's live channel (SSE `live`) */
export type LiveMsg =
  | ({ id: number; label: string } & FramesProgress)
  | ({ id: number } & ThinkProgress)
  | { k: 'end'; id: number; reward: number | null; score: number | null };
