// THE STUDIO SERVER — static viewer + JSON API + a Server-Sent Events stream, Node stdlib only,
// bound to 127.0.0.1 (this machine only). It manages runs: one is open at a time; training starts
// only when asked (from the viewer or `npm run train`).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createBiobuzzWorldForViewer } from './field';
import { Engine, RUNS, ROOT, defaultConfig, deleteRun, listRuns, type RunConfig } from './engine';
import { imitationReport } from './imitate';
import type { AlgoName } from './algos';

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

export function startServer(port: number, first?: Engine): Studio {
  let engine: Engine | null = first ?? null;
  const streams = new Set<ServerResponse>();
  const send = (type: string, data: unknown): void => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of streams) s.write(msg);
  };
  const say = (text: string): void => send('log', text);

  const wire = (e: Engine): void => {
    e.on('progress', (p) => send('progress', p));
    e.on('generation', (g) => send('generation', g));
    e.on('best', (b) => send('best', { fitness: b.fitness, score: b.score, gen: b.gen, parts: b.parts, id: b.id }));
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
    return e ? { running: e.running, paused: e.paused, phase: e.phase, gen: e.gen, stage: e.stage, config: e.config } : null;
  }
  function state() {
    const e = engine;
    const imit = imitationReport();
    const reference = imit ? { files: imit.files.map((f) => ({ name: f.name, score: f.score })), holdoutAgree: imit.holdout.agree, chance: imit.holdout.chance } : null;
    if (!e) return { run: null, runs: listRuns(), reference, defaults: defaultConfig('new-run') };
    const b = e.bestEver;
    return {
      run: {
        name: e.name,
        config: e.config,
        gen: e.gen,
        stage: e.stage,
        totals: e.totals,
        running: e.running,
        paused: e.paused,
        phase: e.phase,
        bestEver: b ? { fitness: b.fitness, score: b.score, gen: b.gen, parts: b.parts, id: b.id } : null,
        history: e.history(),
        events: e.events().slice(-200),
        checkpoints: e.listCheckpoints(),
        evals: e.evals().slice(-50),
      },
      runs: listRuns(),
      reference,
      defaults: defaultConfig('new-run'),
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

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const file = (res: ServerResponse, p: string, type?: string, gz = false): void => {
    res.writeHead(200, { 'content-type': type ?? MIME[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store', ...(gz ? { 'content-encoding': 'gzip' } : {}) });
    res.end(readFileSync(p));
  };
  const body = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      let b = '';
      req.on('data', (c) => {
        b += c;
        if (b.length > 1e6) reject(new HttpError(413, 'request too large'));
      });
      req.on('end', () => {
        try {
          resolve(b ? (JSON.parse(b) as Record<string, unknown>) : {});
        } catch {
          reject(new HttpError(400, 'body must be JSON'));
        }
      });
    });
  let field: unknown = null;

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

    // runs
    if (p === '/api/runs' && !post) return json(res, 200, listRuns());
    if (p === '/api/runs' && post) {
      const b = await body(req);
      if (engine?.running) throw new HttpError(409, `"${engine.name}" is training — stop it before creating another run`);
      const algo = (b.algo === 'es' ? 'es' : 'ga') as AlgoName;
      const cfg: RunConfig = { ...defaultConfig(String(b.name ?? ''), algo) };
      for (const k of ['pop', 'seed', 'workers', 'episodes'] as const) if (b[k] !== undefined) cfg[k] = Number(b[k]);
      if (b.init === 'random' || b.init === 'imitation') cfg.init = b.init;
      if (b.driver === 'human' || b.driver === 'oracle') cfg.driver = b.driver;
      if (b.stage === 'auto' || b.stage === 'full' || b.stage === 'curriculum') cfg.stage = b.stage;
      if (typeof b.profile === 'string') {
        if (!/^profiles\/[A-Za-z0-9_.-]+\.json$/.test(b.profile) || !existsSync(join(ROOT, b.profile))) throw new HttpError(400, 'unknown profile');
        cfg.profile = b.profile;
      }
      if (typeof b.sampleProfile === 'boolean') cfg.sampleProfile = b.sampleProfile;
      say(`creating run "${cfg.name}"${cfg.init === 'imitation' ? ' (fitting your replays if they changed — up to ~20 s)' : ''}…`);
      await new Promise((r) => setImmediate(r)); // let the log line go out first
      let e: Engine;
      try {
        e = Engine.create(cfg, say);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
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
      deleteRun(name);
      send('reset', state());
      return json(res, 200, { ok: true });
    }
    if (p === '/api/profiles') return json(res, 200, readdirSync(join(ROOT, 'profiles')).filter((f) => f.endsWith('.json')).map((f) => `profiles/${f}`));

    // training control
    if (p === '/api/control' && post) {
      const e = need();
      const b = await body(req);
      const a = b.action;
      if (a === 'start') e.start();
      else if (a === 'step') {
        const n = Number(b.n ?? 1);
        if (!(Number.isInteger(n) && n >= 1 && n <= 10000)) throw new HttpError(400, 'step 1 to 10000 generations');
        e.start(n);
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
    const ck = p.match(/^\/api\/checkpoints\/([a-z0-9-]+)\/(rewind|fork|pin|delete)$/);
    if (ck && post) {
      const e = need();
      const b = await body(req);
      try {
        if (ck[2] === 'rewind') return json(res, 200, { ok: true, meta: await e.rewind(ck[1]) });
        if (ck[2] === 'pin') {
          e.pinCheckpoint(ck[1], b.pinned !== false);
          return json(res, 200, { ok: true });
        }
        if (ck[2] === 'delete') {
          e.deleteCheckpoint(ck[1]);
          return json(res, 200, { ok: true });
        }
        const name = e.fork(ck[1] === 'now' ? 'now' : ck[1], String(b.name ?? ''), (b.overrides ?? {}) as Partial<RunConfig>);
        if (b.open) open(name);
        send('runs', listRuns());
        return json(res, 200, { ok: true, name });
      } catch (err) {
        throw err instanceof HttpError ? err : new HttpError(400, (err as Error).message);
      }
    }

    // settings
    if (p === '/api/config' && !post) return json(res, 200, need().config);
    if (p === '/api/config' && post) {
      try {
        return json(res, 200, { ok: true, changed: need().setConfig((await body(req)) as Partial<RunConfig>) });
      } catch (err) {
        throw err instanceof HttpError ? err : new HttpError(400, (err as Error).message);
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
      if (!existsSync(f)) throw new HttpError(404, 'that generation is not on disk (the last 300 and every 100th are kept)');
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
    if (p === '/api/export/metrics.csv') {
      const h = need().history();
      const cols = ['gen', 'stage', 'best', 'mean', 'median', 'p90', 'bestScore', 'meanScore', 'meanTips', 'meanLifeS', 'wallS', 'robotsPerMin', 'bestEver', 'bestEverScore', 'meanMuts', 'bestOp'] as const;
      const rows = h.map((q) => cols.map((c) => String((q as unknown as Record<string, unknown>)[c] ?? '')).join(','));
      res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${need().name}-metrics.csv"` });
      return void res.end([cols.join(','), ...rows].join('\n'));
    }
    if (p === '/api/export/champion.json') {
      const e = need();
      if (!e.bestEver) throw new HttpError(404, 'no champion yet');
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${e.name}-champion.json"` });
      return void res.end(JSON.stringify({ run: e.name, gen: e.bestEver.gen, fitness: e.bestEver.fitness, score: e.bestEver.score, net: 'train/policy.ts SHAPE', genome: e.bestEver.genome, config: e.config }, null, 1));
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
      open(readFileSync(LAST, 'utf8').trim());
    } catch {
      /* it was deleted: start with none open */
    }
  }
  return {
    url: `http://localhost:${port}`,
    engine: () => engine,
    open,
    close: async () => {
      await engine?.halt(true);
      for (const s of streams) s.end();
      server.close();
    },
  };
}
