// `./start.sh` / `npm start` — THE STUDIO: starts everything and trains NOTHING until you press
// Start in the viewer. Everything stops when this terminal is closed or Ctrl-C is pressed (a
// generation in progress is discarded; the run stays exactly at its last checkpointed generation).
//   · the training studio (viewer + API)   http://localhost:4747
//   · DSIM itself (alpha channel, local)   http://localhost:5173  — to watch champions in the real app
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { init } from '../harness/dsim';
import { ROOT } from './engine';
import { startServer } from './server';
import { notifyNow } from './notify';

// A crash must leave its reason behind: the terminal it printed to may be long closed.
// Appended to runs/studio-crash.log, then the studio exits as Node would have.
for (const ev of ['uncaughtException', 'unhandledRejection'] as const)
  process.on(ev, (e: unknown) => {
    const text = `${new Date().toISOString()} ${ev}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n\n`;
    try {
      mkdirSync(join(ROOT, 'runs'), { recursive: true });
      appendFileSync(join(ROOT, 'runs', 'studio-crash.log'), text);
    } catch {
      /* nowhere to write: the terminal still gets it */
    }
    process.stderr.write(`\n  studio crashed — reason saved in runs/studio-crash.log\n${text}`);
    notifyNow('The studio crashed', `${e instanceof Error ? e.message : String(e)}`.slice(0, 160));
    process.exit(1);
  });

const argv = process.argv.slice(2);
const flag = (k: string): boolean => argv.includes(`--${k}`);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const port = Number(arg('port', '4747'));
const dsimPort = Number(arg('dsim-port', '5173'));
const bin = (n: string): string => join(ROOT, 'dsim-main', 'node_modules', '.bin', n);

// ONE studio: a second one would fight the first for the port and, worse, train the same run twice
// (an earlier session once had three trainers running). Exit 0 so a supervisor does not retry.
try {
  const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(800) });
  if (r.status < 500) {
    // (usually the service from ./start.sh --install, running in the background with no window: open it)
    console.log(`The studio is already running at http://localhost:${port} (in the background) — opening it. To quit it: ./start.sh --stop`);
    if (!flag('no-open')) spawn('open', [`http://localhost:${port}`], { stdio: 'ignore', detached: true }).unref();
    process.exit(0);
  }
} catch {
  /* nothing there: start */
}

// the viewer is rebuilt whenever its sources are newer than the build (DSIM's own Vite, no download)
function newest(dir: string): number {
  let t = 0;
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    t = Math.max(t, f.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}
const built = join(ROOT, 'train', 'public', 'index.html');
// (train/zone.ts is the viewer's too: the Robot tab's shooting-zone editor imports it)
if (!existsSync(built) || Math.max(newest(join(ROOT, 'viewer')), ...['engine.ts', 'zone.ts'].map((f) => statSync(join(ROOT, 'train', f)).mtimeMs)) > statSync(built).mtimeMs) {
  console.log('building the viewer…');
  execFileSync(bin('vite'), ['build', join(ROOT, 'viewer'), '--config', join(ROOT, 'viewer/vite.config.ts'), '--logLevel', 'error'], { stdio: 'inherit' });
}

await init(); // DSIM physics, for the imitation fit and the field the viewer draws
const studio = startServer(port, undefined, { onQuit: () => void quit(true) });

const children: ChildProcess[] = [];
if (!flag('no-dsim')) {
  const d = spawn(bin('vite'), ['--port', String(dsimPort), '--strictPort', '--logLevel', 'warn'], {
    cwd: join(ROOT, 'dsim-main'),
    env: { ...process.env, VITE_APP_CHANNEL: 'alpha' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  d.stderr?.on('data', (b: Buffer) => {
    const s = b.toString().trim();
    if (s) console.log(`[dsim] ${s}`);
  });
  children.push(d);
}

const A = '\x1b[38;5;214m';
const D = '\x1b[38;5;244m';
const B = '\x1b[1m';
const R = '\x1b[0m';
console.log(`
  ${B}${A}BIOBUZZ LEARNING STUDIO${R}   ${D}nothing is training — press Start in the studio${R}

  ${A}studio${R}  ${B}${studio.url}${R}   ${D}runs, training controls, checkpoints, rewind, settings, evaluation${R}
  ${flag('no-dsim') ? '' : `${A}DSIM  ${R}  ${B}http://localhost:${dsimPort}${R}   ${D}the real simulator (alpha) — paste a champion's DSIM snippet here${R}`}

  ${D}Close this terminal or press Ctrl-C to stop everything.${R}
`);
if (!flag('no-open')) spawn('open', [studio.url], { stdio: 'ignore', detached: true }).unref();

// one status line, so the terminal shows what is happening without the browser
let last = '';
const timer = setInterval(() => {
  const e = studio.engine();
  const s = e ? `${e.name} · gen ${e.gen} · ${e.running ? (e.paused ? 'paused' : e.phase) : 'idle'}${e.champion.exam ? ` · champion exam ${e.champion.exam.net.mean.toFixed(0)} pts` : ''}` : 'no run open';
  if (s !== last && process.stdout.isTTY) process.stdout.write(`\r\x1b[2K  ${D}${s}${R}`);
  last = s;
}, 500);

/** close the studio's and DSIM's browser tabs (Safari and Chrome, whichever are running). macOS
 * asks once whether the terminal may control the browser; if that is declined, the page shows
 * "Studio closed" and the tab stays for you to close. */
function closeTabs(): Promise<void> {
  const urls = [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://localhost:${dsimPort}`];
  const test = urls.map((u) => `(u starts with "${u}")`).join(' or ');
  const script = (app: string, tabs: string) => `if application "${app}" is running then
  tell application "${app}"
    repeat with w in (every window)
      repeat with i from (count of ${tabs} of w) to 1 by -1
        set u to URL of ${tabs.replace(/s$/, '')} i of w
        if ${test} then close ${tabs.replace(/s$/, '')} i of w
      end repeat
    end repeat
  end tell
end if`;
  const run = (src: string): Promise<void> => new Promise((r) => execFile('osascript', ['-e', src], { timeout: 4000 }, () => r()));
  return Promise.all([run(script('Safari', 'tabs')), run(script('Google Chrome', 'tabs'))]).then(() => undefined);
}

let quitting = false;
async function quit(fromStudio = false): Promise<void> {
  if (quitting) process.exit(130);
  quitting = true;
  clearInterval(timer);
  console.log(`\n  ${D}stopping… (a generation in progress is discarded; the run keeps its last checkpoint)${R}`);
  for (const c of children) c.kill();
  await studio.close();
  if (fromStudio && process.platform === 'darwin') await closeTabs();
  console.log(`  ${D}studio closed.${R}`);
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => void quit());
