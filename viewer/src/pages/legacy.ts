// THE GENERATIONAL TRAINER — the older trainer (train/engine.ts), kept whole but out of the way: its
// strip (run, controls, its pages) appears on demand from the menu, or by itself while one of its runs
// trains. Its field modes (LIVE swarm, a generation's best match, the champion with the decision
// inspector) run on the same stage.
import { Comb } from '../comb';
import { CHOICE_PARTS, LineChart, StackChart, historyTable } from '../charts';
import { AUTO_START, OPTIONS, OP_LABEL, bytes, fmt, getJSON, post, type CheckpointMeta, type EvalResult, type ExamResult, type FocusFile, type GenFile, type GenSummary, type Inspected, type Progress, type RunConfig, type RunState, type State, type Status } from '../data';
import type { FrameInfo } from '../fieldview';
import { clock, hooks, setCaption, setMode, stageMode, syncEmpty, view } from '../stage';
import { $, act, ask, dialog, esc, f1, on, pct, setHTML, setText, sgn, toast } from '../ui';
import { bus } from '../state';

let S: State | null = null;
let run: RunState | null = null;
let hist: GenSummary[] = [];
let onDisk: number[] = [];
let liveGen = -1;
let pendingGen = -1;
let bestGen = -1;
let champId = -1;
let inspect: Inspected[] = [];
let inspSearch = false;
let inspShown = -2;
/** the strip is shown (from the menu, remembered), or forced on while one of its runs trains */
export let v1On = false;
try {
  v1On = localStorage.getItem('bb.v1') === '1';
} catch {
  /* private window */
}
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
const choiceChart = new StackChart($<HTMLCanvasElement>('chartChoice'), $('choiceLegend'), CHOICE_PARTS, (g) => `generation ${g.gen}: the champion's job decisions`);
const comb = new Comb($<HTMLCanvasElement>('comb'));

// ─────────────────────────────── the strip ───────────────────────────────
export function setV1(on2: boolean): void {
  v1On = on2;
  $('v1bar').hidden = !on2;
  $('v1prog').hidden = !on2;
  $('v1modes').hidden = !on2;
  setText($('mV1Label'), on2 ? 'Hide the generational trainer' : 'Show the generational trainer');
  try {
    localStorage.setItem('bb.v1', on2 ? '1' : '0');
  } catch {
    /* private window */
  }
  if (!on2 && ['overview', 'race', 'report', 'runs', 'checkpoints', 'settings', 'data', 'evaluate'].includes(document.querySelector<HTMLElement>('.page:not([hidden])')?.dataset.page ?? '')) bus.emit('go', 'home');
  // hidden, its own field views go with it (LIVE, a generation's best, its champion)
  const m = stageMode();
  if (!on2 && (m === 'live' || m === 'best' || m === 'champion')) {
    view.playing = false;
    view.gen = null;
    view.empty = true;
    view.requestDraw();
    setMode('idle');
    setCaption('');
  }
  // shown with a run open and nothing on the field: its LIVE view, as when the run was opened
  if (on2 && run && m === 'idle') void showLive(newest());
  syncEmpty();
}
hooks.v1Empty = () => v1On && !run && stageMode() === 'idle';

function renderRuns(): void {
  const sel = $<HTMLSelectElement>('runSel');
  const runs = S?.runs ?? [];
  setHTML(sel, (run ? '' : '<option value="" selected>Choose a run</option>') + (runs.length ? runs.map((r) => `<option value="${esc(r.name)}" ${run?.name === r.name ? 'selected' : ''}>${esc(r.name)} · gen ${r.gen}${r.legacy ? ' · old version' : r.exam !== null ? ` · exam ${Math.round(r.exam)} pts` : ''}</option>`).join('') : '<option value="">No runs yet</option>'));
  syncEmpty();
  setHTML(
    $('runsList'),
    runs.length
      ? runs
          .map((r) => {
            const open = run?.name === r.name;
            const acts = r.legacy ? `<button type="button" class="danger small" data-run="delete">Delete</button>` : `${open ? '' : '<button type="button" class="small" data-run="open">Open</button>'}<button type="button" class="quiet small" data-run="rename">Rename</button><button type="button" class="quiet small" data-run="duplicate">Duplicate</button><button type="button" class="danger small" data-run="delete">Delete</button>`;
            const meta = r.legacy ? `old version: ${esc(r.legacy)}` : `gen ${fmt(r.gen)} · ${r.exam !== null ? `champion exam ${Math.round(r.exam)} pts${r.vsBase !== null ? ` (${sgn(r.vsBase, 0)} over no-learning)` : ''}${r.search !== null ? ` · thinking ahead ${Math.round(r.search)}` : ''}` : 'no exam yet'}`;
            return `<div class="ck${open ? ' pinned' : ''}" data-name="${esc(r.name)}"><div class="ckmain"><b>${esc(r.name)}${open ? '<span class="tag">open</span>' : ''}</b><span class="sub">${meta}</span><span class="sub mono">${bytes(r.bytes)} on disk${r.updated ? ` · last trained ${new Date(r.updated).toLocaleString()}` : ''}</span></div><div class="row">${acts}</div></div>`;
          })
          .join('')
      : '<p class="hint">No runs yet. Create one to start.</p>',
  );
}
on<HTMLButtonElement>($('runsList'), 'button[data-run]', async (b) => {
  const name = b.closest<HTMLElement>('[data-name]')!.dataset.name!;
  const what = b.dataset.run;
  if (what === 'open') await act(post('/api/runs/open', { name }));
  else if (what === 'rename') {
    const to = await dialog(`Rename “${name}”`, 'Its history, checkpoints and champion move with it.', 'Rename', { input: { label: 'New name (letters, digits, - and _)', value: name } });
    if (to && to !== name) await act(post('/api/runs/rename', { name, to }), `Renamed to “${to}”.`);
  } else if (what === 'duplicate') {
    const to = await dialog(`Duplicate “${name}”`, 'An independent copy: same generation, history, checkpoints and champion. Training one never changes the other.', 'Duplicate', { input: { label: 'Name of the copy', value: `${name}-copy` } });
    if (to) await act(post('/api/runs/duplicate', { name, to }), `Copied to “${to}”.`);
  } else if (what === 'delete') {
    if (await ask(`Delete run “${name}”?`, 'Every generation, checkpoint, evaluation and the champion of this run are removed from disk. This cannot be undone.', 'Delete run', name, true)) await act(post('/api/runs/delete', { name, confirm: name }), `Deleted “${name}”.`);
  }
});

function renderStatus(): void {
  if (run?.running && !v1On) setV1(true);
  const st = $('status');
  const has = !!run;
  const running = !!run?.running;
  const paused = !!run?.paused;
  setText(st, !run ? 'no run' : !running ? 'idle' : paused ? 'paused' : run.phase === 'evaluating' ? 'evaluating' : 'training');
  st.className = `status ${!running ? 'off' : paused ? 'paused' : 'on'}`;
  const dis = (id: string, d: boolean): void => {
    $<HTMLButtonElement>(id).disabled = d;
  };
  dis('btnStart', !has || (running && !paused));
  setText($('btnStart'), running && paused ? 'Resume training' : 'Start training');
  dis('btnPause', !running || paused);
  dis('btnStep1', !has || (running && !paused));
  dis('btnStep10', !has || (running && !paused));
  dis('btnStop', !running);
  dis('btnAbort', !running || run?.phase !== 'generation');
}
const agoIso = (iso: string | null): string => {
  if (!iso) return '';
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  return m < 1 ? 'just now' : m < 90 ? `${Math.round(m)} min ago` : `${(m / 60).toFixed(1)} h ago`;
};
function renderHeartbeat(): void {
  if (!run) return;
  const last = hist[hist.length - 1];
  const stale = !!run.running && !run.paused && !!run.lastGenAt && !!last && Date.now() - new Date(run.lastGenAt).getTime() > Math.max(20 * 60000, 4 * last.wallS * 1000);
  setText($('genWhen'), run.lastGenAt ? `last ${agoIso(run.lastGenAt)}${stale ? ': slower than usual' : ''}` : 'none finished yet');
  $('genWhen').classList.toggle('bad', stale);
}
function renderRun(): void {
  renderRuns();
  renderStatus();
  if (!run) {
    for (const id of ['gen', 'lessonsN', 'matchesN']) setText($(id), '0');
    setText($('champBody'), 'No run open.');
    return;
  }
  const T = run.totals;
  setText($('gen'), fmt(run.gen));
  setText($('lessonsN'), fmt(T.lessons));
  setText($('matchesN'), fmt(T.matches));
  setText($('simTime'), `${(T.simSeconds / 3600).toFixed(1)} h sim in ${(T.wallSeconds / 3600).toFixed(1)} h`);
  const last = hist[hist.length - 1];
  setText($('rpm'), last ? f1(last.matchesPerMin, 0) : '—');
  renderHeartbeat();
  const c = run.champion;
  const x = c.exam;
  setText($('champGen'), `#${c.id} · ${OP_LABEL[c.op] ?? c.op}${c.op === 'baseline' ? '' : ` · since generation ${c.born}`}`);
  const race = c.race ? `On fresh race matches: <b>${c.race.score.toFixed(0)}</b> ± ${c.race.ci95.toFixed(0)} over ${c.race.n}.` : '';
  setHTML(
    $('champBody'),
    !x
      ? `<p class="sub">${c.op === 'baseline' ? 'The no-learning robot, as a network: the bar. ' : ''}Its exam comes with the first generation. ${race}</p>`
      : `<div class="hero2"><span class="heronum">${sgn(x.vsBase.mean)}</span><span class="herounit">points per match over the no-learning robot</span><span class="ci mono">± ${x.vsBase.ci95.toFixed(1)} (95%) · ${x.vsBase.n} exam matches, same luck</span></div>
       <p class="sub">Exam: <b>${x.net.mean.toFixed(0)}</b> ± ${x.net.ci95.toFixed(0)} DSIM points alone, ${x.net.tips.toFixed(1)} tips${x.search ? ` · thinking ahead <b>${x.search.mean.toFixed(0)}</b> (${sgn(x.search.vsBase.mean)} ± ${x.search.vsBase.ci95.toFixed(1)} over no-learning on ${x.search.n} matches)` : ''}. ${race}${c.parts ? `<br>Showcase match: ${c.parts.tips} tips · ${c.parts.shotsIn} shots in · ${c.parts.pickups} pickups · ${c.parts.wasted} missed · ${c.parts.violations} rule violations` : ''}</p>`,
  );
  for (const id of ['watchChamp', 'copySnippet']) $<HTMLButtonElement>(id).disabled = !c.parts;
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
  setText($('lostNow'), last ? `Last generation, per match: ${f1(last.mistakes.missedShots)} missed shots · ${f1(last.mistakes.emptyTrips)} empty trips · ${f1(last.mistakes.blockedShots)} blocked shots · ${f1(last.mistakes.fouls, 0)} foul points.` : '');
  scoreChart.set(hist, refs());
  choiceChart.set(hist);
  comb.set(hist, onDisk);
  if (!$('fitTable').hidden) setHTML($('fitTable'), historyTable(hist));
  renderRace();
  renderReport();
}
function renderRace(): void {
  const last = hist.at(-1);
  const c = run?.champion;
  setText($('raceNow'), last?.confirm ? `last: #${last.confirm.id} ${sgn(last.confirm.diff)} ± ${(1.96 * last.confirm.se).toFixed(1)} over ${last.confirm.n}${last.confirm.promoted ? ': promoted' : ''}` : '');
  setHTML(
    $('raceTable'),
    last?.arena.length
      ? `<table><thead><tr><th class="l">Contender</th><th class="l">Made by</th><th>Matches</th><th>Lead ± 95%</th><th>z</th></tr></thead><tbody>${last.arena
          .map((a) => `<tr><td class="l">#${a.id}</td><td class="l">${OP_LABEL[a.op] ?? a.op}</td><td>${a.n}</td><td>${a.n ? `${sgn(a.diff)} ± ${Number.isFinite(a.se) ? (1.96 * a.se).toFixed(1) : '—'}` : '—'}</td><td>${a.z.toFixed(2)}</td></tr>`)
          .join('')}</tbody></table>`
      : `<p class="hint">${last ? 'No contender right now: none of this generation’s candidates beat the champion where it counts.' : 'Contenders appear after the first generation.'}</p>`,
  );
  if (last) {
    const f = last.fit;
    const v = last.value;
    const m = last.cma;
    setHTML(
      $('learnNow'),
      [
        `<b>${fmt(last.lessons)}</b> lessons from ${run?.config.collect ?? '?'} matches; the champion's choice lost <b>${last.regret.toFixed(1)}</b> points per decision against the best option.`,
        f ? `Candidate network: trained on ${fmt(f.lessons)} lessons, judged on ${fmt(f.held)} it never saw: its picks lose ${f.regret.toFixed(2)} points per decision (the champion's: ${f.startRegret.toFixed(2)}), best option ${pct(f.hit)} of the time (champion ${pct(f.startHit)}). ${f.regret < f.startRegret ? 'It entered the race.' : 'Not better: it did not race.'}` : '',
        v ? `Rest-of-match predictor: off by ${f1(v.rmse)} points on matches it never saw${Number.isFinite(v.startRmse ?? NaN) ? ` (before: ${f1(v.startRmse)})` : ''}, from ${fmt(v.samples)} moments.` : '',
        m ? `Skill settings: CMA-ES generation ${m.gen}, step ${m.sigma.toFixed(3)}; the settings tried led the champion by ${sgn(m.mean)} on average (best ${sgn(m.best)})${m.entered ? '; their new centre entered the race' : ''}.` : 'Skill settings are not being tuned (0 tried per generation).',
        `Phases: lessons ${(last.phases.collect / 60).toFixed(1)} min · learning ${(last.phases.learn / 60).toFixed(1)} · race ${(last.phases.race / 60).toFixed(1)} · exam ${(last.phases.exam / 60).toFixed(1)}.`,
      ]
        .filter(Boolean)
        .map((t) => `<p>${t}</p>`)
        .join(''),
    );
  } else setHTML($('learnNow'), '<p class="hint">Appears after the first generation.</p>');
  setHTML($('styleTable'), c ? `<table><thead><tr><th class="l">Setting</th><th>Champion</th><th>Start</th></tr></thead><tbody>${c.style.map((q) => `<tr><td class="l">${esc(q.label)}</td><td>${q.value.toFixed(2)}</td><td>${q.def.toFixed(2)}</td></tr>`).join('')}</tbody></table>` : '');
}
function renderReport(): void {
  const x = run?.exams.at(-1);
  const first = run?.exams[0];
  setText($('gapWhen'), x ? `exam of champion #${x.champ}, generation ${x.gen}` : '');
  if (!x) {
    setHTML($('gapTable'), '<p class="hint">Appears with the first exam.</p>');
    setText($('checks'), '');
    setHTML($('examMistakes'), '');
    return;
  }
  const share = (q: { collect: number; shoot: number; drive: number; idle: number }): string =>
    `<span class="share" title="collect ${pct(q.collect)} · shoot ${pct(q.shoot)} · drive ${pct(q.drive)} · idle ${pct(q.idle)}">${(['collect', 'shoot', 'drive', 'idle'] as const).map((k, i) => `<i style="width:${(100 * q[k]).toFixed(1)}%;background:${[OPTIONS[0].color, OPTIONS[3].color, OPTIONS[6].color, '#2e3949'][i]}"></i>`).join('')}</span>`;
  setHTML(
    $('gapTable'),
    x.gap.length
      ? `<table><thead><tr><th class="l">Who · robot · matches</th><th>Points</th><th>Tips</th><th>s / tip</th><th>Pickups/min</th><th>Shots/min</th><th>Hit</th><th>Shots/load</th></tr></thead><tbody>${x.gap
          .map((r) => `<tr><td class="l"><b>${esc(r.who)}</b><br><span class="sub">${esc(r.build)} · ${r.n}</span></td><td>${r.points.toFixed(0)}</td><td>${r.tips.toFixed(1)}</td><td>${f1(r.secPerTip)}</td><td>${r.pickupsPerMin.toFixed(0)}</td><td>${r.shotsPerMin.toFixed(0)}</td><td>${pct(r.accuracy)}</td><td>${r.loadSize.toFixed(1)}</td></tr><tr><td class="l" colspan="8">${share(r.share)} <span class="sub">collect ${pct(r.share.collect)} · shoot ${pct(r.share.shoot)} · drive ${pct(r.share.drive)} · idle ${pct(r.share.idle)}</span></td></tr>`)
          .join('')}</tbody></table>`
      : '<p class="hint">No replays that re-simulate in this DSIM: the gap report needs replays recorded in DSIM Act 2.</p>',
  );
  const d = x.checks.dsim;
  setHTML($('checks'), `<p>${x.checks.deterministic ? '✓' : '⚠'} <b>Deterministic</b>: exam match 1 played again gave ${x.checks.deterministic ? 'exactly the same result' : 'a DIFFERENT result: report this'}.</p><p>${d ? (d.ok ? '✓' : '⚠') : '–'} <b>DSIM verified</b>: ${d ? `${d.ok ? 'DSIM re-simulated the champion’s replay on your build and landed on the identical world' : d.exact ? 'DSIM’s re-simulation DIFFERS: report this' : esc(d.detail)}.` : 'no replay to verify.'}</p>`);
  const rows: [string, (m: ExamResult['mistakes']) => string][] = [
    ['missed shots', (m) => f1(m.missedShots)],
    ['empty trips (s)', (m) => `${f1(m.emptyTrips)} (${f1(m.emptyTripS, 0)} s)`],
    ['blocked shots (s)', (m) => `${f1(m.blockedShots)} (${f1(m.blockedShotS, 0)} s)`],
    ['idle seconds', (m) => f1(m.idleS, 0)],
    ['foul points', (m) => f1(m.fouls, 0)],
  ];
  setHTML($('examMistakes'), `<table><thead><tr><th class="l">Per match</th>${first && first !== x ? `<th>First exam (#${first.champ})</th>` : ''}<th>Now (#${x.champ})</th></tr></thead><tbody>${rows.map(([k, g]) => `<tr><td class="l">${k}</td>${first && first !== x ? `<td>${g(first.mistakes)}</td>` : ''}<td>${g(x.mistakes)}</td></tr>`).join('')}</tbody></table>`);
}

// ─────────────────────────────── checkpoints ───────────────────────────────
function renderCheckpoints(list: CheckpointMeta[]): void {
  if (run) run.checkpoints = list;
  setText($('ckCount'), `${list.length} checkpoint${list.length === 1 ? '' : 's'}`);
  setHTML(
    $('ckList'),
    list.length
      ? list
          .map(
            (m) => `<div class="ck${m.pinned ? ' pinned' : ''}" data-id="${esc(m.id)}">
      <div class="ckmain"><b>${esc(m.label)}</b><span class="sub">gen ${m.gen} · ${m.exam !== null ? `champion exam ${Math.round(m.exam)} pts` : 'no exam yet'} · ${new Date(m.time).toLocaleString()}${m.auto ? ' · automatic' : ''}${m.pinned ? ' · pinned' : ''}</span>
      <span class="sub mono">${m.config.collect} lesson matches / gen · ${m.config.horizon} s play-outs${m.config.preset ? ` · ${esc(S?.presets.find((p) => p.id === m.config.preset)?.label ?? m.config.preset)}` : ''}</span></div>
      <div class="row"><button type="button" class="small" data-do="rewind">Rewind here</button><button type="button" class="quiet small" data-do="fork">Fork</button><button type="button" class="quiet small" data-do="rename">Rename</button><button type="button" class="quiet small" data-do="pin">${m.pinned ? 'Unpin' : 'Pin'}</button><button type="button" class="danger small" data-do="delete">Delete</button></div>
    </div>`,
          )
          .join('')
      : '<p class="hint">No checkpoints yet.</p>',
  );
  renderEvalTargets();
}
on<HTMLButtonElement>($('ckList'), 'button[data-do]', async (b) => {
  if (!run) return;
  const id = b.closest<HTMLElement>('.ck')!.dataset.id!;
  const m = run.checkpoints.find((q) => q.id === id);
  if (!m) return;
  const what = b.dataset.do;
  if (what === 'rewind') {
    if (!(await ask('Rewind the run?', `Go back to “${m.label}” (generation ${m.gen}). Generations after it are removed from this run. The present is saved first as a pinned checkpoint, so you can come back.${run.running ? ' Training stops; the generation in progress is discarded.' : ''}`, 'Rewind'))) return;
    await act(post(`/api/checkpoints/${id}/rewind`), `Rewound to generation ${m.gen}.`);
  } else if (what === 'fork') openFork(id, `from “${m.label}” (generation ${m.gen})`);
  else if (what === 'rename') {
    const label = await dialog('Rename checkpoint', 'A named checkpoint is never deleted automatically.', 'Rename', { input: { label: 'Name', value: m.label } });
    if (label) await act(post(`/api/checkpoints/${id}/rename`, { label }));
  } else if (what === 'pin') await act(post(`/api/checkpoints/${id}/pin`, { pinned: !m.pinned }));
  else if (what === 'delete') {
    if (!(await ask('Delete this checkpoint?', `“${m.label}” (generation ${m.gen}) is removed from disk. This cannot be undone.`, 'Delete', 'delete', true))) return;
    await act(post(`/api/checkpoints/${id}/delete`), 'Checkpoint deleted.');
  }
});
for (const [id, which, what] of [
  ['ckDelAuto', 'auto', 'every automatic checkpoint that is not pinned'],
  ['ckDelUnpinned', 'unpinned', 'every checkpoint that is not pinned (named ones too)'],
] as const) {
  $(id).onclick = async () => {
    if (!run) return;
    if (!(await ask('Delete checkpoints?', `This removes ${what} from disk. Pinned checkpoints stay. This cannot be undone.`, 'Delete', 'delete', true))) return;
    try {
      const r = await post<{ deleted: number }>('/api/checkpoints/delete-many', { which });
      toast(`${r.deleted} checkpoint${r.deleted === 1 ? '' : 's'} deleted.`);
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
}
$<HTMLFormElement>('ckForm').onsubmit = async (e) => {
  e.preventDefault();
  const label = $<HTMLInputElement>('ckLabel').value.trim();
  if (await act(post('/api/checkpoints', { label }), 'Checkpoint saved.')) $<HTMLInputElement>('ckLabel').value = '';
};

// ─────────────────────────────── settings ───────────────────────────────
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
  { key: 'demoWeight', label: 'Your replays’ weight', type: 'number', step: '0.05', min: '0', max: '10', help: 'at generation 0, relative to a lesson' },
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
const KEY_LABEL: Record<string, string> = { workers: 'workers', collect: 'lesson matches', rounds: 'luck draws', window: 'generations remembered', demoWeight: 'replay weight', demoFade: 'replay fade', cmaPop: 'skill settings tried', cmaMatches: 'matches each', raceMatches: 'race matches', examMatches: 'exam matches', examEvery: 'exam every', searchExam: 'thinking-ahead exam', horizon: 'play-out s' };
function renderPresets(): void {
  const list = S?.presets ?? [];
  const c = run?.config;
  const cur = c?.preset ?? '';
  if (!presetPick || !list.some((p) => p.id === presetPick)) presetPick = cur || 'balanced';
  setText($('presetNow'), !run ? '' : cur ? `now: ${list.find((p) => p.id === cur)?.label ?? cur}` : 'now: custom settings');
  setHTML($('presetList'), list.map((p) => `<button type="button" role="radio" aria-checked="${p.id === presetPick}" data-preset="${p.id}" class="preset"><b>${esc(p.label)}${p.id === cur ? '<span class="tag">in use</span>' : ''}</b><span>${esc(p.blurb)}</span></button>`).join(''));
  const p = list.find((q) => q.id === presetPick);
  const diff = p && c ? Object.entries(p.change).filter(([k, v]) => JSON.stringify((c as unknown as Record<string, unknown>)[k]) !== JSON.stringify(v)) : [];
  setText($('presetDiff'), !run ? 'Open a run to apply a preset (new runs choose one when created).' : !diff.length ? (p?.id === cur ? 'This preset is in use.' : 'Same values as now.') : `Changes: ${diff.map(([k, v]) => `${KEY_LABEL[k] ?? k} ${String((c as unknown as Record<string, unknown>)[k])} → ${String(v)}`).join(' · ')}`);
  $<HTMLButtonElement>('presetApply').disabled = !run || !p || (!diff.length && p.id === cur);
}
on<HTMLButtonElement>($('presetList'), '[data-preset]', (b) => {
  presetPick = b.dataset.preset!;
  renderPresets();
});
$('presetApply').onclick = async () => {
  try {
    const r = await post<{ changed: Record<string, unknown> }>('/api/presets/apply', { id: presetPick });
    toast(Object.keys(r.changed).length ? 'Preset applied: from the next generation.' : 'Nothing changed.');
  } catch (err) {
    toast((err as Error).message, true);
  }
};
function renderSettings(): void {
  renderPresets();
  if (!run) return;
  const c = run.config;
  const put = (id: string, defs: FieldDef[]): void => void setHTML($(id), defs.map((d) => fieldHtml(d, c)).join(''));
  put('cfgCollect', COLLECT);
  put('cfgLearn', LEARN);
  put('cfgSkills', SKILLS);
  put('cfgRace', RACE);
  put('cfgWorld', WORLD);
  put('cfgHouse', HOUSE);
  setText($('cfgFixed'), `Fixed for this run (fork or start a new run to change): seed ${c.seed}, robot ${c.profile}${c.sampleProfile ? ' (a new one from its range every match)' : ''}.`);
}
$('cfgReset').onclick = () => {
  // (setHTML skips an unchanged form: clear it so the edits are really undone)
  for (const id of ['cfgCollect', 'cfgLearn', 'cfgSkills', 'cfgRace', 'cfgWorld', 'cfgHouse']) $(id).innerHTML = '';
  renderSettings();
};
$<HTMLFormElement>('cfgForm').onsubmit = async (e) => {
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
    const n = Object.keys(r.changed).filter((k) => k !== 'preset');
    toast(n.length ? `Applied: ${n.join(', ')}. From the next generation.` : 'Nothing changed.');
  } catch (err) {
    toast((err as Error).message, true);
  }
};

// ─────────────────────────────── training data ───────────────────────────────
function renderData(): void {
  const D = S?.data;
  if (!D) return;
  const usable = D.files.filter((f) => f.replayable !== false);
  const changed = !D.fitted || !D.built;
  setText($('dataState'), D.refreshing ? 'refreshing…' : !usable.length ? 'no replay re-simulates in this DSIM' : changed ? 'changed: press Refresh' : `${D.fitted!.samples} decisions learned`);
  setHTML(
    $('dataList'),
    D.files.length
      ? `<table><thead><tr><th></th><th class="l">Replay</th><th>Score</th><th class="l">Lessons</th></tr></thead><tbody>${D.files
          .map((f) => {
            const i = f.info;
            const dead = f.replayable === false;
            const note = dead ? `<span class="badge warn" title="${esc(f.why ?? '')}">does not re-simulate here</span> <span class="sub">${esc(f.why ?? '')}</span>` : i?.error ? `<span class="bad" title="${esc(i.error)}">could not be re-simulated</span>` : i ? `${i.samples}` : '<span class="sub">not yet</span>';
            return `<tr><td><input type="checkbox" data-file="${esc(f.name)}" ${f.included ? 'checked' : ''} ${D.refreshing || dead ? 'disabled' : ''} aria-label="learn from ${esc(f.name)}"/></td><td class="l mono" title="${esc(f.name)}">${esc(f.name.replace(/^dsim-biobuzz-/, '').replace(/\.json$/, '').slice(0, 26))}</td><td>${i && !i.error && !dead ? i.score : '—'}</td><td class="l">${note}</td></tr>`;
          })
          .join('')}</tbody></table>`
      : '<p class="hint">No replays yet. Add DSIM replays of good runs, recorded in DSIM Act 2.</p>',
  );
  $<HTMLButtonElement>('dataRefresh').disabled = D.refreshing || !D.files.some((f) => f.included);
  setText($('dataRefresh'), D.refreshing ? 'Refreshing…' : 'Refresh training data');
  const rd = run?.data;
  setHTML(
    $('dataRun'),
    !run
      ? ''
      : !rd?.key
        ? 'The open run learns from no replays.'
        : rd.key === D.latest
          ? `The open run uses these replays. ${D.fitted ? `The fitted network picks the same next option as you ${pct(D.fitted.agree)} of the time on a replay it never saw (chance ${pct(D.fitted.chance)}).` : ''}`
          : `The open run uses an older set of replays. ${D.built && D.fitted ? '<button type="button" class="link" id="dataUse">Use the current set</button>' : 'Refresh to build the current set.'}`,
  );
}
on<HTMLButtonElement>($('dataRun'), '#dataUse', () => void act(post('/api/data/use'), 'The run uses the current set from its next generation.'));
on<HTMLInputElement>($('dataList'), 'input[data-file]', (cb) => void act(post('/api/data/include', { name: cb.dataset.file, included: cb.checked }), cb.checked ? 'Included: press Refresh to learn from it.' : 'Left out: press Refresh to apply.'), 'change');
$('dataRefresh').onclick = () => void act(post('/api/data/refresh'));
$<HTMLInputElement>('dataUpload').onchange = async (e) => {
  const files = [...((e.target as HTMLInputElement).files ?? [])];
  for (const f of files) {
    try {
      await post('/api/data/upload', { name: f.name, content: await f.text() });
      toast(`${f.name} added: press Refresh to learn from it.`);
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
  setHTML(
    sel,
    [
      ['champion', 'Champion (its network alone)'],
      ['player', 'Champion thinking ahead during the match'],
      ['greedy', 'Greedy baseline (no learning)'],
      ['baseline', 'The no-learning robot as a network'],
      ['imitation', 'Imitation of your replays'],
      ...cks.map((m) => [m.id, `Checkpoint: ${m.label} (gen ${m.gen})`]),
    ]
      .map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`)
      .join(''),
  );
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}
function renderEvals(list: EvalResult[]): void {
  setHTML(
    $('evalList'),
    list.length
      ? `<table><thead><tr><th class="l">Policy</th><th>Gen</th><th>Matches</th><th>Mean ± 95%</th><th>Min–max</th><th>Tips</th><th>Lived</th></tr></thead><tbody>${[...list]
          .reverse()
          .map((e) => `<tr><td class="l">${esc(e.target)}</td><td>${e.gen}</td><td>${e.n}</td><td>${e.mean.toFixed(1)} ± ${e.ci95.toFixed(1)}</td><td>${e.min}–${e.max}</td><td>${e.tips.toFixed(1)}</td><td>${e.deaths.survived}/${e.n}</td></tr>`)
          .join('')}</tbody></table>`
      : '<p class="hint">No evaluations yet. The exam already compares every champion with the no-learning robot; use this for more matches or other policies.</p>',
  );
}
$<HTMLFormElement>('evalForm').onsubmit = async (e) => {
  e.preventDefault();
  await act(post('/api/eval', { target: $<HTMLSelectElement>('evalTarget').value, n: Number($<HTMLInputElement>('evalN').value) }), 'Evaluation queued: results appear here.');
};

// ─────────────────────────────── the field: LIVE, a generation's best, the champion ───────────────────────────────
function v1Mode(m: 'live' | 'best' | 'champion'): void {
  $('modeLive').setAttribute('aria-selected', String(m === 'live'));
  $('modeBest').setAttribute('aria-selected', String(m === 'best'));
  $('modeChamp').setAttribute('aria-selected', String(m === 'champion'));
  setMode(m);
  renderViewInfo();
  pace();
}
async function refreshDisk(): Promise<void> {
  onDisk = run ? await getJSON<number[]>('/api/gens').catch(() => []) : [];
}
const newest = (): number => (onDisk.length ? onDisk[onDisk.length - 1] : -1);
function renderViewInfo(): void {
  const mode = stageMode();
  if (mode !== 'live' && mode !== 'best' && mode !== 'champion') return;
  const n = newest();
  let html = '';
  if (!run) html = '';
  else if (mode === 'live') html = liveGen >= 0 ? `<b>Generation ${fmt(liveGen)}</b><span class="sub">· the champion’s lesson matches · follows training</span>` : run.running && !run.paused ? `<span class="sub">Generation ${fmt(run.gen)} is being played: its lesson matches appear here when it finishes.</span>` : '<span class="sub">No generations yet: press Start training.</span>';
  else if (mode === 'best') html = bestGen >= 0 ? `<b>Generation ${fmt(bestGen)}</b><span class="sub">· its best lesson match · exactly as played</span>${n > bestGen ? ` <button type="button" class="link" data-v1="newest">newest: ${fmt(n)}</button>` : ''}` : '<span class="sub">No generations yet.</span>';
  else {
    const c = run.champion;
    html = c.parts ? `<b>Champion #${c.id}</b><span class="sub">· ${OP_LABEL[c.op] ?? c.op} · exam match 1</span>${champId >= 0 && champId !== c.id ? ` <button type="button" class="link" data-v1="champ">a new champion (#${c.id})</button>` : ''}` : '<span class="sub">No champion showcase yet.</span>';
  }
  setCaption(html);
}
on<HTMLButtonElement>($('stageCap'), 'button[data-v1]', (b) => void (b.dataset.v1 === 'newest' ? showBest(newest()) : watchChampion()));
async function showLive(g: number): Promise<void> {
  if (g < 0) {
    view.gen = null;
    view.mode = 'swarm';
    liveGen = -1;
    v1Mode('live');
    return;
  }
  try {
    const gf = await getJSON<GenFile>(`/api/gen/${g}`);
    view.loadGeneration(gf);
    view.playing = true;
    liveGen = g;
    comb.selected = g;
    comb.draw();
    v1Mode('live');
  } catch (e) {
    bus.emit('log', `generation ${g}: ${(e as Error).message}`);
  }
}
async function showBest(g: number): Promise<void> {
  if (g < 0) return toast('No generation on disk yet: press Start training.', true);
  try {
    view.loadFocus(await getJSON<FocusFile>(`/api/gen/${g}/frames`));
    bestGen = g;
    view.playing = true;
    comb.selected = g;
    comb.draw();
    v1Mode('best');
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
    v1Mode('champion');
  } catch (e) {
    toast((e as Error).message, true);
  }
}
comb.onPick = (g) => void showBest(g);
/** LIVE keeps pace with training: the newest generation's replay lasts about as long as the next
 * generation takes to run, so the field is always the present. Not training: real time (1×). */
function pace(): void {
  if (stageMode() !== 'live') return setText($('pace'), '');
  const last = hist[hist.length - 1];
  const matchS = Math.max(1, (view.endTick - AUTO_START) / 60);
  const training = !!run?.running && !run.paused && !!last;
  view.speed = training ? Math.max(1, Math.min(120, matchS / Math.max(4, last!.wallS))) : 1;
  setText($('pace'), training ? `${view.speed.toFixed(view.speed < 10 ? 1 : 0)}× · keeping pace with training` : '1× · real time');
}
hooks.frame = (f: FrameInfo) => {
  const mode = stageMode();
  if (mode === 'live') {
    const lo = view.startTick;
    const frac = (f.tick - lo) / Math.max(1, f.end - lo);
    $('liveFill').style.transform = `scaleX(${Math.max(0, Math.min(1, frac)).toFixed(4)})`;
    setText($('clockLive'), clock(f.tick));
  }
  if (mode === 'champion') renderInspector(f.tick);
};
hooks.loop = () => {
  if (stageMode() === 'live' && pendingGen >= 0) {
    const g = pendingGen;
    pendingGen = -1;
    void showLive(g);
  }
};
/** the decision the champion was at on this tick: every option it had, what the network scored, and
 * what each made when played out (what-if), and which one it took */
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
  setText($('inspHint'), inspSearch ? 'Thinking ahead: at each job start the network’s best 3 options were played 10 s ahead on copies of the match (2 luck draws each, never the real future), then the predictor valued the rest; it took the best one unless that led by less than 3 points.' : 'What-if: at each job start every option was played out on copies of the match; the robot itself followed its network.');
  if (at < 0) {
    setText($('inspWhen'), '');
    setHTML($('inspBody'), `<p class="hint">${inspect.length ? 'Its first decision comes when AUTO starts.' : 'This showcase has no decisions recorded.'}</p>`);
    return;
  }
  const d = inspect[at];
  const sec = Math.max(0, (d.t - AUTO_START) / 60);
  setText($('inspWhen'), `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')} · ${d.at === 'begin' ? 'a job ended: choose the next' : 're-think while working'} · decision ${at + 1} of ${inspect.length}`);
  const netBest = d.net;
  const order = d.opts.map((o, i) => ({ o, i })).sort((a, b) => (b.o.q ?? -Infinity) - (a.o.q ?? -Infinity) || b.o.s - a.o.s);
  const bestQ = Math.max(...d.opts.map((o) => o.q ?? -Infinity));
  setHTML(
    $('inspBody'),
    `<table><thead><tr><th class="l">Option</th><th>Network</th><th>What-if</th><th class="l"></th></tr></thead><tbody>${order
      .map(({ o, i }) => {
        const k = OPTIONS[o.kind];
        const tag = [i === d.chosen ? '<b>✓ chosen</b>' : '', i === d.current ? 'doing' : '', i === netBest && netBest !== d.chosen ? 'network’s pick' : '', o.q !== null && o.q === bestQ && Number.isFinite(bestQ) ? 'best what-if' : ''].filter(Boolean).join(' · ');
        return `<tr${i === d.chosen ? ' class="sel"' : ''}><td class="l"><i class="optsw" style="background:${k?.color ?? '#888'}"></i>${esc(o.label)}</td><td>${o.s.toFixed(2)}</td><td>${o.q === null ? '—' : o.q.toFixed(1)}</td><td class="l sub">${tag}</td></tr>`;
      })
      .join('')}</tbody></table>`,
  );
}
$('modeLive').onclick = () => void showLive(newest());
$('modeBest').onclick = () => void showBest(newest());
$('modeChamp').onclick = () => void watchChampion();
$('watchChamp').onclick = () => void watchChampion();
$('copySnippet').onclick = async () => {
  try {
    const r = await fetch('/api/best.inject.js', { cache: 'no-store' });
    await navigator.clipboard.writeText(await r.text());
    setText($('snippetHint'), 'Copied. In DSIM (localhost:5173) paste it into the console (Safari: Develop → Show Web Inspector), then open Records → Career.');
  } catch {
    setText($('snippetHint'), 'Copying was blocked by the browser. Open /api/best.inject.js and copy it by hand.');
  }
};
$('tableToggle').onclick = () => {
  const t = $('fitTable');
  t.hidden = !t.hidden;
  setText($('tableToggle'), t.hidden ? 'Show table' : 'Hide table');
  if (!t.hidden) setHTML(t, historyTable(hist));
};

// ─────────────────────────────── controls ───────────────────────────────
$('btnStart').onclick = () => void act(post('/api/control', { action: run?.running ? 'resume' : 'start' }));
$('btnPause').onclick = () => void act(post('/api/control', { action: 'pause' }));
$('btnStep1').onclick = () => void act(post('/api/control', { action: 'step', n: 1 }));
$('btnStep10').onclick = () => void act(post('/api/control', { action: 'step', n: 10 }));
$('btnStop').onclick = () => void act(post('/api/control', { action: 'stop' }), 'Stopping after this generation.');
$('btnAbort').onclick = async () => {
  if (await ask('Abort this generation?', 'The robots of the generation in progress are thrown away and training stops. The run stays exactly as it was before this generation started.', 'Abort generation', undefined, true)) void act(post('/api/control', { action: 'abort' }));
};
$<HTMLSelectElement>('runSel').onchange = async () => {
  const name = $<HTMLSelectElement>('runSel').value;
  if (name && !(await act(post('/api/runs/open', { name })))) renderRuns();
};
async function openNew(): Promise<void> {
  const profiles = await getJSON<string[]>('/api/profiles').catch(() => ['profiles/real-v0.json']);
  setHTML($('newProfile'), profiles.map((p) => `<option value="${esc(p)}" ${p.endsWith('real-v1.json') ? 'selected' : ''}>${esc(p.replace('profiles/', '').replace('.json', ''))}</option>`).join(''));
  setHTML($('newPreset'), (S?.presets ?? []).map((p) => `<option value="${esc(p.id)}" ${p.id === 'balanced' ? 'selected' : ''}>${esc(p.label)}</option>`).join(''));
  setText($('newErr'), '');
  $<HTMLDialogElement>('newDlg').showModal();
}
for (const id of ['btnNew', 'btnNew2', 'btnNew3']) $(id).onclick = () => void openNew();
$<HTMLFormElement>('newForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData($<HTMLFormElement>('newForm'));
  const body = { name: f.get('name'), preset: f.get('preset'), profile: f.get('profile'), sampleProfile: f.get('sampleProfile') === 'on', driver: f.get('driver'), seed: Number(f.get('seed')) };
  setText($('newErr'), 'Creating… (the first run after an update also builds the starting networks: a few minutes)');
  try {
    await post('/api/runs', body);
    $<HTMLDialogElement>('newDlg').close();
    toast(`Run “${String(body.name)}” created: press Start training.`);
  } catch (err) {
    setText($('newErr'), (err as Error).message);
  }
};
let forkId = 'now';
function openFork(id: string, from: string): void {
  forkId = id;
  setText($('forkFrom'), `A new run ${from}. This run is not changed.`);
  const f = $<HTMLFormElement>('forkForm');
  (f.elements.namedItem('name') as HTMLInputElement).value = `${run?.name ?? 'run'}-fork`;
  (f.elements.namedItem('collect') as HTMLInputElement).value = String(run?.config.collect ?? '');
  setText($('forkErr'), '');
  $<HTMLDialogElement>('forkDlg').showModal();
}
$<HTMLFormElement>('forkForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData($<HTMLFormElement>('forkForm'));
  const overrides: Record<string, number> = {};
  if (f.get('collect')) overrides.collect = Number(f.get('collect'));
  try {
    const r = await post<{ name: string }>(`/api/checkpoints/${forkId}/fork`, { name: f.get('name'), overrides, open: f.get('open') === 'on' });
    $<HTMLDialogElement>('forkDlg').close();
    toast(`Forked into “${r.name}”.`);
  } catch (err) {
    setText($('forkErr'), (err as Error).message);
  }
};

// ─────────────────────────────── its live events ───────────────────────────────
function renderProgress(p: Progress | null): void {
  if (!p) {
    $('progFill').style.transform = 'scaleX(0)';
    setText($('progText'), '');
    return;
  }
  $('progFill').style.transform = `scaleX(${p.total ? (p.done / p.total).toFixed(4) : 0})`;
  const what: Record<string, string> = { 'collecting lessons': 'the champion plays; every option at its decisions is played out', learning: 'training a candidate on the lessons · measuring skill settings', racing: 'the race: contenders and champion on the same fresh matches', exam: 'the exam', showcase: "the new champion's showcase match" };
  setText($('progText'), p.eval ? `evaluating ${p.eval} · ${fmt(p.done)} of ${fmt(p.total)} matches` : `generation ${fmt(p.gen)} · ${what[p.stage ?? ''] ?? p.stage ?? ''} · ${fmt(p.done)} of ${fmt(p.total)}`);
}
export async function reset(state: State): Promise<void> {
  const switched = state.run?.name !== run?.name;
  S = state;
  run = state.run;
  hist = run?.history ?? [];
  if (switched) {
    liveGen = -1;
    bestGen = -1;
    champId = -1;
    pendingGen = -1;
    presetPick = '';
    for (const e of run?.events ?? []) bus.emit('log', { text: e.text, time: e.time });
  }
  renderRun();
  renderProgress(run?.progress ?? null);
  renderSettings();
  renderCheckpoints(run?.checkpoints ?? []);
  renderEvals(run?.evals ?? []);
  renderData();
  await refreshDisk();
  renderHistory();
  const mode = stageMode();
  if (!run) {
    if (mode === 'live' || mode === 'best' || mode === 'champion') {
      view.gen = null;
      setMode('idle');
      setCaption('');
    }
    return;
  }
  // after a switch or a rewind, whatever was shown may be gone: back to LIVE on the newest (only when
  // the field is on the generational trainer — never over a match someone is watching)
  if (v1On && (mode === 'idle' || mode === 'live' || (mode === 'best' && !onDisk.includes(bestGen)) || switched)) {
    if (mode !== 'replay') await showLive(newest());
  }
  renderViewInfo();
}
export function onStatus(s: Status | null): void {
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
}
export const onProgress = (p: Progress): void => renderProgress(p);
export async function onGeneration(g: GenSummary): Promise<void> {
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
  if (stageMode() === 'live') {
    if (liveGen < 0) void showLive(g.gen);
    else pendingGen = g.gen; // switch when the current replay ends: never cut one short
  }
  renderViewInfo();
  pace();
}
export function onBest(b: RunState['champion']): void {
  if (run) run.champion = b;
  renderRun();
  renderViewInfo();
  renderRace();
}
export const onCheckpoints = (list: CheckpointMeta[]): void => renderCheckpoints(list);
export function onRuns(runs: State['runs']): void {
  if (S) S.runs = runs;
  renderRuns();
}
export function onData(d: State['data']): void {
  if (S) S.data = d;
  renderData();
}
export function onEval(e: EvalResult): void {
  if (!run) return;
  run.evals.push(e);
  renderEvals(run.evals);
  renderHistory();
  toast('Evaluation finished.');
}
export const onConnected = (): void => renderStatus();
export function onReconnecting(): void {
  setText($('status'), 'reconnecting');
  $('status').className = 'status off';
}
/** a v1 page was opened: its charts draw at their real size */
export function showV1Page(): void {
  renderHistory();
}
