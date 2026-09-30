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
//   · TEAM PLAYS (train/teamplay.ts): an actor's alliance plays a play — most often one of the best
//     the team-play book found beside that partner, sometimes any play of the library (exploring),
//     sometimes free play — and a second REAL-v1 carries the champion's network and THINKS AHEAD at
//     its own job starts too: both robots plan, both robots' decisions are lessons.
//   · OPPONENTS (phase 5): matches bring a red alliance too — DSIM's presets, two copies of our robot
//     (carrying the champion's network in the actors' matches: self-play), a defender — in the exam
//     every partner kind meets every opponent kind. Each champion's exam matches also give the
//     ROUTE LIBRARY (train/routes.ts): how it scores, cycle by cycle.
//   · THE MISTAKE AUDIT (phase 6, MASTERPLAN §7): each champion's exam matches are audited — empty
//     trips, blocked shots, idle spells, fouls, stalls, crashes — and its thinking-ahead exam adds the
//     JUDGEMENT mistakes (decisions where the search beat the network by more than JUDGE_PTS). A
//     mistake the previous champion made in the same match, at the same moment and place, is a REPEAT
//     (the goal: none). Every mistake becomes a DRILL: its state (a recipe: the exam match, the choices
//     on the way, the moment 3 s before) goes to the Store, and every DRILL_EVERY-th actor match
//     starts there, hands over to the current champion and thinks ahead through it.
// Until the first network beats it, the champion is the no-learning robot (the greedy order).
// Evaluator jobs jump the queue, then the learner, then actors: nothing waits long, nothing idles.
// State: runs/.v2/<name>/state.json (written atomically) + store.db. A studio restarted after a crash
// or a reboot carries on where it was.
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { availableParallelism } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { WorkerPool, type Job } from '../harness/pool';
import { seedOf } from '../harness/rng';
import { C, DT } from '../harness/dsim';
import { loadProfile, profileProblems } from '../harness/profiles';
import { RUNS, ROOT, meanCi, type MeanCi } from './engine';
import { JUDGE_PTS, SEARCH2, type AuditItem, type EpisodeArgs, type EpisodeResult, type MistakeKind, type Search2Spec } from './episode';
import { mineRoutes, type RouteLibrary } from './routes';
import { PLAYS, SOLO_PLAYS, type Play } from './teamplay';
import { TeamPlaybook } from './teamplaybook';
import { Store } from './store';
import { entGenome, labelRows, type EntFitReport, type LearnArgs, type LearnResult } from './entlearn';
import { ENT_PREFIX } from './policy';
import type { OpponentKind, PartnerKind } from './team';

export const V2_DIR = join(RUNS, '.v2');
export const V2_VERSION = 4; // 2: the exam brings opponents; 3: team plays (the entity network reads each option's role); 4: DSIM Act 2 (every match in DSIM's 3D solve)
const EXAM_SEED = 525_252;
const PRE = Math.round(C.PRE_COUNTDOWN / DT);
const PLAY_END = Math.round((C.PRE_COUNTDOWN + C.AUTO_DURATION + C.TRANSITION_DURATION + C.TELEOP_DURATION) / DT);
const TELEOP_START = Math.round((C.PRE_COUNTDOWN + C.AUTO_DURATION + C.TRANSITION_DURATION) / DT);
const PRI = { actor: 0, learner: 1, exam: 2 } as const;
const DRILL_EVERY = 4; // every 4th actor match is a drill (when there are drills)
const DRILL_LEAD = 180; // a drill starts 3 s before its mistake
const DRILLS_PER_EXAM = 60; // the costliest mistakes of each audited exam become drills
const DRILLS_KEPT = 400;
/** searched decisions kept in the Store (~5 KB each: ~1.5 GB); the learner reads the newest 40 000 */
const STORE_KEEP = 300_000;
const REPEAT_TICKS = 300; // a repeat: the same kind of mistake in the same exam match within 5 s …
const REPEAT_IN = 24; // … and 24 in
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
  opponents: OpponentKind[]; // the red alliances matches bring (the exam: each seed its own, in turn)
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
  opponents: ['none', 'presets', 'mirror', 'defense'],
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
  byOpponents: Record<string, number>;
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
  totals: { matches: number; labels: number; examMatches: number; wallSeconds: number; busySeconds: number; promotions: number; rejections: number; drills?: number };
  history: HistoryPoint[];
  candidates: CandidateRecord[];
  searchExam: { time: string; hours: number; champion: number; n: number; alone: number; search: number; gain: MeanCi } | null;
  audits: AuditPoint[]; // one per audited champion
  /** a run made by an older version (another sim) is kept under this name, and this run starts
   * from its champion's network: its learner begins there */
  carried?: { from: string; version: number; champion: number; exam: number | null; seeded: boolean; time: string };
}
/** a mistake as the audit keeps it: which exam match, whether the previous champion made it too */
export interface AuditEntry extends AuditItem {
  match: number;
  repeat: boolean;
  forces?: [number, string][]; // judgement mistakes: the search's earlier changes (to replay the match to it)
}
export interface Audit {
  champion: number;
  time: string;
  matches: number;
  items: AuditEntry[];
  judged: number[]; // exam matches the thinking-ahead exam audited (judgement mistakes)
  prevJudgement: AuditEntry[]; // the previous champion's (repeats are judged against them)
}
export interface AuditPoint {
  time: string;
  champion: number;
  perMatch: number; // mistakes per exam match
  byKind: Partial<Record<MistakeKind, number>>; // …per match, by kind
  repeats: number; // repeat mistakes per match
  judgement: number | null; // judgement mistakes per thinking-ahead exam match
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
  opponents: OpponentKind;
}
/** a new run: the no-learning robot is the first champion; the learner starts from `start` (a
 * carried-over champion's network) or a fresh entity network */
function freshState(name: string, config: V2Config, start: string | null): V2State {
  return {
    version: V2_VERSION, name, config, created: now(), running: false,
    champion: { id: 0, genome: null, born: now(), exam: [] },
    base: null,
    learner: { genome: start ?? entGenome(seedOf(name, 'learner')), lr: 0.002, runs: 0, last: null, before: null, tried: [] },
    nextId: 1, actorSeq: 0, labelsAtLearn: 0,
    totals: { matches: 0, labels: 0, examMatches: 0, wallSeconds: 0, busySeconds: 0, promotions: 0, rejections: 0 },
    history: [], candidates: [], searchExam: null, audits: [],
  };
}

/** the fixed exam: every partner kind against every opponent kind, the same seeds forever, interleaved
 * so any prefix covers them all */
export function examList(c: Pick<V2Config, 'examSeeds' | 'partners' | 'opponents'>): ExamEntry[] {
  const out: ExamEntry[] = [];
  for (let k = 0; k < c.examSeeds; k++) for (const p of c.partners) out.push({ seed: seed7(EXAM_SEED, p, k), partner: p, opponents: c.opponents[k % c.opponents.length] });
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
  private teamBook: TeamPlaybook | null = null;
  private teamAt = 0;
  private teamBest = new Map<string, Play[]>();
  private recent: string[] = [];
  private awake: ChildProcess | null = null; // caffeinate: the Mac stays awake while it trains
  problems: string[] = [];

  /** open (or create) the run for a robot profile */
  constructor(name: string, config?: V2Config) {
    super();
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(name)) throw new Error('run names use letters, digits, - and _ (up to 48)');
    this.dir = join(V2_DIR, name);
    const f = join(this.dir, 'state.json');
    if (existsSync(f)) {
      const old = JSON.parse(readFileSync(f, 'utf8')) as V2State;
      if (old.version > V2_VERSION) throw new Error(`run ${name} was made by a newer version (${old.version})`);
      if (old.version === V2_VERSION) this.st = old;
      else {
        // MADE BY AN OLDER VERSION — its champion's exam was played in another sim (version 3 and
        // before: DSIM's 2D pipeline), so continuing it would compare challengers measured here with
        // scores measured there. It is KEPT as it is, under a new name, and a fresh run starts whose
        // learner begins from the old champion's network (the skills and its inputs are the same):
        // the head start is examined here like any candidate before it can be champion.
        let kept = `${name}-v${old.version}`;
        for (let k = 2; existsSync(join(V2_DIR, kept)); k++) kept = `${name}-v${old.version}-${k}`;
        renameSync(this.dir, join(V2_DIR, kept));
        const cfg: V2Config = { ...v2Defaults(old.config.profile), ...old.config };
        const g = old.champion.genome;
        const seeded = !!g && g.startsWith(ENT_PREFIX);
        const ex = old.champion.exam.length ? old.champion.exam.reduce((a, b) => a + b, 0) / old.champion.exam.length : null;
        this.st = freshState(name, cfg, seeded ? g : null);
        this.st.carried = { from: kept, version: old.version, champion: old.champion.id, exam: ex, seeded, time: now() };
        mkdirSync(this.dir, { recursive: true });
        this.save();
      }
    } else {
      if (!config) throw new Error(`no run called "${name}"`);
      const probs = profileProblems(loadProfile(join(ROOT, config.profile)), true);
      if (probs.length) throw new Error(`cannot train ${config.profile}: ${probs.join('; ')}`);
      mkdirSync(this.dir, { recursive: true });
      this.st = freshState(name, config, null);
      this.save();
    }
    this.st.audits ??= [];
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
    this.emit('problem', text);
  }

  // ─────────────────────────────── jobs ───────────────────────────────
  private args(genome: string | null, seed: number, partner: PartnerKind | 'none', o: Partial<EpisodeArgs> = {}): EpisodeArgs {
    return { genome, profile: this.st.config.profile, sampleProfile: true, seed, stage: 'full', driver: 'oracle', track: false, record: false, ...(partner !== 'none' ? { partner: { kind: partner } } : {}), ...o };
  }
  /** exam match `e` for a network (the opponents always the no-learning order: the exam never changes) */
  private examArgs(genome: string | null, e: ExamEntry, o: Partial<EpisodeArgs> = {}): EpisodeArgs {
    return this.args(genome, e.seed, e.partner, { ...(e.opponents !== 'none' ? { opponents: e.opponents } : {}), routes: true, audit: true, ...o });
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
    if (process.platform === 'darwin' && !this.awake) {
      this.awake = spawn('caffeinate', ['-ims', '-w', String(process.pid)], { stdio: 'ignore' });
      this.awake.on('error', () => (this.awake = null));
    }
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
    this.awake?.kill();
    this.awake = null;
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
    this.teamBook?.store.close();
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
    Promise.all(idx.map((i) => this.run<EpisodeResult>(this.job(this.examArgs(champ.genome, list[i], { search2: s.config.search, keepSearched: true, routes: false, audit: false })), PRI.learner)))
      .then((res) => {
        if (pool !== this.pool || champ !== this.st.champion) return;
        // its searched decisions are lessons too (whole matches, every job start)
        res.forEach((r, k) => {
          const id = this.store.addMatch({ gen: champ.id, kind: 'search-exam', seed: list[idx[k]].seed, partner: 'none', start: r.start ?? 'F3', reward: r.reward, score: r.score });
          const rows = labelRows(r, id, champ.id, s.config.search);
          this.store.tx(() => this.store.addDecisions(rows));
          this.st.totals.labels += rows.length;
        });
        this.judge(res, idx, champ);
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
      const opponents = c.opponents[Math.floor(n / c.partners.length) % c.opponents.length];
      const seed = seed7(this.st.name, 'actor', n);
      const play = this.pickPlay(partner, seed);
      const from = PRE + (seedOf(seed, 'window') % Math.max(1, PLAY_END - PRE - c.window));
      const genome = this.st.champion.genome;
      const champ = this.st.champion.id;
      // a DRILL: a mistake's moment, replayed exactly, handed over to the champion, thought through
      const drill = n % DRILL_EVERY === DRILL_EVERY - 1 ? this.store.pickState('drill:') : null;
      const args: EpisodeArgs = drill
        ? { ...(drill.args as EpisodeArgs), forces: drill.forces, handover: { tick: drill.tick, genome }, search2: c.search, keepSearched: true, searchWindow: [drill.tick, drill.tick + c.window] }
        : // copies of our robot on red carry the champion too: self-play
          this.args(genome, seed, partner, {
            search2: c.search,
            keepSearched: true,
            searchWindow: [from, from + c.window],
            play,
            // a second REAL-v1 is our robot too: the champion's network, thinking ahead with us
            ...(partner === 'real' ? { partner: { kind: 'real' as const, genome }, searchPartner: true } : {}),
            ...(opponents !== 'none' ? { opponents, opponentGenome: genome } : {}),
          });
      this.run<EpisodeResult>(this.job(args), PRI.actor)
        .then((r) => {
          if (pool !== this.pool) return;
          const id = drill
            ? this.store.addMatch({ gen: champ, kind: 'drill', seed: args.seed, partner: args.partner?.kind ?? 'none', start: r.start ?? 'F3', reward: r.reward, score: r.score, info: { drill: drill.tag, tick: drill.tick, searched: r.searched } })
            : this.store.addMatch({ gen: champ, kind: 'actor', seed, partner, start: r.start ?? 'F3', reward: r.reward, score: r.score, info: { window: [from, from + c.window], searched: r.searched, mistakes: r.mistakes, opponents, play: play.id } });
          if (drill) this.st.totals.drills = (this.st.totals.drills ?? 0) + 1;
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

  /** the play an actor match plays: the team-play book's best beside this partner (60 %), any play of
   * the library (25 %: exploring), free play (15 %) */
  private pickPlay(partner: PartnerKind | 'none', seed: number): Play {
    if (Date.now() - this.teamAt > 600_000) {
      this.teamAt = Date.now();
      try {
        this.teamBook ??= new TeamPlaybook(this.st.config.profile);
        for (const e of this.teamBook.entries()) this.teamBest.set(e.partner, this.teamBook.best(e.partner));
      } catch {
        /* no book yet */
      }
    }
    const u = (seedOf(seed, 'play') % 1000) / 1000;
    const best = this.teamBest.get(partner) ?? [];
    const lib = partner === 'none' ? PLAYS.filter((p) => SOLO_PLAYS.includes(p.id)) : PLAYS;
    if (u < 0.6 && best.length) return best[seedOf(seed, 'best') % best.length];
    if (u < 0.85) return lib[seedOf(seed, 'lib') % lib.length];
    return PLAYS[0];
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
        const pruned = this.store.pruneDecisions(STORE_KEEP);
        if (pruned) this.say(`the Store keeps the newest ${STORE_KEEP.toLocaleString('en-US')} decisions (${pruned} older ones dropped)`);
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
    const res = await Promise.all(list.map((e) => this.run<EpisodeResult>(this.job(this.examArgs(null, e)), PRI.exam)));
    if (pool !== this.pool) return;
    this.st.base = res.map((r) => r.reward);
    this.st.totals.examMatches += res.length;
    if (!this.st.champion.genome) {
      this.st.champion.exam = [...this.st.base];
      this.saveRoutes(res, 0);
      this.saveAudit(res, 0);
    }
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
    const played: EpisodeResult[] = [];
    this.evaluating = { id: cand.id, done: 0, total: list.length };
    let verdict: 'H1' | 'H0' | null = null;
    try {
      for (let i = 0; i < list.length && verdict === null; i += c.sprt.chunk) {
        const part = list.slice(i, i + c.sprt.chunk);
        const res = await Promise.all(part.map((e) => this.run<EpisodeResult>(this.job(this.examArgs(cand.genome, e)), PRI.exam)));
        if (pool !== this.pool) return;
        got.push(...res.map((r) => r.reward));
        played.push(...res);
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
        const res = await Promise.all(rest.map((e) => this.run<EpisodeResult>(this.job(this.examArgs(cand.genome, e)), PRI.exam)));
        if (pool !== this.pool) return;
        got.push(...res.map((r) => r.reward));
        played.push(...res);
        this.st.totals.examMatches += res.length;
      }
      this.st.candidates = [...this.st.candidates.slice(-49), { time: now(), id: cand.id, lr: cand.lr, verdict: promote ? 'promoted' : 'rejected', n: diff.n, diff, learn: cand.report }];
      const sgn = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;
      if (promote) {
        this.st.champion = { id: cand.id, genome: cand.genome, born: now(), exam: got };
        this.st.totals.promotions++;
        this.point();
        this.saveRoutes(played, cand.id);
        this.saveAudit(played, cand.id);
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
  /** the champion's route library, from its exam matches */
  private saveRoutes(res: EpisodeResult[], champion: number): void {
    const list = examList(this.st.config);
    const lib = mineRoutes(
      res.map((r, i) => ({ match: i, partner: list[i].partner, opponents: list[i].opponents, reward: r.reward, cycles: r.cycles ?? [], teleopStart: TELEOP_START, end: PLAY_END })),
      champion,
    );
    writeFileSync(join(this.dir, 'routes.json'), JSON.stringify(lib));
    this.emit('routes', lib);
  }
  /** the champion's mistake audit, its repeats against the previous champion's, and its drills */
  private saveAudit(res: EpisodeResult[], champion: number): void {
    const prev = this.audit();
    const items: AuditEntry[] = res.flatMap((r, i) => (r.audit ?? []).map((a) => ({ ...a, match: i, repeat: false })));
    if (prev) for (const it of items) it.repeat = prev.items.some((p) => sameMistake(p, it));
    const a: Audit = { champion, time: now(), matches: res.length, items, judged: [], prevJudgement: prev?.items.filter((x) => x.kind === 'judgement') ?? [] };
    writeFileSync(join(this.dir, 'audit.json'), JSON.stringify(a));
    const n = Math.max(1, res.length);
    const byKind: Partial<Record<MistakeKind, number>> = {};
    for (const it of items) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1 / n;
    this.st.audits.push({ time: a.time, champion, perMatch: items.length / n, byKind, repeats: items.filter((x) => x.repeat).length / n, judgement: null });
    // the costliest become drills (a state 3 s before, reached exactly as in the exam)
    const list = examList(this.st.config);
    const genome = this.st.champion.genome;
    this.store.tx(() => {
      for (const it of [...items].sort((x, y) => y.cost - x.cost).slice(0, DRILLS_PER_EXAM)) {
        const { routes: _r, audit: _a, ...args } = this.examArgs(genome, list[it.match]);
        this.store.addState({ gen: champion, tag: `drill:${it.kind}`, args, forces: [], tick: Math.max(PRE + 1, it.tick - DRILL_LEAD), score: it.cost });
      }
      this.store.pruneStates('drill:', DRILLS_KEPT);
    });
    this.emit('audit', a);
    this.say(`audit of champion #${champion}: ${(items.length / n).toFixed(1)} mistakes per exam match, ${items.filter((x) => x.repeat).length} repeats`);
  }
  /** judgement mistakes from the thinking-ahead exam: where the search beat the network clearly */
  private judge(res: EpisodeResult[], idx: number[], champ: Champion): void {
    const a = this.audit();
    if (!a || a.champion !== champ.id) return;
    const list = examList(this.st.config);
    const found: AuditEntry[] = [];
    res.forEach((r, k) => {
      const forces: [number, string][] = [];
      for (const l of r.labels ?? []) {
        if (!l.change) continue;
        const gain = (l.q[l.chosen] ?? 0) - (l.q[l.net] ?? 0);
        if (gain > JUDGE_PTS) found.push({ tick: l.tick, kind: 'judgement', cost: gain, detail: `network: ${l.change.from} · search: ${l.change.to}`, x: 0, y: 0, match: idx[k], repeat: false, forces: [...forces] });
        forces.push([l.tick, l.change.key]);
      }
    });
    for (const it of found) it.repeat = a.prevJudgement.some((p) => sameMistake(p, it));
    a.items = [...a.items.filter((x) => x.kind !== 'judgement'), ...found];
    a.judged = idx;
    writeFileSync(join(this.dir, 'audit.json'), JSON.stringify(a));
    const last = this.st.audits[this.st.audits.length - 1];
    if (last?.champion === champ.id) last.judgement = found.length / Math.max(1, idx.length);
    this.store.tx(() => {
      for (const it of found) {
        const { routes: _r, audit: _a, ...args } = this.examArgs(champ.genome, list[it.match]);
        const lastForce = it.forces!.length ? it.forces![it.forces!.length - 1][0] : 0;
        this.store.addState({ gen: champ.id, tag: 'drill:judgement', args, forces: it.forces!, tick: Math.max(PRE + 1, lastForce + 1, it.tick - DRILL_LEAD), score: it.cost });
      }
      this.store.pruneStates('drill:', DRILLS_KEPT);
    });
    this.emit('audit', a);
    this.say(`thinking-ahead exam: ${found.length} judgement mistakes (the search better by more than ${JUDGE_PTS} points)`);
  }
  audit(): Audit | null {
    const f = join(this.dir, 'audit.json');
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Audit) : null;
  }
  /** audit item `i` replayed with exact frames: the champion's exam match, up to and past the mistake */
  mistakeArgs(i: number): { args: EpisodeArgs; tick: number } {
    const a = this.audit();
    const it = a?.items[i];
    if (!a || !it) throw new Error('no such mistake');
    const list = examList(this.st.config);
    return { args: this.examArgs(this.st.champion.genome, list[it.match], { frames: true, routes: false, audit: false, ...(it.forces?.length ? { forces: it.forces } : {}) }), tick: it.tick };
  }
  routes(): RouteLibrary | null {
    const f = join(this.dir, 'routes.json');
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as RouteLibrary) : null;
  }
  /** the exam, match by match: who it was beside and against, and the champion's points in it */
  examSheet(): { i: number; partner: string; opponents: string; champion: number | null; base: number | null }[] {
    return examList(this.st.config).map((e, i) => ({ i, partner: e.partner, opponents: e.opponents, champion: this.st.champion.exam[i] ?? null, base: this.st.base?.[i] ?? null }));
  }
  /** the champion's exam match `i`, with exact frames (the Routes page's "watch it") */
  watchArgs(i: number): EpisodeArgs {
    const list = examList(this.st.config);
    if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new Error('no such exam match');
    return this.examArgs(this.st.champion.genome, list[i], { frames: true, routes: false });
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
    const avgBy = (keys: string[], key: (e: ExamEntry) => string): Record<string, number> => {
      const o: Record<string, number> = {};
      for (const p of keys) {
        const idx = list.map((e, i) => (key(e) === p ? i : -1)).filter((i) => i >= 0 && i < v.length);
        if (idx.length) o[p] = idx.reduce((a, i) => a + v[i], 0) / idx.length;
      }
      return o;
    };
    return { ...meanCi(v), vsBase: meanCi(v.map((x, i) => x - base[i])), cvar10: cvar10(v), byPartner: avgBy(this.st.config.partners, (e) => e.partner), byOpponents: avgBy(this.st.config.opponents, (e) => e.opponents) };
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
      carried: s.carried ?? null,
      audit: s.audits[s.audits.length - 1] ?? null,
      drills: { ...this.store.countStates('drill:'), played: s.totals.drills ?? 0 },
      problems: this.problems,
      log: this.recent.slice(-30),
    };
  }
}

/** the same mistake: one exam match, one kind, within REPEAT_TICKS and REPEAT_IN (a foul: the same rule) */
export function sameMistake(p: AuditEntry, q: AuditEntry): boolean {
  if (p.match !== q.match || p.kind !== q.kind || Math.abs(p.tick - q.tick) > REPEAT_TICKS) return false;
  if (p.kind === 'foul') return p.detail === q.detail;
  if (p.kind === 'judgement') return p.detail === q.detail;
  return Math.hypot(p.x - q.x, p.y - q.y) <= REPEAT_IN;
}
