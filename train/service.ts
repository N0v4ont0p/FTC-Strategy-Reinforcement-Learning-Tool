// THE STUDIO AS A SERVICE (MASTERPLAN §8) — training that survives a closed terminal, a crash and a
// restart of the Mac. The app's preview panel stops what it started after 30 idle minutes (it ended a
// run on 2026-09-25), so long training never runs there.
//
//   ./start.sh --install     a macOS LaunchAgent: the studio starts at login, restarts after a crash,
//                            and a run that was training resumes by itself. Quit in the studio stops it.
//   ./start.sh --uninstall   remove it
//   ./start.sh --background  the same supervisor, detached from this terminal (no login start):
//                            for when macOS will not let a LaunchAgent read this folder
//   ./start.sh --stop        quit the studio, whichever way it runs
//   ./start.sh --status      is it running, and how
//
// Both run `service.ts --supervise`: it starts the studio and starts it again when it CRASHES (a
// non-zero exit, at most 10 times an hour); a clean exit (Quit) ends it. Output: runs/studio.log.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const LABEL = 'com.reflection19859.biobuzz-studio';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const TSX = join(ROOT, 'dsim-main', 'node_modules', '.bin', 'tsx');
const LOG = join(ROOT, 'runs', 'studio.log');
const PID = join(ROOT, 'runs', 'studio-supervisor.pid');
const PORT = 4747;
const URL = `http://127.0.0.1:${PORT}`;

async function up(): Promise<boolean> {
  try {
    const r = await fetch(`${URL}/api/status`, { signal: AbortSignal.timeout(1500) });
    return r.status < 500;
  } catch {
    return false;
  }
}
async function waitUp(seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds * 2; i++) {
    if (await up()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
const tail = (n = 15): string => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').slice(-n).join('\n') : '(no log yet)');
const uid = (): number => userInfo().uid;
const launchctl = (...a: string[]): string => {
  try {
    return execFileSync('launchctl', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? '') + String((e as { stderr?: string }).stderr ?? '');
  }
};
const installed = (): boolean => existsSync(PLIST);
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** the supervisor: the studio, restarted after a crash (not after Quit) */
async function supervise(): Promise<void> {
  mkdirSync(join(ROOT, 'runs'), { recursive: true });
  writeFileSync(PID, String(process.pid));
  const crashes: number[] = [];
  for (;;) {
    const code = await new Promise<number>((resolve) => {
      const p = spawn(TSX, ['train/studio.ts', '--no-open', '--no-dsim', '--port', String(PORT)], { cwd: ROOT, stdio: 'inherit' });
      p.on('exit', (c, sig) => resolve(c ?? (sig ? 1 : 0)));
    });
    const t = Date.now();
    console.log(`[supervisor ${new Date().toISOString()}] the studio exited with code ${code}`);
    if (code === 0) break; // Quit, or another studio already running
    crashes.push(t);
    while (crashes.length && t - crashes[0] > 3_600_000) crashes.shift();
    if (crashes.length > 10) {
      console.log('[supervisor] 10 crashes within an hour: giving up (see runs/studio-crash.log)');
      process.exitCode = 1;
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (existsSync(PID) && readFileSync(PID, 'utf8') === String(process.pid)) rmSync(PID);
}

export function plist(): string {
  const path = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(TSX)}</string><string>train/service.ts</string><string>--supervise</string></array>
  <key>WorkingDirectory</key><string>${esc(ROOT)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG)}</string>
</dict>
</plist>
`;
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? '--status';
  if (cmd === '--supervise') return supervise();
  if (cmd === '--install') {
    if (await up()) {
      console.log(`A studio is already running at ${URL}. Quit it first (./start.sh --stop), then install.`);
      process.exitCode = 1;
      return;
    }
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    mkdirSync(join(ROOT, 'runs'), { recursive: true });
    writeFileSync(PLIST, plist());
    launchctl('bootout', `gui/${uid()}/${LABEL}`);
    const out = launchctl('bootstrap', `gui/${uid()}`, PLIST);
    if (out.trim()) console.log(out.trim());
    console.log('Installed. Starting the studio…');
    if (await waitUp(40)) console.log(`The studio is running at ${URL} — it will start at every login and restart after a crash.`);
    else {
      console.log(`The studio did not come up. The log says:\n${tail()}\n`);
      console.log('If it says "Operation not permitted", macOS is keeping the service out of this folder:');
      console.log('  System Settings → Privacy & Security → Full Disk Access → add `node`');
      console.log(`  (${join(ROOT, 'dsim-main', 'node_modules', '.bin', 'tsx')} runs /opt/homebrew/bin/node), then ./start.sh --install again.`);
      console.log('Or run it detached from this terminal instead:  ./start.sh --background');
      process.exitCode = 1;
    }
    return;
  }
  if (cmd === '--uninstall') {
    launchctl('bootout', `gui/${uid()}/${LABEL}`);
    if (installed()) rmSync(PLIST);
    console.log('The LaunchAgent is removed (a studio it started has been stopped).');
    return;
  }
  if (cmd === '--background') {
    if (await up()) {
      console.log(`A studio is already running at ${URL}.`);
      return;
    }
    mkdirSync(join(ROOT, 'runs'), { recursive: true });
    const fd = openSync(LOG, 'a');
    const p = spawn(TSX, ['train/service.ts', '--supervise'], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
    p.unref();
    console.log('Starting the studio in the background…');
    if (await waitUp(40)) console.log(`The studio is running at ${URL}. It keeps running when this terminal closes; ./start.sh --stop quits it.`);
    else {
      console.log(`It did not come up. The log says:\n${tail()}`);
      process.exitCode = 1;
    }
    return;
  }
  if (cmd === '--stop') {
    if (!(await up())) {
      console.log('No studio is running.');
      return;
    }
    await fetch(`${URL}/api/quit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
    for (let i = 0; i < 40 && (await up()); i++) await new Promise((r) => setTimeout(r, 500));
    console.log((await up()) ? 'The studio did not stop — see runs/studio.log.' : 'The studio has quit. (A run that was training resumes when the studio starts again.)');
    return;
  }
  // --status
  const running = await up();
  const agent = installed() ? (/state = running/.test(launchctl('print', `gui/${uid()}/${LABEL}`)) ? 'installed, running' : 'installed, not running') : 'not installed';
  const sup = existsSync(PID) ? `supervisor pid ${readFileSync(PID, 'utf8')}` : 'no supervisor';
  console.log(`studio: ${running ? `running at ${URL}` : 'not running'} · LaunchAgent: ${agent} · ${sup}`);
}

// a command when run, a module when imported (the gate reads plist())
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
