import { Comb } from './comb';
import { CHOICE_PARTS, DEATH_PARTS, LineChart, StackChart, historyTable } from './charts';
import { AUTO_START, OPTIONS, fmt, getJSON, post, type CheckpointMeta, type EvalResult, type FocusFile, type GenFile, type GenSummary, type RunConfig, type RunState, type State, type Status } from './data';
import { FieldView, type FrameInfo } from './fieldview';
import type { World } from '../../dsim-main/src/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const view = new FieldView($<HTMLCanvasElement>('field'));
const scoreChart = new LineChart($<HTMLCanvasElement>('chartScore'), $('scoreLegend'), [
  { key: 'bestScore', label: 'best', color: '--s-best' },
  { key: 'meanScore', label: 'mean', color: '--s-mean' },
], ' pts', true);
const fitChart = new LineChart($<HTMLCanvasElement>('chartFit'), $('fitLegend'), [
  { key: 'best', label: 'best', color: '--s-best' },
  { key: 'mean', label: 'mean', color: '--s-mean' },
  { key: 'median', label: 'median', color: '--s-median' },
], '');
const deathChart = new StackChart($<HTMLCanvasElement>('chartDeaths'), $('deathLegend'), DEATH_PARTS, (g) => `generation ${g.gen}`);
const choiceChart = new StackChart($<HTMLCanvasElement>('chartChoice'), $('choiceLegend'), CHOICE_PARTS, (g) => `generation ${g.gen} — decisions`);
const comb = new Comb($<HTMLCanvasElement>('comb'));

let S: State | null = null;
let run: RunState | null = null;
let hist: GenSummary[] = [];
let onDisk: number[] = [];
let shownGen = -1;
let pendingGen = -1;
let mode: 'swarm' | 'focus' | 'champion' = 'swarm';
let genFile: GenFile | null = null;

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
/** a confirm dialog; `word` makes the user type it back (irreversible actions) */
function ask(title: string, text: string, yes: string, word?: string): Promise<boolean> {
  const d = $<HTMLDialogElement>('askDlg');
  $('askTitle').textContent = title;
  $('askText').textContent = text;
  $('askYes').textContent = yes;
  $('askTypeWrap').hidden = !word;
  $('askWord').textContent = word ?? '';
  const inp = $<HTMLInputElement>('askType');
  inp.value = '';
  const yesBtn = $<HTMLButtonElement>('askYes');
  yesBtn.disabled = !!word;
  inp.oninput = () => (yesBtn.disabled = inp.value !== word);
  d.showModal();
  return new Promise((r) => {
    d.onclose = () => r(d.returnValue === 'yes');
  });
}
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
    ? runs.map((r) => `<option value="${esc(r.name)}" ${run?.name === r.name ? 'selected' : ''}>${esc(r.name)} · gen ${r.gen}${r.legacy ? ' · old version (read-only)' : r.bestScore !== null ? ` · ${Math.round(r.bestScore)} pts` : ''}</option>`).join('')
    : '<option value="">no runs yet</option>';
  if (!run) sel.insertAdjacentHTML('afterbegin', '<option value="" selected>— choose —</option>');
  $('empty').hidden = !!run;
}

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

function renderRun(): void {
  renderRuns();
  renderStatus();
  if (!run) {
    for (const id of ['spawned', 'died', 'survived', 'gen']) $(id).textContent = '0';
    return;
  }
  const T = run.totals;
  $('spawned').textContent = fmt(T.spawned);
  $('died').textContent = fmt(T.deaths.crash + T.deaths.stall);
  $('diedSplit').textContent = `crashed ${fmt(T.deaths.crash)} · stalled ${fmt(T.deaths.stall)}`;
  $('survived').textContent = fmt(T.deaths.survived);
  $('gen').textContent = fmt(run.gen);
  $('stage').textContent = run.stage === 'auto' ? 'AUTO only (30 s)' : 'full 2:30 matches';
  const last = hist[hist.length - 1];
  $('rpm').textContent = last ? fmt(last.robotsPerMin) : '—';
  const b = run.bestEver;
  $('champGen').textContent = b ? `born in generation ${b.gen}` : '';
  $('champBody').innerHTML = b
    ? `<b>${Math.round(b.score)}</b> DSIM points · fitness ${b.fitness.toFixed(1)}<br>${b.parts.tips} HIVE tips · ${b.parts.shotsIn} shots in · ${b.parts.pickups} pickups · ${b.parts.hp} human-player entries · ${b.parts.wasted} missed shots · ${b.parts.violations} rule violations`
    : 'No champion yet — press Start training.';
  for (const id of ['watchChamp', 'copySnippet']) ($(id) as HTMLButtonElement).disabled = !b;
  $('dlChamp').classList.toggle('off', !b);
}

function refs(): { value: number; label: string }[] {
  const out: { value: number; label: string }[] = [];
  const ref = S?.reference;
  if (ref?.files.length) {
    const best = Math.max(...ref.files.map((f) => f.score));
    out.push({ value: best, label: `your best replay ${best} (front+back intake build)` });
  }
  const greedy = run?.evals.filter((e) => e.target.startsWith('greedy')).pop();
  if (greedy) out.push({ value: greedy.mean, label: `greedy baseline ${greedy.mean.toFixed(0)}` });
  return out;
}
function renderHistory(): void {
  scoreChart.set(hist, refs());
  fitChart.set(hist);
  deathChart.set(hist);
  choiceChart.set(hist);
  comb.set(hist, onDisk);
  if (!$('fitTable').hidden) $('fitTable').innerHTML = historyTable(hist);
}

function renderCheckpoints(list: CheckpointMeta[]): void {
  if (run) run.checkpoints = list;
  $('ckCount').textContent = `${list.length}`;
  $('ckList').innerHTML = list.length
    ? list
        .map(
          (m) => `<div class="ck${m.pinned ? ' pinned' : ''}" data-id="${m.id}">
      <div class="ckmain"><b>${esc(m.label)}</b><span class="sub">gen ${m.gen} · ${m.bestScore !== null ? `champion ${Math.round(m.bestScore)} pts` : 'no champion yet'} · ${new Date(m.time).toLocaleString()}${m.auto ? ' · automatic' : ''}${m.pinned ? ' · pinned' : ''}</span>
      <span class="sub mono">${m.config.algo.toUpperCase()} pop ${m.config.pop} · σ ${m.config.sigma}${m.config.algo === 'ga' ? ` · cross ${m.config.crossRate} · gene p ${m.config.mutProb}` : ` · lr ${m.config.lr}`}</span></div>
      <div class="row"><button type="button" data-do="rewind">Rewind here</button><button type="button" class="quiet" data-do="fork">Fork</button><button type="button" class="quiet" data-do="pin">${m.pinned ? 'Unpin' : 'Pin'}</button><button type="button" class="quiet danger" data-do="delete">Delete</button></div>
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
  else if (what === 'pin') await act(post(`/api/checkpoints/${id}/pin`, { pinned: !m.pinned }));
  else if (what === 'delete') {
    if (!(await ask('Delete this checkpoint?', `"${m.label}" (generation ${m.gen}) is removed from disk. This cannot be undone.`, 'Delete', 'delete'))) return;
    await act(post(`/api/checkpoints/${id}/delete`), 'checkpoint deleted');
  }
};
$('ckForm').onsubmit = async (e) => {
  e.preventDefault();
  const label = $<HTMLInputElement>('ckLabel').value.trim();
  if (await act(post('/api/checkpoints', { label }), 'checkpoint saved')) $<HTMLInputElement>('ckLabel').value = '';
};

// ─────────────────────────────── settings ───────────────────────────────
type FieldDef = { key: string; label: string; type: 'number' | 'select' | 'check'; step?: string; min?: string; max?: string; opts?: [string, string][]; only?: 'ga' | 'es'; help?: string };
const EVO: FieldDef[] = [
  { key: 'pop', label: 'Population', type: 'number', min: '4', max: '8192', help: 'robots per generation' },
  { key: 'sigma', label: 'Mutation size σ', type: 'number', step: '0.001', min: '0.001', max: '2', help: 'how far a nudged gene moves' },
  { key: 'mutProb', label: 'Genes mutated', type: 'number', step: '0.01', min: '0.01', max: '1', only: 'ga', help: 'probability per gene' },
  { key: 'crossRate', label: 'Crossover rate', type: 'number', step: '0.01', min: '0', max: '1', only: 'ga', help: 'children bred from two parents' },
  { key: 'elite', label: 'Elites', type: 'number', min: '0', only: 'ga', help: 'best robots kept unchanged' },
  { key: 'truncation', label: 'Parent fraction', type: 'number', step: '0.01', min: '0.01', max: '1', only: 'ga', help: 'top share allowed to breed' },
  { key: 'tournament', label: 'Tournament size', type: 'number', min: '1', only: 'ga', help: 'selection pressure' },
  { key: 'lr', label: 'Learning rate', type: 'number', step: '0.001', min: '0.0001', max: '1', only: 'es' },
  { key: 'weightDecay', label: 'Weight decay', type: 'number', step: '0.0001', min: '0', max: '0.99', only: 'es' },
];
const FIT: FieldDef[] = [
  { key: 'shaping.pickup', label: 'Hint: per pickup', type: 'number', step: '0.05', min: '0' },
  { key: 'shaping.shotIn', label: 'Hint: per shot in', type: 'number', step: '0.05', min: '0' },
  { key: 'shaping.hpEntry', label: 'Hint: per human-player entry', type: 'number', step: '0.05', min: '0' },
  { key: 'annealGens', label: 'Hints fade out over', type: 'number', min: '1', help: 'generations' },
  { key: 'penalty.violation', label: 'Penalty: rule violation', type: 'number', step: '0.5', min: '0' },
  { key: 'penalty.wastedShot', label: 'Penalty: missed shot', type: 'number', step: '0.1', min: '0' },
  { key: 'penalty.strike', label: 'Penalty: physics exploit', type: 'number', step: '0.5', min: '0' },
  { key: 'penalty.crash', label: 'Penalty: HIVE-frame crash', type: 'number', step: '0.5', min: '0' },
];
const WORLD: FieldDef[] = [
  { key: 'episodes', label: 'Matches per robot', type: 'number', min: '1', max: '32', help: 'more = less luck, slower' },
  { key: 'stage', label: 'Episodes', type: 'select', opts: [['full', 'full 2:30 matches'], ['auto', 'AUTO only'], ['curriculum', 'AUTO first, then full']] },
  { key: 'driver', label: 'Driver', type: 'select', opts: [['oracle', 'exact'], ['human', 'human reaction time']] },
  { key: 'sampleProfile', label: 'New robot from the range every life', type: 'check' },
];
const HOUSE: FieldDef[] = [
  { key: 'workers', label: 'CPU workers', type: 'number', min: '1', max: '64', help: 'cores used' },
  { key: 'ckEvery', label: 'Auto checkpoint every', type: 'number', min: '0', help: 'generations (0 = off)' },
  { key: 'ckKeep', label: 'Auto checkpoints kept', type: 'number', min: '1' },
  { key: 'keepGens', label: 'Generations kept on disk', type: 'number', min: '10' },
  { key: 'maxGens', label: 'Stop at generation', type: 'number', min: '0', help: '0 = never' },
];
const getPath = (o: unknown, k: string): unknown => k.split('.').reduce<unknown>((a, p) => (a as Record<string, unknown>)?.[p], o);
function fieldHtml(d: FieldDef, cfg: RunConfig): string {
  if (d.only && d.only !== cfg.algo) return '';
  const v = getPath(cfg, d.key);
  const help = d.help ? `<span class="sub">${d.help}</span>` : '';
  if (d.type === 'check') return `<label class="check"><input type="checkbox" data-key="${d.key}" ${v ? 'checked' : ''}/> ${d.label}</label>`;
  if (d.type === 'select') return `<label>${d.label}<select data-key="${d.key}">${d.opts!.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('')}</select>${help}</label>`;
  return `<label>${d.label}<input type="number" data-key="${d.key}" value="${v}" ${d.step ? `step="${d.step}"` : ''} ${d.min ? `min="${d.min}"` : ''} ${d.max ? `max="${d.max}"` : ''}/>${help}</label>`;
}
function renderSettings(): void {
  if (!run) return;
  const c = run.config;
  $('cfgAlgo').textContent = c.algo === 'ga' ? 'genetic algorithm' : 'evolution strategies';
  $('cfgEvo').innerHTML = EVO.map((d) => fieldHtml(d, c)).join('');
  $('cfgFit').innerHTML = FIT.map((d) => fieldHtml(d, c)).join('');
  $('cfgWorld').innerHTML = WORLD.map((d) => fieldHtml(d, c)).join('');
  $('cfgHouse').innerHTML = HOUSE.map((d) => fieldHtml(d, c)).join('');
  $('cfgFixed').textContent = `Fixed for this run (fork or start a new run to change): algorithm ${c.algo.toUpperCase()}, seed ${c.seed}, robot ${c.profile}, generation 0 from ${c.init === 'imitation' ? 'your replays' : 'random networks'}.`;
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
    const n = Object.keys(r.changed).length;
    toast(n ? `applied: ${Object.keys(r.changed).join(', ')} — from the next generation` : 'nothing changed');
  } catch (err) {
    toast((err as Error).message, true);
  }
};

// ─────────────────────────────── evaluation ───────────────────────────────
function renderEvalTargets(): void {
  const sel = $<HTMLSelectElement>('evalTarget');
  const keep = sel.value;
  const cks = run?.checkpoints ?? [];
  sel.innerHTML = [
    ['champion', 'Champion (best ever)'],
    ['current', 'Current policy'],
    ['greedy', 'Greedy baseline (no learning)'],
    ['imitation', 'Imitation of your replays (no evolution)'],
    ...cks.filter((m) => m.bestScore !== null).map((m) => [m.id, `Checkpoint: ${m.label} (gen ${m.gen})`]),
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
    : '<p class="hint">No evaluations yet. Start with the greedy baseline: it is the bar evolution has to clear.</p>';
}
$('evalForm').onsubmit = async (e) => {
  e.preventDefault();
  await act(post('/api/eval', { target: $<HTMLSelectElement>('evalTarget').value, n: Number($<HTMLInputElement>('evalN').value) }), 'evaluation queued — results appear here');
};

// ─────────────────────────────── lineage ───────────────────────────────
let prevRank = new Map<number, number>();
async function renderLineage(g: GenFile): Promise<void> {
  $('linGen').textContent = String(g.gen);
  const ops: Record<string, number> = {};
  for (const i of g.individuals) ops[i.op] = (ops[i.op] ?? 0) + 1;
  $('linOps').innerHTML = Object.entries(ops)
    .map(([k, v]) => `<span><b>${v}</b> ${k}</span>`)
    .join('');
  prevRank = new Map();
  if (g.gen > 0 && onDisk.includes(g.gen - 1)) {
    try {
      const p = await getJSON<GenFile>(`/api/gen/${g.gen - 1}`);
      p.individuals.forEach((q, k) => prevRank.set(q.id, k + 1));
    } catch {
      /* not on disk */
    }
  }
  $('linTable').innerHTML = `<table><thead><tr><th>rank</th><th>robot</th><th>made by</th><th>parents (rank)</th><th>genes changed</th><th>score</th><th>fitness</th><th>ended</th></tr></thead><tbody>${g.individuals
    .slice(0, 40)
    .map(
      (q, k) =>
        `<tr><td>${k + 1}</td><td>#${q.id}</td><td class="l">${q.op}</td><td class="l">${q.parents.map((p) => `#${p}${prevRank.has(p) ? ` (${prevRank.get(p)})` : ''}`).join(' × ') || '—'}</td><td>${q.muts}</td><td>${Math.round(q.score)}</td><td>${q.fitness.toFixed(1)}</td><td>${q.death}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

// ─────────────────────────────── the field ───────────────────────────────
function setMode(m: typeof mode): void {
  mode = m;
  $('modeSwarm').setAttribute('aria-selected', String(m === 'swarm'));
  $('modeFocus').setAttribute('aria-selected', String(m === 'focus'));
  $('modeChamp').setAttribute('aria-selected', String(m === 'champion'));
}
async function refreshDisk(): Promise<void> {
  onDisk = run ? await getJSON<number[]>('/api/gens').catch(() => []) : [];
}
async function showGen(g: number, m: 'swarm' | 'focus' = mode === 'champion' ? 'swarm' : mode): Promise<void> {
  try {
    if (m === 'swarm') {
      genFile = await getJSON<GenFile>(`/api/gen/${g}`);
      view.loadGeneration(genFile);
      void renderLineage(genFile);
    } else view.loadFocus(await getJSON<FocusFile>(`/api/gen/${g}/frames`));
    shownGen = g;
    comb.selected = g;
    comb.draw();
    $('genLabel').textContent = `gen ${fmt(g)}`;
    setMode(m);
    pace();
  } catch (e) {
    log(`generation ${g}: ${(e as Error).message}`);
  }
}
async function watchChampion(): Promise<void> {
  try {
    const f = await getJSON<FocusFile>('/api/best/frames');
    view.loadFocus(f);
    setMode('champion');
    $('genLabel').textContent = `gen ${fmt(f.gen)}`;
    pace();
  } catch (e) {
    toast((e as Error).message, true);
  }
}
const neighbour = (dir: 1 | -1): number | undefined => onDisk[onDisk.indexOf(shownGen) + dir];
$('genPrev').onclick = () => {
  const g = neighbour(-1);
  if (g !== undefined) {
    $<HTMLInputElement>('follow').checked = false;
    void showGen(g);
  }
};
$('genNext').onclick = () => {
  const g = neighbour(1);
  if (g !== undefined) void showGen(g);
};
comb.onPick = (g) => {
  $<HTMLInputElement>('follow').checked = false;
  void showGen(g);
};
$('modeSwarm').onclick = () => shownGen >= 0 && void showGen(shownGen, 'swarm');
$('modeFocus').onclick = () => shownGen >= 0 && void showGen(shownGen, 'focus');
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

/** NO SPEED BUTTONS: a replay plays as fast as it has to so it lasts about as long as the next
 * generation takes — the field always shows the newest generation. Idle: ~20 s per match. */
function pace(): void {
  const last = hist[hist.length - 1];
  const matchS = Math.max(1, (view.endTick - (mode === 'swarm' ? AUTO_START : 0)) / 60);
  const target = run?.running && !run.paused && last ? Math.max(4, last.wallS) : 20;
  view.speed = Math.max(1, Math.min(120, matchS / target));
  $('pace').textContent = `${view.speed.toFixed(view.speed < 10 ? 1 : 0)}×`;
}

$('play').onclick = () => {
  view.playing = !view.playing;
  $('play').textContent = view.playing ? 'Pause' : 'Play';
};
const scrub = $<HTMLInputElement>('scrub');
scrub.oninput = () => {
  const lo = view.mode === 'swarm' ? AUTO_START : 0;
  view.seek(Math.round(lo + (Number(scrub.value) / 1000) * (view.endTick - lo)));
};
const clock = (t: number): string => {
  const s = Math.max(0, (t - AUTO_START) / 60);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
view.onFrame = (f: FrameInfo) => {
  const lo = view.mode === 'swarm' ? AUTO_START : 0;
  if (document.activeElement !== scrub) scrub.value = String(Math.round((1000 * (f.tick - lo)) / Math.max(1, f.end - lo)));
  $('clock').textContent = clock(f.tick);
  if (f.mode === 'swarm') {
    $('overlay').innerHTML = `<span class="alive">${f.alive}</span>alive of ${f.total} · generation ${fmt(shownGen)}`;
  } else {
    const opt = f.optionKind !== undefined ? OPTIONS[f.optionKind] : undefined;
    const hop = [...(f.hopper ?? '')].map((c) => `<i class="dot ${c}"></i>`).join('') || '<span class="sub">empty</span>';
    const ph = f.phase === 'teleop' ? 'TELEOP' : f.phase === 'auto' ? 'AUTO' : (f.phase ?? '').toUpperCase();
    $('overlay').innerHTML = `<span class="alive">${f.score ?? 0}</span>DSIM points · ${f.tips ?? 0} tips · ${ph} ${Math.max(0, f.phaseLeft ?? 0).toFixed(0)} s<br>hopper ${hop}<br>${opt ? `<i class="optsw" style="background:${opt.color}"></i>${esc(f.option ?? '')}` : '<span class="sub">deciding…</span>'}<br><span class="sub">${mode === 'champion' ? 'champion' : `best of generation ${fmt(shownGen)}`} · exactly as trained</span>`;
  }
};
view.onLoop = () => {
  if (pendingGen >= 0 && $<HTMLInputElement>('follow').checked && mode !== 'champion') {
    const g = pendingGen;
    pendingGen = -1;
    void showGen(g);
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

async function openNew(): Promise<void> {
  const profiles = await getJSON<string[]>('/api/profiles').catch(() => ['profiles/real-v0.json']);
  $('newProfile').innerHTML = profiles.map((p) => `<option value="${p}" ${p.endsWith('real-v0.json') ? 'selected' : ''}>${p.replace('profiles/', '').replace('.json', '')}</option>`).join('');
  $('newErr').textContent = '';
  $<HTMLDialogElement>('newDlg').showModal();
}
$('btnNew').onclick = () => void openNew();
$('btnNew2').onclick = () => void openNew();
$('newForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData($<HTMLFormElement>('newForm'));
  const body = { name: f.get('name'), algo: f.get('algo'), pop: Number(f.get('pop')), init: f.get('init'), profile: f.get('profile'), sampleProfile: f.get('sampleProfile') === 'on', driver: f.get('driver'), stage: f.get('stage'), seed: Number(f.get('seed')) };
  $('newErr').textContent = body.init === 'imitation' ? 'Creating… (fitting your replays can take ~20 s the first time)' : 'Creating…';
  try {
    await post('/api/runs', body);
    $<HTMLDialogElement>('newDlg').close();
    toast(`run "${body.name}" created — press Start training`);
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
  (f.elements.namedItem('pop') as HTMLInputElement).value = String(run?.config.pop ?? '');
  (f.elements.namedItem('sigma') as HTMLInputElement).value = String(run?.config.sigma ?? '');
  $('forkErr').textContent = '';
  $<HTMLDialogElement>('forkDlg').showModal();
}
$('forkForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData($<HTMLFormElement>('forkForm'));
  const overrides: Record<string, number> = {};
  if (f.get('pop')) overrides.pop = Number(f.get('pop'));
  if (f.get('sigma')) overrides.sigma = Number(f.get('sigma'));
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
    shownGen = -1;
    pendingGen = -1;
  }
  renderRun();
  renderSettings();
  renderCheckpoints(run?.checkpoints ?? []);
  renderEvals(run?.evals ?? []);
  await refreshDisk();
  renderHistory();
  if (run && (switched || !onDisk.includes(shownGen))) {
    if (onDisk.length) await showGen(onDisk[onDisk.length - 1], 'swarm');
    else {
      view.gen = null;
      $('genLabel').textContent = '—';
    }
  }
}
function connect(): void {
  const es = new EventSource('/api/events');
  es.addEventListener('reset', (e) => void reset(JSON.parse((e as MessageEvent).data) as State));
  es.addEventListener('status', (e) => {
    const s = JSON.parse((e as MessageEvent).data) as Status | null;
    if (!run || !s) return;
    const cfgChanged = JSON.stringify(run.config) !== JSON.stringify(s.config);
    Object.assign(run, { running: s.running, paused: s.paused, phase: s.phase, gen: s.gen, stage: s.stage, config: s.config });
    renderStatus();
    if (cfgChanged) renderSettings();
    pace();
  });
  es.addEventListener('progress', (e) => {
    const p = JSON.parse((e as MessageEvent).data) as { gen: number; done: number; total: number; eval?: string };
    $('progFill').style.transform = `scaleX(${p.total ? p.done / p.total : 0})`;
    $('progText').textContent = p.eval ? `evaluating ${p.eval} · ${fmt(p.done)} of ${fmt(p.total)} matches` : `generation ${fmt(p.gen)} · ${fmt(p.done)} of ${fmt(p.total)} robots have lived`;
  });
  es.addEventListener('generation', async (e) => {
    const g = JSON.parse((e as MessageEvent).data) as GenSummary;
    if (!run) return;
    hist.push(g);
    run.gen = g.gen + 1;
    run.totals.spawned = g.spawnedTotal;
    run.totals.deaths.crash += g.deaths.crash;
    run.totals.deaths.stall += g.deaths.stall;
    run.totals.deaths.survived += g.deaths.survived;
    await refreshDisk();
    renderRun();
    renderHistory();
    if ($<HTMLInputElement>('follow').checked && mode !== 'champion') {
      if (shownGen < 0) void showGen(g.gen);
      else pendingGen = g.gen; // switch when the current replay ends — never cut one short
    }
    pace();
  });
  es.addEventListener('best', (e) => {
    const b = JSON.parse((e as MessageEvent).data) as NonNullable<RunState['bestEver']>;
    if (run) run.bestEver = b;
    renderRun();
    log(`new champion: ${Math.round(b.score)} DSIM points (fitness ${b.fitness.toFixed(1)}) in generation ${b.gen}`);
  });
  es.addEventListener('log', (e) => log(JSON.parse((e as MessageEvent).data) as string));
  es.addEventListener('checkpoints', (e) => renderCheckpoints(JSON.parse((e as MessageEvent).data) as CheckpointMeta[]));
  es.addEventListener('runs', (e) => {
    if (S) S.runs = JSON.parse((e as MessageEvent).data);
    renderRuns();
  });
  es.addEventListener('eval', (e) => {
    if (!run) return;
    run.evals.push(JSON.parse((e as MessageEvent).data) as EvalResult);
    renderEvals(run.evals);
    renderHistory();
    toast('evaluation finished');
  });
  es.onopen = () => renderStatus();
  es.onerror = () => {
    $('status').textContent = 'reconnecting';
    $('status').className = 'status off';
  };
}

async function boot(): Promise<void> {
  view.setField(await getJSON<World>('/api/field'));
  connect();
  requestAnimationFrame(frame);
}
void boot();
