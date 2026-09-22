import { Comb } from './comb';
import { DeathChart, FitnessChart, historyTable } from './charts';
import { AUTO_START, fmt, getJSON, type GenFile, type GenSummary, type State } from './data';
import { FieldView } from './fieldview';
import type { World } from '../../dsim-main/src/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const view = new FieldView($<HTMLCanvasElement>('field'));
const fit = new FitnessChart($<HTMLCanvasElement>('chartFit'), $('fitLegend'));
const deaths = new DeathChart($<HTMLCanvasElement>('chartDeaths'), $('deathLegend'));
const comb = new Comb($<HTMLCanvasElement>('comb'));
let state: State | null = null;
let hist: GenSummary[] = [];
let onDisk: number[] = [];
let shownGen = -1;
let pendingGen = -1; // follow-live: the newest generation, shown when the current replay finishes

$('fieldLegend').innerHTML = [
  `<span><i style="background:var(--honey-hi)"></i>champion of this generation (gold ring + trail)</span>`,
  `<span><i class="box" style="background:transparent;box-shadow:inset 0 0 0 2px var(--st-crash)"></i>× crashed into the HIVE frame</span>`,
  `<span><i class="box" style="background:transparent;border-radius:50%;box-shadow:inset 0 0 0 2px var(--st-stall)"></i>○ stalled</span>`,
  `<span>faint robots = the rest of the population</span>`,
].join('');

// ---------- rendering state into the page ----------
function renderState(): void {
  if (!state) return;
  const c = state.config;
  const T = state.totals;
  $('runline').textContent = `run ${c.name} · ${c.algo.toUpperCase()} · population ${c.pop} · ${c.sampleProfile ? 'robot sampled from the REAL-v0 envelope each life' : 'fixed robot'} · ${c.driver} driver`;
  const st = $('status');
  st.textContent = state.paused ? 'paused' : state.running ? 'training' : 'stopped';
  st.className = `status ${state.paused ? 'paused' : state.running ? 'on' : 'off'}`;
  $('btnPause').textContent = state.paused ? 'Resume training' : 'Pause training';
  ($('btnPause') as HTMLButtonElement).disabled = !state.running;
  ($('btnStop') as HTMLButtonElement).disabled = !state.running;
  $('spawned').textContent = fmt(T.spawned);
  $('died').textContent = fmt(T.deaths.crash + T.deaths.stall);
  $('diedSplit').textContent = `crashed ${fmt(T.deaths.crash)} · stalled ${fmt(T.deaths.stall)}`;
  $('survived').textContent = fmt(T.deaths.survived);
  $('gen').textContent = fmt(state.gen);
  $('stage').textContent = state.stage === 'auto' ? 'learning AUTO (30 s)' : 'full 2:30 matches';
  const last = hist[hist.length - 1];
  $('rpm').textContent = last ? fmt(last.robotsPerMin) : '—';
  const b = state.bestEver;
  $('champGen').textContent = b ? `born in generation ${b.gen}` : '';
  $('champBody').innerHTML = b
    ? `<b>${b.score}</b> DSIM points · fitness ${b.fitness.toFixed(1)}<br>${b.parts.pickups} pickups · ${b.parts.shotsIn} shots in · ${b.parts.tips} HIVE tips · ${b.parts.hp} human-player entries · ${b.parts.wasted} wasted shots · ${b.parts.violations} rule violations`
    : 'No champion yet — the first generation is still being born.';
  ($('watchChamp') as HTMLButtonElement).disabled = !b;
  ($('copySnippet') as HTMLButtonElement).disabled = !b;
}
function renderHistory(): void {
  fit.set(hist);
  deaths.set(hist);
  comb.set(hist, onDisk);
  if (!$('fitTable').hidden) $('fitTable').innerHTML = historyTable(hist);
}
function log(s: string): void {
  const el = document.createElement('div');
  el.textContent = `${new Date().toLocaleTimeString()}  ${s}`;
  $('log').prepend(el);
  while ($('log').childElementCount > 40) $('log').lastChild!.remove();
}

// ---------- generations ----------
async function showGen(g: number): Promise<void> {
  try {
    const file = await getJSON<GenFile>(`/api/gen/${g}`);
    view.loadGeneration(file);
    shownGen = g;
    comb.selected = g;
    comb.draw();
    $('genLabel').textContent = `gen ${fmt(g)}`;
    setMode('swarm');
  } catch {
    log(`generation ${g} is not on disk any more (only the last 300 and every 100th are kept)`);
  }
}
async function refreshDisk(): Promise<void> {
  onDisk = await getJSON<number[]>('/api/gens');
}
function neighbour(dir: 1 | -1): number | undefined {
  const i = onDisk.indexOf(shownGen);
  return onDisk[i + dir];
}
$('genPrev').onclick = () => {
  const g = neighbour(-1);
  if (g !== undefined) {
    ($('follow') as HTMLInputElement).checked = false;
    void showGen(g);
  }
};
$('genNext').onclick = () => {
  const g = neighbour(1);
  if (g !== undefined) void showGen(g);
};
comb.onPick = (g) => {
  ($('follow') as HTMLInputElement).checked = false;
  void showGen(g);
};

// ---------- modes ----------
function setMode(m: 'swarm' | 'champion'): void {
  $('modeSwarm').setAttribute('aria-selected', String(m === 'swarm'));
  $('modeChamp').setAttribute('aria-selected', String(m === 'champion'));
}
$('modeSwarm').onclick = () => {
  if (shownGen >= 0) void showGen(shownGen);
};
async function watchChampion(): Promise<void> {
  try {
    const data = await getJSON<{ meta: { title: string; score: number; replayExact: boolean }; replay: never }>('/api/best');
    await view.loadChampion(data);
    setMode('champion');
    ($('follow') as HTMLInputElement).checked = false;
    if (!data.meta.replayExact) log('champion replay: this life used forced misses (layer C); DSIM re-simulates commands only, so shots can land differently than in training');
  } catch (e) {
    log(`could not load the champion: ${String(e)}`);
  }
}
$('modeChamp').onclick = () => void watchChampion();
$('watchChamp').onclick = () => void watchChampion();
$('copySnippet').onclick = async () => {
  try {
    const r = await fetch('/api/best.inject.js', { cache: 'no-store' });
    await navigator.clipboard.writeText(await r.text());
    $('snippetHint').textContent = 'Copied. Paste it into the console on the DSIM page (Safari: Develop → Show Web Inspector), then open Records → Career.';
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

// ---------- training control ----------
async function control(action: 'pause' | 'resume' | 'stop'): Promise<void> {
  await fetch('/api/control', { method: 'POST', body: JSON.stringify({ action }) });
}
$('btnPause').onclick = () => void control(state?.paused ? 'resume' : 'pause');
$('btnStop').onclick = () => {
  if (confirm(`Stop training after this generation? Everything is checkpointed; resume later with:\n\nnpm run train -- --name ${state?.config.name ?? '<name>'}`)) void control('stop');
};

// ---------- transport ----------
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (reduce) view.speed = 1;
for (const b of document.querySelectorAll<HTMLButtonElement>('.speeds button')) {
  b.classList.toggle('on', Number(b.dataset.speed) === view.speed);
  b.onclick = () => {
    view.speed = Number(b.dataset.speed);
    for (const o of document.querySelectorAll('.speeds button')) o.classList.toggle('on', o === b);
  };
}
$('play').onclick = () => {
  view.playing = !view.playing;
  $('play').textContent = view.playing ? 'Pause' : 'Play';
};
const scrub = $<HTMLInputElement>('scrub');
scrub.oninput = () => {
  const lo = view.mode === 'swarm' ? AUTO_START : 0;
  void view.seek(Math.round(lo + (Number(scrub.value) / 1000) * (view.endTick - lo)));
};
const clock = (t: number): string => {
  const s = Math.max(0, (t - AUTO_START) / 60);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
view.onFrame = ({ alive, total, tick, end }) => {
  const lo = view.mode === 'swarm' ? AUTO_START : 0;
  if (document.activeElement !== scrub) scrub.value = String(Math.round((1000 * (tick - lo)) / Math.max(1, end - lo)));
  $('clock').textContent = clock(tick);
  if (view.mode === 'swarm') {
    $('overlay').innerHTML = `<span class="alive">${alive}</span>alive of ${total} · generation ${fmt(shownGen)}`;
  } else {
    const w = view.champWorld();
    $('overlay').innerHTML = w
      ? `<span class="alive">${w.match.scores.blue.total}</span>DSIM score · ${w.match.phase} · re-simulated in DSIM's own replay player`
      : '';
  }
};
view.onLoop = () => {
  if (pendingGen >= 0 && ($('follow') as HTMLInputElement).checked && pendingGen !== shownGen) {
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

// ---------- live stream ----------
function connect(): void {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    state = JSON.parse((e as MessageEvent).data) as State;
    hist = state.history;
    renderState();
    renderHistory();
  });
  es.addEventListener('progress', (e) => {
    const p = JSON.parse((e as MessageEvent).data) as { gen: number; done: number; total: number };
    $('progFill').style.transform = `scaleX(${p.total ? p.done / p.total : 0})`;
    $('progText').textContent = `generation ${fmt(p.gen)} · ${fmt(p.done)} of ${fmt(p.total)} lives run`;
  });
  es.addEventListener('generation', async (e) => {
    const g = JSON.parse((e as MessageEvent).data) as GenSummary;
    hist.push(g);
    if (state) {
      state.gen = g.gen + 1;
      state.totals.spawned = g.spawnedTotal;
      state.totals.deaths.crash += g.deaths.crash;
      state.totals.deaths.stall += g.deaths.stall;
      state.totals.deaths.survived += g.deaths.survived;
      if (state.bestEver) {
        state.bestEver.fitness = Math.max(state.bestEver.fitness, g.bestEver);
      }
    }
    await refreshDisk();
    renderState();
    renderHistory();
    // follow live without cutting a replay short: queue it; switch at the end of the current replay
    if (($('follow') as HTMLInputElement).checked && view.mode === 'swarm') {
      if (shownGen < 0) void showGen(g.gen);
      else pendingGen = g.gen;
    }
  });
  es.addEventListener('best', (e) => {
    const b = JSON.parse((e as MessageEvent).data) as NonNullable<State['bestEver']>;
    if (state) state.bestEver = b;
    renderState();
    log(`new champion: ${b.score} DSIM points (fitness ${b.fitness.toFixed(1)}) in generation ${b.gen}`);
  });
  es.addEventListener('log', (e) => log(JSON.parse((e as MessageEvent).data) as string));
  es.onerror = () => {
    $('status').textContent = 'reconnecting';
    $('status').className = 'status off';
  };
}

async function boot(): Promise<void> {
  view.setField(await getJSON<World>('/api/field'));
  await refreshDisk();
  connect();
  if (onDisk.length) await showGen(onDisk[onDisk.length - 1]);
  requestAnimationFrame(frame);
}
void boot();
