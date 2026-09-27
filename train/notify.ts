// NOTIFICATIONS (MASTERPLAN §9) — macOS Notification Center, for what the team should know without
// watching the studio: a new champion, a finished playbook, training that stopped on a problem, a
// studio crash. Settings in runs/.notify.json (on by default); each kind can be switched off. The
// last few are kept so the studio can list them.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'runs', '.notify.json');
export type NotifyKind = 'champion' | 'playbook' | 'problems';
export interface NotifySettings {
  enabled: boolean;
  champion: boolean;
  playbook: boolean;
  problems: boolean;
  sound: boolean;
}
const DEFAULTS: NotifySettings = { enabled: true, champion: true, playbook: true, problems: true, sound: true };
export interface Notice {
  time: string;
  kind: NotifyKind | 'test';
  title: string;
  body: string;
}
export const recent: Notice[] = [];
const lastOf = new Map<string, number>();

export function notifySettings(): NotifySettings {
  try {
    return existsSync(FILE) ? { ...DEFAULTS, ...(JSON.parse(readFileSync(FILE, 'utf8')) as Partial<NotifySettings>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}
export function setNotifySettings(p: Partial<NotifySettings>): NotifySettings {
  const s = notifySettings();
  for (const k of Object.keys(DEFAULTS) as (keyof NotifySettings)[]) if (typeof p[k] === 'boolean') s[k] = p[k] as boolean;
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(s, null, 2));
  return s;
}

const q = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const script = (title: string, body: string, sound: boolean): string => `display notification "${q(body)}" with title "BIOBUZZ Learning" subtitle "${q(title)}"${sound ? ' sound name "Glass"' : ''}`;

/** post one (unless switched off; the same kind at most once a minute, problems once in 10) */
export function notify(kind: NotifyKind | 'test', title: string, body: string): boolean {
  const s = notifySettings();
  if (process.env.BIOBUZZ_NO_NOTIFY) return false;
  if (kind !== 'test' && (!s.enabled || !s[kind])) return false;
  const now = Date.now();
  const gap = kind === 'problems' ? 600_000 : kind === 'test' ? 0 : 60_000;
  if (now - (lastOf.get(kind) ?? 0) < gap) return false;
  lastOf.set(kind, now);
  recent.unshift({ time: new Date().toISOString(), kind, title, body });
  recent.length = Math.min(recent.length, 20);
  if (process.platform === 'darwin') execFile('osascript', ['-e', script(title, body, s.sound)], () => {});
  return true;
}

/** from a process that is about to exit (the crash handler): posted before it returns */
export function notifyNow(title: string, body: string): void {
  const s = notifySettings();
  if (process.env.BIOBUZZ_NO_NOTIFY || !s.enabled || !s.problems || process.platform !== 'darwin') return;
  try {
    execFileSync('osascript', ['-e', script(title, body, s.sound)], { timeout: 3000 });
  } catch {
    /* nowhere to show it */
  }
}
