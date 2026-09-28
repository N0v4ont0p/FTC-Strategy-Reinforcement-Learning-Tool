// THE TEAM-PLAY BOOK — for each kind of partner (and alone), the plays (train/teamplay.ts) that win
// full matches, found by the play search in DSIM: the library scored on shared luck, mutated and
// crossed for a few generations, the finalists re-scored on fresh luck. Kept in
// outputs/teamplays/<robot>.db (a Store: one entry per partner kind), built on request, resumable.
// The continuous engine trains inside these plays; the studio's Team plays tab shows them.
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { WorkerPool } from '../harness/pool';
import { ROOT } from './engine';
import { Store } from './store';
import { PLAY_QUICK, PLAY_SEARCH, playWords, searchPlays, type Play, type PlaySearchResult } from './teamplay';
import type { PartnerKind } from './team';

export const TEAMPLAY_DIR = join(ROOT, 'outputs', 'teamplays');
export const TEAM_PARTNERS: (PartnerKind | 'none')[] = ['real', 'skimmer', 'sniper', 'hauler', 'parker', 'none'];
export type TeamEntry = PlaySearchResult & { words: Record<string, ReturnType<typeof playWords>> };

export interface TeamBuildStatus {
  running: boolean;
  done: number; // partner kinds finished
  total: number;
  current: string | null;
  log: string[];
  // live progress
  stage?: string | null;
  matches?: number; // matches played for the current partner…
  matchesTotal?: number; // …of about this many
  allMatches?: number; // the whole search so far
  startedAt?: string | null;
  partnerAt?: string | null;
  partnerS?: number | null; // seconds a partner kind takes (this search's average; before the first: an estimate)
  estimated?: boolean;
  beat?: string | null;
}

export class TeamPlaybook extends EventEmitter {
  readonly name: string;
  readonly store: Store;
  private stopFlag = false;
  status: TeamBuildStatus = { running: false, done: 0, total: 0, current: null, log: [] };

  constructor(
    readonly profile: string,
    root = TEAMPLAY_DIR,
  ) {
    super();
    this.name = basename(profile, '.json');
    mkdirSync(root, { recursive: true });
    this.store = new Store(join(root, `${this.name}.db`));
  }
  entries(): TeamEntry[] {
    return this.store.plans<TeamEntry>('team');
  }
  entry(partner: string): TeamEntry | null {
    return this.store.plan<TeamEntry>('team', partner);
  }
  /** the plays worth training in beside a partner: the best few that beat free play (free first if none does) */
  best(partner: string, k = 3): Play[] {
    const e = this.entry(partner);
    if (!e) return [];
    const good = e.ranked.filter((r) => r.vsFree > 0).slice(0, k).map((r) => r.play);
    return good.length ? good : e.ranked.slice(0, 1).map((r) => r.play);
  }
  private say(s: string): void {
    this.status.log = [...this.status.log.slice(-40), `${new Date().toLocaleTimeString()} ${s}`];
    this.emit('log', s);
    this.emit('status', this.status);
  }
  stop(): void {
    this.stopFlag = true;
  }
  /** search the plays beside each partner kind not searched yet (or all with `redo`) */
  async build(o: { partners?: (PartnerKind | 'none')[]; budget?: 'quick' | 'full'; redo?: boolean; genome?: string | null; workers?: number; seed?: number } = {}): Promise<void> {
    if (this.status.running) throw new Error('the team-play book is already being built');
    this.stopFlag = false;
    const have = new Set(this.entries().map((e) => e.partner));
    const todo = (o.partners ?? TEAM_PARTNERS).filter((p) => o.redo || !have.has(p));
    const quick = o.budget === 'quick';
    this.status = { running: true, done: 0, total: todo.length, current: null, log: this.status.log, stage: 'starting', matches: 0, matchesTotal: 0, allMatches: 0, startedAt: new Date().toISOString(), partnerAt: null, partnerS: quick ? 40 : 330, estimated: true, beat: new Date().toISOString() };
    this.emit('status', this.status);
    const took: number[] = [];
    let before = 0;
    let lastEmit = 0;
    const pool = new WorkerPool(o.workers ?? 12);
    try {
      for (const partner of todo) {
        if (this.stopFlag) break;
        this.status.current = partner;
        Object.assign(this.status, { partnerAt: new Date().toISOString(), matches: 0, matchesTotal: 0 });
        this.say(`searching plays beside ${partner === 'none' ? 'no partner' : partner}`);
        const tp = Date.now();
        const r = await searchPlays({ profile: this.profile, partner, genome: o.genome ?? null, seed: o.seed ?? 1 }, pool, quick ? PLAY_QUICK : PLAY_SEARCH, (s) => this.say(`  ${s}`), () => this.stopFlag, (p) => {
          Object.assign(this.status, { stage: p.stage, matches: p.done, matchesTotal: p.total, allMatches: before + p.done, beat: new Date().toISOString() });
          if (Date.now() - lastEmit > 500) {
            lastEmit = Date.now();
            this.emit('status', this.status);
          }
        });
        before += this.status.matches ?? 0;
        took.push((Date.now() - tp) / 1000);
        Object.assign(this.status, { partnerS: took.reduce((a, b) => a + b, 0) / took.length, estimated: false });
        if (this.stopFlag) break;
        const words = Object.fromEntries(r.ranked.map((x) => [x.play.id, playWords(x.play)]));
        this.store.putPlan('team', partner, r.ranked[0].mean, { ...r, words } satisfies TeamEntry);
        this.status.done++;
        const b = r.ranked[0];
        this.say(`beside ${partner}: ${b.play.label} ${b.mean.toFixed(1)} ± ${b.ci95.toFixed(1)} (${b.vsFree >= 0 ? '+' : ''}${b.vsFree.toFixed(1)} over free play), ${r.evaluated} plays scored in ${r.seconds.toFixed(0)} s`);
        this.emit('entry', partner);
      }
    } finally {
      pool.close();
      this.status.running = false;
      this.status.current = null;
      this.status.stage = null;
      this.say(this.stopFlag ? 'team-play search stopped' : 'team-play search finished');
    }
  }
}
