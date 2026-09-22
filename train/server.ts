// LOCAL SERVER for the viewer: static files + JSON API + a Server-Sent Events stream. Node stdlib
// only (no new dependency). Binds to 127.0.0.1 — this machine only.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createBiobuzzWorldForViewer } from './field';
import { ROOT, type Engine } from './engine';

const PUBLIC = join(ROOT, 'train', 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function startServer(engine: Engine, port: number): { url: string; close: () => void; clients: () => number } {
  const streams = new Set<ServerResponse>();
  const send = (type: string, data: unknown): void => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of streams) s.write(msg);
  };
  engine.on('progress', (p) => send('progress', p));
  engine.on('generation', (g) => send('generation', g));
  engine.on('best', (b) => send('best', { fitness: b.fitness, score: b.score, gen: b.gen, parts: b.parts }));
  engine.on('log', (l) => send('log', l));
  engine.on('stopped', () => send('state', state()));

  function state() {
    const b = engine.bestEver;
    return {
      config: engine.config,
      gen: engine.gen,
      stage: engine.stage,
      totals: engine.totals,
      running: engine.running,
      paused: engine.paused,
      bestEver: b ? { fitness: b.fitness, score: b.score, gen: b.gen, parts: b.parts } : null,
      history: engine.history(),
    };
  }
  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const file = (res: ServerResponse, p: string): void => {
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(p));
  };
  let field: unknown = null;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    try {
      if (p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }
      if (p === '/api/state') return json(res, 200, state());
      if (p === '/api/field') return json(res, 200, (field ??= createBiobuzzWorldForViewer(engine.config.profile)));
      if (p === '/api/gens') {
        const d = join(engine.dir, 'gens');
        const gens = existsSync(d) ? readdirSync(d).map((f) => Number(f.replace('.json', ''))).filter(Number.isFinite).sort((a, b) => a - b) : [];
        return json(res, 200, gens);
      }
      const g = p.match(/^\/api\/gen\/(\d+)$/);
      if (g) {
        const f = join(engine.dir, 'gens', `${g[1]}.json`);
        return existsSync(f) ? file(res, f) : json(res, 404, { error: 'no such generation on disk' });
      }
      if (p === '/api/best') {
        const f = join(engine.dir, 'best.replay.json');
        return existsSync(f) ? file(res, f) : json(res, 404, { error: 'no champion yet' });
      }
      if (p === '/api/best.inject.js') {
        const f = join(engine.dir, 'best.inject.js');
        return existsSync(f) ? file(res, f) : json(res, 404, { error: 'no champion yet' });
      }
      if (p === '/api/control' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const { action } = JSON.parse(body || '{}') as { action?: string };
          if (action === 'pause') engine.paused = true;
          else if (action === 'resume') engine.paused = false;
          else if (action === 'stop') engine.stop();
          else return json(res, 400, { error: 'action must be pause | resume | stop' });
          send('state', state());
          json(res, 200, { ok: true, paused: engine.paused });
        });
        return;
      }
      // static viewer (path traversal refused)
      const rel = normalize(p === '/' ? '/index.html' : p).replace(/^(\.\.[/\\])+/, '');
      const f = join(PUBLIC, rel);
      if (f.startsWith(PUBLIC) && existsSync(f) && statSync(f).isFile()) return file(res, f);
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 500, { error: String(e) });
    }
  });
  server.listen(port, '127.0.0.1');
  return {
    url: `http://localhost:${port}`,
    close: () => {
      for (const s of streams) s.end();
      server.close();
    },
    clients: () => streams.size,
  };
}
