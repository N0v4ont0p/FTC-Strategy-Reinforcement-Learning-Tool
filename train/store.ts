// THE STORE (MASTERPLAN §4) — everything a run produces, kept: every match played, every searched
// decision (its observation, its options, each option's value with its uncertainty), every AUTO plan,
// and the recipes of interesting states to start new matches from. A new network architecture can
// relearn from all of it without replaying a match.
//
// SQLite through Node's built-in node:sqlite (no dependency), one file per run: runs/<name>/store.db,
// WAL mode so the studio can read while the engine writes. Float arrays are stored as raw Float32
// blobs. A STATE is stored as a RECIPE, not a memory image: matches are deterministic, so the episode
// arguments plus the choices forced along the way (tick, option key) rebuild it exactly — cheaper and
// safer than serializing a live object graph (Go-Explore restarts, drills).
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const STORE_VERSION = 1;

export interface MatchRow {
  gen: number;
  kind: string; // 'selfplay' | 'exam' | 'race' | 'auto' | 'drill' | …
  seed: number;
  partner: string;
  start: string;
  reward: number;
  score: number;
  info?: unknown; // anything else (parts, mistakes, …) as JSON
}
export interface DecisionRow {
  match: number; // MatchRow id (0 when not stored)
  gen: number;
  tick: number;
  robot: number;
  chosen: number; // what was taken
  best: number; // the option the search valued highest
  obs: Float32Array;
  feats: Float32Array; // n × feature length, option by option
  q: Float32Array; // each option's value (NaN = not evaluated)
  se: Float32Array; // its standard error (NaN = unknown)
  n: Float32Array; // play-outs behind each value
  ents?: Float32Array; // the entity encoding (phase 4), when recorded
  source: string; // 'search' | 'lesson' | 'demo' | …
  // the entity network's labels (phase 4, train/entlearn.ts)
  opt?: Float32Array; // the options as the entity network reads them (k × N_OPT_IN)
  rq?: Float32Array; // per sequential-halving round, each option's mean (rounds × k, NaN = out by then)
  rd?: Float32Array; // luck draws per round
  v?: number; // points still to come from here (the state value's target)
  net?: number; // the network's own choice
}
/** columns added after version 1 (added in place: an older store keeps its rows) */
const ADDED: [string, string][] = [['opt', 'BLOB'], ['rq', 'BLOB'], ['rd', 'BLOB'], ['v', 'REAL'], ['net', 'INT']];
export interface StateRow {
  gen: number;
  tag: string; // why it is interesting: 'late-game', 'near-mistake', 'drill:<kind>', …
  args: unknown; // the EpisodeArgs that start the match
  forces: [number, string][]; // (tick, option key) choices forced on the way
  tick: number; // play to this tick (the state), then hand over
  score?: number; // the priority (e.g. how much the search beat the network there)
}

const f32 = (b: Uint8Array | null | undefined): Float32Array =>
  b ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : new Float32Array(0);
const blob = (a: Float32Array | undefined): Uint8Array | null => (a ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : null);

export class Store {
  readonly db: DatabaseSync;
  private st: Record<string, StatementSync> = {};

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS matches (id INTEGER PRIMARY KEY, gen INT, kind TEXT, seed INT, partner TEXT, start TEXT, reward REAL, score REAL, info TEXT, at TEXT);
      CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY, match INT, gen INT, tick INT, robot INT, k INT, chosen INT, best INT,
        obs BLOB, feats BLOB, q BLOB, se BLOB, n BLOB, ents BLOB, source TEXT);
      CREATE INDEX IF NOT EXISTS decisions_gen ON decisions(gen);
      CREATE TABLE IF NOT EXISTS states (id INTEGER PRIMARY KEY, gen INT, tag TEXT, args TEXT, forces TEXT, tick INT, score REAL, used INT DEFAULT 0);
      CREATE INDEX IF NOT EXISTS states_tag ON states(tag);
      CREATE TABLE IF NOT EXISTS plans (id INTEGER PRIMARY KEY, kind TEXT, key TEXT, score REAL, json TEXT, at TEXT);
      CREATE INDEX IF NOT EXISTS plans_key ON plans(kind, key);
    `);
    const cols = new Set((this.db.prepare('PRAGMA table_info(decisions)').all() as { name: string }[]).map((c) => c.name));
    for (const [c, t] of ADDED) if (!cols.has(c)) this.db.exec(`ALTER TABLE decisions ADD COLUMN ${c} ${t}`);
    const v = this.meta('version');
    if (v === null) this.setMeta('version', String(STORE_VERSION));
    else if (Number(v) !== STORE_VERSION) throw new Error(`store ${path} is version ${v}, this code reads ${STORE_VERSION}`);
  }

  private s(sql: string): StatementSync {
    return (this.st[sql] ??= this.db.prepare(sql));
  }
  meta(key: string): string | null {
    const r = this.s('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }
  setMeta(key: string, value: string): void {
    this.s('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** a batch in one transaction (fast, and all-or-nothing) */
  tx<T>(f: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = f();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  addMatch(m: MatchRow): number {
    const r = this.s('INSERT INTO matches(gen, kind, seed, partner, start, reward, score, info, at) VALUES(?,?,?,?,?,?,?,?,?)').run(
      m.gen, m.kind, m.seed, m.partner, m.start, m.reward, m.score, m.info === undefined ? null : JSON.stringify(m.info), new Date().toISOString(),
    );
    return Number(r.lastInsertRowid);
  }
  addDecisions(rows: DecisionRow[]): void {
    const st = this.s('INSERT INTO decisions(match, gen, tick, robot, k, chosen, best, obs, feats, q, se, n, ents, source, opt, rq, rd, v, net) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const d of rows)
      st.run(d.match, d.gen, d.tick, d.robot, d.q.length, d.chosen, d.best, blob(d.obs), blob(d.feats), blob(d.q), blob(d.se), blob(d.n), blob(d.ents), d.source, blob(d.opt), blob(d.rq), blob(d.rd), d.v ?? null, d.net ?? null);
  }
  count(table: 'matches' | 'decisions' | 'states' | 'plans'): number {
    return Number((this.s(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint }).n);
  }
  /** decisions from generation `fromGen` on (all when omitted), newest first, at most `limit` */
  decisions(o: { fromGen?: number; limit?: number; source?: string } = {}): DecisionRow[] {
    const rows = this.s(
      `SELECT * FROM decisions WHERE gen >= ? AND (? IS NULL OR source = ?) ORDER BY id DESC LIMIT ?`,
    ).all(o.fromGen ?? -1, o.source ?? null, o.source ?? null, o.limit ?? 1e9) as Record<string, unknown>[];
    return rows.map((r) => ({
      match: Number(r.match), gen: Number(r.gen), tick: Number(r.tick), robot: Number(r.robot), chosen: Number(r.chosen), best: Number(r.best),
      obs: f32(r.obs as Uint8Array), feats: f32(r.feats as Uint8Array), q: f32(r.q as Uint8Array), se: f32(r.se as Uint8Array), n: f32(r.n as Uint8Array),
      ents: r.ents ? f32(r.ents as Uint8Array) : undefined, source: String(r.source),
      ...(r.opt ? { opt: f32(r.opt as Uint8Array) } : {}), ...(r.rq ? { rq: f32(r.rq as Uint8Array) } : {}), ...(r.rd ? { rd: f32(r.rd as Uint8Array) } : {}),
      ...(r.v !== null && r.v !== undefined ? { v: Number(r.v) } : {}), ...(r.net !== null && r.net !== undefined ? { net: Number(r.net) } : {}),
    }));
  }
  /** keep at most `keep` decisions (the newest): the store must not grow without bound */
  pruneDecisions(keep: number): number {
    const r = this.s('DELETE FROM decisions WHERE id <= (SELECT id FROM decisions ORDER BY id DESC LIMIT 1 OFFSET ?)').run(keep);
    return Number(r.changes);
  }

  addState(x: StateRow): number {
    const r = this.s('INSERT INTO states(gen, tag, args, forces, tick, score) VALUES(?,?,?,?,?,?)').run(x.gen, x.tag, JSON.stringify(x.args), JSON.stringify(x.forces), x.tick, x.score ?? 0);
    return Number(r.lastInsertRowid);
  }
  /** the `n` highest-priority states of a tag used least so far (each pick marks them used) */
  pickStates(tag: string, n: number): (StateRow & { id: number })[] {
    const rows = this.s('SELECT * FROM states WHERE tag = ? ORDER BY used ASC, score DESC, id DESC LIMIT ?').all(tag, n) as Record<string, unknown>[];
    const up = this.s('UPDATE states SET used = used + 1 WHERE id = ?');
    for (const r of rows) up.run(Number(r.id));
    return rows.map((r) => ({ id: Number(r.id), gen: Number(r.gen), tag: String(r.tag), args: JSON.parse(String(r.args)), forces: JSON.parse(String(r.forces)), tick: Number(r.tick), score: Number(r.score) }));
  }

  /** the highest-priority state whose tag starts with `prefix`, used least so far (the pick marks it used) */
  pickState(prefix: string): (StateRow & { id: number }) | null {
    const r = this.s("SELECT * FROM states WHERE tag LIKE ? || '%' ORDER BY used ASC, score DESC, id DESC LIMIT 1").get(prefix) as Record<string, unknown> | undefined;
    if (!r) return null;
    this.s('UPDATE states SET used = used + 1 WHERE id = ?').run(Number(r.id));
    return { id: Number(r.id), gen: Number(r.gen), tag: String(r.tag), args: JSON.parse(String(r.args)), forces: JSON.parse(String(r.forces)), tick: Number(r.tick), score: Number(r.score) };
  }
  /** keep only the newest `keep` states whose tag starts with `prefix` */
  pruneStates(prefix: string, keep: number): number {
    const r = this.s("DELETE FROM states WHERE tag LIKE ? || '%' AND id NOT IN (SELECT id FROM states WHERE tag LIKE ? || '%' ORDER BY id DESC LIMIT ?)").run(prefix, prefix, keep);
    return Number(r.changes);
  }
  countStates(prefix: string): { n: number; used: number } {
    const r = this.s("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN used > 0 THEN 1 ELSE 0 END), 0) AS used FROM states WHERE tag LIKE ? || '%'").get(prefix) as { n: number | bigint; used: number | bigint };
    return { n: Number(r.n), used: Number(r.used) };
  }

  /** a plan (AUTO playbook entries, routes): the latest under (kind, key) is the current one */
  putPlan(kind: string, key: string, score: number, plan: unknown): number {
    const r = this.s('INSERT INTO plans(kind, key, score, json, at) VALUES(?,?,?,?,?)').run(kind, key, score, JSON.stringify(plan), new Date().toISOString());
    return Number(r.lastInsertRowid);
  }
  plan<T>(kind: string, key: string): (T & { score: number; at: string }) | null {
    const r = this.s('SELECT score, json, at FROM plans WHERE kind = ? AND key = ? ORDER BY id DESC LIMIT 1').get(kind, key) as { score: number; json: string; at: string } | undefined;
    return r ? { ...(JSON.parse(r.json) as T), score: r.score, at: r.at } : null;
  }
  plans<T>(kind: string): (T & { key: string; score: number; at: string })[] {
    const rows = this.s('SELECT key, score, json, at FROM plans WHERE id IN (SELECT MAX(id) FROM plans WHERE kind = ? GROUP BY key) ORDER BY key').all(kind) as { key: string; score: number; json: string; at: string }[];
    return rows.map((r) => ({ ...(JSON.parse(r.json) as T), key: r.key, score: r.score, at: r.at }));
  }

  close(): void {
    this.db.close();
  }
}
