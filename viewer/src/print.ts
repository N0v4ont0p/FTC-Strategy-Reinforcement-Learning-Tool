// THE PRINTED PLAYBOOK — the AUTO playbook as a document for the drive team: a cover with the best
// plan beside each kind of partner, then every plan with its diagram (DSIM's field, both robots'
// paths, numbered steps) and its timing sheet. The browser prints it; "Save as PDF" in the print
// dialog makes the PDF.
import type { World } from '../../dsim-main/src/types';
import { AUTO_START, OPTIONS, getJSON, type Frames, type PlaybookEntryV, type PlaybookV } from './data';
import { PLAN_COLORS, drawPlan } from './plandiagram';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const PARTNER: Record<string, string> = { none: 'No partner', real: 'A second REAL-v1', sniper: 'Sniper', hauler: 'Hauler', skimmer: 'Skimmer', parker: 'A partner that only parks', idle: 'A partner that does nothing' };
const PARTNER_ORDER = ['none', 'real', 'skimmer', 'sniper', 'hauler', 'parker', 'idle'];
const START: Record<string, string> = { F3: 'F3 (our wall, right of FLOWER F3)', TOP_REAR: 'top, rear wall', BOTTOM_AUD: 'bottom, audience wall', TOP_SIDE: 'top, side wall', BOTTOM_SIDE: 'bottom, side wall' };
const SHORT: Record<string, string> = { F3: 'F3 (ours)', TOP_REAR: 'top rear', BOTTOM_AUD: 'bottom audience', TOP_SIDE: 'top side', BOTTOM_SIDE: 'bottom side' };
const sgn = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
const secs = (tick: number): string => `${Math.max(0, (tick - AUTO_START) / 60).toFixed(1)}`;

const q = new URLSearchParams(location.search);
let field: World;
let book: PlaybookV;
let robots: { file: string; label: string; build: string; id: string }[] = [];

function title(e: PlaybookEntryV): string {
  return e.problem.partner === 'none' ? 'Alone' : `Beside ${(PARTNER[e.problem.partner] ?? e.problem.partner).replace(/^A /, 'a ')}`;
}
function subtitle(e: PlaybookEntryV): string {
  const P = e.problem;
  const where = `We start ${START[P.start] ?? P.start}${P.partnerStart ? `; partner ${START[P.partnerStart] ?? P.partnerStart}` : ''}`;
  return `${where} · ${P.mode === 'joint' ? 'both AUTOs planned together' : P.partner === 'none' ? 'our AUTO' : 'the partner runs its own AUTO'}`;
}
function selected(): PlaybookEntryV[] {
  const s = $<HTMLSelectElement>('fStart').value;
  const p = $<HTMLSelectElement>('fPartner').value;
  const m = $<HTMLSelectElement>('fMode').value;
  return book.entries
    .filter((e) => (!s || e.problem.start === s) && (!p || e.problem.partner === p) && (!m || e.problem.mode === m))
    .sort((a, b) => PARTNER_ORDER.indexOf(a.problem.partner) - PARTNER_ORDER.indexOf(b.problem.partner) || (a.problem.start === 'F3' ? -1 : 0) - (b.problem.start === 'F3' ? -1 : 0) || b.nominal.mean - a.nominal.mean);
}

function cover(list: PlaybookEntryV[], no: Map<string, number>): string {
  const r = robots.find((x) => x.file === book.profile);
  const best = PARTNER_ORDER.map((k) => list.filter((e) => e.problem.partner === k).sort((a, b) => b.nominal.mean - a.nominal.mean)[0]).filter(Boolean);
  return `<section class="sheet cover">
    <div class="brand"><span class="mark"></span><h1>AUTO Playbook · ${esc(r?.id ?? book.name)}</h1></div>
    <p class="who">${esc(r?.build ?? '')}</p>
    <p class="date">${new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })} · ${list.length} plans · every number is a DSIM score</p>
    <h2>The best plan beside each partner</h2>
    <table class="rec"><thead><tr><th>Partner</th><th>We start</th><th>They start</th><th class="n">AUTO pts</th><th class="n">worst tenth</th><th class="n">vs no plan</th><th class="n">plan</th></tr></thead><tbody>${best
      .map((e) => `<tr><td>${esc(PARTNER[e.problem.partner] ?? e.problem.partner)}</td><td>${esc(SHORT[e.problem.start] ?? e.problem.start)}</td><td>${esc(e.problem.partnerStart ? (SHORT[e.problem.partnerStart] ?? e.problem.partnerStart) : '—')}</td><td class="n"><span class="pts">${e.nominal.mean.toFixed(1)}</span></td><td class="n">${e.nominal.cvar10.toFixed(1)}</td><td class="n">${sgn(e.nominal.mean - e.baseline.mean)}</td><td class="n">#${no.get(e.key)}</td></tr>`)
      .join('')}</tbody></table>
    <h2>How to read a plan</h2>
    <div class="howto">
      <p><b>AUTO points</b>: our robot's alliance score in AUTO over 64 fresh luck draws (± its 95 % range). <b>Worst tenth</b>: the average of the worst 10 % — a plan is chosen for both.</p>
      <p><b>vs no plan</b>: the same draws with each robot running its own AUTO. <b>Robot range</b>: robots drawn from the whole profile, not only the nominal one.</p>
      <p><b>The steps</b> are what each robot does at each of its job starts, in order, with when it starts and ends. After its steps a robot plays on by itself.</p>
      <p><b>The diagram</b> is one exact DSIM replay of the plan, seen from the blue drivers' wall like the studio.</p>
    </div>
    <div class="key"><span><i style="background:${PLAN_COLORS.ours}"></i>our robot's path</span><span><i class="dash"></i>partner's path</span><span><b class="n">1</b>a step starts here</span><span>solid robots: the start · faded: where AUTO ends</span></div>
  </section>`;
}

function entry(e: PlaybookEntryV, n: number): string {
  const kind = (k: string): string => OPTIONS.find((o) => o.key === k)?.color ?? '#888';
  const steps = e.taken.length
    ? `<table class="steps"><thead><tr><th></th><th>When (s)</th><th>Who</th><th>Job</th></tr></thead><tbody>${e.taken
        .map((s, i) => `<tr><td><span class="dot" style="background:${s.robot === 0 ? PLAN_COLORS.ours : PLAN_COLORS.partner}">${i + 1}</span></td><td class="n">${secs(s.tick)}${s.end ? `–${secs(s.end)}` : ''}</td><td>${s.robot === 0 ? 'us' : 'partner'}</td><td><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${kind(s.kind)};margin-right:6px"></i>${esc(s.label)}${s.matched ? '' : ' <i>(not there: it chose itself)</i>'}</td></tr>`)
        .join('')}</tbody></table><p class="note">After their steps the robots play on by themselves until AUTO ends.</p>`
    : `<p class="own">No plan beats the robots' own AUTO here — run your usual routine.</p>`;
  const up = e.nominal.mean - e.baseline.mean;
  return `<section class="sheet entry" data-key="${esc(e.key)}">
    <div class="head"><div><h3>${esc(title(e))}</h3><div class="sub">${esc(subtitle(e))}</div></div><span class="no">#${n}</span></div>
    <div class="chips"><span class="chip">AUTO <b>${e.nominal.mean.toFixed(1)}</b> ± ${e.nominal.ci95.toFixed(1)}</span><span class="chip">worst tenth <b>${e.nominal.cvar10.toFixed(1)}</b></span><span class="chip${up > 0 ? ' up' : ''}">vs no plan <b>${sgn(up)}</b></span><span class="chip">robot range <b>${e.sampled.mean.toFixed(1)}</b></span></div>
    <div class="body"><canvas aria-label="Plan diagram"></canvas><div>${steps}</div></div>
  </section>`;
}

async function render(): Promise<void> {
  const list = selected();
  const no = new Map(list.map((e, i) => [e.key, i + 1]));
  $('doc').innerHTML = cover(list, no) + list.map((e, i) => entry(e, i + 1)).join('');
  const btn = $<HTMLButtonElement>('print');
  btn.disabled = true;
  let done = 0;
  const say = (): void => {
    $('status').textContent = `${list.length} plans · diagrams ${done}/${list.length}`;
  };
  say();
  const canvases = [...document.querySelectorAll<HTMLElement>('.entry')];
  let next = 0;
  const work = async (): Promise<void> => {
    while (next < canvases.length) {
      const el = canvases[next++];
      const e = list.find((x) => x.key === el.dataset.key)!;
      try {
        const r = await getJSON<{ frames: Frames }>(`/api/playbook/frames?profile=${encodeURIComponent(book.profile)}&key=${encodeURIComponent(e.key)}`);
        drawPlan(el.querySelector('canvas')!, field, r.frames, e.taken, { css: 316, dpr: 2.5 });
      } catch {
        el.querySelector('canvas')!.replaceWith(Object.assign(document.createElement('p'), { className: 'note', textContent: 'no replay kept for this plan' }));
      }
      done++;
      say();
    }
  };
  await Promise.all([work(), work(), work(), work()]);
  btn.disabled = false;
  $('status').textContent = `${list.length} plans ready`;
}

function syncUrl(): void {
  const u = new URLSearchParams({ profile: book.profile });
  for (const [k, id] of [['start', 'fStart'], ['partner', 'fPartner'], ['mode', 'fMode']] as const) if ($<HTMLSelectElement>(id).value) u.set(k, $<HTMLSelectElement>(id).value);
  history.replaceState(null, '', `?${u}`);
}
async function load(profile: string): Promise<void> {
  book = await getJSON<PlaybookV>(`/api/playbook?profile=${encodeURIComponent(profile)}`);
  const sel = $<HTMLSelectElement>('fRobot');
  sel.innerHTML = book.profiles.map((p) => `<option value="${esc(p)}">${esc(p.replace('profiles/', '').replace('.json', ''))}</option>`).join('');
  sel.value = book.profile;
  document.title = `AUTO Playbook · ${book.name}`;
  if (!book.entries.length) {
    $('doc').innerHTML = `<section class="sheet"><h2>Nothing planned yet</h2><p>Build the playbook in the studio (Playbook tab) first.</p></section>`;
    return;
  }
  syncUrl();
  await render();
}

async function boot(): Promise<void> {
  $<HTMLSelectElement>('fPartner').innerHTML += PARTNER_ORDER.map((k) => `<option value="${k}">${esc(PARTNER[k])}</option>`).join('');
  $<HTMLSelectElement>('fStart').value = q.get('start') ?? 'F3';
  $<HTMLSelectElement>('fPartner').value = q.get('partner') ?? '';
  $<HTMLSelectElement>('fMode').value = q.get('mode') ?? '';
  [field, robots] = await Promise.all([getJSON<World>('/api/field'), getJSON<{ robots: typeof robots }>('/api/robots').then((r) => r.robots)]);
  for (const id of ['fStart', 'fPartner', 'fMode'])
    $(id).onchange = () => {
      syncUrl();
      void render();
    };
  $('fRobot').onchange = () => void load($<HTMLSelectElement>('fRobot').value);
  $('print').onclick = () => window.print();
  await load(q.get('profile') ?? 'profiles/real-v1.json');
}
void boot().catch((e: Error) => ($('doc').innerHTML = `<section class="sheet"><h2>Could not load the playbook</h2><p>${esc(e.message)}</p></section>`));
