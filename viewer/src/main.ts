import { Comb } from './comb';
import { CHOICE_PARTS, LineChart, StackChart, historyTable } from './charts';
import { AUTO_START, OPTIONS, OP_LABEL, bytes, fmt, getJSON, post, type CheckpointMeta, type EvalResult, type ExamResult, type FocusFile, type Frames, type GenFile, type GenSummary, type Inspected, type PlaybookStatusV, type PlaybookV, type HomeStatusV, type HomeV, type RouteLibraryV, type AuditV, type AuditPointV, type Progress, type RunConfig, type RunState, type State, type Status, type DataInfo } from './data';
import { FieldView, type FrameInfo } from './fieldview';
import type { World } from '../../dsim-main/src/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pct = (v: number | undefined): string => (v === undefined || !Number.isFinite(v) ? '—' : `${(100 * v).toFixed(0)}%`);
const sgn = (v: number, d = 1): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;
const f1 = (v: number | null | undefined, d = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));
const view = new FieldView($<HTMLCanvasElement>('field'));
const genTip = (g: GenSummary): string => `<b>generation ${g.gen}</b> · ${g.hours.toFixed(1)} h of training`;
const examChart = new LineChart<ExamResult>($<HTMLCanvasElement>('chartExam'), $('examLegend'), [
  { label: 'alone', color: '--s-best', get: (x) => x.net.mean },
  { label: 'thinking ahead', color: '--s-median', get: (x) => x.search?.mean ?? null },
], { unit: ' pts', zeroBase: false, xLabel: (x) => `${x.hours.toFixed(1)} h`, tip: (x) => `<b>exam after ${x.hours.toFixed(1)} h</b> (generation ${x.gen})<br>champion #${x.champ} · ${OP_LABEL[x.champOp] ?? x.champOp}<br>vs no-learning ${sgn(x.vsBase.mean)} ± ${x.vsBase.ci95.toFixed(1)}`, empty: 'the first exam appears after generation 0' });
const regretChart = new LineChart<GenSummary>($<HTMLCanvasElement>('chartRegret'), $('regretLegend'), [{ label: 'points lost per decision', color: '--s-mean', get: (g) => (g.lessons ? g.regret : null) }], { unit: ' pts', zeroBase: true, xLabel: (g) => `gen ${g.gen}`, tip: genTip });
const lostChart = new LineChart<GenSummary>($<HTMLCanvasElement>('chartLost'), $('lostLegend'), [
  { label: 'idle', color: OPTIONS[0].color, get: (g) => g.mistakes.idleS },
  { label: 'empty trips', color: OPTIONS[1].color, get: (g) => g.mistakes.emptyTripS },
  { label: 'blocked shots', color: OPTIONS[3].color, get: (g) => g.mistakes.blockedShotS },
], { unit: ' s', zeroBase: true, xLabel: (g) => `gen ${g.gen}`, tip: genTip });
const scoreChart = new LineChart<GenSummary>($<HTMLCanvasElement>('chartScore'), $('scoreLegend'), [
  { label: 'lesson matches', color: '--s-mean', get: (g) => g.meanScore },
  { label: 'champion, fresh', color: '--s-median', get: (g) => (g.champN ? g.champScore : null) },
], { unit: ' pts', zeroBase: true, xLabel: (g) => `gen ${g.gen}`, tip: (g) => `${genTip(g)}<br>champion #${g.champId}${g.newChamp ? ' (new)' : ''} · ${g.champN} fresh matches ± ${g.champCi.toFixed(1)}` });
const choiceChart = new StackChart($<HTMLCanvasElement>('chartChoice'), $('choiceLegend'), CHOICE_PARTS, (g) => `generation ${g.gen} — the champion's job decisions`);
const comb = new Comb($<HTMLCanvasElement>('comb'));

let S: State | null = null;
let run: RunState | null = null;
let hist: GenSummary[] = [];
let onDisk: number[] = [];
/** LIVE follows training; the two replays are for analysing at 1× or 2× */
let mode: 'live' | 'best' | 'champion' | 'playbook' | 'replay' = 'live';
/** what a 'replay' shows (a route's example, a mistake's moment) */
let replayLabel = '';
let liveGen = -1;
let pendingGen = -1;
let bestGen = -1;
let champId = -1;
let inspect: Inspected[] = [];
let inspSearch = false;
let inspShown = -2;
let speed = 1;
let closed = false;
// the AUTO playbook: what is loaded, and which entry is selected / on the field
let PB: PlaybookV | null = null;
let pbWatching: string | null = null;
let pbSelected: string | null = null;
try {
  speed = Number(localStorage.getItem('bb.speed')) === 2 ? 2 : 1;
} catch {
  /* private window: 1× */
}

// ─────────────────────────────── small UI helpers ───────────────────────────────
function toast(msg: string, bad = false): void {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${bad ? ' bad' : ''}`;
  t.hidden = false;
  clearTimeout((toast as unknown as { h?: number }).h);
  (toast as unknown as { h?: number }).h = window.setTimeout(() => (t.hidden = true), bad ? 6000 : 3000);
}
async function act(p: Promise<unknown>, ok?: string): Promise<boolean> {
  try {
    await p;
    if (ok) toast(ok);
    return true;
  } catch (e) {
    toast((e as Error).message, true);
    return false;
  }
}
/** a confirm dialog; `word` makes the user type it back (irreversible actions); `input` asks for a
 * value (resolves to it, or null on cancel) */
function dialog(title: string, text: string, yes: string, o: { word?: string; input?: { label: string; value: string } } = {}): Promise<string | null> {
  const d = $<HTMLDialogElement>('askDlg');
  $('askTitle').textContent = title;
  $('askText').textContent = text;
  $('askYes').textContent = yes;
  $('askTypeWrap').hidden = !o.word;
  $('askWord').textContent = o.word ?? '';
  $('askInputWrap').hidden = !o.input;
  $('askInputLabel').textContent = o.input?.label ?? '';
  const typed = $<HTMLInputElement>('askType');
  const inp = $<HTMLInputElement>('askInput');
  typed.value = '';
  inp.value = o.input?.value ?? '';
  const yesBtn = $<HTMLButtonElement>('askYes');
  const sync = (): void => {
    yesBtn.disabled = (!!o.word && typed.value !== o.word) || (!!o.input && !inp.value.trim());
  };
  typed.oninput = sync;
  inp.oninput = sync;
  sync();
  d.showModal();
  if (o.input) inp.select();
  return new Promise((r) => {
    d.onclose = () => r(d.returnValue === 'yes' ? (o.input ? inp.value.trim() : 'yes') : null);
  });
}
const ask = async (title: string, text: string, yes: string, word?: string): Promise<boolean> => (await dialog(title, text, yes, { word })) !== null;
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-close]')) b.onclick = () => b.closest('dialog')!.close();
function log(s: string, time = new Date()): void {
  const el = document.createElement('div');
  el.textContent = `${time.toLocaleTimeString()}  ${s}`;
  $('log').prepend(el);
  while ($('log').childElementCount > 300) $('log').lastChild!.remove();
}

// side panel tabs
for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs [data-tab]')) {
  b.onclick = () => {
    for (const o of document.querySelectorAll<HTMLButtonElement>('.tabs [data-tab]')) o.setAttribute('aria-selected', String(o === b));
    for (const p of document.querySelectorAll<HTMLElement>('[data-panel]')) p.hidden = p.dataset.panel !== b.dataset.tab;
    if (b.dataset.tab === 'overview') renderHistory();
  };
}

$('fieldLegend').innerHTML = [
  ...OPTIONS.map((o) => `<span><i style="background:${o.color}"></i>${o.label}</span>`),
  `<span><i class="box" style="background:transparent;box-shadow:inset 0 0 0 2px var(--honey-hi)"></i>gold ring: best robot · flash: a shot went in</span>`,
  `<span><i class="box" style="background:transparent;box-shadow:inset 0 0 0 2px var(--st-crash)"></i>× crashed into the HIVE frame</span>`,
  `<span><i class="box" style="background:transparent;border-radius:50%;box-shadow:inset 0 0 0 2px var(--st-stall)"></i>○ stalled</span>`,
].join('');

// ─────────────────────────────── rendering ───────────────────────────────
function renderRuns(): void {
  const sel = $<HTMLSelectElement>('runSel');
  const runs = S?.runs ?? [];
  sel.innerHTML = runs.length
    ? runs.map((r) => `<option value="${esc(r.name)}" ${run?.name === r.name ? 'selected' : ''}>${esc(r.name)} · gen ${r.gen}${r.legacy ? ' · old version' : r.exam !== null ? ` · exam ${Math.round(r.exam)} pts` : ''}</option>`).join('')
    : '<option value="">no runs yet</option>';
  if (!run) sel.insertAdjacentHTML('afterbegin', '<option value="" selected>— choose —</option>');
  $('empty').hidden = !!run || mode === 'playbook' || mode === 'replay';
  $('runsList').innerHTML = runs.length
    ? runs
        .map((r) => {
          const open = run?.name === r.name;
          const acts = r.legacy
            ? `<button type="button" class="quiet danger" data-run="delete">Delete</button>`
            : `${open ? '' : '<button type="button" data-run="open">Open</button>'}<button type="button" class="quiet" data-run="rename">Rename</button><button type="button" class="quiet" data-run="duplicate">Duplicate</button><button type="button" class="quiet danger" data-run="delete">Delete</button>`;
          const meta = r.legacy ? `old version: ${esc(r.legacy)}` : `gen ${fmt(r.gen)} · ${r.exam !== null ? `champion exam ${Math.round(r.exam)} pts${r.vsBase !== null ? ` (${sgn(r.vsBase, 0)} over no-learning)` : ''}${r.search !== null ? ` · thinking ahead ${Math.round(r.search)}` : ''}` : 'no exam yet'}`;
          return `<div class="ck${open ? ' pinned' : ''}" data-name="${esc(r.name)}"><div class="ckmain"><b>${esc(r.name)}${open ? '<span class="tag">open</span>' : ''}</b><span class="sub">${meta}</span><span class="sub mono">${bytes(r.bytes)} on disk${r.updated ? ` · last trained ${new Date(r.updated).toLocaleString()}` : ''}</span></div><div class="row">${acts}</div></div>`;
        })
        .join('')
    : '<p class="hint">No runs yet. Create one to start.</p>';
}
$('runsList').onclick = async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-run]');
  if (!b) return;
  const name = b.closest<HTMLElement>('[data-name]')!.dataset.name!;
  const what = b.dataset.run;
  if (what === 'open') await act(post('/api/runs/open', { name }));
  else if (what === 'rename') {
    const to = await dialog(`Rename "${name}"`, 'Its history, checkpoints and champion move with it.', 'Rename', { input: { label: 'New name (letters, digits, - and _)', value: name } });
    if (to && to !== name) await act(post('/api/runs/rename', { name, to }), `renamed to "${to}"`);
  } else if (what === 'duplicate') {
    const to = await dialog(`Duplicate "${name}"`, 'An independent copy: same generation, history, checkpoints and champion. Training one never changes the other.', 'Duplicate', { input: { label: 'Name of the copy', value: `${name}-copy` } });
    if (to) await act(post('/api/runs/duplicate', { name, to }), `copied to "${to}"`);
  } else if (what === 'delete') {
    if (await ask(`Delete run "${name}"?`, 'Every generation, checkpoint, evaluation and the champion of this run are removed from disk. This cannot be undone.', 'Delete run', name)) await act(post('/api/runs/delete', { name, confirm: name }), `deleted "${name}"`);
  }
};

function renderStatus(): void {
  const st = $('status');
  const on = !!run;
  const running = !!run?.running;
  const paused = !!run?.paused;
  const txt = !run ? 'no run open' : !running ? 'idle' : paused ? 'paused' : run.phase === 'evaluating' ? 'evaluating' : 'training';
  st.textContent = txt;
  st.className = `status ${!running ? 'off' : paused ? 'paused' : 'on'}`;
  const dis = (id: string, d: boolean): void => {
    ($(id) as HTMLButtonElement).disabled = d;
  };
  dis('btnStart', !on || (running && !paused));
  $('btnStart').textContent = running && paused ? 'Resume training' : 'Start training';
  dis('btnPause', !running || paused);
  dis('btnStep1', !on || (running && !paused));
  dis('btnStep10', !on || (running && !paused));
  dis('btnStop', !running);
  dis('btnAbort', !running || run?.phase !== 'generation');
}

const ago = (iso: string | null): string => {
  if (!iso) return '';
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  return m < 1 ? 'just now' : m < 90 ? `${Math.round(m)} min ago` : `${(m / 60).toFixed(1)} h ago`;
};
function renderHeartbeat(): void {
  if (!run) return;
  const last = hist[hist.length - 1];
  const stale = !!run.running && !run.paused && !!run.lastGenAt && !!last && Date.now() - new Date(run.lastGenAt).getTime() > Math.max(20 * 60000, 4 * last.wallS * 1000);
  $('genWhen').textContent = run.lastGenAt ? `last finished ${ago(run.lastGenAt)}${stale ? ' — slower than usual' : ''}` : 'none finished yet';
  $('genWhen').classList.toggle('bad', stale);
}
function renderRun(): void {
  renderRuns();
  renderStatus();
  if (!run) {
    for (const id of ['gen', 'lessonsN', 'matchesN']) $(id).textContent = '0';
    $('champBody').textContent = 'No run open.';
    return;
  }
  const T = run.totals;
  $('gen').textContent = fmt(run.gen);
  $('lessonsN').textContent = fmt(T.lessons);
  $('matchesN').textContent = fmt(T.matches);
  $('simTime').textContent = `${(T.simSeconds / 3600).toFixed(1)} h simulated in ${(T.wallSeconds / 3600).toFixed(1)} h`;
  const last = hist[hist.length - 1];
  $('rpm').textContent = last ? f1(last.matchesPerMin, 0) : '—';
  renderHeartbeat();
  const c = run.champion;
  const x = c.exam;
  $('champGen').textContent = `#${c.id} · ${OP_LABEL[c.op] ?? c.op}${c.op === 'baseline' ? '' : ` · since generation ${c.born}`}`;
  const race = c.race ? `On fresh race matches: <b>${c.race.score.toFixed(0)}</b> ± ${c.race.ci95.toFixed(0)} over ${c.race.n}.` : '';
  $('champBody').innerHTML = !x
    ? `${c.op === 'baseline' ? 'The no-learning robot, as a network — the bar. ' : ''}Its exam comes with the first generation. ${race}`
    : `<div class="hero"><span class="heronum mono">${sgn(x.vsBase.mean)}</span><span class="herounit">points per match over the no-learning robot</span><span class="ci mono">± ${x.vsBase.ci95.toFixed(1)} (95%) · ${x.vsBase.n} exam matches, same luck</span></div>
       Exam: <b>${x.net.mean.toFixed(0)}</b> ± ${x.net.ci95.toFixed(0)} DSIM points alone, ${x.net.tips.toFixed(1)} tips${x.search ? ` · thinking ahead <b>${x.search.mean.toFixed(0)}</b> (${sgn(x.search.vsBase.mean)} ± ${x.search.vsBase.ci95.toFixed(1)} over no-learning on ${x.search.n} matches; ${sgn(x.search.vsNet.mean)} ± ${x.search.vsNet.ci95.toFixed(1)} over itself alone)` : ''}.<br>${race}${c.parts ? `<br><span class="sub">Showcase match: ${c.parts.tips} tips · ${c.parts.shotsIn} shots in · ${c.parts.pickups} pickups · ${c.parts.wasted} missed · ${c.parts.violations} rule violations</span>` : ''}`;
  for (const id of ['watchChamp', 'copySnippet']) ($(id) as HTMLButtonElement).disabled = !c.parts;
}

function refs(): { value: number; label: string }[] {
  const out: { value: number; label: string }[] = [];
  const ref = S?.reference;
  if (ref?.files.length) {
    const best = Math.max(...ref.files.map((f) => f.score));
    out.push({ value: best, label: `your best replay ${best} (your build)` });
  }
  const x = run?.exams.at(-1);
  if (x) out.push({ value: x.net.mean - x.vsBase.mean, label: `no-learning robot ${(x.net.mean - x.vsBase.mean).toFixed(0)} (exam)` });
  return out;
}
function renderHistory(): void {
  const ex = run?.exams ?? [];
  const bar = ex.at(-1);
  examChart.set(ex, bar ? [{ value: bar.net.mean - bar.vsBase.mean, label: `no-learning robot ${(bar.net.mean - bar.vsBase.mean).toFixed(0)}` }] : []);
  regretChart.set(hist);
  lostChart.set(hist);
  const last = hist.at(-1);
  $('lostNow').textContent = last ? `Last generation, per match: ${f1(last.mistakes.missedShots)} missed shots · ${f1(last.mistakes.emptyTrips)} empty trips · ${f1(last.mistakes.blockedShots)} blocked shots · ${f1(last.mistakes.fouls, 0)} foul points.` : '';
  scoreChart.set(hist, refs());
  choiceChart.set(hist);
  comb.set(hist, onDisk);
  if (!$('fitTable').hidden) $('fitTable').innerHTML = historyTable(hist);
  renderRace();
  renderReport();
}

// ─────────────────────────────── race + report ───────────────────────────────
function renderRace(): void {
  const last = hist.at(-1);
  const c = run?.champion;
  $('raceNow').textContent = last?.confirm ? `last: #${last.confirm.id} ${sgn(last.confirm.diff)} ± ${(1.96 * last.confirm.se).toFixed(1)} over ${last.confirm.n}${last.confirm.promoted ? ' — promoted' : ''}` : '';
  $('raceTable').innerHTML = last?.arena.length
    ? `<table><thead><tr><th class="l">contender</th><th class="l">made by</th><th>matches</th><th>lead ± 95%</th><th>z</th></tr></thead><tbody>${last.arena
        .map((a) => `<tr><td class="l">#${a.id}</td><td class="l">${OP_LABEL[a.op] ?? a.op}</td><td>${a.n}</td><td>${a.n ? `${sgn(a.diff)} ± ${Number.isFinite(a.se) ? (1.96 * a.se).toFixed(1) : '—'}` : '—'}</td><td>${a.z.toFixed(2)}</td></tr>`)
        .join('')}</tbody></table>`
    : `<p class="hint">${last ? 'No contender right now: none of this generation\'s candidates beat the champion where it counts (the lessons it never saw).' : 'Contenders appear after the first generation.'}</p>`;
  if (last) {
    const f = last.fit;
    const v = last.value;
    const m = last.cma;
    $('learnNow').innerHTML = [
      `<b>${fmt(last.lessons)}</b> lessons from ${run?.config.collect ?? '?'} matches; the champion's choice lost <b>${last.regret.toFixed(1)}</b> points per decision against the best option.`,
      f ? `Candidate network: trained on ${fmt(f.lessons)} lessons, judged on ${fmt(f.held)} it never saw — its picks lose ${f.regret.toFixed(2)} points per decision (the champion's: ${f.startRegret.toFixed(2)}), best option ${pct(f.hit)} of the time (champion ${pct(f.startHit)}). ${f.regret < f.startRegret ? 'It entered the race.' : 'Not better: it did not race.'}` : '',
      v ? `Rest-of-match predictor: off by ${f1(v.rmse)} points on matches it never saw${Number.isFinite(v.startRmse ?? NaN) ? ` (before: ${f1(v.startRmse)})` : ''}, from ${fmt(v.samples)} moments.` : '',
      m ? `Skill settings: CMA-ES generation ${m.gen}, step ${m.sigma.toFixed(3)}; the settings tried led the champion by ${sgn(m.mean)} on average (best ${sgn(m.best)}) on the same matches${m.entered ? '; their new centre entered the race' : ''}.` : 'Skill settings are not being tuned (0 tried per generation).',
      `Phases: lessons ${(last.phases.collect / 60).toFixed(1)} min · learning ${(last.phases.learn / 60).toFixed(1)} · race ${(last.phases.race / 60).toFixed(1)} · exam ${(last.phases.exam / 60).toFixed(1)}.`,
    ]
      .filter(Boolean)
      .map((t) => `<p>${t}</p>`)
      .join('');
  } else $('learnNow').innerHTML = '<p class="hint">Appears after the first generation.</p>';
  $('styleTable').innerHTML = c
    ? `<table><thead><tr><th class="l">setting</th><th>champion</th><th>start</th></tr></thead><tbody>${c.style
        .map((q) => `<tr><td class="l">${esc(q.label)}</td><td>${q.value.toFixed(2)}</td><td>${q.def.toFixed(2)}</td></tr>`)
        .join('')}</tbody></table>`
    : '';
}
function renderReport(): void {
  const x = run?.exams.at(-1);
  const first = run?.exams[0];
  $('gapWhen').textContent = x ? `exam of champion #${x.champ}, generation ${x.gen}` : '';
  if (!x) {
    $('gapTable').innerHTML = '<p class="hint">Appears with the first exam.</p>';
    $('checks').textContent = '';
    $('examMistakes').innerHTML = '';
    return;
  }
  const share = (q: { collect: number; shoot: number; drive: number; idle: number }): string =>
    `<span class="share" title="collect ${pct(q.collect)} · shoot ${pct(q.shoot)} · drive ${pct(q.drive)} · idle ${pct(q.idle)}">${(['collect', 'shoot', 'drive', 'idle'] as const).map((k, i) => `<i style="width:${(100 * q[k]).toFixed(1)}%;background:${[OPTIONS[0].color, OPTIONS[3].color, OPTIONS[6].color, '#3a322a'][i]}"></i>`).join('')}</span>`;
  $('gapTable').innerHTML = `<table><thead><tr><th class="l">who · robot · matches</th><th>points</th><th>tips</th><th>s / tip</th><th>pickups / min</th><th>shots / min</th><th>hit</th><th>shots / load</th></tr></thead><tbody>${x.gap
    .map((r) => `<tr><td class="l"><b>${esc(r.who)}</b><br><span class="sub">${esc(r.build)} · ${r.n}</span></td><td>${r.points.toFixed(0)}</td><td>${r.tips.toFixed(1)}</td><td>${f1(r.secPerTip)}</td><td>${r.pickupsPerMin.toFixed(0)}</td><td>${r.shotsPerMin.toFixed(0)}</td><td>${pct(r.accuracy)}</td><td>${r.loadSize.toFixed(1)}</td></tr><tr><td class="l" colspan="8">${share(r.share)} <span class="sub">collect ${pct(r.share.collect)} · shoot ${pct(r.share.shoot)} · drive ${pct(r.share.drive)} · idle ${pct(r.share.idle)}</span></td></tr>`)
    .join('')}</tbody></table>`;
  const d = x.checks.dsim;
  $('checks').innerHTML = `<p>${x.checks.deterministic ? '✓' : '⚠'} <b>Deterministic</b>: exam match 1 played again gave ${x.checks.deterministic ? 'exactly the same result' : 'a DIFFERENT result — report this'}.</p><p>${d ? (d.ok ? '✓' : '⚠') : '–'} <b>DSIM verified</b>: ${d ? `${d.ok ? 'DSIM re-simulated the champion\'s replay on your build and landed on the identical world' : d.exact ? 'DSIM\'s re-simulation DIFFERS — report this' : d.detail}. <span class="mono">${esc(d.detail)}</span>` : 'no replay to verify (no replays in Training data).'} (On REAL-v0, simulated misses change the world after DSIM steps, so only the build check can be re-simulated exactly.)</p>`;
  const rows: [string, (m: ExamResult['mistakes']) => string][] = [
    ['missed shots', (m) => f1(m.missedShots)],
    ['empty trips (s)', (m) => `${f1(m.emptyTrips)} (${f1(m.emptyTripS, 0)} s)`],
    ['blocked shots (s)', (m) => `${f1(m.blockedShots)} (${f1(m.blockedShotS, 0)} s)`],
    ['idle seconds', (m) => f1(m.idleS, 0)],
    ['foul points', (m) => f1(m.fouls, 0)],
  ];
  $('examMistakes').innerHTML = `<table><thead><tr><th class="l">per match</th>${first && first !== x ? `<th>first exam (#${first.champ})</th>` : ''}<th>now (#${x.champ})</th></tr></thead><tbody>${rows.map(([k, g]) => `<tr><td class="l">${k}</td>${first && first !== x ? `<td>${g(first.mistakes)}</td>` : ''}<td>${g(x.mistakes)}</td></tr>`).join('')}</tbody></table>`;
}

// ─────────────────────────────── checkpoints ───────────────────────────────
function renderCheckpoints(list: CheckpointMeta[]): void {
  if (run) run.checkpoints = list;
  $('ckCount').textContent = `${list.length}`;
  $('ckList').innerHTML = list.length
    ? list
        .map(
          (m) => `<div class="ck${m.pinned ? ' pinned' : ''}" data-id="${m.id}">
      <div class="ckmain"><b>${esc(m.label)}</b><span class="sub">gen ${m.gen} · ${m.exam !== null ? `champion exam ${Math.round(m.exam)} pts` : 'no exam yet'} · ${new Date(m.time).toLocaleString()}${m.auto ? ' · automatic' : ''}${m.pinned ? ' · pinned' : ''}</span>
      <span class="sub mono">${m.config.collect} lesson matches / gen · ${m.config.horizon} s play-outs${m.config.preset ? ` · ${esc(S?.presets.find((p) => p.id === m.config.preset)?.label ?? m.config.preset)}` : ''}</span></div>
      <div class="row"><button type="button" data-do="rewind">Rewind here</button><button type="button" class="quiet" data-do="fork">Fork</button><button type="button" class="quiet" data-do="rename">Rename</button><button type="button" class="quiet" data-do="pin">${m.pinned ? 'Unpin' : 'Pin'}</button><button type="button" class="quiet danger" data-do="delete">Delete</button></div>
    </div>`,
        )
        .join('')
    : '<p class="hint">No checkpoints yet.</p>';
  renderEvalTargets();
}
$('ckList').onclick = async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-do]');
  if (!b || !run) return;
  const id = b.closest<HTMLElement>('.ck')!.dataset.id!;
  const m = run.checkpoints.find((q) => q.id === id)!;
  const what = b.dataset.do;
  if (what === 'rewind') {
    if (!(await ask('Rewind the run?', `Go back to "${m.label}" (generation ${m.gen}). Generations after it are removed from this run. The present is saved first as a pinned checkpoint, so you can come back.${run.running ? ' Training stops; the generation in progress is discarded.' : ''}`, 'Rewind'))) return;
    await act(post(`/api/checkpoints/${id}/rewind`), `rewound to generation ${m.gen}`);
  } else if (what === 'fork') openFork(id, `from "${m.label}" (generation ${m.gen})`);
  else if (what === 'rename') {
    const label = await dialog('Rename checkpoint', 'A named checkpoint is never deleted automatically.', 'Rename', { input: { label: 'Name', value: m.label } });
    if (label) await act(post(`/api/checkpoints/${id}/rename`, { label }));
  } else if (what === 'pin') await act(post(`/api/checkpoints/${id}/pin`, { pinned: !m.pinned }));
  else if (what === 'delete') {
    if (!(await ask('Delete this checkpoint?', `"${m.label}" (generation ${m.gen}) is removed from disk. This cannot be undone.`, 'Delete', 'delete'))) return;
    await act(post(`/api/checkpoints/${id}/delete`), 'checkpoint deleted');
  }
};
for (const [id, which, what] of [
  ['ckDelAuto', 'auto', 'every automatic checkpoint that is not pinned'],
  ['ckDelUnpinned', 'unpinned', 'every checkpoint that is not pinned (named ones too)'],
] as const) {
  $(id).onclick = async () => {
    if (!run) return;
    if (!(await ask('Delete checkpoints?', `This removes ${what} from disk. Pinned checkpoints stay. This cannot be undone.`, 'Delete', 'delete'))) return;
    try {
      const r = await post<{ deleted: number }>('/api/checkpoints/delete-many', { which });
      toast(`${r.deleted} checkpoint${r.deleted === 1 ? '' : 's'} deleted`);
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
}
$('ckForm').onsubmit = async (e) => {
  e.preventDefault();
  const label = $<HTMLInputElement>('ckLabel').value.trim();
  if (await act(post('/api/checkpoints', { label }), 'checkpoint saved')) $<HTMLInputElement>('ckLabel').value = '';
};

// ─────────────────────────────── settings: presets + every setting ───────────────────────────────
type FieldDef = { key: string; label: string; type: 'number' | 'select' | 'check'; step?: string; min?: string; max?: string; opts?: [string, string][]; help?: string };
const COLLECT: FieldDef[] = [
  { key: 'collect', label: 'Lesson matches per generation', type: 'number', min: '1', max: '512', help: 'the champion plays these; its decisions become lessons' },
  { key: 'thinkRate', label: 'Re-thinks that are lessons', type: 'number', step: '0.01', min: '0', max: '1', help: 'share of the quarter-second re-thinks (every job start is a lesson)' },
  { key: 'horizon', label: 'Play-out length', type: 'number', step: '1', min: '1', max: '60', help: 'seconds each option is played out, then the predictor counts the rest' },
  { key: 'rounds', label: 'Luck draws', type: 'number', min: '1', max: '8', help: 'per lesson; each keeps the better half of the options' },
];
const LEARN: FieldDef[] = [
  { key: 'window', label: 'Generations of lessons remembered', type: 'number', min: '1', max: '50' },
  { key: 'epochs', label: 'Epochs (at most)', type: 'number', min: '1', max: '1000', help: 'stops early when it stops improving on lessons it never saw' },
  { key: 'lr', label: 'Learning rate', type: 'number', step: '0.0001', min: '0.00001', max: '0.1' },
  { key: 'anchor', label: 'Pull toward the champion', type: 'number', step: '0.0001', min: '0', max: '10', help: 'keeps each step small and safe' },
  { key: 'demoWeight', label: 'Your replays\' weight', type: 'number', step: '0.05', min: '0', max: '10', help: 'at generation 0, relative to a lesson' },
  { key: 'demoFade', label: '…fading out over', type: 'number', min: '0', help: 'generations (0 = not used)' },
];
const SKILLS: FieldDef[] = [
  { key: 'cmaPop', label: 'Skill settings tried', type: 'number', min: '0', max: '64', help: 'per generation (0 = off, else 4 or more)' },
  { key: 'cmaMatches', label: 'Matches each', type: 'number', min: '1', max: '64', help: 'against the champion, same luck' },
  { key: 'cmaSigma', label: 'First step size', type: 'number', step: '0.05', min: '0.01', max: '5' },
];
const RACE: FieldDef[] = [
  { key: 'raceMatches', label: 'Race matches', type: 'number', min: '2', max: '64', help: 'fresh matches per contender per generation' },
  { key: 'examMatches', label: 'Exam matches', type: 'number', min: '4', max: '512', help: 'the same matches for every run (changing it re-measures the bar)' },
  { key: 'examEvery', label: 'Exam at least every', type: 'number', min: '0', help: 'generations (0 = only for a new champion)' },
  { key: 'searchExam', label: 'Also exam the champion thinking ahead during the match', type: 'check' },
];
const WORLD: FieldDef[] = [{ key: 'driver', label: 'Driver', type: 'select', opts: [['oracle', 'exact'], ['human', 'human reaction time']] }];
const HOUSE: FieldDef[] = [
  { key: 'workers', label: 'CPU workers', type: 'number', min: '1', max: '64', help: 'cores used' },
  { key: 'ckEvery', label: 'Auto checkpoint every', type: 'number', min: '0', help: 'generations (0 = off)' },
  { key: 'ckKeep', label: 'Auto checkpoints kept', type: 'number', min: '1' },
  { key: 'keepGens', label: 'Generations kept on disk', type: 'number', min: '10' },
  { key: 'maxGens', label: 'Stop at generation', type: 'number', min: '0', help: '0 = never' },
];
const getPath = (o: unknown, k: string): unknown => k.split('.').reduce<unknown>((a, p) => (a as Record<string, unknown>)?.[p], o);
function fieldHtml(d: FieldDef, cfg: RunConfig): string {
  const v = getPath(cfg, d.key);
  const help = d.help ? `<span class="sub">${d.help}</span>` : '';
  if (d.type === 'check') return `<label class="check"><input type="checkbox" data-key="${d.key}" ${v ? 'checked' : ''}/> ${d.label}</label>`;
  if (d.type === 'select') return `<label>${d.label}<select data-key="${d.key}">${d.opts!.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('')}</select>${help}</label>`;
  return `<label>${d.label}<input type="number" data-key="${d.key}" value="${v}" ${d.step ? `step="${d.step}"` : ''} ${d.min ? `min="${d.min}"` : ''} ${d.max ? `max="${d.max}"` : ''}/>${help}</label>`;
}
let presetPick = '';
const KEY_LABEL: Record<string, string> = {
  workers: 'workers',
  collect: 'lesson matches',
  rounds: 'luck draws',
  window: 'generations remembered',
  demoWeight: 'replay weight',
  demoFade: 'replay fade',
  cmaPop: 'skill settings tried',
  cmaMatches: 'matches each',
  raceMatches: 'race matches',
  examMatches: 'exam matches',
  examEvery: 'exam every',
  searchExam: 'thinking-ahead exam',
  horizon: 'play-out s',
};
function renderPresets(): void {
  const list = S?.presets ?? [];
  const c = run?.config;
  const cur = c?.preset ?? '';
  if (!presetPick || !list.some((p) => p.id === presetPick)) presetPick = cur || 'balanced';
  $('presetNow').textContent = !run ? '' : cur ? `now: ${list.find((p) => p.id === cur)?.label ?? cur}` : 'now: custom settings';
  $('presetList').innerHTML = list
    .map(
      (p) => `<button type="button" role="radio" aria-checked="${p.id === presetPick}" data-preset="${p.id}" class="preset${p.id === cur ? ' current' : ''}"><b>${esc(p.label)}</b>${p.id === cur ? '<span class="tag">in use</span>' : ''}<span>${esc(p.blurb)}</span></button>`,
    )
    .join('');
  const p = list.find((q) => q.id === presetPick);
  const diff = p && c ? Object.entries(p.change).filter(([k, v]) => JSON.stringify((c as unknown as Record<string, unknown>)[k]) !== JSON.stringify(v)) : [];
  $('presetDiff').textContent = !run ? 'Open a run to apply a preset (new runs choose one when created).' : !diff.length ? (p?.id === cur ? 'This preset is in use.' : 'Same values as now.') : `Changes: ${diff.map(([k, v]) => `${KEY_LABEL[k] ?? k} ${String((c as unknown as Record<string, unknown>)[k])} → ${String(v)}`).join(' · ')}`;
  ($('presetApply') as HTMLButtonElement).disabled = !run || !p || (!diff.length && p.id === cur);
}
$('presetList').onclick = (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-preset]');
  if (!b) return;
  presetPick = b.dataset.preset!;
  renderPresets();
};
$('presetApply').onclick = async () => {
  try {
    const r = await post<{ changed: Record<string, unknown> }>('/api/presets/apply', { id: presetPick });
    toast(Object.keys(r.changed).length ? `preset applied — from the next generation` : 'nothing changed');
  } catch (err) {
    toast((err as Error).message, true);
  }
};
function renderSettings(): void {
  renderPresets();
  if (!run) return;
  const c = run.config;
  const put = (id: string, defs: FieldDef[]): void => void ($(id).innerHTML = defs.map((d) => fieldHtml(d, c)).join(''));
  put('cfgCollect', COLLECT);
  put('cfgLearn', LEARN);
  put('cfgSkills', SKILLS);
  put('cfgRace', RACE);
  put('cfgWorld', WORLD);
  put('cfgHouse', HOUSE);
  $('cfgFixed').textContent = `Fixed for this run (fork or start a new run to change): seed ${c.seed}, robot ${c.profile}${c.sampleProfile ? ' (a new one from its range every match)' : ''}.`;
}
$('cfgReset').onclick = renderSettings;
$('cfgForm').onsubmit = async (e) => {
  e.preventDefault();
  if (!run) return;
  const change: Record<string, unknown> = {};
  for (const el of $('cfgForm').querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]')) {
    const k = el.dataset.key!;
    const v = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el instanceof HTMLInputElement ? Number(el.value) : el.value;
    const [a, b] = k.split('.');
    if (b) change[a] = { ...((change[a] as object) ?? (run.config as unknown as Record<string, object>)[a]), [b]: v };
    else change[a] = v;
  }
  try {
    const r = await post<{ changed: Record<string, unknown> }>('/api/config', change);
    const n = Object.keys(r.changed).filter((k) => k !== 'preset').length;
    toast(n ? `applied: ${Object.keys(r.changed).filter((k) => k !== 'preset').join(', ')} — from the next generation` : 'nothing changed');
  } catch (err) {
    toast((err as Error).message, true);
  }
};

// ─────────────────────────────── training data ───────────────────────────────
function renderData(): void {
  const D: DataInfo | undefined = S?.data;
  if (!D) return;
  const changed = !D.fitted || !D.built;
  $('dataState').textContent = D.refreshing ? 'refreshing…' : !D.files.length ? 'no replays' : changed ? 'changed — press Refresh' : `${D.fitted!.samples} decisions learned`;
  $('dataList').innerHTML = D.files.length
    ? `<table><thead><tr><th></th><th class="l">replay</th><th>score</th><th>lessons</th></tr></thead><tbody>${D.files
        .map((f) => {
          const i = f.info;
          const note = i?.error ? `<span class="bad" title="${esc(i.error)}">could not be re-simulated</span>` : i ? `${i.samples}` : '<span class="sub">not yet</span>';
          return `<tr><td><input type="checkbox" data-file="${esc(f.name)}" ${f.included ? 'checked' : ''} aria-label="learn from ${esc(f.name)}" ${D.refreshing ? 'disabled' : ''}/></td><td class="l mono" title="${esc(f.name)}">${esc(f.name.replace(/^dsim-biobuzz-/, '').replace(/\.json$/, '').slice(0, 26))}</td><td>${i && !i.error ? i.score : '—'}</td><td>${note}</td></tr>`;
        })
        .join('')}</tbody></table>`
    : `<p class="hint">No replays yet. Add DSIM replays of good runs; the robots learn which choices they made.</p>`;
  ($('dataRefresh') as HTMLButtonElement).disabled = D.refreshing || !D.files.some((f) => f.included);
  $('dataRefresh').textContent = D.refreshing ? 'Refreshing…' : 'Refresh training data';
  const rd = run?.data;
  $('dataRun').innerHTML = !run
    ? ''
    : !rd?.key
      ? 'The open run learns from no replays.'
      : rd.key === D.latest
        ? `The open run uses these replays. ${D.fitted ? `The fitted network picks the same next option as you ${pct(D.fitted.agree)} of the time on a replay it never saw (chance ${pct(D.fitted.chance)}).` : ''}`
        : `The open run uses an older set of replays. ${D.built && D.fitted ? '<button type="button" class="link" id="dataUse">Use the current set</button>' : 'Refresh to build the current set.'}`;
  const use = document.getElementById('dataUse');
  if (use) use.onclick = () => void act(post('/api/data/use'), 'the run uses the current set from its next generation');
}
$('dataList').onchange = (e) => {
  const cb = e.target as HTMLInputElement;
  if (!cb.dataset.file) return;
  void act(post('/api/data/include', { name: cb.dataset.file, included: cb.checked }), cb.checked ? 'included — press Refresh to learn from it' : 'left out — press Refresh to apply');
};
$('dataRefresh').onclick = () => void act(post('/api/data/refresh'));
$<HTMLInputElement>('dataUpload').onchange = async (e) => {
  const files = [...((e.target as HTMLInputElement).files ?? [])];
  for (const f of files) {
    try {
      await post('/api/data/upload', { name: f.name, content: await f.text() });
      toast(`${f.name} added — press Refresh to learn from it`);
    } catch (err) {
      toast(`${f.name}: ${(err as Error).message}`, true);
    }
  }
  (e.target as HTMLInputElement).value = '';
};

// ─────────────────────────────── evaluation ───────────────────────────────
function renderEvalTargets(): void {
  const sel = $<HTMLSelectElement>('evalTarget');
  const keep = sel.value;
  const cks = run?.checkpoints ?? [];
  sel.innerHTML = [
    ['champion', 'Champion (its network alone)'],
    ['player', 'Champion thinking ahead during the match'],
    ['greedy', 'Greedy baseline (no learning)'],
    ['baseline', 'The no-learning robot as a network (the starting champion)'],
    ['imitation', 'Imitation of your replays'],
    ...cks.map((m) => [m.id, `Checkpoint: ${m.label} (gen ${m.gen})`]),
  ]
    .map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`)
    .join('');
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}
function renderEvals(list: EvalResult[]): void {
  $('evalList').innerHTML = list.length
    ? `<table><thead><tr><th>policy</th><th>gen</th><th>matches</th><th>mean ± 95%</th><th>min–max</th><th>tips</th><th>lived</th></tr></thead><tbody>${[...list]
        .reverse()
        .map((e) => `<tr><td class="l">${esc(e.target)}</td><td>${e.gen}</td><td>${e.n}</td><td>${e.mean.toFixed(1)} ± ${e.ci95.toFixed(1)}</td><td>${e.min}–${e.max}</td><td>${e.tips.toFixed(1)}</td><td>${e.deaths.survived}/${e.n}</td></tr>`)
        .join('')}</tbody></table>`
    : '<p class="hint">No evaluations yet. The exam already compares every champion with the no-learning robot; use this for more matches or other policies.</p>';
}
$('evalForm').onsubmit = async (e) => {
  e.preventDefault();
  await act(post('/api/eval', { target: $<HTMLSelectElement>('evalTarget').value, n: Number($<HTMLInputElement>('evalN').value) }), 'evaluation queued — results appear here');
};

// ─────────────────────────────── the field: LIVE or a replay ───────────────────────────────
function setMode(m: typeof mode): void {
  mode = m;
  $('modeLive').setAttribute('aria-selected', String(m === 'live'));
  $('modeBest').setAttribute('aria-selected', String(m === 'best'));
  $('modeChamp').setAttribute('aria-selected', String(m === 'champion'));
  $('transportLive').hidden = m !== 'live';
  $('transportReplay').hidden = m === 'live';
  $('inspector').hidden = m !== 'champion';
  $('empty').hidden = !!run || m === 'playbook' || m === 'replay';
  view.loop = m === 'live';
  if (m !== 'live') view.speed = speed;
  renderViewInfo();
  pace();
}
async function refreshDisk(): Promise<void> {
  onDisk = run ? await getJSON<number[]>('/api/gens').catch(() => []) : [];
}
const newest = (): number => (onDisk.length ? onDisk[onDisk.length - 1] : -1);
function renderViewInfo(): void {
  const n = newest();
  let html = '';
  if (mode === 'replay') html = `${esc(replayLabel)} · exactly as played`;
  else if (mode === 'playbook') html = pbWatching ? `AUTO playbook · ${esc(pbLabel(pbWatching))} · exactly as planned` : 'AUTO playbook';
  else if (!run) html = '';
  else if (mode === 'live') html = liveGen >= 0 ? `generation ${fmt(liveGen)} · the champion's lesson matches · follows training` : run.running && !run.paused ? `generation ${fmt(run.gen)} is being played — its lesson matches appear here when it finishes` : 'no generations yet — press Start training';
  else if (mode === 'best') html = bestGen >= 0 ? `generation ${fmt(bestGen)} · its best lesson match · exactly as played${n > bestGen ? ` · <button type="button" class="link" id="loadNewest">newest: ${fmt(n)}</button>` : ''}` : 'no generations yet';
  else {
    const c = run.champion;
    html = c.parts ? `champion #${c.id} · ${OP_LABEL[c.op] ?? c.op} · exam match 1${champId >= 0 && champId !== c.id ? ` · <button type="button" class="link" id="loadChamp">a new champion (#${c.id})</button>` : ''}` : 'no champion showcase yet';
  }
  $('viewInfo').innerHTML = html;
  const ln = document.getElementById('loadNewest');
  if (ln) ln.onclick = () => void showBest(newest());
  const lc = document.getElementById('loadChamp');
  if (lc) lc.onclick = () => void watchChampion();
}
async function showLive(g: number): Promise<void> {
  if (g < 0) {
    view.gen = null;
    view.mode = 'swarm';
    liveGen = -1;
    setMode('live');
    return;
  }
  try {
    const gf = await getJSON<GenFile>(`/api/gen/${g}`);
    view.loadGeneration(gf);
    view.playing = true;
    liveGen = g;
    comb.selected = g;
    comb.draw();
    setMode('live');
  } catch (e) {
    log(`generation ${g}: ${(e as Error).message}`);
  }
}
async function showBest(g: number): Promise<void> {
  if (g < 0) return toast('No generation on disk yet — press Start training.', true);
  try {
    view.loadFocus(await getJSON<FocusFile>(`/api/gen/${g}/frames`));
    bestGen = g;
    view.playing = true;
    $('play').textContent = 'Pause';
    comb.selected = g;
    comb.draw();
    setMode('best');
  } catch (e) {
    toast((e as Error).message, true);
  }
}
async function watchChampion(): Promise<void> {
  try {
    const f = await getJSON<FocusFile>('/api/best/frames');
    view.loadFocus(f);
    champId = f.lineage.id;
    inspect = f.inspect ?? [];
    inspSearch = !!f.search;
    inspShown = -2;
    view.playing = true;
    $('play').textContent = 'Pause';
    setMode('champion');
  } catch (e) {
    toast((e as Error).message, true);
  }
}
comb.onPick = (g) => void showBest(g);

// ─────────────────────────────── the AUTO playbook ───────────────────────────────
const PARTNER_LABEL: Record<string, string> = { none: 'no partner', real: 'a second REAL-v1', sniper: 'Sniper', hauler: 'Hauler', skimmer: 'Skimmer', parker: 'parks only', idle: 'does nothing' };
const START_SHORT: Record<string, string> = { F3: 'F3', TOP_REAR: 'top rear', BOTTOM_AUD: 'bottom audience', TOP_SIDE: 'top side', BOTTOM_SIDE: 'bottom side' };
const pbLabel = (key: string): string => {
  const [partner, start, pstart, m] = key.split('|');
  return `us at ${START_SHORT[start] ?? start} · ${PARTNER_LABEL[partner] ?? partner}${pstart !== '-' ? ` at ${START_SHORT[pstart] ?? pstart}` : ''}${m === 'joint' ? ' · joint plan' : ''}`;
};
function renderPbStatus(st: PlaybookStatusV): void {
  $('pbStatus').textContent = st.running ? `building ${st.done}/${st.total}${st.current ? ` · ${pbLabel(st.current)}` : ''}` : st.total ? `${st.done}/${st.total} planned in the last build` : '';
  ($('pbFill') as HTMLElement).style.width = st.total ? `${(100 * st.done) / st.total}%` : '0%';
  $<HTMLButtonElement>('pbBuild').disabled = st.running;
  $<HTMLButtonElement>('pbStop').disabled = !st.running;
}
function renderPlaybook(): void {
  if (!PB) return;
  const sel = $<HTMLSelectElement>('pbProfile');
  if (sel.options.length !== PB.profiles.length) sel.innerHTML = PB.profiles.map((p) => `<option value="${esc(p)}">${esc(p.replace('profiles/', '').replace('.json', ''))}</option>`).join('');
  sel.value = PB.profile;
  const filt = $<HTMLSelectElement>('pbFilter');
  if (filt.options.length === 1) filt.innerHTML += Object.entries(PARTNER_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  renderPbStatus(PB.status);
  const f = filt.value;
  const rows = PB.entries.filter((e) => !f || e.problem.partner === f).sort((a, b) => a.key.localeCompare(b.key));
  $('pbList').innerHTML = rows.length
    ? `<table><thead><tr><th>entry</th><th title="our nominal robot, 64 fresh luck draws">AUTO points</th><th title="mean of the worst tenth of those draws">worst tenth</th><th title="the same draws with no plan (every robot its own brain)">vs no plan</th><th title="robots drawn from the profile's range">robot range</th></tr></thead><tbody>${rows
        .map(
          (e) =>
            `<tr data-key="${esc(e.key)}" class="pick${e.key === pbSelected ? ' sel' : ''}"><td>${esc(pbLabel(e.key))}</td><td class="mono">${e.nominal.mean.toFixed(1)} ± ${e.nominal.ci95.toFixed(1)}</td><td class="mono">${e.nominal.cvar10.toFixed(1)}</td><td class="mono">${sgn(e.nominal.mean - e.baseline.mean)}</td><td class="mono">${e.sampled.mean.toFixed(1)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<p class="hint">${PB.status.running ? 'The first entry appears when it is planned.' : 'Nothing planned yet — press Build playbook.'}</p>`;
  for (const tr of $('pbList').querySelectorAll<HTMLTableRowElement>('tr[data-key]')) tr.onclick = () => showPbEntry(tr.dataset.key!);
  if (pbSelected) showPbEntry(pbSelected, false);
}
function showPbEntry(key: string, scroll = true): void {
  const e = PB?.entries.find((q) => q.key === key);
  if (!e) return;
  pbSelected = key;
  for (const tr of $('pbList').querySelectorAll<HTMLTableRowElement>('tr[data-key]')) tr.classList.toggle('sel', tr.dataset.key === key);
  $('pbDetail').hidden = false;
  $('pbTitle').textContent = pbLabel(key);
  const who = (r: number): string => (r === 0 ? 'our robot' : 'partner');
  const t = (tick: number): string => `${Math.max(0, (tick - AUTO_START) / 60).toFixed(1)} s`;
  $('pbSheet').innerHTML = `<p class="hint">${e.nominal.mean.toFixed(1)} ± ${e.nominal.ci95.toFixed(1)} AUTO points (worst tenth ${e.nominal.cvar10.toFixed(1)}); with no plan ${e.baseline.mean.toFixed(1)}; across the robot's range ${e.sampled.mean.toFixed(1)}. ${e.explored} plans scored in ${e.seconds.toFixed(0)} s${e.style ? '; skill settings tuned for it' : ''}.</p>
    ${e.taken.length ? '' : '<p><b>No plan beats the robots\' own AUTO here</b> — run your usual routine (the replay shows it).</p>'}
    <table><thead><tr><th>when</th><th>robot</th><th>job</th></tr></thead><tbody>${e.taken
      .map((q) => `<tr><td class="mono">${t(q.tick)}${q.end ? `–${t(q.end)}` : ''}</td><td>${who(q.robot)}</td><td><i class="dot" style="background:${OPTIONS.find((o) => o.key === q.kind)?.color ?? '#888'}"></i> ${esc(q.label)}${q.matched ? '' : ' <span class="hint">(not there: it chose itself)</span>'}</td></tr>`)
      .join('')}</tbody></table>
    <p class="hint">After its planned steps each robot plays on with its own brain until AUTO ends.</p>`;
  if (scroll) $('pbDetail').scrollIntoView({ block: 'nearest' });
}
async function loadPlaybook(profile?: string): Promise<void> {
  try {
    PB = await getJSON<PlaybookV>(`/api/playbook${profile ? `?profile=${encodeURIComponent(profile)}` : ''}`);
    renderPlaybook();
  } catch (e) {
    $('pbList').innerHTML = `<p class="hint">${esc((e as Error).message)}</p>`;
  }
}
async function watchPlaybook(key: string): Promise<void> {
  if (!PB) return;
  try {
    const r = await getJSON<{ frames: Frames; events: [number, string][] }>(`/api/playbook/frames?profile=${encodeURIComponent(PB.profile)}&key=${encodeURIComponent(key)}`);
    view.loadFocus({ gen: 0, fitness: 0, score: 0, death: 'survived', parts: { pickups: 0, shotsIn: 0, wasted: 0, hp: 0, tips: 0, violations: 0, strikes: 0 }, lineage: { id: -1, op: 'champion', parents: [], muts: 0, born: 0 }, frames: r.frames, events: r.events } as FocusFile);
    pbWatching = key;
    view.playing = true;
    $('play').textContent = 'Pause';
    setMode('playbook');
  } catch (e) {
    toast((e as Error).message, true);
  }
}
$('pbProfile').onchange = () => void loadPlaybook($<HTMLSelectElement>('pbProfile').value);
$('pbFilter').onchange = () => renderPlaybook();
$('pbWatch').onclick = () => pbSelected && void watchPlaybook(pbSelected);
$('pbBuild').onclick = async () => {
  if (!PB) return;
  const start = $<HTMLSelectElement>('pbStart').value;
  await act(post('/api/playbook/build', { profile: PB.profile, budget: $<HTMLSelectElement>('pbBudget').value, starts: start ? [start] : [] }), 'playbook build started — entries appear as they are planned');
};
$('pbStop').onclick = () => void act(post('/api/playbook/stop', {}), 'the playbook build stops after the entry in progress');
void loadPlaybook();
// ─────────────────────────────── Home: the one button (the continuous engine) ───────────────────────────────
let HOME: HomeV | null = null;
const homeChart = new LineChart<HomeStatusV['history'][number]>($<HTMLCanvasElement>('homeChart'), $('homeLegend'), [{ label: 'champion, alone', color: '--s-best', get: (x) => x.exam }], {
  unit: ' pts',
  zeroBase: false,
  xLabel: (x) => `${x.hours.toFixed(1)} h`,
  tip: (x) => `<b>champion #${x.champion}</b> after ${x.hours.toFixed(1)} h<br>exam ${x.exam.toFixed(1)} · vs no-learning ${sgn(x.vsBase)}<br>${fmt(x.labels)} decisions learned from`,
  empty: 'the first point appears after the no-learning robot\'s exam',
});
function renderHome(): void {
  if (!HOME) return;
  const sel = $<HTMLSelectElement>('homeProfile');
  if (sel.options.length !== HOME.profiles.length) sel.innerHTML = HOME.profiles.map((p) => `<option value="${esc(p)}">${esc(p.replace('profiles/', '').replace('.json', ''))}</option>`).join('');
  sel.value = HOME.profile;
  const s = HOME.status;
  const busy = HOME.busy.v1 ? `the generational run "${HOME.busy.v1}" is training (Overview) — one trainer at a time` : HOME.busy.playbook ? `the ${HOME.busy.playbook} AUTO playbook is being built — it needs every core` : '';
  $<HTMLButtonElement>('homeTrain').disabled = !!s?.running || !!busy;
  $<HTMLButtonElement>('homePause').disabled = !s?.running;
  sel.disabled = !!s?.running;
  const ex = s?.champion.exam;
  $('homeExam').textContent = ex ? ex.mean.toFixed(1) : '—';
  $('homeExamSub').textContent = !s
    ? 'press Train: nothing has been learned yet'
    : ex
      ? `± ${ex.ci95.toFixed(1)} on ${ex.n} fixed matches · ${s.champion.learned ? `${sgn(ex.vsBase.mean)} ± ${ex.vsBase.ci95.toFixed(1)} over the no-learning robot` : 'the no-learning robot (the first network has to beat it)'} · worst tenth ${ex.cvar10.toFixed(0)}`
      : 'the no-learning robot takes the exam first';
  $('homeState').textContent = !s ? 'idle' : s.running ? (s.improving === 'flat' ? 'training · flat' : 'training') : 'paused';
  $('homeState').className = `v${s?.running ? ' on' : ''}`;
  const a = s?.activity;
  $('homeDoing').textContent = !s?.running ? '' : a?.evaluating ? `exam of candidate #${a.evaluating.id}: ${a.evaluating.done}/${a.evaluating.total} matches` : a?.learning ? 'learning a new candidate' : `playing and thinking ahead · next lesson in ${fmt(s.nextLearnIn)} decisions`;
  $('homeCpu').textContent = s?.running ? pct(s.cpu) : '—';
  $('homeHours').textContent = s ? `${s.totals.hours.toFixed(1)} h trained · ${fmt(s.totals.matches)} matches` : '';
  $('homeLabels').textContent = s ? fmt(s.totals.labels) : '0';
  $('homeRate').textContent = s?.labelsPerHour ? `${fmt(s.labelsPerHour)} an hour` : '';
  $('homeChamp').textContent = s ? (s.champion.learned ? `#${s.champion.id}` : 'no-learning') : '—';
  $('homeChampWhen').textContent = s ? `${s.totals.promotions} promoted, ${s.totals.rejections} not${s.lastPromotion ? ` · last ${ago(s.lastPromotion)}` : ''}` : '';
  $('homeTrend').textContent = s?.trend !== null && s?.trend !== undefined ? `${sgn(s.trend)} over the last champions` : '';
  $('homeProblems').textContent = [busy, ...(s?.problems ?? [])].filter(Boolean).join(' · ');
  homeChart.set(s?.history ?? [], s?.base !== null && s?.base !== undefined ? [{ value: s.base, label: `no-learning robot ${s.base.toFixed(0)}` }] : []);
  const PL: Record<string, string> = { none: 'no partner', real: 'a second REAL-v1', sniper: 'Sniper', hauler: 'Hauler', skimmer: 'Skimmer', parker: 'parks only', idle: 'does nothing' };
  $('homePartners').innerHTML = ex
    ? `<table><thead><tr><th class="l">partner</th><th>champion</th></tr></thead><tbody>${Object.entries(ex.byPartner)
        .map(([k, v]) => `<tr><td class="l">${esc(PL[k] ?? k)}</td><td>${v.toFixed(1)}</td></tr>`)
        .join('')}</tbody></table>${s?.searchExam ? `<p class="hint">Thinking ahead (champion #${s.searchExam.champion}, ${s.searchExam.n} solo matches): alone ${s.searchExam.alone.toFixed(1)}, with search ${s.searchExam.search.toFixed(1)} (${sgn(s.searchExam.gain.mean)} ± ${s.searchExam.gain.ci95.toFixed(1)}). The goal: the network alone as good as with search.</p>` : ''}`
    : '<p class="hint">After the first exam.</p>';
  const OL: Record<string, string> = { none: 'no opponents', presets: 'Skimmer + Sniper', mirror: 'two REAL-v1s', defense: 'a defender + Skimmer' };
  $('homeOpponents').innerHTML = ex?.byOpponents
    ? `<table><thead><tr><th class="l">red alliance</th><th>champion</th></tr></thead><tbody>${Object.entries(ex.byOpponents)
        .map(([k, v]) => `<tr><td class="l">${esc(OL[k] ?? k)}</td><td>${v.toFixed(1)}</td></tr>`)
        .join('')}</tbody></table>`
    : '<p class="hint">After the first exam.</p>';
  const L = s?.learner;
  $('homeLearner').textContent = L?.last ? `last lesson: agrees with the search ${pct(L.last.agree)} of held-out decisions, gives away ${L.last.regret.toFixed(1)} pts each · learning rate ${L.lr.toPrecision(2)}` : '';
  $('homeCands').innerHTML = s?.candidates.length
    ? `<table><thead><tr><th>#</th><th class="l">verdict</th><th title="paired with the champion on the same exam matches">vs champion</th><th>matches</th><th title="held-out decisions where its first choice is the search's">agrees</th></tr></thead><tbody>${[...s.candidates]
        .reverse()
        .map((c) => `<tr><td>${c.id}</td><td class="l">${c.verdict === 'promoted' ? '★ promoted' : 'not better'}</td><td>${sgn(c.diff.mean)} ± ${c.diff.ci95.toFixed(1)}</td><td>${c.n}</td><td>${pct(c.learn.agree)}</td></tr>`)
        .join('')}</tbody></table>`
    : `<p class="hint">${s?.running ? `The first candidate is learned after ${fmt(s.nextLearnIn)} more decisions.` : 'None yet.'}</p>`;
  $('homeLog').innerHTML = (s?.log ?? []).slice().reverse().map((l) => `<div>${esc(l)}</div>`).join('');
}
async function loadHome(profile?: string): Promise<void> {
  try {
    HOME = await getJSON<HomeV>(`/api/home${profile ? `?profile=${encodeURIComponent(profile)}` : ''}`);
    renderHome();
  } catch (e) {
    $('homeProblems').textContent = (e as Error).message;
  }
}
$('homeProfile').onchange = () =>
  void loadHome($<HTMLSelectElement>('homeProfile').value).then(() => {
    void loadRoutes();
    void loadMistakes();
  });
$('homeTrain').onclick = async () => {
  try {
    HOME = await post<HomeV>('/api/home/train', { profile: $<HTMLSelectElement>('homeProfile').value });
    renderHome();
    toast('training — it keeps going until you pause');
  } catch (e) {
    toast((e as Error).message, true);
  }
};
$('homePause').onclick = async () => {
  try {
    HOME = await post<HomeV>('/api/home/pause', {});
    renderHome();
  } catch (e) {
    toast((e as Error).message, true);
  }
};
void loadHome();
window.setInterval(() => HOME && renderHome(), 60_000); // "… min ago"

// ─────────────────────────────── Routes: the route library ───────────────────────────────
let RT: { profile: string; library: RouteLibraryV | null } | null = null;
let rtSel = -1;
function renderRoutes(): void {
  const L = RT?.library;
  $('rtWhen').textContent = L ? `champion ${L.champion ? `#${L.champion}` : '(no-learning)'} · ${L.cycles} cycles in ${L.matches} exam matches` : '';
  if (!L) {
    $('rtList').innerHTML = '<p class="hint">After the first exam on the Home page.</p>';
    $('rtOpen').innerHTML = '';
    $('rtDetail').hidden = true;
    return;
  }
  const rows = L.routes.filter((r) => r.n >= 3);
  $('rtList').innerHTML = rows.length
    ? `<table><thead><tr><th class="l">collect</th><th class="l">shoot from</th><th title="cycles, and their share of all cycles">cycles</th><th title="mean cycle time, volley to volley">s</th><th title="our robot's elements into the HIVE per cycle">in</th><th title="…per minute of the route: the rate">in/min</th><th title="the alliance's points meanwhile (they arrive in lumps when a HIVE tips)">alliance pts</th></tr></thead><tbody>${rows
        .map((r, i) => `<tr data-i="${i}" class="pick${i === rtSel ? ' sel' : ''}"><td class="l">${esc(r.collect)}</td><td class="l">${esc(r.shoot)}</td><td>${r.n} (${pct(r.share)})</td><td>${r.seconds.toFixed(1)}</td><td>${r.mine.toFixed(1)}</td><td>${r.inPerMin.toFixed(1)}</td><td>${r.points.toFixed(1)}</td></tr>`)
        .join('')}</tbody></table>`
    : '<p class="hint">No route was used 3 times yet.</p>';
  for (const tr of $('rtList').querySelectorAll<HTMLTableRowElement>('tr[data-i]'))
    tr.onclick = () => {
      rtSel = Number(tr.dataset.i);
      renderRoutes();
    };
  const r = rows[rtSel];
  $('rtDetail').hidden = !r;
  if (r) {
    $('rtTitle').textContent = r.sig;
    const PL: Record<string, string> = { none: 'no partner', real: 'a second REAL-v1', sniper: 'Sniper', hauler: 'Hauler', skimmer: 'Skimmer', parker: 'parks only', idle: 'does nothing' };
    const OL: Record<string, string> = { none: 'no opponents', presets: 'Skimmer + Sniper', mirror: 'two REAL-v1s', defense: 'a defender + Skimmer' };
    const list = (o: Record<string, number>, names: Record<string, string>): string =>
      Object.entries(o)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${esc(names[k] ?? k)} ${v}`)
        .join(' · ');
    $('rtSheet').innerHTML = `<table><tbody>
      <tr><td class="l">when</td><td class="l">AUTO ${r.when.auto} · TELEOP ${r.when.teleop} · last 30 s ${r.when.endgame}</td></tr>
      <tr><td class="l">beside</td><td class="l">${list(r.byPartner, PL)}</td></tr>
      <tr><td class="l">against</td><td class="l">${list(r.byOpponents, OL)}</td></tr>
      <tr><td class="l">example</td><td class="l">exam match ${r.example.match + 1}, ${((r.example.t0 - AUTO_START) / 60).toFixed(1)}–${((r.example.t1 - AUTO_START) / 60).toFixed(1)} s</td></tr>
    </tbody></table>`;
  }
  $('rtOpen').innerHTML = L.openings.length
    ? `<table><thead><tr><th class="l">first TELEOP places</th><th>matches</th><th title="the match's reward">points</th></tr></thead><tbody>${L.openings
        .map((o) => `<tr><td class="l">${esc(o.seq)}</td><td>${o.n}</td><td>${o.reward.toFixed(1)}</td></tr>`)
        .join('')}</tbody></table>`
    : '';
}
async function loadRoutes(): Promise<void> {
  try {
    RT = await getJSON<{ profile: string; library: RouteLibraryV | null }>(`/api/routes${HOME?.profile ? `?profile=${encodeURIComponent(HOME.profile)}` : ''}`);
    renderRoutes();
  } catch (e) {
    $('rtList').innerHTML = `<p class="hint">${esc((e as Error).message)}</p>`;
  }
}
$('rtWatch').onclick = async () => {
  const r = RT?.library?.routes.filter((q) => q.n >= 3)[rtSel];
  if (!r || !RT) return;
  try {
    toast('playing that exam match in DSIM…');
    const f = await post<{ frames: Frames; events: [number, string][] }>('/api/routes/watch', { profile: RT.profile, match: r.example.match });
    view.loadFocus({ gen: 0, fitness: 0, score: 0, death: 'survived', parts: { pickups: 0, shotsIn: 0, wasted: 0, hp: 0, tips: 0, violations: 0, strikes: 0 }, lineage: { id: -1, op: 'champion', parents: [], muts: 0, born: 0 }, frames: f.frames, events: f.events } as FocusFile);
    view.seek(r.example.t0);
    view.playing = true;
    $('play').textContent = 'Pause';
    replayLabel = `route · ${r.sig} · the champion's exam match ${r.example.match + 1}`;
    setMode('replay');
  } catch (e) {
    toast((e as Error).message, true);
  }
};
void loadRoutes();

// ─────────────────────────────── Mistakes: the audit ───────────────────────────────
const MK_LABEL: Record<string, string> = { 'empty-trip': 'empty trip', 'blocked-shot': 'blocked shot', idle: 'idle', foul: 'foul', stall: 'stall', crash: 'crash', judgement: 'judgement' };
let MK: { profile: string; audit: AuditV | null; history: AuditPointV[]; drills: { n: number; used: number; played: number } | null } | null = null;
const mkChart = new LineChart<AuditPointV>($<HTMLCanvasElement>('mkChart'), $('mkLegend'), [
  { label: 'mistakes', color: '--s-mean', get: (x) => x.perMatch },
  { label: 'repeats', color: '--s-best', get: (x) => x.repeats },
], { unit: '', zeroBase: true, xLabel: (x) => (x.champion ? `#${x.champion}` : 'no-learning'), tip: (x) => `<b>${x.champion ? `champion #${x.champion}` : 'the no-learning robot'}</b><br>${x.perMatch.toFixed(2)} mistakes per match, ${x.repeats.toFixed(2)} repeats${x.judgement !== null ? `<br>${x.judgement.toFixed(1)} judgement mistakes per thinking-ahead match` : ''}`, empty: 'after the first exam' });
function renderMistakes(): void {
  const a = MK?.audit;
  const h = MK?.history ?? [];
  const last = h[h.length - 1];
  $('mkRepeats').textContent = last ? last.repeats.toFixed(2) : '—';
  $('mkPer').textContent = last ? last.perMatch.toFixed(1) : '—';
  $('mkWho').textContent = a ? `${a.champion ? `champion #${a.champion}` : 'the no-learning robot'} · ${a.matches} exam matches` : '';
  mkChart.set(h);
  const kinds = Object.keys(MK_LABEL);
  $('mkKinds').innerHTML = h.length
    ? `<table><thead><tr><th class="l">champion</th>${kinds.map((k) => `<th>${MK_LABEL[k]}</th>`).join('')}<th>repeats</th></tr></thead><tbody>${[...h]
        .reverse()
        .slice(0, 12)
        .map((x) => `<tr><td class="l">${x.champion ? `#${x.champion}` : 'no-learning'}</td>${kinds.map((k) => `<td>${k === 'judgement' ? (x.judgement === null ? '—' : x.judgement.toFixed(1)) : (x.byKind[k as keyof typeof x.byKind] ?? 0).toFixed(2)}</td>`).join('')}<td>${x.repeats.toFixed(2)}</td></tr>`)
        .join('')}</tbody></table>`
    : '';
  const d = MK?.drills;
  $('mkDrills').textContent = d ? `${fmt(d.n)} drills waiting (${fmt(d.used)} practised at least once) · ${fmt(d.played)} drill matches played` : '';
  const f = $<HTMLSelectElement>('mkFilter');
  if (f.options.length === 2) f.innerHTML += kinds.map((k) => `<option value="${k}">${MK_LABEL[k]}</option>`).join('');
  if (!a) {
    $('mkList').innerHTML = '<p class="hint">After the first exam on the Home page.</p>';
    return;
  }
  const rows = a.items.map((it, i) => ({ it, i })).filter(({ it }) => !f.value || (f.value === 'repeat' ? it.repeat : it.kind === f.value));
  rows.sort((p, q) => Number(q.it.repeat) - Number(p.it.repeat) || q.it.cost - p.it.cost);
  const unit = (k: string): string => (k === 'foul' || k === 'judgement' ? ' pts' : k === 'crash' ? '' : ' s');
  $('mkList').innerHTML = rows.length
    ? `<table><thead><tr><th>match</th><th>time</th><th class="l">kind</th><th class="l">what</th><th>cost</th><th></th></tr></thead><tbody>${rows
        .slice(0, 300)
        .map(({ it, i }) => `<tr><td>${it.match + 1}</td><td>${((it.tick - AUTO_START) / 60).toFixed(1)} s</td><td class="l">${MK_LABEL[it.kind]}${it.repeat ? ' <b>· repeat</b>' : ''}</td><td class="l">${esc(it.detail)}</td><td>${it.kind === 'crash' ? '' : it.cost.toFixed(1)}${unit(it.kind)}</td><td><button type="button" class="link" data-mk="${i}">watch</button></td></tr>`)
        .join('')}</tbody></table>`
    : '<p class="hint">None of this kind.</p>';
  for (const b of $('mkList').querySelectorAll<HTMLButtonElement>('button[data-mk]')) b.onclick = () => void watchMistake(Number(b.dataset.mk));
}
async function loadMistakes(): Promise<void> {
  try {
    MK = await getJSON(`/api/mistakes${HOME?.profile ? `?profile=${encodeURIComponent(HOME.profile)}` : ''}`);
    renderMistakes();
  } catch (e) {
    $('mkList').innerHTML = `<p class="hint">${esc((e as Error).message)}</p>`;
  }
}
async function watchMistake(i: number): Promise<void> {
  const it = MK?.audit?.items[i];
  if (!it || !MK) return;
  try {
    toast('replaying that exam match in DSIM…');
    const f = await post<{ frames: Frames; events: [number, string][]; tick: number }>('/api/mistakes/watch', { profile: MK.profile, i });
    view.loadFocus({ gen: 0, fitness: 0, score: 0, death: 'survived', parts: { pickups: 0, shotsIn: 0, wasted: 0, hp: 0, tips: 0, violations: 0, strikes: 0 }, lineage: { id: -1, op: 'champion', parents: [], muts: 0, born: 0 }, frames: f.frames, events: f.events } as FocusFile);
    view.seek(Math.max(0, f.tick - 180));
    view.playing = true;
    $('play').textContent = 'Pause';
    replayLabel = `mistake · ${MK_LABEL[it.kind]}: ${it.detail} · exam match ${it.match + 1} at ${((it.tick - AUTO_START) / 60).toFixed(1)} s (from 3 s before)`;
    setMode('replay');
  } catch (e) {
    toast((e as Error).message, true);
  }
}
$('mkFilter').onchange = () => renderMistakes();
void loadMistakes();

$('modeLive').onclick = () => void showLive(newest());
$('modeBest').onclick = () => void showBest(newest());
$('modeChamp').onclick = () => void watchChampion();
$('watchChamp').onclick = () => void watchChampion();
$('copySnippet').onclick = async () => {
  try {
    const r = await fetch('/api/best.inject.js', { cache: 'no-store' });
    await navigator.clipboard.writeText(await r.text());
    $('snippetHint').textContent = 'Copied. In DSIM (http://localhost:5173) paste it into the console (Safari: Develop → Show Web Inspector), then open Records → Career.';
  } catch {
    $('snippetHint').textContent = 'Copying was blocked by the browser. Open /api/best.inject.js and copy it by hand.';
  }
};
$('tableToggle').onclick = () => {
  const t = $('fitTable');
  t.hidden = !t.hidden;
  $('tableToggle').textContent = t.hidden ? 'Show table' : 'Hide table';
  if (!t.hidden) t.innerHTML = historyTable(hist);
};

/** LIVE keeps pace with training: the newest generation's replay lasts about as long as the next
 * generation takes to run, so the field is always the present. Not training: real time (1×). */
function pace(): void {
  if (mode !== 'live') return;
  const last = hist[hist.length - 1];
  const matchS = Math.max(1, (view.endTick - AUTO_START) / 60);
  const training = !!run?.running && !run.paused && !!last;
  view.speed = training ? Math.max(1, Math.min(120, matchS / Math.max(4, last!.wallS))) : 1;
  $('pace').textContent = training ? `${view.speed.toFixed(view.speed < 10 ? 1 : 0)}× · keeping pace with training` : '1× · real time';
}

// replay transport (1× / 2×, pause, restart, scrub)
for (const b of document.querySelectorAll<HTMLButtonElement>('.seg [data-speed]')) {
  b.setAttribute('aria-checked', String(Number(b.dataset.speed) === speed));
  b.onclick = () => {
    speed = Number(b.dataset.speed) === 2 ? 2 : 1;
    try {
      localStorage.setItem('bb.speed', String(speed));
    } catch {
      /* not remembered */
    }
    for (const o of document.querySelectorAll<HTMLButtonElement>('.seg [data-speed]')) o.setAttribute('aria-checked', String(o === b));
    if (mode !== 'live') view.speed = speed;
  };
}
$('play').onclick = () => {
  if (!view.playing && view.tick >= view.endTick) view.seek(view.startTick);
  view.playing = !view.playing;
  $('play').textContent = view.playing ? 'Pause' : 'Play';
};
$('restart').onclick = () => {
  view.seek(view.startTick);
  view.playing = true;
  $('play').textContent = 'Pause';
};
view.onEnd = () => {
  $('play').textContent = 'Replay';
};
const scrub = $<HTMLInputElement>('scrub');
scrub.oninput = () => {
  const lo = view.startTick;
  view.seek(Math.round(lo + (Number(scrub.value) / 1000) * (view.endTick - lo)));
};
const clock = (t: number): string => {
  const s = Math.max(0, (t - AUTO_START) / 60);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
view.onFrame = (f: FrameInfo) => {
  const lo = view.startTick;
  const frac = (f.tick - lo) / Math.max(1, f.end - lo);
  if (mode === 'live') {
    $('liveFill').style.transform = `scaleX(${Math.max(0, Math.min(1, frac))})`;
    $('clockLive').textContent = clock(f.tick);
  } else {
    if (document.activeElement !== scrub) scrub.value = String(Math.round(1000 * frac));
    $('clock').textContent = clock(f.tick);
  }
  if (f.mode === 'swarm') {
    $('overlay').innerHTML = `<span class="alive">${f.alive}</span>of ${f.total} lesson matches still playing · generation ${fmt(liveGen)}`;
  } else {
    const opt = f.optionKind !== undefined ? OPTIONS[f.optionKind] : undefined;
    const hop = [...(f.hopper ?? '')].map((c) => `<i class="dot ${c}"></i>`).join('') || '<span class="sub">empty</span>';
    const ph = f.phase === 'teleop' ? 'TELEOP' : f.phase === 'auto' ? 'AUTO' : (f.phase ?? '').toUpperCase();
    if (mode === 'champion') renderInspector(f.tick);
    $('overlay').innerHTML = `<span class="alive">${f.score ?? 0}</span>DSIM points · ${f.tips ?? 0} tips · ${ph} ${Math.max(0, f.phaseLeft ?? 0).toFixed(0)} s<br>hopper ${hop}<br>${opt ? `<i class="optsw" style="background:${opt.color}"></i>${esc(f.option ?? '')}` : '<span class="sub">deciding…</span>'}<br><span class="sub">${mode === 'champion' ? `champion #${champId}` : mode === 'playbook' ? 'AUTO playbook, luck draw 1' : mode === 'replay' ? esc(replayLabel) : `best lesson match of generation ${fmt(bestGen)}`} · exactly as played · ${speed}×</span>`;
  }
};
/** the decision the champion was at on this tick: every option it had, what the network scored,
 * and what each made when played out (what-if) — and which one it took */
function renderInspector(tick: number): void {
  let lo = 0;
  let hi = inspect.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (inspect[mid].t <= tick) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (at === inspShown) return;
  inspShown = at;
  $('inspHint').textContent = inspSearch
    ? 'Thinking ahead: at each job start the network\'s best 3 options were played 10 s ahead on copies of the match (2 luck draws each, never the real future), then the predictor valued the rest; it took the best one unless that led by less than 3 points.'
    : 'What-if: at each job start every option was played out on copies of the match; the robot itself followed its network.';
  if (at < 0) {
    $('inspWhen').textContent = '';
    $('inspBody').innerHTML = `<p class="hint">${inspect.length ? 'Its first decision comes when AUTO starts.' : 'This showcase has no decisions recorded.'}</p>`;
    return;
  }
  const d = inspect[at];
  const sec = Math.max(0, (d.t - AUTO_START) / 60);
  $('inspWhen').textContent = `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')} · ${d.at === 'begin' ? 'a job ended: choose the next' : 're-think while working'} · decision ${at + 1} of ${inspect.length}`;
  const netBest = d.net;
  const order = d.opts.map((o, i) => ({ o, i })).sort((a, b) => (b.o.q ?? -Infinity) - (a.o.q ?? -Infinity) || b.o.s - a.o.s);
  const bestQ = Math.max(...d.opts.map((o) => o.q ?? -Infinity));
  $('inspBody').innerHTML = `<table><thead><tr><th class="l">option</th><th>network</th><th>what-if points</th><th class="l"></th></tr></thead><tbody>${order
    .map(({ o, i }) => {
      const k = OPTIONS[o.kind];
      const tag = [i === d.chosen ? '<b>✓ chosen</b>' : '', i === d.current ? 'doing' : '', i === netBest && netBest !== d.chosen ? 'network\'s pick' : '', o.q !== null && o.q === bestQ && Number.isFinite(bestQ) ? 'best what-if' : ''].filter(Boolean).join(' · ');
      return `<tr${i === d.chosen ? ' class="sel"' : ''}><td class="l"><i class="optsw" style="background:${k?.color ?? '#888'}"></i>${esc(o.label)}</td><td>${o.s.toFixed(2)}</td><td>${o.q === null ? '—' : o.q.toFixed(1)}</td><td class="l sub">${tag}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}
view.onLoop = () => {
  if (mode === 'live' && pendingGen >= 0) {
    const g = pendingGen;
    pendingGen = -1;
    void showLive(g);
  }
};
let prev = performance.now();
function frame(now: number): void {
  view.step(Math.min(100, now - prev));
  prev = now;
  view.draw();
  requestAnimationFrame(frame);
}

// ─────────────────────────────── controls ───────────────────────────────
$('btnStart').onclick = () => void act(post('/api/control', { action: run?.running ? 'resume' : 'start' }));
$('btnPause').onclick = () => void act(post('/api/control', { action: 'pause' }));
$('btnStep1').onclick = () => void act(post('/api/control', { action: 'step', n: 1 }));
$('btnStep10').onclick = () => void act(post('/api/control', { action: 'step', n: 10 }));
$('btnStop').onclick = () => void act(post('/api/control', { action: 'stop' }), 'stopping after this generation');
$('btnAbort').onclick = async () => {
  if (await ask('Abort this generation?', 'The robots of the generation in progress are thrown away and training stops. The run stays exactly as it was before this generation started.', 'Abort generation')) void act(post('/api/control', { action: 'abort' }));
};
$('runSel').onchange = async () => {
  const name = $<HTMLSelectElement>('runSel').value;
  if (name && !(await act(post('/api/runs/open', { name })))) renderRuns();
};

function showClosed(): void {
  if (closed) return;
  closed = true;
  $('closed').hidden = false;
  window.close(); // works when the browser allows it; otherwise the page says the studio is closed
  setTimeout(() => ($('closedHint').textContent = 'You can close this tab.'), 300);
}
$('btnQuit').onclick = async () => {
  if (!(await ask('Quit the studio?', `Everything stops: ${run?.running ? 'training (the generation in progress is discarded; the run keeps its last finished generation, and training carries on by itself the next time you start the studio — press Stop first if you do not want that), ' : ''}DSIM, and the studio itself. This tab closes. Start again with ./start.sh.`, 'Quit studio'))) return;
  try {
    await post('/api/quit');
    showClosed();
  } catch (e) {
    toast((e as Error).message, true);
  }
};

async function openNew(): Promise<void> {
  const profiles = await getJSON<string[]>('/api/profiles').catch(() => ['profiles/real-v0.json']);
  $('newProfile').innerHTML = profiles.map((p) => `<option value="${p}" ${p.endsWith('real-v0.json') ? 'selected' : ''}>${p.replace('profiles/', '').replace('.json', '')}</option>`).join('');
  $('newPreset').innerHTML = (S?.presets ?? []).map((p) => `<option value="${p.id}" ${p.id === 'balanced' ? 'selected' : ''}>${esc(p.label)}</option>`).join('');
  $('newErr').textContent = '';
  $<HTMLDialogElement>('newDlg').showModal();
}
$('btnNew').onclick = () => void openNew();
$('btnNew2').onclick = () => void openNew();
$('btnNew3').onclick = () => void openNew();
$('newForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData($<HTMLFormElement>('newForm'));
  const body = { name: f.get('name'), preset: f.get('preset'), profile: f.get('profile'), sampleProfile: f.get('sampleProfile') === 'on', driver: f.get('driver'), seed: Number(f.get('seed')) };
  $('newErr').textContent = 'Creating… (the first run after an update also builds the starting networks: a few minutes)';
  try {
    await post('/api/runs', body);
    $<HTMLDialogElement>('newDlg').close();
    toast(`run "${String(body.name)}" created — press Start training`);
  } catch (err) {
    $('newErr').textContent = (err as Error).message;
  }
};

let forkId = 'now';
function openFork(id: string, from: string): void {
  forkId = id;
  $('forkFrom').textContent = `A new run ${from}. This run is not changed.`;
  const f = $<HTMLFormElement>('forkForm');
  (f.elements.namedItem('name') as HTMLInputElement).value = `${run?.name ?? 'run'}-fork`;
  (f.elements.namedItem('collect') as HTMLInputElement).value = String(run?.config.collect ?? '');
  $('forkErr').textContent = '';
  $<HTMLDialogElement>('forkDlg').showModal();
}
$('forkForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData($<HTMLFormElement>('forkForm'));
  const overrides: Record<string, number> = {};
  if (f.get('collect')) overrides.collect = Number(f.get('collect'));
  try {
    const r = await post<{ name: string }>(`/api/checkpoints/${forkId}/fork`, { name: f.get('name'), overrides, open: f.get('open') === 'on' });
    $<HTMLDialogElement>('forkDlg').close();
    toast(`forked into "${r.name}"`);
  } catch (err) {
    $('forkErr').textContent = (err as Error).message;
  }
};

// ─────────────────────────────── live stream ───────────────────────────────
async function reset(state: State): Promise<void> {
  const switched = state.run?.name !== run?.name;
  S = state;
  run = state.run;
  hist = run?.history ?? [];
  if (switched) {
    $('log').innerHTML = '';
    for (const e of run?.events ?? []) log(e.text, new Date(e.time));
    liveGen = -1;
    bestGen = -1;
    champId = -1;
    pendingGen = -1;
    presetPick = '';
  }
  renderRun();
  renderProgress(run?.progress ?? null);
  renderSettings();
  renderCheckpoints(run?.checkpoints ?? []);
  renderEvals(run?.evals ?? []);
  renderData();
  await refreshDisk();
  renderHistory();
  if (!run) {
    view.gen = null;
    setMode('live');
    return;
  }
  // after a switch or a rewind, whatever was shown may be gone: back to LIVE on the newest
  if (switched || mode === 'live' || (mode === 'best' && !onDisk.includes(bestGen))) await showLive(newest());
  renderViewInfo();
}
function renderProgress(p: Progress | null): void {
  if (!p) {
    $('progFill').style.transform = 'scaleX(0)';
    $('progText').textContent = '';
    return;
  }
  $('progFill').style.transform = `scaleX(${p.total ? p.done / p.total : 0})`;
  const what: Record<string, string> = {
    'collecting lessons': 'the champion plays; every option at its decisions is played out',
    learning: 'training a candidate on the lessons · measuring skill settings',
    racing: 'the race: contenders and champion on the same fresh matches',
    exam: 'the exam',
    showcase: "the new champion's showcase match",
  };
  $('progText').textContent = p.eval ? `evaluating ${p.eval} · ${fmt(p.done)} of ${fmt(p.total)} matches` : `generation ${fmt(p.gen)} · ${what[p.stage ?? ''] ?? p.stage ?? ''} · ${fmt(p.done)} of ${fmt(p.total)}`;
}
function connect(): void {
  const es = new EventSource('/api/events');
  es.addEventListener('reset', (e) => void reset(JSON.parse((e as MessageEvent).data) as State));
  es.addEventListener('status', (e) => {
    const s = JSON.parse((e as MessageEvent).data) as Status | null;
    if (!run || !s) return;
    const cfgChanged = JSON.stringify(run.config) !== JSON.stringify(s.config);
    const dataChanged = JSON.stringify(run.data) !== JSON.stringify(s.data);
    Object.assign(run, { running: s.running, paused: s.paused, phase: s.phase, gen: s.gen, config: s.config, data: s.data, lastGenAt: s.lastGenAt });
    renderHeartbeat();
    if (!s.running) renderProgress(null);
    renderStatus();
    if (cfgChanged) renderSettings();
    if (dataChanged) renderData();
    pace();
  });
  es.addEventListener('progress', (e) => renderProgress(JSON.parse((e as MessageEvent).data) as Progress));
  es.addEventListener('generation', async (e) => {
    const g = JSON.parse((e as MessageEvent).data) as GenSummary;
    if (!run) return;
    hist.push(g);
    run.gen = g.gen + 1;
    run.lastGenAt = g.time;
    run.totals.matches = g.matchesTotal;
    run.totals.lessons = g.lessonsTotal;
    run.totals.simSeconds = g.simHoursTotal * 3600;
    run.totals.wallSeconds = g.hours * 3600;
    if (g.exam && !run.exams.some((x) => x.gen === g.exam!.gen && x.champ === g.exam!.champ)) run.exams.push(g.exam);
    if (g.exam) run.champion.exam = g.exam;
    await refreshDisk();
    renderRun();
    renderHistory();
    if (mode === 'live') {
      if (liveGen < 0) void showLive(g.gen);
      else pendingGen = g.gen; // switch when the current replay ends — never cut one short
    }
    renderViewInfo();
    pace();
  });
  es.addEventListener('best', (e) => {
    const b = JSON.parse((e as MessageEvent).data) as RunState['champion'];
    if (run) run.champion = b;
    renderRun();
    renderViewInfo();
    renderRace();
  });
  es.addEventListener('log', (e) => log(JSON.parse((e as MessageEvent).data) as string));
  es.addEventListener('checkpoints', (e) => renderCheckpoints(JSON.parse((e as MessageEvent).data) as CheckpointMeta[]));
  es.addEventListener('runs', (e) => {
    if (S) S.runs = JSON.parse((e as MessageEvent).data);
    renderRuns();
  });
  es.addEventListener('data', (e) => {
    if (S) S.data = JSON.parse((e as MessageEvent).data) as DataInfo;
    renderData();
  });
  es.addEventListener('eval', (e) => {
    if (!run) return;
    run.evals.push(JSON.parse((e as MessageEvent).data) as EvalResult);
    renderEvals(run.evals);
    renderHistory();
    toast('evaluation finished');
  });
  es.addEventListener('playbook', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { profile: string; status: PlaybookStatusV };
    if (PB && d.profile === PB.profile) {
      PB.status = d.status;
      renderPbStatus(d.status);
    }
  });
  es.addEventListener('playbookEntry', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { profile: string; key: string };
    if (PB && d.profile === PB.profile) void loadPlaybook(PB.profile);
  });
  es.addEventListener('home', (e) => {
    const st = JSON.parse((e as MessageEvent).data) as HomeStatusV;
    if (HOME && (!HOME.status || HOME.status.name === st.name)) {
      HOME.status = st;
      HOME.profile = st.profile;
      renderHome();
    } else void loadHome();
  });
  es.addEventListener('routes', () => void loadRoutes());
  es.addEventListener('mistakes', () => void loadMistakes());
  es.addEventListener('quit', () => {
    es.close();
    showClosed();
  });
  es.onopen = () => renderStatus();
  es.onerror = () => {
    if (closed) return es.close();
    $('status').textContent = 'reconnecting';
    $('status').className = 'status off';
  };
}

async function boot(): Promise<void> {
  view.setField(await getJSON<World>('/api/field'));
  setMode('live');
  connect();
  requestAnimationFrame(frame);
}
void boot();
