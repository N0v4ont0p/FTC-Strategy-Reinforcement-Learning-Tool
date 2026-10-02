// WHAT IS RUNNING, EVERYWHERE — the status strip under the top bar (on every page) and Home's
// "Right now" panel. Both read the trainer's live picture (SSE `train`: train/live.ts TrainLive,
// twice a second while it trains) and the studio's other long jobs: the AUTO playbook, the team-play
// search, a shooting envelope being measured, a match played again in DSIM to watch it.
// Everything here that can be clicked is built once and then only updated (text, widths), so a click
// never lands on an element being replaced.
import { fmt, post, type JobKind, type LiveJob, type TrainLive } from './data';
import { $, PARTNER_LABEL, act, dur, on, setHTML, setText, sgn } from './ui';
import { S, bus } from './state';
import { follow, following, liveAvailable, shownId } from './stream';

// ─────────────────────────────── the stage training is at ───────────────────────────────
interface Stage {
  text: string; // what it is doing, in words
  short: string; // the same, for Home's State tile
  frac: number | null; // how far (null: no measure)
}
const learnerOf = (t: TrainLive): LiveJob | undefined => t.jobs.find((j) => j.kind === 'learner');
/** the candidate exam's evidence, in words */
function leaning(e: NonNullable<TrainLive['exam']>): string {
  if (e.mean === null || e.done < 2) return '';
  return ` · ${e.llr >= 0 ? 'leaning better' : 'leaning not better'} (${sgn(e.mean)} pts a match)`;
}
export function trainStage(t: TrainLive): Stage {
  if (t.base) return { text: `The no-learning robot’s exam · ${t.base.done} of ${t.base.total} matches`, short: `no-learning exam ${t.base.done}/${t.base.total}`, frac: t.base.done / Math.max(1, t.base.total) };
  if (t.exam) return { text: `Candidate #${t.exam.id}’s exam · ${t.exam.done} of ${t.exam.total} matches${leaning(t.exam)}`, short: `exam of #${t.exam.id} ${t.exam.done}/${t.exam.total}`, frac: t.exam.done / Math.max(1, t.exam.total) };
  if (t.learning) {
    const p = learnerOf(t)?.p;
    const L = p?.k === 'learn' ? p : null;
    return { text: `Learning candidate #${t.next} from its lessons${L ? ` · epoch ${L.epoch + 1} of ${L.epochs}, rate ${L.lr + 1} of ${L.lrs}` : ''}`, short: `learning #${t.next}${L ? ` · ${Math.round(100 * L.frac)} %` : ''}`, frac: L ? L.frac : null };
  }
  const { have, need } = t.lessons;
  return {
    text: have >= need ? `Playing and thinking ahead · ${fmt(have)} lessons: candidate #${t.next} is learned next` : `Playing and thinking ahead · ${fmt(have)} of ${fmt(need)} lessons toward candidate #${t.next}`,
    short: `playing · ${fmt(Math.min(have, need))}/${fmt(need)} lessons`,
    frac: Math.min(1, have / Math.max(1, need)),
  };
}

// ─────────────────────────────── the strip ───────────────────────────────
const items = new Map<string, HTMLButtonElement>();
const ORDER = ['train', 'playbook', 'plays', 'measure', 'sim'];
/** one entry of the strip, made once */
function item(key: string, go: string | null): HTMLButtonElement {
  let el = items.get(key);
  if (!el) {
    el = document.createElement('button');
    el.type = 'button';
    el.className = `act act-${key}`;
    el.style.order = String(ORDER.indexOf(key));
    el.innerHTML = '<i class="adot" aria-hidden="true"></i><b class="k"></b><span class="t"></span><span class="mb" aria-hidden="true"><span></span></span>';
    if (go) el.dataset.go = go;
    else el.disabled = true;
    $('acts').append(el);
    items.set(key, el);
  }
  return el;
}
function drop(key: string): void {
  items.get(key)?.remove();
  items.delete(key);
}
function fill(el: HTMLElement, word: string, text: string, frac: number | null, title: string): void {
  setText(el.querySelector('.k')!, word);
  setText(el.querySelector('.t')!, text);
  const mb = el.querySelector<HTMLElement>('.mb')!;
  mb.hidden = frac === null;
  (mb.firstElementChild as HTMLElement).style.transform = `scaleX(${Math.max(0, Math.min(1, frac ?? 0)).toFixed(3)})`;
  if (el.title !== title) el.title = title;
}
/** the strip: shown while anything runs */
export function renderActivity(): void {
  let lead: number | null = null;
  const t = S.live;
  if (t?.running) {
    const st = trainStage(t);
    const el = item('train', 'home');
    fill(el, 'Training', st.text, st.frac, `${t.name} is training · ${t.jobs.length} of ${t.workers} cores busy${t.matchesPerHour ? ` · ${fmt(t.matchesPerHour)} matches an hour` : ''} · open Home`);
    lead = st.frac;
  } else drop('train');
  const pb = S.pbStatus;
  if (pb?.running) {
    const f = (pb.done + (pb.frac ?? 0)) / Math.max(1, pb.total);
    fill(item('playbook', 'playbook'), 'Playbook', `Building the AUTO playbook · plan ${Math.min(pb.total, pb.done + 1)} of ${pb.total} · ${Math.round(100 * f)} %`, f, 'The AUTO playbook is being built · open Playbook');
    lead ??= f;
  } else drop('playbook');
  const tp = S.tpStatus;
  if (tp?.running) {
    const f = (tp.done + (tp.matchesTotal ? (tp.matches ?? 0) / tp.matchesTotal : 0)) / Math.max(1, tp.total);
    fill(item('plays', 'plays'), 'Team plays', `Searching plays${tp.current ? ` beside ${(PARTNER_LABEL[tp.current] ?? tp.current).toLowerCase()}` : ''} · partner ${Math.min(tp.total, tp.done + 1)} of ${tp.total} · ${Math.round(100 * f)} %`, f, 'The team-play search · open Team plays');
    lead ??= f;
  } else drop('plays');
  const m = S.measure;
  if (m?.running) {
    const f = m.total ? (m.done ?? 0) / m.total : 0;
    fill(item('measure', 'robot'), 'Measuring', `${m.build ?? 'The robot'}’s shooting envelope in DSIM · ${Math.round(100 * f)} %`, f, 'Every spot and heading it could shoot from, in the 3D solve · open Robot');
    lead ??= f;
  } else drop('measure');
  const sim = S.sim;
  if (sim) fill(item('sim', null), 'DSIM', `Playing ${sim.label} · ${Math.round(100 * sim.frac)} %`, sim.frac, 'Played again in DSIM for the field');
  else drop('sim');
  const any = items.size > 0;
  $('activity').hidden = !any;
  $('actWatch').hidden = !(t?.running && liveAvailable() && !following());
  $('actStop').hidden = !t?.running;
  $('actFill').style.transform = `scaleX(${Math.max(0, Math.min(1, lead ?? 0)).toFixed(4)})`;
  $('activity').classList.toggle('train', !!t?.running);
}
on<HTMLButtonElement>($('acts'), 'button[data-go]', (b) => bus.emit('go', b.dataset.go));
$('actWatch').onclick = () => follow();
// stop training from any page (Home's Continue training carries on; nothing learned is lost)
$('actStop').onclick = () => void act(post('/api/home/pause', {}), 'Stopped. Everything it learned is kept.');
bus.on('activity', renderActivity);
bus.on('pill', renderActivity); // (the playbook's and the team plays' progress)

// ─────────────────────────────── Home: right now ───────────────────────────────
const KIND: Record<JobKind, string> = { actor: 'Match', drill: 'Drill', exam: 'Exam', 'base-exam': 'Exam', 'search-exam': 'Search exam', learner: 'Learning' };
const QUEUED: Record<JobKind, [string, string]> = {
  actor: ['match', 'matches'],
  drill: ['drill', 'drills'],
  exam: ['exam match', 'exam matches'],
  'base-exam': ['exam match', 'exam matches'],
  'search-exam': ['thinking-ahead exam match', 'thinking-ahead exam matches'],
  learner: ['learning job', 'learning jobs'],
};
const PHASE: Record<string, string> = { pre: 'Pre-match', auto: 'AUTO', transition: 'Transition', teleop: 'TELEOP', post: 'Final' };
function mmss(s: number): string {
  const v = Math.max(0, Math.ceil(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}
const bar = (f: number | null): string => `<span class="lbar"><b style="transform:scaleX(${Math.max(0, Math.min(1, f ?? 0)).toFixed(3)})"></b></span>`;

/** the training loop's tracks: they run side by side (lessons keep coming while it learns and while a
 * candidate sits its exam) */
function tracks(t: TrainLive): string {
  const rows: string[] = [];
  const row = (state: 'on' | 'wait' | 'done', name: string, what: string, f: number | null, right: string, extra = ''): void => {
    rows.push(`<li class="${state}"><span class="tn"><b>${name}</b><span class="sub">${what}</span></span><span class="tv">${state === 'wait' ? '' : bar(f)}<span class="tr">${right}</span></span>${extra}</li>`);
  };
  if (t.base) {
    row('on', 'The no-learning robot’s exam', 'its fixed matches, once: every network after it has to beat this', t.base.done / Math.max(1, t.base.total), `${t.base.done} of ${t.base.total}`);
    row('wait', 'Lessons', 'begin once its exam is in', null, '');
    return rows.join('');
  }
  const { have, need, perHour } = t.lessons;
  const left = Math.max(0, need - have);
  const eta = left > 0 && perHour ? ` · about ${dur((3600 * left) / perHour)}` : '';
  // (while #next is being learned, the lessons count toward the one after it)
  row(have >= need ? 'done' : 'on', `Lessons toward candidate #${t.learning ? t.next + 1 : t.next}`, 'every decision it thinks through in a match is one', have / Math.max(1, need), have >= need ? `${fmt(have)} · enough${t.exam ? ': learns after this exam' : ''}` : `${fmt(have)} of ${fmt(need)}${eta}`);
  const L = learnerOf(t)?.p;
  if (t.learning) row('on', `Learning candidate #${t.next}`, 'one fit per learning rate: the best on held-out decisions becomes the candidate', L?.k === 'learn' ? L.frac : null, L?.k === 'learn' ? `rate ${L.lr + 1} of ${L.lrs} · epoch ${L.epoch + 1} of ${L.epochs}${L.loss !== null ? ` · loss ${L.loss.toFixed(3)}` : ''}` : 'starting');
  else row('wait', `Learning candidate #${t.next}`, `starts at ${fmt(need)} lessons${t.exam ? ', after the exam in progress' : ''}`, null, '');
  const E = t.exam;
  if (E) {
    const span = E.hi - E.lo;
    const at = Math.max(0, Math.min(1, (E.llr - E.lo) / span));
    const zero = Math.max(0, Math.min(1, -E.lo / span));
    const meter = `<div class="evid" title="The evidence so far (a sequential test on the paired differences): it stops at the right end (better: promoted) or the left (not better)"><span>not better</span><span class="et"><i style="left:${(100 * zero).toFixed(1)}%"></i><b style="left:${(100 * at).toFixed(1)}%"></b></span><span>better</span></div>`;
    row('on', `Candidate #${E.id}’s exam`, 'paired with the champion on the same matches', E.done / Math.max(1, E.total), `${E.done} of ${E.total}${E.mean !== null ? ` · ${sgn(E.mean)} pts a match` : ''}`, meter);
  } else row('wait', 'The exam', 'a new candidate sits it right after learning', null, '');
  const X = t.searchExam;
  if (X) row('on', `Thinking-ahead exam of champion #${X.champion}`, 'the champion alone vs thinking ahead: the gap is what is left to learn', X.done / Math.max(1, X.total), `${X.done} of ${X.total}`);
  return rows.join('');
}

// the worker tiles: one per core, each keeps its place while its job runs
const slotOf = new Map<number, number>();
interface Tile {
  el: HTMLElement;
  kind: HTMLElement;
  lv: HTMLElement;
  el2: HTMLElement;
  ttl: HTMLElement;
  ts: HTMLElement;
  fill: HTMLElement;
  ph: HTMLElement;
  sc: HTMLElement;
}
const tiles: Tile[] = [];
function tile(i: number): Tile {
  while (tiles.length <= i) {
    const el = document.createElement('div');
    el.className = 'tile idle';
    el.innerHTML = '<div class="th"><span class="kind"></span><span class="lv">LIVE</span><span class="grow"></span><span class="el"></span></div><b class="ttl"></b><span class="ts"></span><div class="tbar"><div></div></div><div class="tf"><span class="ph"></span><span class="sc"></span></div>';
    $('lvTiles').append(el);
    const q = <T extends HTMLElement>(s: string): T => el.querySelector<T>(s)!;
    tiles.push({ el, kind: q('.kind'), lv: q('.lv'), el2: q('.el'), ttl: q('.ttl'), ts: q('.ts'), fill: q('.tbar > div'), ph: q('.ph'), sc: q('.sc') });
  }
  return tiles[i];
}
function renderTiles(t: TrainLive): void {
  // jobs keep their tile; a new job takes the first free one
  const ids = new Set(t.jobs.map((j) => j.id));
  for (const id of slotOf.keys()) if (!ids.has(id)) slotOf.delete(id);
  const used = new Set(slotOf.values());
  for (const j of t.jobs)
    if (!slotOf.has(j.id)) {
      let s = 0;
      while (used.has(s)) s++;
      slotOf.set(j.id, s);
      used.add(s);
    }
  const n = Math.max(t.workers, ...[...used].map((s) => s + 1));
  const bySlot = new Map([...t.jobs].map((j) => [slotOf.get(j.id)!, j]));
  for (let i = 0; i < n; i++) {
    const T = tile(i);
    const j = bySlot.get(i);
    T.el.hidden = false;
    if (!j) {
      T.el.className = 'tile idle';
      setText(T.kind, 'Core');
      setText(T.el2, '');
      setText(T.ttl, 'Idle');
      setText(T.ts, t.running ? 'waiting for work' : 'stopped');
      T.fill.style.transform = 'scaleX(0)';
      setText(T.ph, '');
      setText(T.sc, '');
      T.el.removeAttribute('title');
      continue;
    }
    const p = j.p;
    const thinking = !!j.think;
    const onField = j.live && shownId() === j.id;
    T.el.className = `tile k-${j.kind}${j.live ? ' live' : ''}${thinking ? ' thinking' : ''}${onField ? ' watched' : ''}`;
    setText(T.kind, KIND[j.kind]);
    setText(T.lv, onField ? 'ON THE FIELD' : 'LIVE · WATCH');
    setText(T.el2, j.since ? dur((t.time - j.since) / 1000) : '');
    const [title, ...rest] = j.label.split(' · ');
    setText(T.ttl, title);
    setText(T.ts, rest.join(' · '));
    T.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, p?.frac ?? 0)).toFixed(3)})`;
    if (p?.k === 'learn') {
      setText(T.ph, `rate ${p.lr + 1} of ${p.lrs} · epoch ${p.epoch + 1} of ${p.epochs}`);
      setText(T.sc, p.loss !== null ? `loss ${p.loss.toFixed(3)}` : '');
    } else if (thinking) {
      // (the match stands still while it thinks: what-ifs played, not its score)
      const k = j.think!;
      setText(T.ph, `thinking ahead · round ${Math.min(k.rounds, k.r + 1)} of ${k.rounds}`);
      setText(T.sc, k.total ? `${k.done}/${k.total}` : '');
    } else if (p?.k === 'match') {
      setText(T.ph, `${PHASE[p.phase] ?? p.phase} ${mmss(p.left)}${p.searched ? ` · ${p.searched} thought through` : ''}`);
      setText(T.sc, `${p.score} pts`);
    } else {
      setText(T.ph, 'starting');
      setText(T.sc, '');
    }
    const tip = `${j.label}${j.think ? ` · thinking ahead at a decision: round ${Math.min(j.think.rounds, j.think.r + 1)} of ${j.think.rounds}, ${j.think.done} of ${j.think.total} what-ifs played` : ''}${j.live ? (onField ? ' · on the field now' : ' · click to watch it on the field') : ''}`;
    if (T.el.title !== tip) T.el.title = tip;
  }
  for (let i = n; i < tiles.length; i++) tiles[i].el.hidden = true;
}
on<HTMLElement>($('lvTiles'), '.tile.live', () => follow());

function renderRightNow(): void {
  const t = S.live;
  const card = $('homeLive');
  card.hidden = !t?.running;
  if (!t?.running) return;
  const busy = t.jobs.length;
  setText($('lvRates'), [`${busy} of ${t.workers} cores busy`, t.matchesPerHour ? `${fmt(t.matchesPerHour)} matches an hour` : '', t.lessons.perHour ? `${fmt(t.lessons.perHour)} lessons an hour` : ''].filter(Boolean).join(' · '));
  setHTML($('lvTracks'), tracks(t));
  renderTiles(t);
  const q = Object.entries(t.queued).filter(([, n]) => n) as [JobKind, number][];
  setText($('lvQueue'), q.length ? `Waiting for a core: ${q.map(([k, n]) => `${fmt(n)} ${QUEUED[k][n === 1 ? 0 : 1]}`).join(' · ')}` : busy < t.workers ? 'Nothing waiting: a core frees up, the next match starts.' : 'Nothing waiting.');
  setText($('homeDoing'), trainStage(t).short);
}

// the trainer's live picture changed (SSE `train`, or loaded on connecting)
bus.on('train', () => {
  renderActivity();
  renderRightNow();
});
