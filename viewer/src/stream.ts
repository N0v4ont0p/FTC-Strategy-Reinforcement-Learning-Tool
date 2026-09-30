// TRAINING, LIVE ON THE FIELD — the trainer streams one match it is playing right now (the first to
// start while none is streamed: train/continuous.ts), frame by frame as DSIM plays it, and at each
// decision its search thinking ahead: every option played out on shared luck, the better half again,
// the best two longest (train/episode.ts searchHalving). The field follows it:
//   · the playback runs at 1× at the live edge and faster behind it (outside the searched window, or
//     in an exam, a match is simulated far faster than real time), and jumps when far behind;
//   · at a decision the match stops while it thinks, and the panel over the field shows the options,
//     their values round by round, and what it took;
//   · a finished match gives way to the next one.
// A studio opening mid-match joins it from the server's snapshot (every element's state now).
import { OPTIONS, PLAY_TICKS, AUTO_START, getJSON, type Frame, type LiveHead, type LiveMsg, type StreamSnap, type ThinkProgress, type TrainLive } from './data';
import { clock, hooks, setCaption, setMode, stageMode, view } from './stage';
import { $, esc, setHTML, setText } from './ui';
import { S, bus } from './state';

interface Stream {
  id: number;
  label: string;
  head: LiveHead | null; // null: joined mid-match, waiting for the snapshot
  f: Frame[]; // every frame received (the first carries every element's state)
  end: { reward: number | null; score: number | null } | null;
  think: (ThinkProgress & { since: number }) | null; // the decision it thinks at (start, merged with its rounds), then its verdict
  thinkEnd: number; // when the verdict came (performance.now())
}
const streams = new Map<number, Stream>();
/** the stream on the field */
let shown: Stream | null = null;
/** the user left the live view: not followed again until asked */
let left = false;
let switchTimer = 0;
const VERDICT_MS = 2600; // the verdict stays up this long after the search ends
const REWIND = 180; // following a match well under way starts this many ticks before its newest frame

const ready = (st: Stream | null | undefined): st is Stream & { head: LiveHead } => !!st?.head && st.f.length > 0;
/** the newest stream that can be shown */
function newest(): (Stream & { head: LiveHead }) | null {
  let best: (Stream & { head: LiveHead }) | null = null;
  for (const st of streams.values()) if (ready(st) && (!best || st.id > best.id)) best = st;
  return best;
}
/** keep the shown stream and the two newest; nothing else */
function prune(): void {
  const keep = new Set([...streams.keys()].sort((a, b) => b - a).slice(0, 2));
  for (const id of streams.keys()) if (!keep.has(id) && streams.get(id) !== shown) streams.delete(id);
}
/** something could be watched live */
export const liveAvailable = (): boolean => !!newest() || !!S.live?.stream;
export const following = (): boolean => stageMode() === 'stream';
/** the streamed match on the field now (its job id), if any */
export const shownId = (): number | null => (following() && shown ? shown.id : null);

// ─────────────────────────────── following ───────────────────────────────
/** follow training on the field (Watch live) */
export function follow(): void {
  left = false;
  const st = newest();
  setMode('stream');
  if (st) show(st);
  else waiting();
  bus.emit('activity');
}
/** stop following: the field goes back to its empty state */
function leave(): void {
  left = true;
  shown = null;
  clearTimeout(switchTimer);
  view.playing = false;
  view.empty = true;
  view.requestDraw();
  setMode('idle');
  setCaption('');
  bus.emit('activity');
}
$('streamLeave').onclick = leave;
/** training streams while the field shows nothing: follow it (unless the user left) */
function autoFollow(): void {
  if (!left && stageMode() === 'idle' && S.live?.running && newest()) follow();
}
function show(st: Stream & { head: LiveHead }): void {
  clearTimeout(switchTimer);
  shown = st;
  view.startStream(st.head, st.f[0]);
  view.pushFrames(st.f.slice(1));
  // a match well under way: from a moment before its newest frame; one just begun: from its start
  // (the playback catches up)
  if (view.endTick - view.startTick > 40 * 60) view.seek(view.endTick - REWIND);
  view.speed = 1;
  view.playing = true;
  renderCaption();
  syncThink(true);
  renderTransport();
}
/** following, with no match to show yet */
function waiting(): void {
  shown = null;
  setCaption(`<span class="sub">${S.live?.running ? 'Waiting for training’s next match: it appears as soon as a core starts it.' : 'Training is paused: press Train on Home and its matches play here as they happen.'}</span>`);
  $('think').hidden = true;
  renderTransport();
}
/** the shown match is over and played out: after a moment, the newest one */
function maybeSwitch(): void {
  if (!following() || !shown?.end || view.lag > 0 || switchTimer) return;
  switchTimer = window.setTimeout(() => {
    switchTimer = 0;
    if (!following()) return;
    const st = newest();
    if (st && st !== shown) show(st);
    else renderTransport();
  }, 1500);
}
hooks.modeChanged = (m) => {
  if (m === 'stream') return;
  // a replay or the generational trainer took the field
  shown = null;
  clearTimeout(switchTimer);
  switchTimer = 0;
  $('think').hidden = true;
};

// ─────────────────────────────── what arrives (SSE `live`, and the snapshot) ───────────────────────────────
export function onLive(m: LiveMsg): void {
  if (m.k === 'end') {
    const st = streams.get(m.id);
    if (!st) return;
    st.end = { reward: m.reward, score: m.score };
    if (st.think?.at !== 'end') st.think = null;
    if (st === shown) {
      renderCaption();
      renderTransport();
      maybeSwitch();
    }
    return prune();
  }
  if (m.k === 'frames') {
    let st = streams.get(m.id);
    if (!st) {
      st = { id: m.id, label: m.label, head: null, f: [], end: null, think: null, thinkEnd: 0 };
      streams.set(m.id, st);
      prune();
    }
    if (m.head) st.head = m.head;
    const last = st.f.length ? st.f[st.f.length - 1].t : -1;
    const fresh = m.f.filter((q) => q.t > last);
    for (const q of fresh) st.f.push(q);
    // frames coming in: it is being played (a lost connection had marked it over)
    if (fresh.length && st.end) {
      st.end = null;
      if (st === shown) renderCaption();
    }
    if (!following()) autoFollow();
    else if (st === shown) view.pushFrames(fresh);
    else if (!shown && ready(st)) show(st);
    else maybeSwitch(); // (the shown match, once over and played out, gives way after a moment)
    return;
  }
  // the search at a decision
  const st = streams.get(m.id);
  if (!st) return;
  const p: ThinkProgress = m;
  const T = st.think;
  if (p.at === 'start') st.think = { ...p, since: performance.now() };
  else if (!T || T.tick !== p.tick || T.robot !== p.robot) return; // (a search joined half-way: its start comes with the snapshot)
  else if (p.at === 'round') st.think = { ...T, at: 'round', r: p.r, alive: p.alive, q: p.q };
  else if (p.at === 'play') st.think = { ...T, at: 'play', r: p.r, done: p.done, total: p.total };
  else {
    st.think = { ...T, at: 'end', best: p.best, net: p.net, changed: p.changed, q: p.q ?? T.q };
    st.thinkEnd = performance.now();
  }
  if (st === shown) {
    syncThink(true);
    if (p.at === 'start' && !$('think').hidden) dodge();
    renderTransport();
  }
}
/** a studio opening (or reconnecting) mid-match: the stream as it is now */
export function joinSnapshot(sn: StreamSnap | null): void {
  if (!sn) return;
  let st = streams.get(sn.id);
  if (!st) {
    st = { id: sn.id, label: sn.label, head: null, f: [], end: null, think: null, thinkEnd: 0 };
    streams.set(sn.id, st);
    prune();
  }
  const key = sn.key;
  if (!st.head) {
    // the key holds everything up to its tick; frames that came in meanwhile continue it
    st.head = sn.head;
    st.label = sn.label;
    if (key) st.f = [key, ...st.f.filter((q) => q.t > key.t)];
    if (sn.think) st.think = { ...sn.think, since: performance.now() };
  } else if (key && key.t > (st.f[st.f.length - 1]?.t ?? -1)) {
    // reconnected: the frames sent meanwhile were missed, and the key carries every element's state
    st.f.push(key);
    if (st === shown && following()) view.pushFrames([key]);
  }
  if (st.end) {
    st.end = null; // (it is still being played)
    if (st === shown) renderCaption();
  }
  autoFollow();
}
// the live picture (SSE `train`): the stage's Watch button, following when training starts
bus.on('train', () => {
  const t = S.live;
  if (!t?.running) {
    // paused (or the studio is out of reach): nothing more comes for the matches in flight
    for (const st of streams.values()) st.end ??= { reward: null, score: null };
    if (shown && following()) {
      renderCaption();
      maybeSwitch();
    }
  }
  $('btnWatchLive').hidden = !t?.running;
  $<HTMLButtonElement>('btnWatchLive').disabled = !liveAvailable();
  $('btnWatchChamp').classList.toggle('quiet', !!t?.running); // (one primary button: the live one)
  if (following() && !shown) waiting();
  else autoFollow();
  renderTransport();
});
/** (re)connected: the trainer's picture and the match it streams now */
export async function loadLive(): Promise<void> {
  try {
    const r = await getJSON<{ train: TrainLive | null; stream: StreamSnap | null }>('/api/train/live');
    S.live = r.train;
    bus.emit('train');
    joinSnapshot(r.stream);
  } catch {
    /* an older server: no live picture */
  }
}

// ─────────────────────────────── the field while following ───────────────────────────────
hooks.stream = () => {
  if (!shown) return;
  // pace: 1× at the live edge, faster behind it, a jump when far behind
  const lagS = view.lag / 60;
  if (lagS > 40) view.seek(view.endTick - 600);
  view.speed = lagS <= 1.5 ? 1 : Math.min(16, 1 + (lagS - 1.5) / 1.5);
  renderTransport();
  syncThink(false);
  maybeSwitch();
};
function renderCaption(): void {
  const st = shown;
  if (!st) return;
  const [title, ...rest] = st.label.split(' · ');
  const fin = st.end ? (st.end.reward !== null ? ` · final <b>${Math.round(st.end.reward)}</b> pts` : ' · stopped') : '';
  setCaption(`<b>${esc(title)}</b><span class="sub">· ${esc(rest.join(' · '))} · live from training${fin}</span>`);
}
let paceWord = '';
function renderTransport(): void {
  const st = shown;
  const lo = AUTO_START;
  const frac = (t: number): string => Math.max(0, Math.min(1, (t - lo) / PLAY_TICKS)).toFixed(4);
  $('streamFill').style.transform = `scaleX(${st ? frac(view.tick) : 0})`;
  $('streamBuf').style.transform = `scaleX(${st ? frac(view.endTick) : 0})`;
  setText($('streamClock'), st ? clock(view.tick) : '–:––');
  const thinking = !!st?.think && st.think.at !== 'end' && view.lag === 0;
  const over = !!st?.end && view.lag === 0;
  const ff = !!st && view.lag > 90 && view.speed >= 1.5;
  const word = !st ? 'waiting' : over ? 'match over' : thinking ? 'thinking ahead' : ff ? `×${view.speed < 10 ? view.speed.toFixed(1) : Math.round(view.speed)} catching up` : 'live';
  if (word !== paceWord) {
    paceWord = word;
    setText($('streamPace'), word);
    $('streamPace').className = `pace${thinking ? ' p-think' : over ? ' p-over' : ff ? ' p-ff' : ''}`;
    $('transportStream').classList.toggle('over', over);
  }
}

// ─────────────────────────────── the search, over the field ───────────────────────────────
/** the panel shows once the playback reaches the decision, and its verdict for a moment after;
 * `render`: something in it changed (otherwise it is drawn only when it appears) */
function syncThink(render: boolean): void {
  const st = shown;
  let T = st?.think ?? null;
  if (T?.at === 'end' && performance.now() - st!.thinkEnd >= VERDICT_MS) T = st!.think = null;
  const on = !!T && following() && view.tick >= T.tick - 2;
  const was = !$('think').hidden;
  $('think').hidden = !on;
  if (on && (render || !was)) renderThink();
  if (on && !was) dodge();
  if (on) tickLater();
}
/** the panel takes the corner of the field clear of our robot (it stands still while it thinks):
 * lower left, lower right, upper left, upper right, in that order */
function dodge(): void {
  const el = $('think');
  const p = view.robotOnScreen();
  const W = el.offsetWidth;
  const H = el.offsetHeight;
  const cw = $('field').clientWidth;
  const ch = $('field').clientHeight;
  const M = 10;
  const corners: [string, number, number][] = [
    ['bl', M, ch - M - H],
    ['br', cw - M - W, ch - M - H],
    ['tl', M, M],
    ['tr', cw - M - W, M],
  ];
  const clear = ([, x, y]: [string, number, number]): boolean => !p || p.x < x - 36 || p.x > x + W + 36 || p.y < y - 36 || p.y > y + H + 36;
  el.dataset.at = (corners.find(clear) ?? corners[0])[0];
}
/** the seconds counter moves and the verdict goes, even while the field waits at the live edge */
let thinkTimer = 0;
function tickLater(): void {
  if (thinkTimer) return;
  thinkTimer = window.setTimeout(() => {
    thinkTimer = 0;
    syncThink(true);
  }, 1000);
}
function renderThink(): void {
  const T = shown?.think;
  if (!T) return;
  const opts = T.opts ?? [];
  const q = T.q ?? [];
  const alive = new Set(T.alive ?? opts.map((_, i) => i));
  const vals = q.filter((v): v is number => v !== null);
  const lo = vals.length ? Math.min(...vals) : 0;
  const hi = vals.length ? Math.max(...vals) : 1;
  const lead = q.reduce<number>((b, v, i) => (v !== null && alive.has(i) && (b < 0 || v > q[b]!) ? i : b), -1);
  const done = T.at === 'end';
  const pick = done ? (T.best ?? -1) : lead;
  // the options, best first; the ones dropped in earlier rounds after the ones still in
  const order = opts.map((_, i) => i).sort((a, b) => Number(alive.has(b)) - Number(alive.has(a)) || (q[b] ?? -Infinity) - (q[a] ?? -Infinity));
  const MAX = 5;
  const rows = order.slice(0, MAX).map((i) => {
    const [kind, label] = opts[i];
    const v = q[i];
    const w = v === null || v === undefined ? 0 : hi > lo ? 0.12 + (0.88 * (v - lo)) / (hi - lo) : 1;
    const cls = [alive.has(i) || done ? '' : 'out', i === pick ? 'lead' : ''].filter(Boolean).join(' ');
    return `<li class="${cls}"><i style="background:${OPTIONS[kind]?.color ?? '#8a8176'}"></i><span class="l">${esc(label)}</span><span class="bar"><b style="transform:scaleX(${w.toFixed(3)})"></b></span><span class="q">${v === null || v === undefined ? '…' : v.toFixed(1)}</span><span class="tag"${i === T.net ? ' title="the network’s own pick: what it does without thinking ahead"' : ''}>${i === T.net ? 'NET' : ''}</span></li>`;
  });
  const more = order.length - MAX;
  const who = T.robot === 1 ? 'Its partner (our network)' : 'Our robot';
  const rounds = T.rounds ?? 0;
  const r = Math.min(rounds, (T.r ?? 0) + 1);
  const secs = Math.round((performance.now() - T.since) / 1000);
  const head = `<div class="thead"><span class="tk">${done ? 'DECIDED' : 'THINKING AHEAD'}</span><span class="tw">${who} · at ${clock(T.tick)}</span><span class="grow"></span><span class="tr">${done ? `${opts.length} options` : `round ${r} of ${rounds}`}</span></div>`;
  const prog = done ? 1 : T.at === 'play' && T.total ? (T.done ?? 0) / T.total : T.at === 'round' ? 1 : 0;
  const sub = done ? '' : `<div class="tsub"><span>${T.at === 'play' ? `${T.done} of ${T.total} what-ifs played` : T.at === 'round' ? `round ${(T.r ?? 0) + 1} scored: the better half goes on` : 'every option played out on the same luck'}</span><span>${secs > 0 ? `${secs} s` : ''}</span></div>`;
  let end = '';
  if (done && T.best !== undefined) {
    const took = opts[T.best]?.[1] ?? '?';
    const gain = T.changed && q[T.best] != null && T.net !== undefined && q[T.net] != null ? q[T.best]! - q[T.net]! : null;
    end = T.changed
      ? `<div class="tend over">Overrules the network: <b>${esc(took)}</b>${gain !== null ? ` · +${gain.toFixed(1)} pts over “${esc(opts[T.net!]?.[1] ?? '')}”` : ''}<span class="sub"> · a lesson for the next network</span></div>`
      : `<div class="tend">Keeps the network’s choice: <b>${esc(took)}</b></div>`;
  }
  setHTML($('thinkBody'), `${head}<div class="tprog"><div style="transform:scaleX(${prog.toFixed(3)})"></div></div>${sub}<ol class="topts">${rows.join('')}</ol>${more > 0 ? `<p class="tmore">+ ${more} more</p>` : ''}${end}`);
  $('think').classList.toggle('done', done);
}
$('btnWatchLive').onclick = () => follow();
bus.on('follow', () => follow());
