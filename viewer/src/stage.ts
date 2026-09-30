// THE STAGE — the field, exactly as DSIM played it, with its transport and the scoreboard rail over
// it (the studio's signature: an FTC audience display — phase and clock, the blue alliance's score,
// the HIVE's tips as honeycomb cells, the hopper, the job the robot is on).
//
// Every page that shows a match on the field goes through `watch` (a champion's exam match, a
// playbook plan, a route, a mistake, a team play), and `simulate` plays it in DSIM first with its
// progress over the field. Training's live match comes in through stream.ts (mode 'stream'); the
// older generational trainer adds its own modes (legacy.ts) through `setMode` and the frame hook.
import type { World } from '../../dsim-main/src/types';
import { AUTO_START, OPTIONS, PLAY_TICKS, post, type FocusFile, type Frames } from './data';
import { FieldView, type FrameInfo } from './fieldview';
import { $, esc, setHTML, setText } from './ui';
import { S, bus, type SimV } from './state';

export type StageMode = 'idle' | 'replay' | 'live' | 'best' | 'champion' | 'stream';
export const view = new FieldView($<HTMLCanvasElement>('field'));
let mode: StageMode = 'idle';
/** set by legacy.ts (its LIVE bar, the decision inspector) and stream.ts (training's live match) */
export const hooks: { frame: (f: FrameInfo) => void; stream: (f: FrameInfo) => void; loop: () => void; v1Empty: () => boolean; modeChanged: (m: StageMode) => void } = {
  frame: () => {},
  stream: () => {},
  loop: () => {},
  v1Empty: () => false,
  modeChanged: () => {},
};

let speed = 1;
try {
  const s = Number(localStorage.getItem('bb.speed'));
  speed = s === 2 || s === 4 ? s : 1;
} catch {
  /* private window: 1× */
}

export const stageMode = (): StageMode => mode;

/** which transport, which empty state: one place decides */
export function setMode(m: StageMode): void {
  mode = m;
  const replaying = m === 'replay' || m === 'best' || m === 'champion';
  $('transport').hidden = !replaying;
  $('transportLive').hidden = m !== 'live';
  $('transportStream').hidden = m !== 'stream';
  $('inspector').hidden = m !== 'champion';
  view.loop = m === 'live';
  if (m !== 'live' && m !== 'stream') view.speed = speed; // (both pace themselves)
  syncEmpty();
  syncPlay();
  hooks.modeChanged(m);
}
export function syncEmpty(): void {
  const v1 = hooks.v1Empty();
  $('stageEmpty').hidden = mode !== 'idle' || v1;
  $('stageEmptyV1').hidden = mode !== 'idle' || !v1;
  $('board').classList.toggle('idle', mode === 'idle');
}
export function setCaption(html: string): void {
  setHTML($('stageCap'), html);
}

/** play a recorded match on the field: from its first frame, or from `seek` */
export function watch(f: { frames: Frames; events: [number, string][] }, label: string, o: { seek?: number; mode?: StageMode } = {}): void {
  view.loadFocus({ gen: 0, fitness: 0, score: 0, death: 'survived', parts: { pickups: 0, shotsIn: 0, wasted: 0, hp: 0, tips: 0, violations: 0, strikes: 0 }, lineage: { id: -1, op: 'champion', parents: [], muts: 0, born: 0 }, frames: f.frames, events: f.events } as FocusFile);
  if (o.seek !== undefined) view.seek(o.seek);
  view.playing = true;
  setMode(o.mode ?? 'replay');
  setCaption(`<b>${esc(label)}</b><span class="sub">· exactly as DSIM played it</span>`);
}

// ─────────────────────────────── transport ───────────────────────────────
function syncPlay(): void {
  const p = view.playing;
  $('play').setAttribute('aria-label', p ? 'Pause' : 'Play');
  $('playIcon').setAttribute('d', p ? 'M3 1.5h3v11H3zM8 1.5h3v11H8z' : 'M3 1.5v11l9-5.5z');
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#transport [data-speed]')) {
  b.setAttribute('aria-checked', String(Number(b.dataset.speed) === speed));
  b.onclick = () => {
    const s = Number(b.dataset.speed);
    speed = s === 2 || s === 4 ? s : 1;
    try {
      localStorage.setItem('bb.speed', String(speed));
    } catch {
      /* not remembered */
    }
    for (const o of document.querySelectorAll<HTMLButtonElement>('#transport [data-speed]')) o.setAttribute('aria-checked', String(o === b));
    if (mode !== 'live' && mode !== 'stream') view.speed = speed;
  };
}
$('play').onclick = () => {
  if (view.empty) return;
  if (!view.playing && view.tick >= view.endTick) view.seek(view.startTick);
  view.playing = !view.playing;
  syncPlay();
};
$('restart').onclick = () => {
  if (view.empty) return;
  view.seek(view.startTick);
  view.playing = true;
  syncPlay();
};
view.onEnd = () => syncPlay();
const scrub = $<HTMLInputElement>('scrub');
scrub.oninput = () => {
  if (view.empty) return;
  const lo = view.startTick;
  view.seek(Math.round(lo + (Number(scrub.value) / 1000) * (view.endTick - lo)));
};
export const clock = (t: number): string => {
  const s = Math.max(0, (t - AUTO_START) / 60);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
// keyboard: space plays/pauses, ← → step 5 s (not while typing)
document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (e.metaKey || e.ctrlKey || e.altKey || view.empty || mode === 'idle' || mode === 'live' || mode === 'stream') return;
  if (t.closest('textarea, select, [contenteditable], dialog') || (t.closest('input') && !t.matches('input[type=range]'))) return;
  // a button or the scrubber focused from the KEYBOARD keeps its keys (Space presses it); one the
  // mouse left focused does not — Space after "Watch it" pauses instead of starting it again
  const control = t.closest<HTMLElement>('button, input');
  if (control?.matches(':focus-visible')) return;
  if (e.key === ' ') {
    e.preventDefault();
    control?.blur();
    $('play').click();
  } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !t.closest('input')) {
    e.preventDefault();
    view.seek(view.tick + (e.key === 'ArrowRight' ? 300 : -300));
  }
});

// ─────────────────────────────── the scoreboard rail ───────────────────────────────
const PHASE: Record<string, string> = { pre: 'Pre-match', auto: 'AUTO', transition: 'Transition', teleop: 'TELEOP', post: 'Final', freeplay: 'Free play' };
let boardAt = 0;
function mmss(s: number): string {
  const v = Math.max(0, Math.ceil(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}
function hexes(n: number): string {
  const shown = Math.min(8, Math.max(4, n));
  let h = '';
  for (let i = 0; i < shown; i++) h += `<i class="hex${i < n ? ' on' : ''}"></i>`;
  return h + (n > 8 ? `<span class="more">+${n - 8}</span>` : '');
}
function renderBoard(f: FrameInfo): void {
  if (f.mode === 'swarm') {
    setText($('bPhaseK'), 'Generation');
    setText($('bClock'), `${f.alive}/${f.total}`);
    setText($('bScore'), '—');
    setText($('bJobK'), 'lesson matches');
    setHTML($('bJob'), `<span>${f.alive} of ${f.total} still playing</span>`);
    setHTML($('bTips'), hexes(0));
    ($('bHop').parentElement as HTMLElement).hidden = true;
    return;
  }
  setText($('bPhaseK'), PHASE[f.phase ?? ''] ?? (f.phase ?? 'match').toUpperCase());
  setText($('bClock'), mmss(f.phaseLeft ?? 0));
  setText($('bScore'), String(f.score ?? 0));
  setText($('bJobK'), 'doing');
  const opt = f.optionKind !== undefined ? OPTIONS[f.optionKind] : undefined;
  setHTML($('bJob'), opt ? `<i style="background:${opt.color}"></i><span>${esc(f.option ?? opt.label)}</span>` : '<span class="sub">deciding…</span>');
  setHTML($('bTips'), hexes(f.tips ?? 0));
  const hop = [...(f.hopper ?? '')];
  ($('bHop').parentElement as HTMLElement).hidden = false;
  setHTML($('bHop'), hop.length ? hop.map((c) => `<i class="dot ${c}"></i>`).join('') : '<span class="sub">empty</span>');
}
view.onFrame = (f: FrameInfo) => {
  const lo = view.startTick;
  const frac = (f.tick - lo) / Math.max(1, f.end - lo);
  if (mode !== 'live' && mode !== 'stream' && document.activeElement !== scrub) scrub.value = String(Math.round(1000 * frac));
  setText($('clock'), clock(f.tick));
  hooks.frame(f);
  if (mode === 'stream') hooks.stream(f);
  // the rail at ~12 Hz and only what changed (the canvas runs at 60)
  const now = performance.now();
  if (now - boardAt < 80 && view.playing) return;
  boardAt = now;
  renderBoard(f);
};
view.onLoop = () => hooks.loop();

// ─────────────────────────────── playing a match in DSIM to watch it ───────────────────────────────
/** a match played again in DSIM (Watch on any page: an exam match, a route, a mistake, a team play):
 * the server reports its clock on the way (SSE `sim`, by request id) and the field shows how far it
 * is. The newest request wins: an older one that finishes later is not shown over it. */
let simRid = '';
export async function simulate<T>(url: string, body: Record<string, unknown>, label: string): Promise<T | null> {
  const rid = Math.random().toString(36).slice(2, 10);
  simRid = rid;
  S.sim = { rid, label, frac: 0 };
  renderSim();
  try {
    const r = await post<T>(url, { ...body, rid });
    return rid === simRid ? r : null;
  } finally {
    if (rid === simRid) {
      S.sim = null;
      renderSim();
    }
  }
}
/** the server's report on a match it is playing (SSE `sim`) */
export function simProgress(d: SimV): void {
  if (d.rid !== simRid || !S.sim) return;
  if (d.done) return; // (the request itself ends it)
  S.sim = { ...S.sim, frac: d.frac, t: d.t };
  renderSim();
}
function renderSim(): void {
  const s = S.sim;
  $('simProg').hidden = !s;
  bus.emit('activity');
  if (!s) return;
  setText($('simLabel'), `Playing ${s.label} in DSIM`);
  $('simFill').style.transform = `scaleX(${Math.max(0.02, Math.min(1, s.frac)).toFixed(3)})`;
  $('simProg').querySelector('.jpbar')!.setAttribute('aria-valuenow', String(Math.round(100 * s.frac)));
  setText($('simSub'), s.t === undefined ? 'starting DSIM…' : `${Math.round(100 * s.frac)} % · ${clock(Math.min(s.t, AUTO_START + PLAY_TICKS))} of ${clock(AUTO_START + PLAY_TICKS)} · every tick in the 3D solve`);
}

/** the legend: what each job colour means */
export function renderLegend(): void {
  setHTML($('fieldLegend'), OPTIONS.filter((o) => o.key !== 'flower').map((o) => `<span><i style="background:${o.color}"></i>${o.label}</span>`).join('') + '<span><i class="ring"></i>gold ring: best robot (generations)</span>');
}

export function initStage(field: World): void {
  view.setField(field);
  renderLegend();
  setMode('idle');
  setCaption('');
}
