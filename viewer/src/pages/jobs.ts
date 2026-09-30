// LIVE PROGRESS OF THE LONG SEARCHES (the AUTO playbook, the team plays): overall and this-item
// bars, the stage in words, an ETA from the measured pace, and a heartbeat that says when the last
// progress report came. Ticks once a second only while a search runs.
import { fmt } from '../data';
import { $, PARTNER_LABEL, dur, esc, pbLabel, setHTML, setText, since } from '../ui';
import { S, bus } from '../state';

interface JobView {
  running: boolean;
  now: string; // the headline: which item of how many
  overall: number; // 0–1
  item: number; // 0–1 through the current item
  stage: string;
  eta: number; // seconds left
  estimated: boolean;
  itemElapsed: number;
  work: string; // simulations done
  beat: number; // seconds since the last progress report
  elapsed: number;
  log: string[];
}
function drawJob(x: string, v: JobView | null): void {
  const el = $(`${x}Prog`);
  el.hidden = !v?.running;
  if (!v?.running) return;
  const all = Math.max(0, Math.min(1, v.overall));
  $(`${x}Fill`).style.transform = `scaleX(${all.toFixed(4)})`;
  $(`${x}Fill2`).style.transform = `scaleX(${Math.max(0, Math.min(1, v.item)).toFixed(4)})`;
  $(`${x}Bar`).setAttribute('aria-valuenow', (100 * all).toFixed(0));
  setText($(`${x}Now`), v.now);
  setText($(`${x}Eta`), `${(100 * all).toFixed(1)} % · ${v.estimated ? 'about ' : ''}${dur(v.eta)} left`);
  setText($(`${x}Stage`), `${(100 * v.item).toFixed(0)} % of this one · ${v.stage} · ${dur(v.itemElapsed)} on it`);
  const stale = v.beat > 45;
  $(`${x}Beat`).className = `jpbeat${stale ? ' stale' : ''}`;
  setHTML($(`${x}Beat`), `<i class="pulse" aria-hidden="true"></i>${stale ? `no progress report for ${dur(v.beat)}: a long step (or check the Log)` : `live · last report ${v.beat < 1.5 ? 'just now' : `${Math.round(v.beat)} s ago`}`} · ${esc(v.work)} · running ${dur(v.elapsed)}`);
  setHTML($(`${x}Log`), v.log.slice(-6).map((l) => `<div>${esc(l)}</div>`).join(''));
}
export function renderJobs(): void {
  const p = S.pbStatus;
  if (p) {
    const frac = p.frac ?? 0;
    const itemEl = since(p.entryAt);
    const perEntry = p.entryS ?? 180;
    // the current entry's own pace once it is well under way, the build's average for the rest
    const leftNow = frac > 0.15 && itemEl > 20 ? (itemEl / frac) * (1 - frac) : Math.max(0, perEntry - (Number.isFinite(itemEl) ? itemEl : 0));
    drawJob('pb', {
      running: p.running,
      now: `Plan ${Math.min(p.total, p.done + 1)} of ${p.total}${p.current ? ` · ${pbLabel(p.current)}` : ''}`,
      overall: p.total ? (p.done + frac) / p.total : 0,
      item: frac,
      stage: p.stage ?? 'starting',
      eta: leftNow + Math.max(0, p.total - p.done - 1) * perEntry,
      estimated: !!p.estimated,
      itemElapsed: itemEl,
      work: `${fmt(p.sims ?? 0)} AUTOs simulated for this plan, ${fmt(p.totalSims ?? 0)} in all`,
      beat: since(p.beat),
      elapsed: since(p.startedAt),
      log: p.log ?? [],
    });
  }
  const t = S.tpStatus;
  if (t) {
    const f = t.matchesTotal ? (t.matches ?? 0) / t.matchesTotal : 0;
    const itemEl = since(t.partnerAt);
    const per = t.partnerS ?? 330;
    const leftNow = f > 0.1 && itemEl > 15 ? (itemEl / f) * (1 - f) : Math.max(0, per - (Number.isFinite(itemEl) ? itemEl : 0));
    const who = t.current ? (PARTNER_LABEL[t.current] ?? t.current) : '';
    drawJob('tp', {
      running: t.running,
      now: `Partner ${Math.min(t.total, t.done + 1)} of ${t.total}${t.current ? ` · beside ${who.toLowerCase()}` : ''}`,
      overall: t.total ? (t.done + f) / t.total : 0,
      item: f,
      stage: t.stage ?? 'starting',
      eta: leftNow + Math.max(0, t.total - t.done - 1) * per,
      estimated: !!t.estimated,
      itemElapsed: itemEl,
      work: `${fmt(t.matches ?? 0)} of ~${fmt(t.matchesTotal ?? 0)} matches for this partner, ${fmt(t.allMatches ?? 0)} in all`,
      beat: since(t.beat),
      elapsed: since(t.startedAt),
      log: t.log ?? [],
    });
  }
  bus.emit('pill');
}
// the ETA and heartbeat move every second while a search runs; nothing ticks otherwise
window.setInterval(() => {
  if (S.pbStatus?.running || S.tpStatus?.running) renderJobs();
}, 1000);
