// THE AUTO PLAYBOOK (MASTERPLAN §5, phase 2) — the best AUTO for our robot beside every kind of
// partner, from every legal pair of starts: the answer to "our partner can do X — what do we run?".
// Built by the AUTO planner (train/auto.ts) one entry at a time, in the order a team needs them (our
// own start first, the playing partners first), and kept: outputs/playbook/<profile>.db (a Store: each
// entry's plan, scores and timing sheet) and outputs/playbook/<profile>/<entry>.frames.json.gz (its
// exact replay). A build can stop and continue; an entry is only redone when asked.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { WorkerPool } from '../harness/pool';
import { loadProfile, resolve } from '../harness/profiles';
import { ROOT } from './engine';
import { AUTO_CFG, AUTO_QUICK, planAuto, type AutoCfg, type AutoProblem, type AutoResult } from './auto';
import { Store } from './store';
import { PARTNERS, PLAYBOOK_PARTNERS, STARTS, legalPair, partnerProfile, type PartnerKind, type StartId } from './team';
import type { Frames } from './episode';
import { ensureEnvelopes } from './envelope';

export const PLAYBOOK_DIR = join(ROOT, 'outputs', 'playbook');
export type PlaybookEntry = Omit<AutoResult, 'frames' | 'events'> & { key: string; at: string };
/** an entry's replay: exact frames and the match's events (what the studio's field view plays) */
export interface PlaybookReplay {
  frames: Frames;
  events: [number, string][];
}

export const keyOf = (P: Pick<AutoProblem, 'partner' | 'start' | 'partnerStart' | 'mode'>): string => `${P.partner}|${P.start}|${P.partnerStart ?? '-'}|${P.mode}`;
const fileOf = (key: string): string => `${key.replace(/[^A-Za-z0-9_-]+/g, '_')}-${createHash('sha1').update(key).digest('hex').slice(0, 6)}`;

/** every problem the playbook covers for a profile, in build order */
export function problems(profile: string, o: { partners?: (PartnerKind | 'none')[]; starts?: StartId[]; modes?: ('best' | 'joint')[]; seed?: number } = {}): AutoProblem[] {
  const ours = resolve(loadProfile(join(ROOT, profile))).spec;
  const starts = o.starts ?? (['F3', ...STARTS.filter((s) => s !== 'F3')] as StartId[]);
  const partners = o.partners ?? (['none', 'real', 'skimmer', 'sniper', 'hauler', 'parker', 'idle'] as (PartnerKind | 'none')[]);
  const modes = o.modes ?? ['best', 'joint'];
  const out: AutoProblem[] = [];
  for (const start of starts)
    for (const partner of partners) {
      if (partner === 'none') {
        out.push({ profile, start, partner, mode: 'best', seed: o.seed ?? 1 });
        continue;
      }
      const ps = partnerProfile(partner, join(ROOT, profile), 1, false).spec;
      for (const pstart of STARTS)
        if (legalPair(ours, start, ps, pstart))
          for (const mode of modes) {
            if (mode === 'joint' && PARTNERS[partner].mode !== 'play') continue; // nothing to plan for a parker
            out.push({ profile, start, partner, partnerStart: pstart, mode, seed: o.seed ?? 1 });
          }
    }
  return out;
}

export interface BuildStatus {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
  log: string[];
}

export class Playbook extends EventEmitter {
  readonly name: string;
  readonly store: Store;
  readonly dir: string;
  private stopFlag = false;
  status: BuildStatus = { running: false, done: 0, total: 0, current: null, log: [] };

  /** `root`: where the playbook lives (outputs/playbook; the gate builds one elsewhere) */
  constructor(
    readonly profile: string,
    root = PLAYBOOK_DIR,
  ) {
    super();
    this.name = basename(profile, '.json');
    mkdirSync(root, { recursive: true });
    this.store = new Store(join(root, `${this.name}.db`));
    this.dir = join(root, this.name);
    mkdirSync(this.dir, { recursive: true });
  }

  entries(): PlaybookEntry[] {
    return this.store.plans<PlaybookEntry>('auto').map((e) => ({ ...e, key: e.key }));
  }
  entry(key: string): PlaybookEntry | null {
    const e = this.store.plan<PlaybookEntry>('auto', key);
    return e ? { ...e, key } : null;
  }
  replay(key: string): PlaybookReplay | null {
    const f = join(this.dir, `${fileOf(key)}.frames.json.gz`);
    return existsSync(f) ? (JSON.parse(gunzipSync(readFileSync(f)).toString('utf8')) as PlaybookReplay) : null;
  }
  /** the gzip file itself (the studio streams it) */
  framesFile(key: string): string | null {
    const f = join(this.dir, `${fileOf(key)}.frames.json.gz`);
    return existsSync(f) ? f : null;
  }

  private say(s: string): void {
    this.status.log = [...this.status.log.slice(-40), `${new Date().toLocaleTimeString()} ${s}`];
    this.emit('log', s);
    this.emit('status', this.status);
  }

  stop(): void {
    this.stopFlag = true;
  }

  /** plan every problem not in the playbook yet (or all with `redo`) */
  async build(o: { partners?: (PartnerKind | 'none')[]; starts?: StartId[]; modes?: ('best' | 'joint')[]; budget?: 'quick' | 'full'; redo?: boolean; workers?: number; genome?: string | null } = {}): Promise<void> {
    if (this.status.running) throw new Error('the playbook is already being built');
    this.stopFlag = false;
    const cfg: AutoCfg = o.budget === 'quick' ? AUTO_QUICK : AUTO_CFG;
    const all = problems(this.profile, o).map((P) => ({ ...P, genome: o.genome ?? null }));
    const have = new Set(this.entries().map((e) => e.key));
    const todo = o.redo ? all : all.filter((P) => !have.has(keyOf(P)));
    this.status = { running: true, done: 0, total: todo.length, current: null, log: this.status.log };
    this.emit('status', this.status);
    const pool = new WorkerPool(o.workers ?? 12);
    try {
      // every build the partners bring needs its shooting envelope first
      await ensureEnvelopes([resolve(loadProfile(join(ROOT, this.profile))).spec, ...PLAYBOOK_PARTNERS.map((k) => partnerProfile(k, join(ROOT, this.profile), 1, false).spec)], (s) => this.say(s));
      for (const P of todo) {
        if (this.stopFlag) break;
        const key = keyOf(P);
        this.status.current = key;
        this.say(`planning ${describe(P)}`);
        const r = await planAuto(P, pool, cfg, (s) => this.emit('log', `  ${s}`), () => this.stopFlag);
        if (this.stopFlag) break;
        const { frames, events, ...rest } = r;
        this.store.putPlan('auto', key, rest.nominal.mean, rest);
        if (frames) writeFileSync(join(this.dir, `${fileOf(key)}.frames.json.gz`), gzipSync(JSON.stringify({ frames, events: events ?? [] } satisfies PlaybookReplay)));
        this.status.done++;
        this.say(`${describe(P)}: ${rest.nominal.mean.toFixed(1)} ± ${rest.nominal.ci95.toFixed(1)} AUTO points (no plan ${rest.baseline.mean.toFixed(1)}), ${rest.seconds.toFixed(0)} s`);
        this.emit('entry', key);
      }
    } finally {
      pool.close();
      this.status.running = false;
      this.status.current = null;
      this.say(this.stopFlag ? 'playbook build stopped' : 'playbook build finished');
    }
  }
}

export function describe(P: AutoProblem): string {
  const partner = P.partner === 'none' ? 'no partner' : `${PARTNERS[P.partner].label} at ${P.partnerStart}`;
  return `our robot at ${P.start}, ${partner}${P.mode === 'joint' ? ' (joint plan)' : ''}`;
}
