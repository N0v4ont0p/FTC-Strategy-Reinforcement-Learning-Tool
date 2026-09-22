import { Comb } from './comb';
import { CHOICE_PARTS, DEATH_PARTS, LineChart, StackChart, historyTable } from './charts';
import { AUTO_START, OPTIONS, OP_LABEL, bytes, fmt, getJSON, post, type CheckpointMeta, type EvalResult, type FocusFile, type GenFile, type GenSummary, type RunConfig, type RunState, type State, type Status, type DataInfo } from './data';
import { FieldView, type FrameInfo } from './fieldview';
import type { World } from '../../dsim-main/src/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pct = (v: number | undefined): string => (v === undefined ? '—' : `${(100 * v).toFixed(0)}%`);
const view = new FieldView($<HTMLCanvasElement>('field'));
const scoreChart = new LineChart($<HTMLCanvasElement>('chartScore'), $('scoreLegend'), [
  { key: 'bestScore', label: 'best', color: '--s-best' },
  { key: 'meanScore', label: 'mean', color: '--s-mean' },
  { key: 'champScore', label: 'champion', color: '--s-median' },
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
/** LIVE follows training; the two replays are for analysing at 1× or 2× */
let mode: 'live' | 'best' | 'champion' = 'live';
let liveGen = -1;
let pendingGen = -1;
let bestGen = -1;
let champGen = -1;
let speed = 1;
let closed = false;
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
    ? runs.map((r) => `<option value="${esc(r.name)}" ${run?.name === r.name ? 'selected' : ''}>${esc(r.name)} · gen ${r.gen}${r.legacy ? ' · old version' : r.bestScore !== null ? ` · ${Math.round(r.bestScore)} pts` : ''}</option>`).join('')
    : '<option value="">no runs yet</option>';
  if (!run) sel.insertAdjacentHTML('afterbegin', '<option value="" selected>— choose —</option>');
  $('empty').hidden = !!run;
  $('runsList').innerHTML = runs.length
    ? runs
        .map((r) => {
          const open = run?.name === r.name;
          const acts = r.legacy
            ? `<button type="button" class="quiet danger" data-run="delete">Delete</button>`
            : `${open ? '' : '<button type="button" data-run="open">Open</button>'}<button type="button" class="quiet" data-run="rename">Rename</button><button type="button" class="quiet" data-run="duplicate">Duplicate</button><button type="button" class="quiet danger" data-run="delete">Delete</button>`;
          const meta = r.legacy ? `old version: ${esc(r.legacy)}` : `gen ${fmt(r.gen)} · ${r.bestScore !== null ? `champion ${Math.round(r.bestScore)} pts` : 'no champion yet'} · ${r.algo.toUpperCase()} ${r.pop} robots`;
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

function renderRun(): void {
  renderRuns();
  renderStatus();
  if (!run) {
    for (const id of ['spawned', 'died', 'survived', 'gen']) $(id).textContent = '0';
    $('champBody').textContent = 'No run open.';
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
    ? `<b>${b.score.toFixed(0)}</b> DSIM points${b.val ? ` <span class="ci">± ${b.val.ci95.toFixed(0)}</span> — mean of ${b.val.n} validation matches (95% interval)` : ' — one match (validation is off)'} · fitness ${b.fitness.toFixed(1)}<br>in its showcase match: ${b.parts.tips} HIVE tips · ${b.parts.shotsIn} shots in · ${b.parts.pickups} pickups · ${b.parts.hp} human-player entries · ${b.parts.wasted} missed shots · ${b.parts.violations} rule violations`
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
  renderOpStats();
}

// ─────────────────────────────── checkpoints ───────────────────────────────
function renderCheckpoints(list: CheckpointMeta[]): void {
  if (run) run.checkpoints = list;
  $('ckCount').textContent = `${list.length}`;
  $('ckList').innerHTML = list.length
    ? list
        .map(
          (m) => `<div class="ck${m.pinned ? ' pinned' : ''}" data-id="${m.id}">
      <div class="ckmain"><b>${esc(m.label)}</b><span class="sub">gen ${m.gen} · ${m.bestScore !== null ? `champion ${Math.round(m.bestScore)} pts` : 'no champion yet'} · ${new Date(m.time).toLocaleString()}${m.auto ? ' · automatic' : ''}${m.pinned ? ' · pinned' : ''}</span>
      <span class="sub mono">${m.config.algo.toUpperCase()} pop ${m.config.pop} · σ ${m.config.sigma}${m.config.preset ? ` · ${esc(S?.presets.find((p) => p.id === m.config.preset)?.label ?? m.config.preset)}` : ''}</span></div>
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
type FieldDef = { key: string; label: string; type: 'number' | 'select' | 'check'; step?: string; min?: string; max?: string; opts?: [string, string][]; only?: 'ga' | 'es'; help?: string };
const EVO: FieldDef[] = [
  { key: 'pop', label: 'Robots per generation', type: 'number', min: '4', max: '8192' },
  { key: 'elite', label: 'Elites', type: 'number', min: '0', only: 'ga', help: 'best robots kept unchanged' },
  { key: 'truncation', label: 'Parent fraction', type: 'number', step: '0.01', min: '0.01', max: '1', only: 'ga', help: 'top share allowed to breed' },
  { key: 'tournament', label: 'Tournament size', type: 'number', min: '1', only: 'ga', help: 'selection pressure' },
  { key: 'crossRate', label: 'Crossover rate', type: 'number', step: '0.01', min: '0', max: '1', only: 'ga', help: 'of ordinary children' },
  { key: 'sigma', label: 'Mutation size σ', type: 'number', step: '0.001', min: '0.001', max: '2', help: 'how far a nudged gene moves' },
  { key: 'mutProb', label: 'Genes nudged', type: 'number', step: '0.01', min: '0.01', max: '1', only: 'ga', help: 'probability per gene' },
  { key: 'lr', label: 'Learning rate', type: 'number', step: '0.001', min: '0.0001', max: '1', only: 'es' },
  { key: 'weightDecay', label: 'Weight decay', type: 'number', step: '0.0001', min: '0', max: '0.99', only: 'es' },
];
const LEARN: FieldDef[] = [
  { key: 'macroRate', label: 'Behaviour mutations', type: 'number', step: '0.01', min: '0', max: '0.9', only: 'ga', help: 'share of children; each changes what it chooses' },
  { key: 'immigrants', label: 'Random newcomers', type: 'number', step: '0.01', min: '0', max: '0.5', only: 'ga', help: 'share of brand-new robots' },
  { key: 'imitRate', label: 'Students', type: 'number', step: '0.01', min: '0', max: '0.9', only: 'ga', help: 'share taking a lesson from your replays (start)' },
  { key: 'imitMin', label: 'Students at least', type: 'number', step: '0.01', min: '0', max: '0.9', only: 'ga' },
  { key: 'imitMax', label: 'Students at most', type: 'number', step: '0.01', min: '0', max: '0.9', only: 'ga' },
  { key: 'lessonSteps', label: 'Lesson length', type: 'number', min: '1', max: '1000', only: 'ga', help: 'learning steps per student' },
  { key: 'imitAdapt', label: 'The students\' share follows how well they do', type: 'check', only: 'ga' },
];
const ACC: FieldDef[] = [
  { key: 'episodes', label: 'Matches per robot', type: 'number', min: '1', max: '32', help: 'more = less luck in the ranking, slower' },
  { key: 'validateTop', label: 'Robots validated', type: 'number', min: '0', max: '32', help: 'best of each generation (0 = champion by one match)' },
  { key: 'valEpisodes', label: 'Validation matches', type: 'number', min: '1', max: '64', help: 'fixed matches the champion is proven on' },
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
let presetPick = '';
const KEY_LABEL: Record<string, string> = {
  pop: 'robots',
  episodes: 'matches per robot',
  sigma: 'σ',
  mutProb: 'genes nudged',
  crossRate: 'crossover',
  elite: 'elites',
  truncation: 'parent fraction',
  tournament: 'tournament',
  macroRate: 'behaviour mutations',
  immigrants: 'newcomers',
  imitRate: 'students',
  imitAdapt: 'adaptive students',
  imitMin: 'students min',
  imitMax: 'students max',
  lessonSteps: 'lesson',
  validateTop: 'validated',
  valEpisodes: 'validation matches',
  workers: 'workers',
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
  const diff = p && c ? Object.entries(p.change).filter(([k, v]) => !(c.algo === 'es' && !['pop', 'episodes', 'validateTop', 'valEpisodes', 'workers', 'sigma'].includes(k)) && JSON.stringify((c as unknown as Record<string, unknown>)[k]) !== JSON.stringify(v)) : [];
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
  $('cfgAlgo').textContent = c.algo === 'ga' ? 'genetic algorithm' : 'evolution strategies';
  $('cfgEvo').innerHTML = EVO.map((d) => fieldHtml(d, c)).join('');
  $('cfgLearn').innerHTML = LEARN.map((d) => fieldHtml(d, c)).join('') || '<p class="hint">Evolution-strategies runs have no students or behaviour mutations.</p>';
  $('cfgAcc').innerHTML = ACC.map((d) => fieldHtml(d, c)).join('');
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
        ? `The open run learns from this data${rd.experience ? ` and from its champion's own ${rd.experience} decisions` : ''}. ${D.fitted ? `The fitted network picks the same next option as you ${pct(D.fitted.agree)} of the time on a replay it never saw (chance ${pct(D.fitted.chance)}).` : ''}`
        : `The open run learns from an older set of replays. ${D.built && D.fitted ? '<button type="button" class="link" id="dataUse">Use the current set</button>' : 'Refresh to build the current set.'}`;
  const use = document.getElementById('dataUse');
  if (use) use.onclick = () => void act(post('/api/data/use'), 'the run learns from the current set from its next generation');
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

// ─────────────────────────────── what works: operators ───────────────────────────────
function renderOpStats(): void {
  const last = hist[hist.length - 1];
  const ops = ['mutant', 'cross', 'macro', 'student', 'random'] as const;
  if (!last || !last.opSmooth) {
    $('opStats').innerHTML = '<p class="hint">Appears after the first generations.</p>';
    $('studentStats').innerHTML = '<p class="hint">Appears after the first generations.</p>';
    return;
  }
  $('opStats').innerHTML = `<table><thead><tr><th class="l">made by</th><th>last generation</th><th>smoothed</th><th>in this generation</th></tr></thead><tbody>${ops
    .map((o) => `<tr><td class="l">${OP_LABEL[o]}</td><td>${pct(last.opRates?.[o])}</td><td>${pct(last.opSmooth?.[o])}</td><td>${last.ops?.[o] ?? 0}</td></tr>`)
    .join('')}</tbody></table><p class="hint">A child "makes it" when it ranks in the top quarter of its generation (the parents of the next). Students' share of the next generation: <b>${pct(last.imitShare)}</b>${run?.config.imitAdapt ? ' — it grows while students beat plain mutants and shrinks while they do not' : ' (fixed)'}.</p>`;
  const s = last.opSmooth.student;
  const m = last.opSmooth.mutant;
  $('studentStats').innerHTML =
    s === undefined
      ? `Students' share: ${pct(last.imitShare)}. ${run?.data.key ? 'No students have been scored yet.' : 'No replays to learn from.'}`
      : `Students make the top quarter <b>${pct(s)}</b> of the time, plain mutants <b>${pct(m)}</b>. So learning from your replays is ${s > (m ?? 0) ? '<b>helping</b>: the next generations use more of it' : '<b>not helping right now</b>: the next generations use less of it'} — students are ${pct(last.imitShare)} of the next generation.`;
}

// ─────────────────────────────── evaluation ───────────────────────────────
function renderEvalTargets(): void {
  const sel = $<HTMLSelectElement>('evalTarget');
  const keep = sel.value;
  const cks = run?.checkpoints ?? [];
  sel.innerHTML = [
    ['champion', 'Champion'],
    ['current', 'Current policy (best of the last generation)'],
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
    .map(([k, v]) => `<span><b>${v}</b> ${OP_LABEL[k] ?? k}</span>`)
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
  $('linTable').innerHTML = `<table><thead><tr><th>rank</th><th>robot</th><th class="l">made by</th><th class="l">parents (rank)</th><th>genes</th><th>behaviour</th><th>score</th><th>validated</th><th>ended</th></tr></thead><tbody>${g.individuals
    .slice(0, 40)
    .map(
      (q, k) =>
        `<tr><td>${k + 1}</td><td>#${q.id}</td><td class="l">${OP_LABEL[q.op] ?? q.op}${q.style ? ' (skill)' : ''}</td><td class="l">${q.parents.map((p) => `#${p}${prevRank.has(p) ? ` (${prevRank.get(p)})` : ''}`).join(' × ') || '—'}</td><td>${q.muts}</td><td>${q.style ? 'skill' : q.changed !== undefined ? pct(q.changed) : '—'}</td><td>${Math.round(q.score)}</td><td>${q.val ? `${q.val.score.toFixed(0)} ± ${q.val.ci95.toFixed(0)}` : '—'}</td><td>${q.death}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

// ─────────────────────────────── the field: LIVE or a replay ───────────────────────────────
function setMode(m: typeof mode): void {
  mode = m;
  $('modeLive').setAttribute('aria-selected', String(m === 'live'));
  $('modeBest').setAttribute('aria-selected', String(m === 'best'));
  $('modeChamp').setAttribute('aria-selected', String(m === 'champion'));
  $('transportLive').hidden = m !== 'live';
  $('transportReplay').hidden = m === 'live';
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
  if (!run) html = '';
  else if (mode === 'live') html = liveGen >= 0 ? `generation ${fmt(liveGen)} · every robot · follows training` : 'no generations yet — press Start training';
  else if (mode === 'best') html = bestGen >= 0 ? `generation ${fmt(bestGen)} · its best robot · exactly as trained${n > bestGen ? ` · <button type="button" class="link" id="loadNewest">newest: ${fmt(n)}</button>` : ''}` : 'no generations yet';
  else {
    const b = run.bestEver;
    html = b ? `champion · born in generation ${fmt(b.gen)}${b.val ? ` · ${b.score.toFixed(0)} ± ${b.val.ci95.toFixed(0)} over ${b.val.n} validation matches` : ''}${champGen >= 0 && champGen !== b.gen ? ` · <button type="button" class="link" id="loadChamp">a new champion (gen ${fmt(b.gen)})</button>` : ''}` : 'no champion yet';
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
    void renderLineage(gf);
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
    void getJSON<GenFile>(`/api/gen/${g}`).then(renderLineage).catch(() => {});
  } catch (e) {
    toast((e as Error).message, true);
  }
}
async function watchChampion(): Promise<void> {
  try {
    const f = await getJSON<FocusFile>('/api/best/frames');
    view.loadFocus(f);
    champGen = f.gen;
    view.playing = true;
    $('play').textContent = 'Pause';
    setMode('champion');
  } catch (e) {
    toast((e as Error).message, true);
  }
}
comb.onPick = (g) => void showBest(g);
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
    $('overlay').innerHTML = `<span class="alive">${f.alive}</span>alive of ${f.total} · generation ${fmt(liveGen)}`;
  } else {
    const opt = f.optionKind !== undefined ? OPTIONS[f.optionKind] : undefined;
    const hop = [...(f.hopper ?? '')].map((c) => `<i class="dot ${c}"></i>`).join('') || '<span class="sub">empty</span>';
    const ph = f.phase === 'teleop' ? 'TELEOP' : f.phase === 'auto' ? 'AUTO' : (f.phase ?? '').toUpperCase();
    $('overlay').innerHTML = `<span class="alive">${f.score ?? 0}</span>DSIM points · ${f.tips ?? 0} tips · ${ph} ${Math.max(0, f.phaseLeft ?? 0).toFixed(0)} s<br>hopper ${hop}<br>${opt ? `<i class="optsw" style="background:${opt.color}"></i>${esc(f.option ?? '')}` : '<span class="sub">deciding…</span>'}<br><span class="sub">${mode === 'champion' ? 'champion' : `best of generation ${fmt(bestGen)}`} · exactly as trained · ${speed}×</span>`;
  }
};
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
  if (!(await ask('Quit the studio?', `Everything stops: ${run?.running ? 'training (the generation in progress is discarded; the run keeps its last saved generation), ' : ''}DSIM, and the studio itself. This tab closes. Start again with ./start.sh.`, 'Quit studio'))) return;
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
  const pop = String(f.get('pop') ?? '').trim();
  const body = { name: f.get('name'), preset: f.get('preset'), algo: f.get('algo'), ...(pop ? { pop: Number(pop) } : {}), init: f.get('init'), profile: f.get('profile'), sampleProfile: f.get('sampleProfile') === 'on', driver: f.get('driver'), stage: f.get('stage'), seed: Number(f.get('seed')) };
  $('newErr').textContent = body.init === 'imitation' ? 'Creating… (if your replays changed, they are re-simulated first: a few seconds each)' : 'Creating…';
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
    liveGen = -1;
    bestGen = -1;
    champGen = -1;
    pendingGen = -1;
    presetPick = '';
  }
  renderRun();
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
function connect(): void {
  const es = new EventSource('/api/events');
  es.addEventListener('reset', (e) => void reset(JSON.parse((e as MessageEvent).data) as State));
  es.addEventListener('status', (e) => {
    const s = JSON.parse((e as MessageEvent).data) as Status | null;
    if (!run || !s) return;
    const cfgChanged = JSON.stringify(run.config) !== JSON.stringify(s.config);
    const dataChanged = JSON.stringify(run.data) !== JSON.stringify(s.data);
    Object.assign(run, { running: s.running, paused: s.paused, phase: s.phase, gen: s.gen, stage: s.stage, config: s.config, data: s.data });
    renderStatus();
    if (cfgChanged) renderSettings();
    if (dataChanged) renderData();
    pace();
  });
  es.addEventListener('progress', (e) => {
    const p = JSON.parse((e as MessageEvent).data) as { gen: number; done: number; total: number; eval?: string; stage?: string };
    $('progFill').style.transform = `scaleX(${p.total ? p.done / p.total : 0})`;
    $('progText').textContent = p.eval
      ? `evaluating ${p.eval} · ${fmt(p.done)} of ${fmt(p.total)} matches`
      : p.stage === 'validating'
        ? `generation ${fmt(p.gen)} · proving the best on the validation matches · ${fmt(p.done)} of ${fmt(p.total)}`
        : `generation ${fmt(p.gen)} · ${fmt(p.done)} of ${fmt(p.total)} robots have lived`;
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
    if (mode === 'live') {
      if (liveGen < 0) void showLive(g.gen);
      else pendingGen = g.gen; // switch when the current replay ends — never cut one short
    }
    renderViewInfo();
    pace();
  });
  es.addEventListener('best', (e) => {
    const b = JSON.parse((e as MessageEvent).data) as NonNullable<RunState['bestEver']>;
    if (run) run.bestEver = b;
    renderRun();
    renderViewInfo();
    log(`new champion: ${b.score.toFixed(1)} DSIM points${b.val ? ` (± ${b.val.ci95.toFixed(1)} over ${b.val.n} validation matches)` : ''} in generation ${b.gen}`);
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
