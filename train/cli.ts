// `npm run train` — train from the terminal with a live dashboard (the studio, ./start.sh, is the
// full UI; this starts training immediately). Independent of Claude.
//   npm run train -- --name solo --preset full-push           (resumes if the run exists)
//   npm run train -- --name solo2 --fresh                     (refuses to touch an existing run)
// Keys: [p] pause/resume  [o] open the studio  [q] stop after this generation (checkpointed)
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { Engine, PRESETS, ROOT, defaultConfig, type GenSummary, type RunConfig } from './engine';
import { init } from '../harness/dsim';
import { startServer } from './server';

// ---------- args ----------
const argv = process.argv.slice(2);
const arg = (k: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const flag = (k: string): boolean => argv.includes(`--${k}`);
if (flag('help')) {
  console.log(`npm run train -- [--name solo] [--preset balanced|full-push|replays|quick|background] [--workers 9]
                 [--collect 20] [--driver oracle|human] [--profile profiles/real-v0.json] [--fixed-robot]
                 [--seed 1] [--port 4747] [--max-gens 0] [--fresh] [--no-open] [--plain]`);
  process.exit(0);
}
const name = arg('name', 'solo')!;
const runDir = join(ROOT, 'runs', name);
const exists = existsSync(join(runDir, 'checkpoint.json'));
if (flag('fresh') && exists) {
  console.error(`run "${name}" already exists at ${runDir}. Pick another --name (runs are never overwritten).`);
  process.exit(1);
}
let cfg: RunConfig = { ...defaultConfig(name) };
const preset = arg('preset');
if (preset) {
  const p = PRESETS.find((q) => q.id === preset);
  if (!p) throw new Error(`--preset must be one of ${PRESETS.map((q) => q.id).join(', ')}`);
  cfg = { ...cfg, ...p.change, preset: p.id };
}
if (arg('workers')) cfg.workers = Number(arg('workers'));
if (arg('collect')) cfg.collect = Number(arg('collect'));
if (arg('seed')) cfg.seed = Number(arg('seed'));
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

await init();
const engine = exists ? Engine.open(name) : Engine.create(cfg, (s) => console.log(s));
if (exists) {
  // a resumed run keeps the settings that define it — never silently ignore a flag asking for others
  const fixed: [string, unknown, unknown][] = [
    ['seed', arg('seed') && cfg.seed, engine.config.seed],
    ['profile', arg('profile') && cfg.profile, engine.config.profile],
    ['fixed-robot', flag('fixed-robot') && !cfg.sampleProfile, !engine.config.sampleProfile],
  ];
  const clash = fixed.filter(([, want, have]) => want !== undefined && want !== false && want !== '' && want !== 0 && want !== have);
  if (clash.length) {
    console.error(`run "${name}" already exists and keeps its own settings: ${clash.map(([k, want, have]) => `--${k} ${String(want)} (run has ${String(have)})`).join(', ')}.\nStart a separate run instead: npm run train -- --name ${name}-2 --fresh ...`);
    process.exit(1);
  }
  const live: Partial<RunConfig> = {};
  if (preset) Object.assign(live, PRESETS.find((q) => q.id === preset)!.change, { preset });
  for (const k of ['workers', 'collect', 'driver'] as const) if (arg(k)) (live as Record<string, unknown>)[k] = cfg[k];
  if (arg('max-gens')) live.maxGens = cfg.maxGens;
  if (Object.keys(live).length) engine.setConfig(live);
}
const server = startServer(port, engine, {
  // the studio's Quit button: discard the generation in progress and leave (training resumes next start)
  onQuit: () =>
    void engine.halt(true, true).then(() => {
      restore();
      process.exit(0);
    }),
});
const plain = flag('plain') || !process.stdout.isTTY;

// ---------- live state ----------
let progress: { done: number; total: number; stage?: string } = { done: 0, total: 0 };
const hist: GenSummary[] = engine.history();
const log: string[] = [];
const say = (s: string): void => {
  log.push(`${new Date().toLocaleTimeString()}  ${s}`);
  if (log.length > 8) log.shift();
  if (plain) console.log(s);
};
engine.on('progress', (p) => (progress = p));
engine.on('generation', (g: GenSummary) => {
  hist.push(g);
  if (plain) console.log(`gen ${g.gen}: champion #${g.champId} ${g.champScore.toFixed(1)} ± ${g.champCi.toFixed(1)} on fresh matches · ${g.lessons} lessons (choices lost ${g.regret.toFixed(1)} pts each) · ${(g.wallS / 60).toFixed(1)} min`);
});
engine.on('log', (s: string) => say(s));
say(exists ? `resumed "${name}" at generation ${engine.gen}` : `new run "${name}"`);
say(`studio: ${server.url}`);

// ---------- dashboard ----------
const E = '\x1b[';
const c = (n: number, s: string): string => `${E}38;5;${n}m${s}${E}0m`;
const b = (s: string): string => `${E}1m${s}${E}0m`;
const AMBER = 214;
const GOLD = 220;
const TEAL = 44;
const DIM = 244;
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
  const ch = engine.champion;
  const ex = ch.exam;
  const status = engine.paused ? c(GOLD, '❚❚ PAUSED') : engine.running ? c(GREEN, '● TRAINING') : c(DIM, '■ STOPPED');
  const L: string[] = [];
  const rule = (label = ''): string => c(DIM, `── ${label}${'─'.repeat(Math.max(0, W - label.length - 4))}`);
  L.push('');
  L.push(`  ${b(c(AMBER, 'BIOBUZZ  LEARNING FROM EVERY DECISION'))}   ${status}   ${c(DIM, 'run')} ${b(name)}  ${c(DIM, '·')} ${engine.config.preset || 'custom settings'}`);
  L.push('');
  L.push(`  ${c(DIM, 'GENERATION')} ${b(c(GOLD, String(engine.gen).padStart(5)))}   ${c(DIM, 'LESSONS')} ${b(fmt(T.lessons))}   ${c(DIM, 'MATCHES')} ${fmt(T.matches)}   ${c(DIM, 'SIMULATED')} ${hms(T.simSeconds)} in ${hms(T.wallSeconds)}`);
  const frac = progress.total ? progress.done / progress.total : 0;
  L.push(`  ${c(DIM, (progress.stage ?? 'this generation').toUpperCase().padEnd(18))} ${bar(frac, W - 44)}  ${fmt(progress.done)}/${fmt(progress.total)}`);
  L.push('');
  L.push(rule('CHAMPION'));
  L.push(`  #${ch.id} ${c(DIM, `(${ch.lineage.op}, since generation ${ch.born})`)}${ex ? `   exam ${b(c(GOLD, ex.net.mean.toFixed(1)))} ± ${ex.net.ci95.toFixed(1)}  ${c(DIM, 'vs no-learning')} ${ex.vsBase.mean >= 0 ? '+' : ''}${ex.vsBase.mean.toFixed(1)} ± ${ex.vsBase.ci95.toFixed(1)}${ex.search ? `  ${c(DIM, 'thinking ahead')} ${b(ex.search.mean.toFixed(1))}` : ''}` : c(DIM, '   exam after the first generation')}`);
  const sw = W - 34;
  L.push(`  ${c(DIM, 'exam         ')} ${c(GOLD, spark(engine.exams().map((x) => x.net.mean), sw))}`);
  L.push(`  ${c(DIM, 'choice regret')} ${c(TEAL, spark(hist.map((h) => h.regret), sw))}  ${hist.length ? `${hist[hist.length - 1].regret.toFixed(1)} pts/decision` : ''}`);
  L.push('');
  L.push(rule('LOG'));
  for (const l of log) L.push(`  ${c(DIM, l)}`);
  L.push('');
  L.push(`  ${c(AMBER, 'studio')} ${b(server.url)}   ${c(DIM, '[p] pause/resume   [o] open studio   [q] stop + checkpoint')}`);
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
      if (k === 'q' || k === '\u0003') quit();
      else if (k === 'p') {
        if (engine.paused) engine.resume();
        else engine.pause();
      } else if (k === 'o') spawn('open', [server.url], { stdio: 'ignore', detached: true }).unref();
    });
  }
}
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
const timer = setInterval(draw, 250);
if (!flag('no-open') && !plain) spawn('open', [server.url], { stdio: 'ignore', detached: true }).unref();

engine.start();
await new Promise<void>((r) => engine.once('stopped', () => r()));
clearInterval(timer);
draw();
restore();
await server.close();
console.log(`\nstopped at generation ${engine.gen}; checkpoint saved in ${runDir}. Resume with: npm run train -- --name ${name}`);
process.exit(0);
