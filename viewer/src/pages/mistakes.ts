// MISTAKES — every champion's exam matches audited (train/continuous.ts): the counts by champion,
// repeats, drills, and each mistake to watch from 3 s before.
import { LineChart } from '../charts';
import { AUTO_START, fmt, getJSON, type AuditPointV, type AuditV, type Frames } from '../data';
import { simulate, watch } from '../stage';
import { $, esc, on, setHTML, setText, toast } from '../ui';
import { profileQuery } from '../state';

const LABEL: Record<string, string> = { 'empty-trip': 'empty trip', 'blocked-shot': 'blocked shot', idle: 'idle', foul: 'foul', stall: 'stall', crash: 'crash', judgement: 'judgement' };
let MK: { profile: string; audit: AuditV | null; history: AuditPointV[]; drills: { n: number; used: number; played: number } | null } | null = null;
const chart = new LineChart<AuditPointV>($<HTMLCanvasElement>('mkChart'), $('mkLegend'), [
  { label: 'mistakes', color: '--s-mean', get: (x) => x.perMatch },
  { label: 'repeats', color: '--s-best', get: (x) => x.repeats },
], { unit: '', zeroBase: true, xLabel: (x) => (x.champion ? `#${x.champion}` : 'no-learning'), tip: (x) => `<b>${x.champion ? `champion #${x.champion}` : 'the no-learning robot'}</b><br>${x.perMatch.toFixed(2)} mistakes per match, ${x.repeats.toFixed(2)} repeats${x.judgement !== null ? `<br>${x.judgement.toFixed(1)} judgement mistakes per thinking-ahead match` : ''}`, empty: 'after the first exam' });
let chartKey = '';

export function renderMistakes(): void {
  const a = MK?.audit;
  const h = MK?.history ?? [];
  const last = h[h.length - 1];
  setText($('mkRepeats'), last ? last.repeats.toFixed(2) : '—');
  setText($('mkPer'), last ? last.perMatch.toFixed(1) : '—');
  setText($('mkWho'), a ? `${a.champion ? `champion #${a.champion}` : 'the no-learning robot'} · ${a.matches} exam matches` : ' ');
  const k = `${h.length}:${last?.perMatch ?? ''}`;
  if (k !== chartKey) {
    chartKey = k;
    chart.set(h);
  }
  const kinds = Object.keys(LABEL);
  setHTML(
    $('mkKinds'),
    h.length
      ? `<table><thead><tr><th class="l">Champion</th>${kinds.map((q) => `<th>${LABEL[q]}</th>`).join('')}<th>Repeats</th></tr></thead><tbody>${[...h]
          .reverse()
          .slice(0, 12)
          .map((x) => `<tr><td class="l">${x.champion ? `#${x.champion}` : 'no-learning'}</td>${kinds.map((q) => `<td>${q === 'judgement' ? (x.judgement === null ? '—' : x.judgement.toFixed(1)) : (x.byKind[q as keyof typeof x.byKind] ?? 0).toFixed(2)}</td>`).join('')}<td>${x.repeats.toFixed(2)}</td></tr>`)
          .join('')}</tbody></table>`
      : '',
  );
  const d = MK?.drills;
  setText($('mkDrills'), d ? `${fmt(d.n)} drills waiting (${fmt(d.used)} practised at least once) · ${fmt(d.played)} drill matches played` : '');
  const f = $<HTMLSelectElement>('mkFilter');
  if (f.options.length === 2) f.insertAdjacentHTML('beforeend', kinds.map((q) => `<option value="${q}">${LABEL[q][0].toUpperCase()}${LABEL[q].slice(1)}</option>`).join(''));
  if (!a) {
    setHTML($('mkList'), '<p class="hint">After the first exam on Home.</p>');
    return;
  }
  const rows = a.items.map((it, i) => ({ it, i })).filter(({ it }) => !f.value || (f.value === 'repeat' ? it.repeat : it.kind === f.value));
  rows.sort((p, q) => Number(q.it.repeat) - Number(p.it.repeat) || q.it.cost - p.it.cost);
  const unit = (q: string): string => (q === 'foul' || q === 'judgement' ? ' pts' : q === 'crash' ? '' : ' s');
  setHTML(
    $('mkList'),
    rows.length
      ? `<table><thead><tr><th>Match</th><th>Time</th><th class="l">Kind</th><th class="l">What</th><th>Cost</th><th></th></tr></thead><tbody>${rows
          .slice(0, 300)
          .map(({ it, i }) => `<tr><td>${it.match + 1}</td><td>${((it.tick - AUTO_START) / 60).toFixed(1)} s</td><td class="l">${LABEL[it.kind]}${it.repeat ? ' <span class="badge warn">repeat</span>' : ''}</td><td class="l">${esc(it.detail)}</td><td>${it.kind === 'crash' ? '' : it.cost.toFixed(1)}${unit(it.kind)}</td><td><button type="button" class="link" data-mk="${i}">Watch</button></td></tr>`)
          .join('')}</tbody></table>`
      : '<p class="hint">None of this kind.</p>',
  );
}
on<HTMLButtonElement>($('mkList'), 'button[data-mk]', (b) => void watchMistake(Number(b.dataset.mk)));
export async function loadMistakes(): Promise<void> {
  try {
    MK = await getJSON(`/api/mistakes${profileQuery()}`);
    renderMistakes();
  } catch (e) {
    setHTML($('mkList'), `<p class="hint">${esc((e as Error).message)}</p>`);
  }
}
async function watchMistake(i: number): Promise<void> {
  const it = MK?.audit?.items[i];
  if (!it || !MK) return;
  try {
    const f = await simulate<{ frames: Frames; events: [number, string][]; tick: number }>('/api/mistakes/watch', { profile: MK.profile, i }, `exam match ${it.match + 1}`);
    if (!f) return;
    watch(f, `Mistake · ${LABEL[it.kind]}: ${it.detail} · exam match ${it.match + 1} at ${((it.tick - AUTO_START) / 60).toFixed(1)} s (from 3 s before)`, { seek: Math.max(0, f.tick - 180) });
  } catch (e) {
    toast((e as Error).message, true);
  }
}
$<HTMLSelectElement>('mkFilter').onchange = () => renderMistakes();
