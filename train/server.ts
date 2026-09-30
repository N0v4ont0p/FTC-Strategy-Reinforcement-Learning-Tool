// THE STUDIO SERVER — static viewer + JSON API + a Server-Sent Events stream, Node stdlib only,
// bound to 127.0.0.1 (this machine only). It manages runs: one is open at a time; training starts
// only when asked (from the viewer or `npm run train`). It also manages the training data (the
// replays in "Training data/") and can shut the whole studio down.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createBiobuzzWorldForViewer } from './field';
import { Engine, NAME_RE, PRESETS, RUNS, ROOT, SEARCH, checkRun, confStats, defaultConfig, deleteRun, listRuns, renameRun, type Champ, type RunConfig } from './engine';
import { DATA_DIR, currentKey, dataFiles, excluded, greedyReport, hasSet, imitationReport, setExcluded, valueReport } from './imitate';
import { WorkerPool, runPool } from '../harness/pool';
import { STYLE, decodeStyle } from './policy';
import { fromB64, styleOffset } from './net';
import { SHAPE } from './policy';
import { Playbook } from './playbook';
import { Continuous, listV2, v2Defaults } from './continuous';
import { TeamPlaybook } from './teamplaybook';
import { PLAYS, SOLO_PLAYS, playWords, type Play } from './teamplay';
import { notify, notifySettings, recent as recentNotices, setNotifySettings } from './notify';
import { draftFrom, fileFor, inspectRobot, listRobots, replayRobots, saveRobot, specsIn } from './robots';
import { loadProfile, resolve as resolveProfile, type ProfileFile } from '../harness/profiles';
import { ensureEnvelopes } from './envelope';
import { LABEL as SERVICE_LABEL } from './service';
import { homedir } from 'node:os';
import type { PartnerKind as PartnerKindT } from './team';

const PUBLIC = join(ROOT, 'train', 'public');
const LAST = join(RUNS, '.last');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

class HttpError extends Error {
  constructor(
    readonly code: number,
    msg: string,
  ) {
    super(msg);
  }
}

export interface Studio {
  url: string;
  engine: () => Engine | null;
  open: (name: string) => Engine;
  close: () => Promise<void>;
}

/** the champion as the studio shows it: its race record on fresh matches, its exam, its skill settings */
const champ = (c: Champ) => {
  const o = styleOffset(SHAPE);
  const st = decodeStyle(fromB64(c.genome).subarray(o, o + STYLE.length));
  return { id: c.id, op: c.lineage.op, born: c.born, race: c.conf?.n ? confStats(c.conf) : null, exam: c.exam, parts: c.parts, style: STYLE.map((d) => ({ key: d.key, label: d.label, value: st[d.key], def: d.def })) };
};

export function startServer(port: number, first?: Engine, opts: { onQuit?: () => void; noResume?: boolean } = {}): Studio {
  let engine: Engine | null = first ?? null;
  let refreshing: Promise<unknown> | null = null;
  const streams = new Set<ServerResponse>();
  const send = (type: string, data: unknown): void => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of streams) s.write(msg);
  };
  const say = (text: string): void => send('log', text);

  // THE AUTO PLAYBOOK (train/playbook.ts): one per robot profile, built on request in the background
  let playbook: Playbook | null = null;
  const book = (profile: string): Playbook => {
    if (!/^profiles\/[A-Za-z0-9_.-]+\.json$/.test(profile) || !existsSync(join(ROOT, profile))) throw new HttpError(400, 'unknown profile');
    if (playbook?.profile === profile) return playbook;
    if (playbook?.status.running) throw new HttpError(409, `the ${playbook.name} playbook is being built — stop it first`);
    playbook?.removeAllListeners();
    playbook = new Playbook(profile);
    playbook.on('status', (st) => send('playbook', { profile, status: st }));
    playbook.on('log', (l: string) => send('log', `playbook: ${l}`));
    playbook.on('entry', (key: string) => send('playbookEntry', { profile, key }));
    let was = false;
    playbook.on('status', (st: { running: boolean; done: number; total: number }) => {
      if (was && !st.running && st.done > 0) notify('playbook', `${playbook!.name} playbook`, `${st.done} of ${st.total} entries planned${st.done < st.total ? ' (stopped)' : ' — ready to print'}`);
      was = st.running;
    });
    return playbook;
  };
  const pbSummary = (pb: Playbook) => ({ profile: pb.profile, name: pb.name, status: pb.status, entries: pb.entries() });

  // THE TEAM-PLAY BOOK (train/teamplaybook.ts): the plays that win beside each partner, searched on request
  let team: TeamPlaybook | null = null;
  const teamFor = (profile: string): TeamPlaybook => {
    if (!/^profiles\/[A-Za-z0-9_.-]+\.json$/.test(profile) || !existsSync(join(ROOT, profile))) throw new HttpError(400, 'unknown profile');
    if (team?.profile === profile) return team;
    if (team?.status.running) throw new HttpError(409, `the ${team.name} team plays are being searched — stop it first`);
    team?.removeAllListeners();
    team?.store.close();
    team = new TeamPlaybook(profile);
    const t = team;
    t.on('status', (st) => send('teamplays', { profile, status: st }));
    t.on('log', (l: string) => send('log', `team plays: ${l}`));
    t.on('entry', () => send('teamplays', { profile, status: t.status, entry: true }));
    let was = false;
    t.on('status', (st: { running: boolean; done: number; total: number }) => {
      if (was && !st.running && st.done > 0) notify('playbook', `${t.name} team plays`, `${st.done} of ${st.total} partner kinds searched`);
      was = st.running;
    });
    return t;
  };
  /** the network the robots play with: the continuous run's champion for this robot (else the no-learning order) */
  const championOf = (profile: string): string | null => listV2().some((r) => r.profile === profile) ? (coach?.st.config.profile === profile ? coach.st.champion.genome : coachFor(profile).st.champion.genome) : null;

  // THE CONTINUOUS ENGINE (train/continuous.ts, phase 4): the Home page's one button — one run per robot
  let coach: Continuous | null = null;
  const coachFor = (profile: string): Continuous => {
    if (!/^profiles\/[A-Za-z0-9_.-]+\.json$/.test(profile) || !existsSync(join(ROOT, profile))) throw new HttpError(400, 'unknown profile');
    const name = profile.replace('profiles/', '').replace('.json', '').replace(/[^A-Za-z0-9_-]/g, '_');
    if (coach?.name === name) return coach;
    if (coach?.running) throw new HttpError(409, `${coach.name} is training — pause it first`);
    coach?.removeAllListeners();
    coach?.store.close();
    const exists = listV2().some((r) => r.name === name);
    try {
      coach = exists ? new Continuous(name) : new Continuous(name, v2Defaults(profile));
    } catch (err) {
      throw bad(err);
    }
    const c = coach;
    const push = (): void => send('home', c.status());
    c.on('status', push);
    c.on('state', push);
    c.on('champion', push);
    c.on('champion', () => {
      const ex = c.status().champion.exam;
      notify('champion', `New champion #${c.st.champion.id} (${c.name})`, ex ? `exam ${ex.mean.toFixed(1)} pts, ${ex.vsBase.mean >= 0 ? '+' : ''}${ex.vsBase.mean.toFixed(1)} over the no-learning robot` : 'exam done');
    });
    c.on('problem', (text: string) => notify('problems', `Training ${c.name}: a problem`, text.slice(0, 180)));
    c.on('routes', () => send('routes', { profile: c.st.config.profile }));
    c.on('audit', () => send('mistakes', { profile: c.st.config.profile }));
    c.on('log', (l: string) => send('log', `training: ${l}`));
    // the live picture (the status bar, Home's live panel) and the match streamed to the field
    c.on('train', (x: unknown) => send('train', x));
    c.on('live', (m: unknown) => send('live', m));
    return c;
  };

  // WATCHING a match again in DSIM (an exam match, a route, a mistake, a team play): two workers kept
  // warm while they are used (a fresh worker costs a second or two to start), closed after two idle
  // minutes; the match reports its clock on the way, so the field shows how far it is (SSE `sim`)
  let watchPool: WorkerPool | null = null;
  let watchIdle: NodeJS.Timeout | null = null;
  let watching = 0;
  const simulate = async <T,>(args: object, rid: unknown, label: string): Promise<T> => {
    if (watchIdle) clearTimeout(watchIdle);
    watchIdle = null;
    watchPool ??= new WorkerPool(2);
    const pool = watchPool;
    const id = typeof rid === 'string' && /^[\w-]{1,40}$/.test(rid) ? rid : null;
    let last = 0;
    const tell = (x: object): void => {
      if (id) send('sim', { rid: id, label, ...x });
    };
    tell({ frac: 0 });
    watching++;
    try {
      return await pool.submit<T>({ module: '../train/episode.ts', fn: 'runEpisode', args: { ...args, progress: true } }, 0, {
        onProgress: (p) => {
          const m = p as { k?: string; frac?: number; t?: number };
          if (m.k !== 'match' || Date.now() - last < 150) return;
          last = Date.now();
          tell({ frac: m.frac ?? 0, t: m.t ?? 0 });
        },
      });
    } finally {
      watching--;
      tell({ done: true });
      if (!watching && watchPool === pool)
        watchIdle = setTimeout(() => {
          if (watching) return;
          watchPool?.close();
          watchPool = null;
        }, 120_000);
    }
  };
  const home = (profile?: string) => {
    const profiles = readdirSync(join(ROOT, 'profiles')).filter((f) => f.endsWith('.json')).map((f) => `profiles/${f}`);
    const runs = listV2();
    const pick = profile ?? coach?.st.config.profile ?? runs[0]?.profile ?? 'profiles/real-v1.json';
    const exists = runs.some((r) => r.profile === pick);
    return { profile: pick, profiles, runs, status: coach && coach.st.config.profile === pick ? coach.status() : exists && !coach?.running ? coachFor(pick).status() : null, busy: { v1: engine?.running ? engine.name : null, playbook: playbook?.status.running ? playbook.name : null } };
  };

  const wire = (e: Engine): void => {
    e.on('progress', (p) => send('progress', p));
    e.on('generation', (g) => {
      send('generation', g);
      send('runs', listRuns()); // generation, champion and size in the run list
    });
    e.on('best', (b: Champ) => send('best', champ(b)));
    e.on('exam', (x) => send('exam', x));
    e.on('log', (l) => send('log', l));
    e.on('checkpoints', () => send('checkpoints', e.listCheckpoints()));
    e.on('eval', (r) => send('eval', r));
    e.on('reset', () => send('reset', state()));
    e.on('state', () => send('status', status()));
    e.on('stopped', () => send('status', status()));
  };
  if (engine) wire(engine);

  function status() {
    const e = engine;
    return e ? { running: e.running, paused: e.paused, phase: e.phase, gen: e.gen, config: e.config, data: e.data, lastGenAt: e.lastGenAt, progress: e.running ? e.progress : null } : null;
  }
  /** the training data: every replay, what the current data set made of it, and the fit */
  function data() {
    const rep = imitationReport();
    const latest = currentKey();
    const fitted = rep && rep.dataKey === latest ? rep : null;
    const byName = new Map((rep?.files ?? []).map((f) => [f.name, f]));
    return {
      dir: DATA_DIR,
      files: dataFiles().map((f) => ({ ...f, ...(byName.has(f.name) ? { info: byName.get(f.name) } : {}) })),
      latest,
      built: hasSet(latest),
      fitted: fitted ? { agree: fitted.holdout.agree, chance: fitted.holdout.chance, holdout: fitted.holdout.file, samples: fitted.train.samples + fitted.holdout.samples } : null,
      refreshing: !!refreshing,
    };
  }
  function state() {
    const e = engine;
    const imit = imitationReport();
    const reference = imit ? { files: imit.files.map((f) => ({ name: f.name, score: f.score })), holdoutAgree: imit.holdout.agree, chance: imit.holdout.chance } : null;
    const common = { runs: listRuns(), reference, defaults: defaultConfig('new-run'), presets: PRESETS, data: data() };
    if (!e) return { run: null, ...common };
    return {
      run: {
        name: e.name,
        config: e.config,
        gen: e.gen,
        totals: e.totals,
        running: e.running,
        paused: e.paused,
        phase: e.phase,
        lastGenAt: e.lastGenAt,
        progress: e.running ? e.progress : null,
        champion: champ(e.champion),
        arena: e.arena.map((a) => ({ id: a.id, op: a.lineage.op, since: a.since, n: a.pairs.length })),
        history: e.history(),
        exams: e.exams(),
        events: e.events().slice(-200),
        checkpoints: e.listCheckpoints(),
        evals: e.evals().slice(-50),
        data: e.data,
        search: SEARCH,
      },
      ...common,
    };
  }

  const need = (): Engine => {
    if (!engine) throw new HttpError(409, 'open or create a run first');
    return engine;
  };
  const open = (name: string): Engine => {
    if (engine?.name === name) return engine;
    if (engine?.running) throw new HttpError(409, `"${engine.name}" is training — stop it before switching runs`);
    engine?.removeAllListeners();
    engine = Engine.open(name);
    wire(engine);
    writeFileSync(LAST, name);
    send('reset', state());
    return engine;
  };

  /** rebuild the data set from the included replays and refit, in a worker (the server stays live) */
  const refresh = (rebuild: boolean): Promise<unknown> => {
    if (refreshing) return refreshing;
    const n = dataFiles().filter((f) => f.included).length;
    say(n ? `training data: re-simulating ${n} replay${n > 1 ? 's' : ''} and refitting (≈ ${Math.max(10, 3 * n)} s)…` : 'training data: no replays included');
    refreshing = runPool<{ key: string; log: string[] } | null>([{ module: '../train/imitate.ts', fn: 'refreshJob', args: { rebuild } }], 1)
      .then(([r]) => {
        for (const l of r?.log ?? []) say(l);
        const d = data();
        say(r ? `training data ready: ${d.fitted ? `the fitted network agrees with a held-out replay ${(100 * d.fitted.agree).toFixed(0)}% of the time (chance ${(100 * d.fitted.chance).toFixed(0)}%)` : 'fitted'}` : 'training data: nothing to learn from');
        if (engine && engine.data.key !== (r?.key ?? '')) engine.useData(r?.key ?? '');
      })
      .catch((e: Error) => say(`training data refresh failed: ${e.message}`))
      .finally(() => {
        refreshing = null;
        send('data', data());
        send('status', status());
      });
    send('data', data());
    return refreshing;
  };

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const file = (res: ServerResponse, p: string, type?: string, gz = false): void => {
    res.writeHead(200, { 'content-type': type ?? MIME[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store', ...(gz ? { 'content-encoding': 'gzip' } : {}) });
    res.end(readFileSync(p));
  };
  const body = (req: IncomingMessage, limit = 1e6): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      let b = '';
      req.on('data', (c) => {
        b += c;
        if (b.length > limit) reject(new HttpError(413, 'request too large'));
      });
      req.on('end', () => {
        try {
          resolve(b ? (JSON.parse(b) as Record<string, unknown>) : {});
        } catch {
          reject(new HttpError(400, 'body must be JSON'));
        }
      });
    });
  const bad = (err: unknown): HttpError => (err instanceof HttpError ? err : new HttpError(400, (err as Error).message));
  let field: unknown = null;
  let measuring = false;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const post = req.method === 'POST';
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: reset\ndata: ${JSON.stringify(state())}\n\n`);
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (p === '/api/state') return json(res, 200, state());
    if (p === '/api/field') return json(res, 200, (field ??= createBiobuzzWorldForViewer('profiles/real-v0.json')));

    // shut everything down (the studio process, DSIM, training); the page closes itself
    if (p === '/api/quit' && post) {
      if (!opts.onQuit) throw new HttpError(409, 'this studio was started without a quit handler — close its terminal');
      json(res, 200, { ok: true });
      send('quit', {});
      setTimeout(() => opts.onQuit!(), 100);
      return;
    }

    // the AUTO playbook
    if (p === '/api/playbook' && !post) {
      const profile = url.searchParams.get('profile') ?? playbook?.profile ?? 'profiles/real-v1.json';
      const profiles = readdirSync(join(ROOT, 'profiles')).filter((f) => f.endsWith('.json')).map((f) => `profiles/${f}`);
      return json(res, 200, { ...pbSummary(book(profile)), profiles });
    }
    if (p === '/api/playbook/frames') {
      const f = book(url.searchParams.get('profile') ?? 'profiles/real-v1.json').framesFile(url.searchParams.get('key') ?? '');
      if (!f) throw new HttpError(404, 'no replay for that playbook entry');
      return file(res, f, 'application/json', true);
    }
    if (p === '/api/playbook/build' && post) {
      const b = await body(req);
      if (team?.status.running) throw new HttpError(409, 'the team plays are being searched — one search at a time');
      if (engine?.running) throw new HttpError(409, `"${engine.name}" is training — the playbook needs every core; pause training first`);
      if (coach?.running) throw new HttpError(409, `${coach.name} is training — the playbook needs every core; pause training first`);
      const pb = book(String(b.profile ?? 'profiles/real-v1.json'));
      if (pb.status.running) throw new HttpError(409, 'the playbook is already being built');
      const list = <T,>(v: unknown): T[] | undefined => (Array.isArray(v) && v.length ? (v as T[]) : undefined);
      pb.build({ budget: b.budget === 'quick' ? 'quick' : 'full', redo: !!b.redo, starts: list(b.starts), partners: list(b.partners), modes: list(b.modes) }).catch((err: Error) => say(`playbook build failed: ${err.message}`));
      return json(res, 200, { ok: true });
    }
    if (p === '/api/playbook/stop' && post) {
      playbook?.stop();
      return json(res, 200, { ok: true });
    }

    // the Home page: Train / Pause (the continuous engine)
    if (p === '/api/home' && !post) return json(res, 200, home(url.searchParams.get('profile') ?? undefined));
    if (p === '/api/home/train' && post) {
      const b = await body(req);
      if (engine?.running) throw new HttpError(409, `the generational run "${engine.name}" is training — stop it first (one trainer at a time)`);
      if (playbook?.status.running) throw new HttpError(409, 'the AUTO playbook is being built — stop it first (it needs every core)');
      if (team?.status.running) throw new HttpError(409, 'the team plays are being searched — stop it first (it needs every core)');
      coachFor(String(b.profile ?? 'profiles/real-v1.json')).start();
      return json(res, 200, home());
    }
    if (p === '/api/home/pause' && post) {
      coach?.stop('paused');
      return json(res, 200, home());
    }

    // the Home page: the exam match by match, watching the champion play one, its network
    if (p === '/api/home/exam' && !post) {
      const prof = url.searchParams.get('profile') ?? coach?.st.config.profile ?? listV2()[0]?.profile;
      const has = !!prof && (coach?.st.config.profile === prof || (!coach?.running && listV2().some((r) => r.profile === prof)));
      return json(res, 200, has ? coachFor(prof!).examSheet() : []);
    }
    if (p === '/api/home/watch' && post) {
      const b = await body(req);
      const c = coachFor(String(b.profile ?? coach?.st.config.profile ?? 'profiles/real-v1.json'));
      let args;
      try {
        args = c.watchArgs(Number(b.match));
      } catch (err) {
        throw bad(err);
      }
      const r = await simulate<{ frames: unknown; events: unknown; reward: number }>(args, b.rid, `exam match ${Number(b.match) + 1}`);
      return json(res, 200, { frames: r.frames, events: r.events, reward: r.reward });
    }
    // the live picture now (a studio opening mid-training joins the streamed match from here)
    if (p === '/api/train/live' && !post) return json(res, 200, { train: coach ? coach.live() : null, stream: coach ? coach.liveSnapshot() : null });
    if (p === '/api/export/v2-champion.json') {
      const c = coachFor(url.searchParams.get('profile') ?? coach?.st.config.profile ?? 'profiles/real-v1.json');
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${c.name}-champion-${c.st.champion.id}.json"` });
      return void res.end(JSON.stringify({ robot: c.st.config.profile, champion: c.st.champion.id, born: c.st.champion.born, genome: c.st.champion.genome, exam: c.status().champion.exam }));
    }

    // notifications
    if (p === '/api/notify' && !post) return json(res, 200, { settings: notifySettings(), recent: recentNotices, mac: process.platform === 'darwin' });
    if (p === '/api/notify' && post) {
      const b = await body(req);
      return json(res, 200, { settings: setNotifySettings(b as Record<string, boolean>), recent: recentNotices });
    }
    if (p === '/api/notify/test' && post) {
      notify('test', 'Notifications are on', 'You will hear from the studio when something happens.');
      return json(res, 200, { ok: true });
    }

    // the setup checklist on Home
    if (p === '/api/setup' && !post) {
      const profile = url.searchParams.get('profile') ?? coach?.st.config.profile ?? 'profiles/real-v1.json';
      const robot = listRobots().find((r) => r.file === profile) ?? null;
      let envelope: string | null = null;
      try {
        envelope = inspectRobot(loadProfile(join(ROOT, profile))).envelope.quality;
      } catch {
        envelope = null;
      }
      const pb = playbook?.profile === profile ? playbook : !playbook?.status.running ? book(profile) : null;
      const run = listV2().find((r) => r.profile === profile) ?? null;
      return json(res, 200, {
        profile,
        robot: robot ? { ok: robot.ok, problems: robot.problems, build: robot.build } : null,
        envelope,
        service: existsSync(join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)),
        notify: notifySettings().enabled,
        run: run ? { champion: run.champion, exam: run.exam } : null,
        playbook: pb ? { entries: pb.entries().length } : null,
        teamplays: (() => {
          try {
            return team?.profile === profile || !team?.status.running ? teamFor(profile).entries().length : null;
          } catch {
            return null;
          }
        })(),
      });
    }

    // the Robot page
    if (p === '/api/robots' && !post) return json(res, 200, { robots: listRobots(), replays: replayRobots() });
    if (p === '/api/robots/profile' && !post) {
      const f = url.searchParams.get('file') ?? '';
      if (!/^profiles\/[A-Za-z0-9_.-]+\.json$/.test(f) || !existsSync(join(ROOT, f))) throw new HttpError(404, 'no such robot');
      return json(res, 200, loadProfile(join(ROOT, f)));
    }
    if (p === '/api/robots/inspect' && post) {
      const b = await body(req);
      try {
        return json(res, 200, inspectRobot(b.profile as ProfileFile));
      } catch (err) {
        throw bad(err);
      }
    }
    if (p === '/api/robots/import' && post) {
      const b = await body(req);
      try {
        const cands = typeof b.text === 'string' ? specsIn(b.text) : replayRobots();
        const pick = Number(b.pick ?? -1);
        if (pick < 0) return json(res, 200, { candidates: cands.map((c) => c.label) });
        const c = cands[pick];
        if (!c) throw new Error('no such robot in it');
        const tpl = loadProfile(join(ROOT, typeof b.template === 'string' && /^profiles\/[A-Za-z0-9_.-]+\.json$/.test(b.template) ? b.template : 'profiles/real-v1.json'));
        return json(res, 200, { profile: draftFrom(c.spec, tpl) });
      } catch (err) {
        throw bad(err);
      }
    }
    if (p === '/api/robots/save' && post) {
      const b = await body(req);
      const prof = b.profile as ProfileFile;
      const training = [coach?.running ? coach.st.config.profile : null, engine?.running ? engine.config.profile : null].filter(Boolean);
      try {
        if (training.includes(fileFor(String(prof?.id ?? '')))) throw new Error('that robot is training — pause it before changing its profile');
        const f = saveRobot(prof, !!b.overwrite);
        send('robots', {});
        return json(res, 200, { file: f });
      } catch (err) {
        throw bad(err);
      }
    }
    if (p === '/api/robots/measure' && post) {
      const b = await body(req);
      if (coach?.running || engine?.running || playbook?.status.running) throw new HttpError(409, 'measuring needs every core — pause training and the playbook first');
      if (measuring) throw new HttpError(409, 'already measuring an envelope');
      let spec;
      try {
        spec = resolveProfile(b.profile as ProfileFile).spec;
      } catch (err) {
        throw bad(err);
      }
      measuring = true;
      let told = 0;
      const tell = (x: object): void => send('measure', x);
      tell({ running: true, build: spec.name ?? 'the robot', done: 0, total: 1 });
      ensureEnvelopes([spec], (l) => say(`envelope: ${l}`), 12, (e) => {
        if (Date.now() - told < 250 && e.done < e.total) return;
        told = Date.now();
        tell({ running: true, ...e });
      })
        .then(() => send('robots', { measured: true }))
        .catch((err: Error) => say(`envelope measurement failed: ${err.message}`))
        .finally(() => {
          measuring = false;
          tell({ running: false });
        });
      return json(res, 200, { ok: true });
    }

    // team plays: the book, a search, watching a play
    if (p === '/api/teamplays' && !post) {
      const profile = url.searchParams.get('profile') ?? coach?.st.config.profile ?? 'profiles/real-v1.json';
      const t = teamFor(profile);
      const library = PLAYS.map((q) => ({ id: q.id, label: q.label, blurb: q.blurb, solo: SOLO_PLAYS.includes(q.id), words: playWords(q) }));
      return json(res, 200, { profile, status: t.status, entries: t.entries(), library });
    }
    if (p === '/api/teamplays/build' && post) {
      const b = await body(req);
      if (engine?.running || coach?.running) throw new HttpError(409, 'training is running — the play search needs every core; pause it first');
      if (playbook?.status.running) throw new HttpError(409, 'the AUTO playbook is being built — one search at a time');
      const t = teamFor(String(b.profile ?? 'profiles/real-v1.json'));
      if (t.status.running) throw new HttpError(409, 'already searching');
      const partners = Array.isArray(b.partners) && b.partners.length ? (b.partners as (PartnerKindT | 'none')[]) : undefined;
      t.build({ partners, budget: b.budget === 'quick' ? 'quick' : 'full', redo: !!b.redo, genome: championOf(t.profile) }).catch((err: Error) => say(`team-play search failed: ${err.message}`));
      return json(res, 200, { ok: true });
    }
    if (p === '/api/teamplays/stop' && post) {
      team?.stop();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/teamplays/watch' && post) {
      const b = await body(req);
      const profile = String(b.profile ?? 'profiles/real-v1.json');
      const partner = String(b.partner ?? 'real');
      const play = (typeof b.play === 'string' ? PLAYS.find((q) => q.id === b.play) : (b.play as Play)) ?? null;
      if (!play || !Array.isArray(play.roles)) throw new HttpError(400, 'no such play');
      if (!/^profiles\/[A-Za-z0-9_.-]+\.json$/.test(profile) || !existsSync(join(ROOT, profile))) throw new HttpError(400, 'unknown profile');
      const genome = championOf(profile);
      const args = { genome, profile, sampleProfile: false, seed: Number(b.seed ?? 4242) >>> 0, stage: 'full', driver: 'oracle', track: false, record: false, frames: true, routes: true, play, ...(partner !== 'none' ? { partner: { kind: partner, genome: partner === 'real' ? genome : null } } : {}) };
      const r = await simulate<{ frames: unknown; events: unknown; reward: number }>(args, b.rid, `the play ${play.label ?? play.id}`);
      return json(res, 200, { frames: r.frames, events: r.events, reward: r.reward });
    }

    // the route library (the champion's exam matches, cycle by cycle)
    if (p === '/api/routes' && !post) {
      const profile = url.searchParams.get('profile') ?? coach?.st.config.profile ?? listV2()[0]?.profile ?? 'profiles/real-v1.json';
      const has = coach?.st.config.profile === profile || (!coach?.running && listV2().some((r) => r.profile === profile));
      return json(res, 200, { profile, library: has ? coachFor(profile).routes() : null });
    }
    if (p === '/api/routes/watch' && post) {
      const b = await body(req);
      const c = coachFor(String(b.profile ?? coach?.st.config.profile ?? 'profiles/real-v1.json'));
      let args;
      try {
        args = c.watchArgs(Number(b.match));
      } catch (err) {
        throw bad(err);
      }
      const r = await simulate<{ frames: unknown; events: unknown }>(args, b.rid, `exam match ${Number(b.match) + 1}`);
      return json(res, 200, { frames: r.frames, events: r.events });
    }

    // the mistake audit (the champion's exam matches; judgement mistakes from its thinking-ahead exam)
    if (p === '/api/mistakes' && !post) {
      const profile = url.searchParams.get('profile') ?? coach?.st.config.profile ?? listV2()[0]?.profile ?? 'profiles/real-v1.json';
      const has = coach?.st.config.profile === profile || (!coach?.running && listV2().some((r) => r.profile === profile));
      if (!has) return json(res, 200, { profile, audit: null, history: [], drills: null });
      const c = coachFor(profile);
      return json(res, 200, { profile, audit: c.audit(), history: c.st.audits, drills: c.status().drills });
    }
    if (p === '/api/mistakes/watch' && post) {
      const b = await body(req);
      const c = coachFor(String(b.profile ?? coach?.st.config.profile ?? 'profiles/real-v1.json'));
      let m;
      try {
        m = c.mistakeArgs(Number(b.i));
      } catch (err) {
        throw bad(err);
      }
      const r = await simulate<{ frames: unknown; events: unknown }>(m.args, b.rid, 'the exam match of that mistake');
      return json(res, 200, { frames: r.frames, events: r.events, tick: m.tick });
    }

    // runs
    if (p === '/api/runs' && !post) return json(res, 200, listRuns());
    if (p === '/api/runs' && post) {
      const b = await body(req);
      if (engine?.running) throw new HttpError(409, `"${engine.name}" is training — stop it before creating another run`);
      let cfg: RunConfig = { ...defaultConfig(String(b.name ?? '')) };
      if (typeof b.preset === 'string' && b.preset) {
        const pr = PRESETS.find((q) => q.id === b.preset);
        if (!pr) throw new HttpError(400, 'unknown preset');
        cfg = { ...cfg, ...pr.change, preset: pr.id };
      }
      for (const k of ['seed', 'workers', 'collect'] as const) if (b[k] !== undefined && b[k] !== '' && b[k] !== null) cfg[k] = Number(b[k]);
      if (b.driver === 'human' || b.driver === 'oracle') cfg.driver = b.driver;
      if (typeof b.profile === 'string') {
        if (!/^profiles\/[A-Za-z0-9_.-]+\.json$/.test(b.profile) || !existsSync(join(ROOT, b.profile))) throw new HttpError(400, 'unknown profile');
        cfg.profile = b.profile;
      }
      if (typeof b.sampleProfile === 'boolean') cfg.sampleProfile = b.sampleProfile;
      const err = (NAME_RE.test(cfg.name) ? null : 'run names use letters, digits, - and _ (up to 48)') ?? checkRun(cfg);
      if (err) throw new HttpError(400, err);
      // the replays are fitted in a worker first, so the studio stays responsive
      if ((currentKey() && (!hasSet(currentKey()) || imitationReport()?.dataKey !== currentKey())) || !greedyReport() || !valueReport()) await refresh(false);
      say(`creating run "${cfg.name}"…`);
      let e: Engine;
      try {
        e = Engine.create(cfg, say);
      } catch (err) {
        throw bad(err);
      }
      engine?.removeAllListeners();
      engine = e;
      wire(e);
      writeFileSync(LAST, e.name);
      send('reset', state());
      return json(res, 200, { ok: true, name: e.name });
    }
    if (p === '/api/runs/open' && post) {
      const b = await body(req);
      try {
        open(String(b.name ?? ''));
      } catch (err) {
        throw err instanceof HttpError ? err : new HttpError(404, (err as Error).message);
      }
      return json(res, 200, { ok: true });
    }
    if (p === '/api/runs/delete' && post) {
      const b = await body(req);
      const name = String(b.name ?? '');
      if (b.confirm !== name) throw new HttpError(400, 'type the run name to confirm');
      if (engine?.name === name) {
        if (engine.running) throw new HttpError(409, 'stop training before deleting this run');
        engine.removeAllListeners();
        engine = null;
      }
      try {
        deleteRun(name);
      } catch (err) {
        throw bad(err);
      }
      send('reset', state());
      return json(res, 200, { ok: true });
    }
    if (p === '/api/runs/rename' && post) {
      const b = await body(req);
      const from = String(b.name ?? '');
      const to = String(b.to ?? '');
      const wasOpen = engine?.name === from;
      if (wasOpen && engine!.running) throw new HttpError(409, 'stop training before renaming this run');
      if (wasOpen) {
        engine!.removeAllListeners();
        engine = null;
      }
      try {
        renameRun(from, to);
      } catch (err) {
        if (wasOpen) open(from);
        throw bad(err);
      }
      if (wasOpen) open(to);
      else send('reset', state());
      return json(res, 200, { ok: true, name: to });
    }
    if (p === '/api/runs/duplicate' && post) {
      const b = await body(req);
      const from = String(b.name ?? '');
      const to = String(b.to ?? '');
      try {
        if (engine?.name === from) engine.fork('now', to);
        else {
          if (!NAME_RE.test(to)) throw new Error('run names use letters, digits, - and _ (up to 48)');
          if (existsSync(join(RUNS, to))) throw new Error(`run "${to}" already exists`);
          if (!NAME_RE.test(from) || !existsSync(join(RUNS, from, 'checkpoint.json'))) throw new Error(`no run called "${from}"`);
          const tmp = `_copy-${Date.now().toString(36)}`;
          cpSync(join(RUNS, from), join(RUNS, tmp), { recursive: true });
          renameRun(tmp, to);
        }
      } catch (err) {
        throw bad(err);
      }
      send('runs', listRuns());
      return json(res, 200, { ok: true, name: to });
    }
    if (p === '/api/profiles') return json(res, 200, readdirSync(join(ROOT, 'profiles')).filter((f) => f.endsWith('.json')).map((f) => `profiles/${f}`));

    // training data
    if (p === '/api/data' && !post) return json(res, 200, data());
    if (p === '/api/data/refresh' && post) {
      if (!refreshing) void refresh(true);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/data/include' && post) {
      const b = await body(req);
      const name = String(b.name ?? '');
      if (!dataFiles().some((f) => f.name === name)) throw new HttpError(404, 'no such replay');
      const ex = new Set(excluded());
      if (b.included === false) ex.add(name);
      else ex.delete(name);
      setExcluded([...ex]);
      send('data', data());
      return json(res, 200, { ok: true });
    }
    if (p === '/api/data/upload' && post) {
      const b = await body(req, 8e6);
      const name = String(b.name ?? '').replace(/[^A-Za-z0-9_.-]/g, '_');
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,120}\.json$/.test(name)) throw new HttpError(400, 'the file must be a .json DSIM replay');
      if (existsSync(join(DATA_DIR, name))) throw new HttpError(409, `"${name}" is already in the training data`);
      let rep: { game?: string; mode?: string; setups?: { spec?: unknown }[]; tracks?: unknown };
      try {
        rep = JSON.parse(String(b.content ?? ''));
      } catch {
        throw new HttpError(400, 'that file is not JSON');
      }
      if (rep.game !== 'biobuzz' || rep.mode !== 'match' || !Array.isArray(rep.setups) || rep.setups.length !== 1 || !rep.setups[0]?.spec || typeof rep.tracks !== 'object')
        throw new HttpError(400, 'that is not a solo BIOBUZZ match replay from DSIM (Records → the run → ↓ Data)');
      writeFileSync(join(DATA_DIR, name), String(b.content));
      say(`training data: added ${name} — press Refresh to learn from it`);
      send('data', data());
      return json(res, 200, { ok: true, name });
    }
    if (p === '/api/data/use' && post) {
      try {
        need().useData(currentKey());
      } catch (err) {
        throw bad(err);
      }
      return json(res, 200, { ok: true });
    }

    // presets
    if (p === '/api/presets' && !post) return json(res, 200, PRESETS);
    if (p === '/api/presets/apply' && post) {
      const b = await body(req);
      try {
        return json(res, 200, { ok: true, changed: need().applyPreset(String(b.id ?? '')) });
      } catch (err) {
        throw bad(err);
      }
    }

    // training control
    if (p === '/api/control' && post) {
      const e = need();
      const b = await body(req);
      const a = b.action;
      if (a === 'start' || a === 'step') {
        if (coach?.running) throw new HttpError(409, `${coach.name} is training on the Home page — pause it first (one trainer at a time)`);
        const n = a === 'step' ? Number(b.n ?? 1) : -1;
        if (a === 'step' && !(Number.isInteger(n) && n >= 1 && n <= 10000)) throw new HttpError(400, 'step 1 to 10000 generations');
        try {
          e.start(n);
        } catch (err) {
          throw bad(err);
        }
      } else if (a === 'pause') e.pause();
      else if (a === 'resume') e.resume();
      else if (a === 'stop') e.stop();
      else if (a === 'abort') e.abort();
      else throw new HttpError(400, 'action must be start | step | pause | resume | stop | abort');
      return json(res, 200, { ok: true, status: status() });
    }

    // checkpoints
    if (p === '/api/checkpoints' && !post) return json(res, 200, need().listCheckpoints());
    if (p === '/api/checkpoints' && post) {
      const b = await body(req);
      const m = need().checkpoint(String(b.label ?? '').trim() || `gen ${need().gen}`);
      return json(res, 200, { ok: true, saved: m, deferred: !m });
    }
    if (p === '/api/checkpoints/delete-many' && post) {
      const b = await body(req);
      if (b.which !== 'auto' && b.which !== 'unpinned') throw new HttpError(400, 'which must be auto or unpinned');
      return json(res, 200, { ok: true, deleted: need().deleteCheckpoints(b.which) });
    }
    const ck = p.match(/^\/api\/checkpoints\/([a-z0-9-]+)\/(rewind|fork|pin|delete|rename)$/);
    if (ck && post) {
      const e = need();
      const b = await body(req);
      try {
        if (ck[2] === 'rewind') return json(res, 200, { ok: true, meta: await e.rewind(ck[1]) });
        if (ck[2] === 'pin') {
          e.pinCheckpoint(ck[1], b.pinned !== false);
          return json(res, 200, { ok: true });
        }
        if (ck[2] === 'rename') {
          e.renameCheckpoint(ck[1], String(b.label ?? ''));
          return json(res, 200, { ok: true });
        }
        if (ck[2] === 'delete') {
          e.deleteCheckpoint(ck[1]);
          return json(res, 200, { ok: true });
        }
        const name = e.fork(ck[1] === 'now' ? 'now' : ck[1], String(b.name ?? ''), (b.overrides ?? {}) as Partial<RunConfig>);
        send('runs', listRuns());
        if (b.open) open(name);
        return json(res, 200, { ok: true, name });
      } catch (err) {
        throw bad(err);
      }
    }

    // settings
    if (p === '/api/config' && !post) return json(res, 200, need().config);
    if (p === '/api/config' && post) {
      try {
        return json(res, 200, { ok: true, changed: need().setConfig((await body(req)) as Partial<RunConfig>) });
      } catch (err) {
        throw bad(err);
      }
    }

    // evaluation
    if (p === '/api/evals') return json(res, 200, need().evals());
    if (p === '/api/eval' && post) {
      const e = need();
      const b = await body(req);
      e.evaluate(String(b.target ?? 'champion'), Number(b.n ?? 32)).catch(() => {}); // result arrives on the stream
      return json(res, 200, { ok: true, queued: true });
    }

    // generations and frames
    if (p === '/api/gens') {
      const d = join(need().dir, 'gens');
      const gens = existsSync(d) ? readdirSync(d).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.split('.')[0])).sort((a, b) => a - b) : [];
      return json(res, 200, gens);
    }
    const g = p.match(/^\/api\/gen\/(\d+)(\/frames)?$/);
    if (g) {
      const f = join(need().dir, 'gens', g[2] ? `${g[1]}.frames.json.gz` : `${g[1]}.json`);
      if (!existsSync(f)) throw new HttpError(404, `generation ${g[1]} is not on disk (the last ${need().config.keepGens} and every 100th are kept)`);
      return g[2] ? file(res, f, 'application/json', true) : file(res, f);
    }
    if (p === '/api/best/frames') {
      const f = join(need().dir, 'best.frames.json.gz');
      if (!existsSync(f)) throw new HttpError(404, 'no champion yet');
      return file(res, f, 'application/json', true);
    }
    if (p === '/api/best' || p === '/api/best.inject.js') {
      const f = join(need().dir, p === '/api/best' ? 'best.replay.json' : 'best.inject.js');
      if (!existsSync(f)) throw new HttpError(404, 'no champion yet');
      return file(res, f);
    }

    // exports
    if (p === '/api/exams') return json(res, 200, need().exams());
    if (p === '/api/export/metrics.csv') {
      const h = need().history();
      const rows: (string | number)[][] = [['gen', 'hours', 'meanScore', 'meanReward', 'meanTips', 'lessons', 'regret', 'fitRegret', 'fitStartRegret', 'valueRmse', 'champId', 'champOp', 'champScore', 'champCi', 'newChamp', 'exam', 'examVsBase', 'examSearch', 'wallS', 'matchesPerMin']];
      for (const q of h) rows.push([q.gen, q.hours.toFixed(3), q.meanScore.toFixed(1), q.meanReward.toFixed(1), q.meanTips.toFixed(2), q.lessons, q.regret.toFixed(2), q.fit?.regret.toFixed(2) ?? '', q.fit?.startRegret.toFixed(2) ?? '', q.value?.rmse.toFixed(1) ?? '', q.champId, q.champOp, q.champScore.toFixed(1), q.champCi.toFixed(1), q.newChamp ? 1 : 0, q.exam?.net.mean.toFixed(1) ?? '', q.exam?.vsBase.mean.toFixed(1) ?? '', q.exam?.search?.mean.toFixed(1) ?? '', q.wallS.toFixed(0), q.matchesPerMin.toFixed(1)]);
      res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${need().name}-metrics.csv"` });
      return void res.end(rows.map((r) => r.join(',')).join('\n'));
    }
    if (p === '/api/export/champion.json') {
      const e = need();
      const c = e.champion;
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${e.name}-champion.json"` });
      return void res.end(JSON.stringify({ run: e.name, champion: c.id, made: c.lineage.op, born: c.born, exam: c.exam, net: 'train/policy.ts SHAPE (+ STYLE skill genes)', genome: c.genome, config: e.config }, null, 1));
    }

    // static viewer (path traversal refused)
    const rel = normalize(p === '/' ? '/index.html' : p).replace(/^(\.\.[/\\])+/, '');
    const f = join(PUBLIC, rel);
    if (f.startsWith(PUBLIC) && existsSync(f) && statSync(f).isFile()) return file(res, f);
    throw new HttpError(404, 'not found');
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.end();
      json(res, e instanceof HttpError ? e.code : 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });
  server.listen(port, '127.0.0.1');
  // the last run you had open comes back
  if (!engine && existsSync(LAST)) {
    try {
      const e = open(readFileSync(LAST, 'utf8').trim());
      // it was training when the studio closed (quit, crash, the Mac restarting): carry on
      if (e.wasTraining) {
        try {
          e.start();
          e.event('training resumed by itself — it was running when the studio closed');
        } catch (err) {
          e.event(`training could not resume by itself: ${(err as Error).message}`);
        }
      }
    } catch {
      /* it was deleted or is an old version: start with none open */
    }
  }
  // the continuous engine was training when the studio closed (a crash, the Mac restarting): carry on
  if (!first && !opts.noResume && !engine?.running) {
    const was = listV2().find((r) => r.running);
    if (was) {
      try {
        const c = coachFor(was.profile);
        c.start();
        say(`training ${c.name} resumed by itself — it was running when the studio closed`);
      } catch (err) {
        say(`training could not resume by itself: ${(err as Error).message}`);
      }
    }
  }
  return {
    url: `http://localhost:${port}`,
    engine: () => engine,
    open,
    close: async () => {
      if (watchIdle) clearTimeout(watchIdle);
      watchPool?.close();
      coach?.close();
      team?.stop();
      playbook?.stop();
      await engine?.halt(true, true); // closing the studio is not stopping training: it resumes next start
      await refreshing;
      for (const s of streams) s.end();
      server.close();
    },
  };
}
