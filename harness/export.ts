// Replays → files a person can watch in UNMODIFIED DSIM (PLAN.md §14.1 row "watching AI replays").
// DSIM keeps practice runs in localStorage (src/net/practiceRuns.ts, key decodesim.practice.v1);
// the .inject.js snippet writes one there, and it then appears under Records → Career → Watch.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Replay } from './dsim';

export interface ExportMeta {
  title: string;
  profile: string;
  score: number;
  replayExact: boolean;
  notes?: string;
}

export function exportReplay(path: string, replay: Replay, meta: ExportMeta): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.replay.json`, JSON.stringify({ meta, replay }));
  const warn = meta.replayExact
    ? ''
    : '// ⚠ this run used layer-C perturbations (e.g. forced misses); DSIM re-simulates commands only, so the playback diverges after the first perturbation.\n';
  writeFileSync(
    `${path}.inject.js`,
    `// ${meta.title} — profile ${meta.profile}, score ${meta.score}\n` +
      warn +
      `// Paste into the console on the DSIM page (Safari: Develop → Show Web Inspector → Console), then open Records → Career.\n` +
      `// DSIM refuses a replay whose balance/sim version differs from the site (this one: balance ${replay.balanceVersion}, sim ${replay.sim}).\n` +
      `(() => { const r = ${JSON.stringify(replay)}; const K = 'decodesim.practice.v1';\n` +
      `  const id = 'pAI' + Date.now().toString(36); localStorage.setItem(K + '.' + id, JSON.stringify(r));\n` +
      `  const i = JSON.parse(localStorage.getItem(K) || '[]'); i.push({ id, at: Date.now(), game: 'biobuzz', score: ${meta.score}, ticks: r.ticks, balanceVersion: r.balanceVersion, sim: r.sim });\n` +
      `  localStorage.setItem(K, JSON.stringify(i)); return 'added ' + id; })();\n`,
  );
}
