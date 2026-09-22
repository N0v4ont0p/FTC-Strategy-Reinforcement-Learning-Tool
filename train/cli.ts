// `npm run train` — the training launcher and live terminal dashboard. Independent of Claude.
//   npm run train -- --name solo --algo es --pop 256          (resumes if the run exists)
//   npm run train -- --name solo2 --fresh                     (refuses to touch an existing run)
// Keys: [p] pause/resume  [o] open the viewer  [q] stop after this generation (checkpointed)
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { Engine, ROOT, defaultConfig, type GenSummary, type RunConfig } from './engine';
import { startServer } from './server';
import type { AlgoName } from './algos';

// ---------- args ----------
const argv = process.argv.slice(2);
const arg = (k: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const flag = (k: string): boolean => argv.includes(`--${k}`);
if (flag('help')) {
  console.log(`npm run train -- [--name solo] [--algo es|ga] [--pop 256] [--workers 8] [--stage curriculum|auto|full]
                 [--driver human|oracle] [--profile profiles/real-v0.json] [--fixed-robot] [--seed 1]
                 [--port 4747] [--max-gens 0] [--fresh] [--no-open] [--plain]`);
  process.exit(0);
}
const name = arg('name', 'solo')!;
const algo = (arg('algo', 'es') as AlgoName) ?? 'es';
if (algo !== 'es' && algo !== 'ga') throw new Error('--algo must be es or ga');
const runDir = join(ROOT, 'runs', name);
const exists = existsSync(join(runDir, 'checkpoint.json'));
if (flag('fresh') && exists) {
  console.error(`run "${name}" already exists at ${runDir}. Pick another --name (runs are never overwritten).`);
  process.exit(1);
}
const cfg: RunConfig = { ...defaultConfig(name, algo) };
if (arg('pop')) cfg.pop = Number(arg('pop'));
if (arg('workers')) cfg.workers = Number(arg('workers'));
if (arg('seed')) cfg.seed = Number(arg('seed'));
if (arg('stage')) cfg.stage = arg('stage') as RunConfig['stage'];
if (arg('driver')) cfg.driver = arg('driver') as RunConfig['driver'];
if (arg('profile')) cfg.profile = arg('profile')!;
if (flag('fixed-robot')) cfg.sampleProfile = false;
cfg.maxGens = Number(arg('max-gens', '0'));
const port = Number(arg('port', '4747'));

// the viewer's build output is not committed: build it on first use (DSIM's own Vite, no download)
if (!existsSync(join(ROOT, 'train/public/index.html'))) {
  console.log('building the viewer (first run only)…');
  execFileSync(join(ROOT, 'dsim-main/node_modules/.bin/vite'), ['build', join(ROOT, 'viewer'), '--config', join(ROOT, 'viewer/vite.config.ts'), '--logLevel', 'error'], { stdio: 'inherit' });
}

const engine = new Engine(cfg, true);
// a resumed run keeps the settings it was created with — never silently ignore a flag that asks
// for something else
if (exists) {
  const fixed: [string, unknown, unknown][] = [
    ['algo', arg('algo') && cfg.algo, engine.config.algo],
    ['pop', arg('pop') && cfg.pop, engine.config.pop],
    ['seed', arg('seed') && cfg.seed, engine.config.seed],
    ['stage', arg('stage') && cfg.stage, engine.config.stage],
    ['driver', arg('driver') && cfg.driver, engine.config.driver],
    ['profile', arg('profile') && cfg.profile, engine.config.profile],
    ['fixed-robot', flag('fixed-robot') && !cfg.sampleProfile, !engine.config.sampleProfile],
  ];
  const clash = fixed.filter(([, want, have]) => want !== undefined && want !== false && want !== '' && want !== 0 && want !== have);
  if (clash.length) {
    console.error(`run "${name}" already exists and keeps its own settings: ${clash.map(([k, want, have]) => `--${k} ${String(want)} (run has ${String(have)})`).join(', ')}.\nStart a separate run instead: npm run train -- --name ${name}-2 --fresh ...`);
    process.exit(1);
  }
}
const server = startServer(engine, port);
const plain = flag('plain') || !process.stdout.isTTY;

// ---------- live state ----------
let progress = { done: 0, total: 0 };
const hist: GenSummary[] = engine.history();
const log: string[] = [];
const say = (s: string): void => {
  log.push(`${new Date().toLocaleTimeString()}  ${s}`);
  if (log.length > 6) log.shift();
  if (plain) console.log(s);
};
engine.on('progress', (p) => (progress = p));
engine.on('generation', (g: GenSummary) => {
  hist.push(g);
  if (plain)
    console.log(`gen ${g.gen} [${g.stage}] best ${g.best.toFixed(1)} mean ${g.mean.toFixed(1)} score ${g.bestScore} · deaths crash ${g.deaths.crash} stall ${g.deaths.stall} survived ${g.deaths.survived} · ${g.robotsPerMin.toFixed(0)} robots/min`);
});
engine.on('best', (b) => say(`NEW CHAMPION — fitness ${b.fitness.toFixed(1)}, score ${b.score}, generation ${b.gen}`));
engine.on('log', (s: string) => say(s));
say(exists ? `resumed "${name}" at generation ${engine.gen}` : `new run "${name}" (${cfg.algo.toUpperCase()}, population ${cfg.pop})`);
say(`viewer: ${server.url}`);

// ---------- dashboard ----------
const E = '\x1b[';
const c = (n: number, s: string): string => `${E}38;5;${n}m${s}${E}0m`;
const b = (s: string): string => `${E}1m${s}${E}0m`;
const AMBER = 214;
const GOLD = 220;
const TEAL = 44;
const DIM = 244;
const RED = 203;
const GREEN = 114;
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
const SPARK = '▁▂▃▄▅▆▇█';
function spark(v: number[], width: number): string {
  const s = v.slice(-width);
  if (!s.length) return '';
  const lo = Math.min(...s);
  const hi = Math.max(...s);
  return s.map((x) => SPARK[hi > lo ? Math.min(7, Math.floor(((x - lo) / (hi - lo)) * 7.999)) : 3]).join('');
}
function bar(frac: number, width: number): string {
  const n = Math.round(frac * width);
  return c(AMBER, '█'.repeat(n)) + c(238, '░'.repeat(width - n));
}
function hms(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
function draw(): void {
  if (plain) return;
  const W = Math.max(72, Math.min(110, process.stdout.columns ?? 100));
  const T = engine.totals;
  const died = T.deaths.crash + T.deaths.stall;
  const last = hist[hist.length - 1];
  const be = engine.bestEver;
  const status = engine.paused ? c(GOLD, '❚❚ PAUSED') : engine.running ? c(GREEN, '● TRAINING') : c(DIM, '■ STOPPED');
  const L: string[] = [];
  const rule = (label = ''): string => c(DIM, `── ${label}${'─'.repeat(Math.max(0, W - label.length - 4))}`);
  L.push('');
  L.push(`  ${b(c(AMBER, 'BIOBUZZ  EVOLUTION'))}   ${status}   ${c(DIM, `run`)} ${b(name)}  ${c(DIM, '·')} ${engine.config.algo.toUpperCase()} ${c(DIM, '·')} pop ${engine.config.pop} ${c(DIM, '·')} ${engine.config.sampleProfile ? 'robot sampled per life' : 'fixed robot'} ${c(DIM, '·')} ${engine.config.driver} driver`);
  L.push('');
  L.push(`  ${c(DIM, 'GENERATION')} ${b(c(GOLD, String(engine.gen).padStart(6)))}     ${c(DIM, 'STAGE')} ${b(engine.stage === 'auto' ? c(TEAL, 'AUTO only (30 s)') : c(GREEN, 'FULL MATCH'))}     ${c(DIM, 'SHAPING')} ${(100 * Math.max(0, 1 - engine.gen / engine.config.annealGens)).toFixed(0)}%`);
  L.push('');
  L.push(`  ${c(DIM, 'ROBOTS SPAWNED')} ${b(fmt(T.spawned).padStart(12))}   ${c(DIM, 'DIED')} ${b(c(RED, fmt(died).padStart(10)))}  ${c(DIM, `(crash ${fmt(T.deaths.crash)} · stall ${fmt(T.deaths.stall)})`)}   ${c(DIM, 'SURVIVED')} ${b(c(GREEN, fmt(T.deaths.survived)))}`);
  L.push(`  ${c(DIM, 'SIMULATED')} ${hms(T.simSeconds)} of matches in ${hms(T.wallSeconds)} of wall time${last ? `   ${c(DIM, '·')}  ${fmt(last.robotsPerMin)} robots/min` : ''}`);
  L.push('');
  const frac = progress.total ? progress.done / progress.total : 0;
  L.push(`  ${c(DIM, 'THIS GENERATION')}  ${bar(frac, W - 40)}  ${fmt(progress.done)}/${fmt(progress.total)} lives`);
  L.push('');
  L.push(rule('FITNESS'));
  const sw = W - 30;
  L.push(`  ${c(DIM, 'best  ')} ${c(GOLD, spark(hist.map((h) => h.best), sw))}  ${last ? b(last.best.toFixed(1)) : '—'}`);
  L.push(`  ${c(DIM, 'mean  ')} ${c(TEAL, spark(hist.map((h) => h.mean), sw))}  ${last ? last.mean.toFixed(1) : '—'}`);
  L.push(`  ${c(DIM, 'score ')} ${c(GREEN, spark(hist.map((h) => h.bestScore), sw))}  ${last ? `${last.bestScore} pts` : '—'}`);
  L.push(`  ${c(DIM, 'life  ')} ${c(AMBER, spark(hist.map((h) => h.meanLifeS), sw))}  ${last ? `${last.meanLifeS.toFixed(1)} s avg` : '—'}`);
  L.push('');
  L.push(rule('CHAMPION'));
  if (be) {
    const p = be.parts;
    L.push(`  ${b(c(GOLD, `fitness ${be.fitness.toFixed(1)}`))}  ${c(DIM, '·')}  DSIM score ${b(String(be.score))}  ${c(DIM, '·')}  born generation ${be.gen}`);
    L.push(`  ${c(DIM, `pickups ${p.pickups} · shots in ${p.shotsIn} · tips ${p.tips} · human-player ${p.hp} · wasted shots ${p.wasted} · violations ${p.violations}`)}`);
  } else L.push(`  ${c(DIM, 'none yet — the first generation is being born')}`);
  L.push('');
  L.push(rule('LOG'));
  for (const l of log) L.push(`  ${c(DIM, l)}`);
  L.push('');
  L.push(`  ${c(AMBER, 'viewer')} ${b(server.url)}   ${c(DIM, '[p] pause/resume   [o] open viewer   [q] stop + checkpoint')}`);
  process.stdout.write(`${E}H${E}2J` + L.join('\n') + '\n');
}

// ---------- terminal lifecycle ----------
let stopping = false;
function quit(): void {
  if (stopping) {
    restore();
    process.exit(130); // second press: leave now (the last completed generation is checkpointed)
  }
  stopping = true;
  engine.stop();
}
function restore(): void {
  if (!plain) process.stdout.write(`${E}?25h${E}?1049l`);
}
if (!plain) {
  process.stdout.write(`${E}?1049h${E}?25l`);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (d) => {
      const k = d.toString();
      if (k === 'q' || k === '') quit();
      else if (k === 'p') {
        engine.paused = !engine.paused;
        say(engine.paused ? 'paused (between generations)' : 'resumed');
      } else if (k === 'o') spawn('open', [server.url], { stdio: 'ignore', detached: true }).unref();
    });
  }
}
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
const timer = setInterval(draw, 250);
if (!flag('no-open') && !plain) spawn('open', [server.url], { stdio: 'ignore', detached: true }).unref();

await engine.run();
clearInterval(timer);
draw();
restore();
server.close();
console.log(`\nstopped at generation ${engine.gen}; checkpoint saved in ${runDir}. Resume with: npm run train -- --name ${name}`);
process.exit(0);
