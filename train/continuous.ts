// THE CONTINUOUS ENGINE (MASTERPLAN §4, phase 4) — one button, no generations. Three kinds of work
// share one pool of worker processes, every core busy all the time:
//   · ACTORS play matches with the champion network and THINK AHEAD (train/episode.ts search2,
//     sequential halving on shared luck draws) through a window of each match — a different stretch
//     each time, late game included (Go-Explore-style: the sim goes where decisions are, a match
//     reaches any tick in about a second) — and every searched decision becomes a clean label in the
//     Store: each option's value per round, the points still to come.
//   · THE LEARNER (train/entlearn.ts) fits the entity network to the newest labels every
//     `learnEvery` labels, one candidate per learning rate (population-based: the best on held-out
//     decisions wins, and the learning rate follows it). The learner keeps training its own network.
//   · THE EVALUATOR plays each candidate on the FIXED EXAM — every partner kind, the same seeds and
//     robot draws forever — paired against the champion's own exam matches, and promotes it by a
//     sequential probability ratio test (SPRT: it stops as soon as the evidence is clear), never with
//     a worse worst tenth. The actors pick a new champion up at their next match.
// Until the first network beats it, the champion is the no-learning robot (the greedy order).
// Evaluator jobs jump the queue, then the learner, then actors: nothing waits long, nothing idles.
// State: runs/.v2/<name>/state.json (written atomically) + store.db. A studio restarted after a crash
// or a reboot carries on where it was.
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { availableParallelism } from 'node:os';
import { WorkerPool, type Job } from '../harness/pool';
import { seedOf } from '../harness/rng';
import { C, DT } from '../harness/dsim';
import { loadProfile, profileProblems } from '../harness/profiles';
import { RUNS, ROOT, meanCi, type MeanCi } from './engine';
import { SEARCH2, type EpisodeArgs, type EpisodeResult, type Search2Spec } from './episode';
import { Store } from './store';
import { entGenome, labelRows, type EntFitReport, type LearnArgs, type LearnResult } from './entlearn';
import type { PartnerKind } from './team';

export const V2_DIR = join(RUNS, '.v2');
export const V2_VERSION = 1;
const EXAM_SEED = 525_252;
const PRE = Math.round(C.PRE_COUNTDOWN / DT);
const PLAY_END = Math.round((C.PRE_COUNTDOWN + C.AUTO_DURATION + C.TRANSITION_DURATION + C.TELEOP_DURATION) / DT);
const PRI = { actor: 0, learner: 1, exam: 2 } as const;
const seed7 = (...p: (number | string)[]): number => seedOf(...p) % 1_000_000_007;
const now = (): string => new Date().toISOString();

export interface V2Config {
  profile: string;
  workers: number;
  search: Search2Spec; // the actors' thinking ahead
  window: number; // ticks of each actor match that are searched
  learnEvery: number; // new labels between learner runs
  learnWindow: number; // newest labels the learner reads
  epochs: number;
  examSeeds: number; // exam matches per partner kind
  partners: (PartnerKind | 'none')[];
  sprt: { delta: number; alpha: number; beta: number; sigmaFloor: number; minN: number; chunk: number };
  tailTol: number; // the candidate's worst tenth may be at most this much below the champion's
}
export const v2Defaults = (profile: string): V2Config => ({
  profile,
  workers: Math.max(1, availableParallelism() - 1),
  search: SEARCH2,
  window: 1800,
  learnEvery: 400,
  learnWindow: 40_000,
  epochs: 4,
  examSeeds: 24,
  partners: ['none', 'real', 'skimmer', 'sniper', 'hauler', 'parker'],
  sprt: { delta: 4, alpha: 0.05, beta: 0.1, sigmaFloor: 10, minN: 36, chunk: 36 },
  tailTol: 5,
});

export interface Champion {
  id: number;
  genome: string | null; // null: the no-learning robot
  born: string;
  exam: number[]; // its reward on every exam match (list order)
}
export interface ExamSummary extends MeanCi {
  vsBase: MeanCi;
  cvar10: number;
  byPartner: Record<string, number>;
}
export interface CandidateRecord {
  time: string;
  id: number;
  lr: number;
  verdict: 'promoted' | 'rejected';
  n: number; // exam matches played
  diff: MeanCi; // paired, candidate − champion
  learn: EntFitReport;
}
export interface HistoryPoint {
  time: string;
  hours: number; // training hours so far
  labels: number;
  champion: number;
  exam: number; // champion exam mean
  vsBase: number;
}
export interface V2State {
  version: number;
  name: string;
  config: V2Config;
  created: string;
  running: boolean; // training when last saved (a restarted studio carries on)
  champion: Champion;
  base: number[] | null; // the no-learning robot on the exam
  learner: { genome: string; lr: number; runs: number; last: LearnResult['report'] | null; before: LearnResult['before'] | null; tried: LearnResult['tried'] };
  nextId: number;
  actorSeq: number; // actor matches handed out (their seeds)
  labelsAtLearn: number;
  totals: { matches: number; labels: number; examMatches: number; wallSeconds: number; busySeconds: number; promotions: number; rejections: number };
  history: HistoryPoint[];
  candidates: CandidateRecord[];
  searchExam: { time: string; hours: number; champion: number; n: number; alone: number; search: number; gain: MeanCi } | null;
}
/** how the champion alone compares with the champion thinking ahead (MASTERPLAN phase 4's pass
 * condition: the network alone reaches the search): this many solo exam matches, at most this often */
const SEARCH_EXAM = { n: 6, everyHours: 6 };

/** Gaussian SPRT on paired differences (Wald): 'H1' = better by delta, 'H0' = not better, null = go on */
export function sprt(d: number[], s: V2Config['sprt']): 'H1' | 'H0' | null {
  if (d.length < s.minN) return null;
  const m = d.reduce((a, b) => a + b, 0) / d.length;
  const sd = Math.max(s.sigmaFloor, Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / (d.length - 1)));
  const llr = (s.delta / sd ** 2) * d.reduce((a, x) => a + (x - s.delta / 2), 0);
  if (llr >= Math.log((1 - s.beta) / s.alpha)) return 'H1';
  if (llr <= Math.log(s.beta / (1 - s.alpha))) return 'H0';
  return null;
}
/** mean of the worst tenth */
export const cvar10 = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const k = Math.max(1, Math.floor(s.length / 10));
  return s.slice(0, k).reduce((a, b) => a + b, 0) / k;
};

export interface ExamEntry {
  seed: number;
  partner: PartnerKind | 'none';
}
/** the fixed exam: every partner kind, the same seeds forever, interleaved so any prefix covers them all */
export function examList(c: Pick<V2Config, 'examSeeds' | 'partners'>): ExamEntry[] {
  const out: ExamEntry[] = [];
  for (let k = 0; k < c.examSeeds; k++) for (const p of c.partners) out.push({ seed: seed7(EXAM_SEED, p, k), partner: p });
  return out;
}

export function listV2(): { name: string; profile: string; running: boolean; champion: number; exam: number | null; updated: string }[] {
  if (!existsSync(V2_DIR)) return [];
  return readdirSync(V2_DIR)
    .filter((n) => existsSync(join(V2_DIR, n, 'state.json')))
    .map((n) => {
      const s = JSON.parse(readFileSync(join(V2_DIR, n, 'state.json'), 'utf8')) as V2State & { updated?: string };
      const ex = s.champion.exam.length ? s.champion.exam.reduce((a, b) => a + b, 0) / s.champion.exam.length : null;
      return { name: n, profile: s.config.profile, running: s.running, champion: s.champion.id, exam: ex, updated: s.updated ?? s.created };
    });
}

export class Continuous extends EventEmitter {
  readonly dir: string;
  st: V2State;
  readonly store: Store;
  private pool: WorkerPool | null = null;
  private active = false;
  private actorsInFlight = 0;
  private learning = false;
  private evaluating: { id: number; done: number; total: number } | null = null;
  private pending: (LearnResult & { id: number }) | null = null;
  private timers: NodeJS.Timeout[] = [];
  private startedAt = 0;
  private busy = 0; // busy worker share, smoothed
  private failures = 0;
  private searchExamRunning = false;
  private recent: string[] = [];
  problems: string[] = [];

  /** open (or create) the run for a robot profile */
  constructor(name: string, config?: V2Config) {
    super();
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(name)) throw new Error('run names use letters, digits, - and _ (up to 48)');
    this.dir = join(V2_DIR, name);
    const f = join(this.dir, 'state.json');
    if (existsSync(f)) {
      this.st = JSON.parse(readFileSync(f, 'utf8')) as V2State;
      if (this.st.version !== V2_VERSION) throw new Error(`run ${name} was made by another version (${this.st.version})`);
    } else {
      if (!config) throw new Error(`no run called "${name}"`);
      const probs = profileProblems(loadProfile(join(ROOT, config.profile)), true);
      if (probs.length) throw new Error(`cannot train ${config.profile}: ${probs.join('; ')}`);
      mkdirSync(this.dir, { recursive: true });
      this.st = {
        version: V2_VERSION, name, config, created: now(), running: false,
        champion: { id: 0, genome: null, born: now(), exam: [] },
        base: null,
        learner: { genome: entGenome(seedOf(name, 'learner')), lr: 0.002, runs: 0, last: null, before: null, tried: [] },
        nextId: 1, actorSeq: 0, labelsAtLearn: 0,
        totals: { matches: 0, labels: 0, examMatches: 0, wallSeconds: 0, busySeconds: 0, promotions: 0, rejections: 0 },
        history: [], candidates: [], searchExam: null,
      };
      this.save();
    }
    this.store = new Store(join(this.dir, 'store.db'));
  }
  get name(): string {
    return this.st.name;
  }
  get running(): boolean {
    return this.active;
  }

  private save(): void {
    const f = join(this.dir, 'state.json');
    writeFileSync(f + '.tmp', JSON.stringify({ ...this.st, updated: now() }));
    renameSync(f + '.tmp', f);
  }
  private say(text: string): void {
    const line = `${new Date().toLocaleTimeString()} ${text}`;
    this.recent = [...this.recent.slice(-60), line];
    appendFileSync(join(this.dir, 'events.jsonl'), JSON.stringify({ time: now(), text }) + '\n');
    this.emit('log', text);
  }
  private problem(text: string): void {
    this.problems = [...this.problems.slice(-9), `${new Date().toLocaleString()}: ${text}`];
    this.say(`⚠ ${text}`);
  }

  // ─────────────────────────────── jobs ───────────────────────────────
  private args(genome: string | null, seed: number, partner: PartnerKind | 'none', o: Partial<EpisodeArgs> = {}): EpisodeArgs {
    return { genome, profile: this.st.config.profile, sampleProfile: true, seed, stage: 'full', driver: 'oracle', track: false, record: false, ...(partner !== 'none' ? { partner: { kind: partner } } : {}), ...o };
  }
  private job(a: EpisodeArgs): Job {
    return { module: '../train/episode.ts', fn: 'runEpisode', args: a };
  }
  private async run<T>(job: Job, pri: number): Promise<T> {
    const t0 = Date.now();
    const r = await this.pool!.submit<T>(job, pri);
    this.st.totals.busySeconds += (Date.now() - t0) / 1000;
    return r;
  }

  // ─────────────────────────────── control ───────────────────────────────
  /** train until paused (the one button) */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.st.running = true;
    this.failures = 0;
    this.startedAt = Date.now();
    this.pool = new WorkerPool(this.st.config.workers);
    this.save();
    this.say(`training ${basename(this.st.config.profile, '.json')}: ${this.st.config.workers} workers`);
    this.timers.push(
      setInterval(() => {
        const l = this.pool?.load;
        if (l) this.busy = 0.9 * this.busy + 0.1 * (l.size ? l.busy / l.size : 0);
      }, 2000),
      setInterval(() => this.tick(), 30_000),
    );
    this.emit('state');
    void this.begin();
  }
  private async begin(): Promise<void> {
    try {
      if (!this.st.base) await this.baseExam();
      if (!this.active || !this.st.base) return;
      this.fill();
      if (this.pending) void this.evaluate();
      else this.maybeLearn();
    } catch (e) {
      this.fault(e);
    }
  }
  /** pause: work in flight is dropped (labels already stored stay) */
  stop(why = 'paused'): void {
    if (!this.active) return;
    this.tick();
    this.active = false;
    if (why !== 'interrupted') this.st.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.pool?.close();
    this.pool = null;
    this.actorsInFlight = 0;
    this.learning = false;
    this.evaluating = null;
    this.save();
    this.say(`training ${why}`);
    this.emit('state');
  }
  /** the studio is closing (a signal, a reboot): keep `running` so it carries on next time */
  close(): void {
    this.stop('interrupted');
    this.store.close();
  }
  private tick(): void {
    if (!this.active) return;
    const t = Date.now();
    this.st.totals.wallSeconds += (t - this.startedAt) / 1000;
    this.startedAt = t;
    this.save();
    this.emit('status', this.status());
    this.maybeSearchExam();
  }
  /** the champion thinking ahead vs alone, on the first solo exam matches (each new champion, at most every few hours) */
  private maybeSearchExam(): void {
    const s = this.st;
    const pool = this.pool;
    if (!this.active || !pool || this.searchExamRunning || !s.champion.genome || !s.base) return;
    const hours = s.totals.wallSeconds / 3600;
    if (s.searchExam && (s.searchExam.champion === s.champion.id || hours - s.searchExam.hours < SEARCH_EXAM.everyHours)) return;
    const list = examList(s.config);
    const idx = list.map((e, i) => (e.partner === 'none' ? i : -1)).filter((i) => i >= 0).slice(0, SEARCH_EXAM.n);
    const champ = s.champion;
    this.searchExamRunning = true;
    this.say(`thinking-ahead exam: champion #${champ.id} with search on ${idx.length} solo exam matches`);
    Promise.all(idx.map((i) => this.run<EpisodeResult>(this.job(this.args(champ.genome, list[i].seed, 'none', { search2: s.config.search })), PRI.learner)))
      .then((res) => {
        if (pool !== this.pool || champ !== this.st.champion) return;
        const srch = res.map((r) => r.reward);
        const alone = idx.map((i) => champ.exam[i]);
        const gain = meanCi(srch.map((x, k) => x - alone[k]));
        s.searchExam = { time: now(), hours, champion: champ.id, n: idx.length, alone: meanCi(alone).mean, search: meanCi(srch).mean, gain };
        this.say(`thinking-ahead exam: alone ${s.searchExam.alone.toFixed(1)}, with search ${s.searchExam.search.toFixed(1)} (${gain.mean >= 0 ? '+' : ''}${gain.mean.toFixed(1)} ± ${gain.ci95.toFixed(1)})`);
        this.save();
      })
      .catch((e) => pool === this.pool && this.fault(e))
      .finally(() => (this.searchExamRunning = false));
  }
  /** a worker lost: a fresh pool, and on; five in a row is a bug, not bad luck — stop and say so */
  private fault(e: unknown): void {
    if (!this.active) return;
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'aborted') return;
    this.failures++;
    this.problem(`${msg.split('\n')[0].slice(0, 300)}`);
    if (this.failures >= 5) {
      this.stop('stopped after repeated failures — see the problems list');
      return;
    }
    this.pool?.close();
    this.pool = new WorkerPool(this.st.config.workers);
    this.actorsInFlight = 0;
    this.learning = false;
    this.evaluating = null;
    setTimeout(() => void this.begin(), 3000);
  }

  // ─────────────────────────────── actors ───────────────────────────────
  private fill(): void {
    const pool = this.pool;
    if (!this.active || !pool) return;
    // one actor job per worker in the queue: a higher-priority job always gets the next free worker
    while (this.actorsInFlight < this.st.config.workers) {
      this.actorsInFlight++;
      const n = this.st.actorSeq++;
      const c = this.st.config;
      const partner = c.partners[n % c.partners.length];
      const seed = seed7(this.st.name, 'actor', n);
      const from = PRE + (seedOf(seed, 'window') % Math.max(1, PLAY_END - PRE - c.window));
      const genome = this.st.champion.genome;
      const champ = this.st.champion.id;
      this.run<EpisodeResult>(this.job(this.args(genome, seed, partner, { search2: c.search, keepSearched: true, searchWindow: [from, from + c.window] })), PRI.actor)
        .then((r) => {
          if (pool !== this.pool) return;
          const id = this.store.addMatch({ gen: champ, kind: 'actor', seed, partner, start: r.start ?? 'F3', reward: r.reward, score: r.score, info: { window: [from, from + c.window], searched: r.searched, mistakes: r.mistakes } });
          const rows = labelRows(r, id, champ, c.search);
          this.store.tx(() => this.store.addDecisions(rows));
          this.st.totals.matches++;
          this.st.totals.labels += rows.length;
          this.failures = 0;
          this.emit('actor', { labels: this.st.totals.labels, matches: this.st.totals.matches });
          this.maybeLearn();
        })
        .catch((e) => pool === this.pool && this.fault(e))
        .finally(() => {
          if (pool !== this.pool) return;
          this.actorsInFlight--;
          this.fill();
        });
    }
  }

  // ─────────────────────────────── learner ───────────────────────────────
  private maybeLearn(): void {
    const c = this.st.config;
    if (!this.active || !this.st.base || this.learning || this.pending || this.st.totals.labels - this.st.labelsAtLearn < c.learnEvery) return;
    this.learning = true;
    const pool = this.pool;
    const L = this.st.learner;
    const args: LearnArgs = { store: join(this.dir, 'store.db'), start: L.genome, lrs: [L.lr / 2, L.lr, L.lr * 2], epochs: c.epochs, window: c.learnWindow, seed: seedOf(this.st.name, 'learn', L.runs), maxSeconds: 900 };
    this.st.labelsAtLearn = this.st.totals.labels;
    this.say(`learning from the newest ${Math.min(c.learnWindow, this.st.totals.labels)} decisions`);
    this.run<LearnResult>({ module: '../train/entlearn.ts', fn: 'learnJob', args }, PRI.learner)
      .then((r) => {
        if (pool !== this.pool) return;
        L.genome = r.genome;
        L.lr = Math.min(0.02, Math.max(1e-4, r.lr));
        L.runs++;
        L.last = r.report;
        L.before = r.before;
        L.tried = r.tried;
        const id = this.st.nextId++;
        this.say(`candidate #${id}: held-out agrees with the search ${(100 * r.report.agree).toFixed(0)}% (was ${(100 * r.before.agree).toFixed(0)}%), gives away ${r.report.regret.toFixed(1)} pts per decision (was ${r.before.regret.toFixed(1)}); learning rate ${r.lr.toPrecision(2)}`);
        this.pending = { ...r, id };
        this.save();
        void this.evaluate();
      })
      .catch((e) => pool === this.pool && this.fault(e))
      .finally(() => {
        if (pool === this.pool) this.learning = false;
      });
  }

  // ─────────────────────────────── evaluator ───────────────────────────────
  /** the no-learning robot on the whole exam: the baseline, and the first champion */
  private async baseExam(): Promise<void> {
    const list = examList(this.st.config);
    this.say(`exam: the no-learning robot on ${list.length} matches (every partner kind)`);
    const pool = this.pool!;
    const res = await Promise.all(list.map((e) => this.run<EpisodeResult>(this.job(this.args(null, e.seed, e.partner)), PRI.exam)));
    if (pool !== this.pool) return;
    this.st.base = res.map((r) => r.reward);
    this.st.totals.examMatches += res.length;
    if (!this.st.champion.genome) this.st.champion.exam = [...this.st.base];
    this.point();
    this.say(`no-learning robot: ${meanCi(this.st.base).mean.toFixed(1)} on the exam`);
    this.save();
  }

  private async evaluate(): Promise<void> {
    const cand = this.pending;
    const pool = this.pool;
    if (!cand || !pool || this.evaluating) return;
    const c = this.st.config;
    const list = examList(c);
    const champ = this.st.champion;
    if (champ.exam.length !== list.length) return; // (the baseline exam comes first)
    const got: number[] = [];
    this.evaluating = { id: cand.id, done: 0, total: list.length };
    let verdict: 'H1' | 'H0' | null = null;
    try {
      for (let i = 0; i < list.length && verdict === null; i += c.sprt.chunk) {
        const part = list.slice(i, i + c.sprt.chunk);
        const res = await Promise.all(part.map((e) => this.run<EpisodeResult>(this.job(this.args(cand.genome, e.seed, e.partner)), PRI.exam)));
        if (pool !== this.pool) return;
        got.push(...res.map((r) => r.reward));
        this.st.totals.examMatches += res.length;
        this.evaluating = { id: cand.id, done: got.length, total: list.length };
        this.emit('status', this.status());
        verdict = sprt(got.map((x, k) => x - champ.exam[k]), c.sprt);
      }
      const d = got.map((x, k) => x - champ.exam[k]);
      const diff = meanCi(d);
      if (verdict === null) verdict = diff.n > 1 && diff.mean / (diff.ci95 / 1.96) >= 1.96 ? 'H1' : 'H0'; // the whole exam and still unsure: a plain paired test
      const tailOk = cvar10(got) >= cvar10(champ.exam.slice(0, got.length)) - c.tailTol;
      const promote = verdict === 'H1' && tailOk;
      if (promote && got.length < list.length) {
        // a champion's exam is always the whole list (the next candidate is paired with all of it)
        const rest = list.slice(got.length);
        const res = await Promise.all(rest.map((e) => this.run<EpisodeResult>(this.job(this.args(cand.genome, e.seed, e.partner)), PRI.exam)));
        if (pool !== this.pool) return;
        got.push(...res.map((r) => r.reward));
        this.st.totals.examMatches += res.length;
      }
      this.st.candidates = [...this.st.candidates.slice(-49), { time: now(), id: cand.id, lr: cand.lr, verdict: promote ? 'promoted' : 'rejected', n: diff.n, diff, learn: cand.report }];
      const sgn = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;
      if (promote) {
        this.st.champion = { id: cand.id, genome: cand.genome, born: now(), exam: got };
        this.st.totals.promotions++;
        this.point();
        this.say(`★ new champion #${cand.id}: ${sgn(diff.mean)} ± ${diff.ci95.toFixed(1)} over #${champ.id} on ${diff.n} exam matches — exam ${meanCi(got).mean.toFixed(1)}`);
        this.emit('champion', this.status().champion);
      } else {
        this.st.totals.rejections++;
        this.say(`candidate #${cand.id} not promoted: ${sgn(diff.mean)} ± ${diff.ci95.toFixed(1)} on ${diff.n} matches${verdict === 'H1' && !tailOk ? ' (its worst tenth is worse)' : ''}`);
      }
      this.save();
    } catch (e) {
      this.fault(e);
    } finally {
      if (pool === this.pool) {
        this.evaluating = null;
        this.pending = null;
        this.maybeLearn();
      }
    }
  }
  private point(): void {
    const base = this.st.base;
    const ex = this.st.champion.exam;
    if (!base || ex.length !== base.length) return;
    this.st.history.push({ time: now(), hours: this.st.totals.wallSeconds / 3600, labels: this.st.totals.labels, champion: this.st.champion.id, exam: meanCi(ex).mean, vsBase: meanCi(ex.map((x, i) => x - base[i])).mean });
  }

  // ─────────────────────────────── the studio's view ───────────────────────────────
  examSummary(v: number[]): ExamSummary | null {
    const base = this.st.base;
    if (!v.length || !base) return null;
    const list = examList(this.st.config);
    const byPartner: Record<string, number> = {};
    for (const p of this.st.config.partners) {
      const idx = list.map((e, i) => (e.partner === p ? i : -1)).filter((i) => i >= 0 && i < v.length);
      if (idx.length) byPartner[p] = idx.reduce((a, i) => a + v[i], 0) / idx.length;
    }
    return { ...meanCi(v), vsBase: meanCi(v.map((x, i) => x - base[i])), cvar10: cvar10(v), byPartner };
  }
  status() {
    const s = this.st;
    const hist = s.history;
    const trend = hist.length >= 2 ? hist[hist.length - 1].exam - hist[Math.max(0, hist.length - 4)].exam : null;
    const hours = s.totals.wallSeconds / 3600;
    const lastPromo = s.candidates.filter((c) => c.verdict === 'promoted').pop()?.time ?? null;
    return {
      name: s.name,
      profile: s.config.profile,
      running: this.active,
      champion: { id: s.champion.id, born: s.champion.born, learned: !!s.champion.genome, exam: this.examSummary(s.champion.exam) },
      base: s.base ? meanCi(s.base).mean : null,
      trend,
      improving: trend === null ? null : trend > 1 ? 'improving' : 'flat',
      history: hist,
      candidates: s.candidates.slice(-12),
      learner: { lr: s.learner.lr, runs: s.learner.runs, last: s.learner.last, before: s.learner.before, tried: s.learner.tried },
      totals: { ...s.totals, hours },
      labelsPerHour: hours > 0.01 ? s.totals.labels / hours : null,
      nextLearnIn: Math.max(0, s.config.learnEvery - (s.totals.labels - s.labelsAtLearn)),
      cpu: this.active ? this.busy : 0,
      activity: { actors: this.actorsInFlight, learning: this.learning, evaluating: this.evaluating },
      lastPromotion: lastPromo,
      searchExam: s.searchExam,
      problems: this.problems,
      log: this.recent.slice(-30),
    };
  }
}
