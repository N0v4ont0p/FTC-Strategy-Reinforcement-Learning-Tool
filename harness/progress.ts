// A JOB'S PROGRESS, from inside a worker process (harness/worker.ts) to whoever submitted the job
// (harness/pool.ts `submit`, its onProgress hook): a match's clock, the frames of a match streamed
// to the studio's field, a search thinking at a decision, a learner's epochs. Outside a worker (a
// direct call, a check) nobody listens and a report costs nothing.
let sink: ((p: unknown) => void) | null = null;

/** the worker points this at its current job (and back at null when the job ends) */
export function setProgressSink(s: ((p: unknown) => void) | null): void {
  sink = s;
}
/** report progress: a plain JSON value */
export function progress(p: unknown): void {
  sink?.(p);
}
/** is anyone listening (skip building a report nobody reads) */
export const listening = (): boolean => sink !== null;
