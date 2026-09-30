// HOME — the one button (train/continuous.ts): the exam as the headline, what the trainer is doing,
// the setup checklist, the exam trend, the champion beside each partner and opponent, watching it,
// the candidates, the log and the notifications.
import { LineChart } from '../charts';
import { fmt, getJSON, post, type Frames, type HomeStatusV, type HomeV } from '../data';
import { simulate, watch } from '../stage';
import { trainStage } from '../live';
import { $, OPP_LABEL, PARTNER_LABEL, act, ago, esc, on, pct, profileName, setHTML, setText, sgn, toast } from '../ui';
import { S, bus, profileQuery } from '../state';

const homeChart = new LineChart<HomeStatusV['history'][number]>($<HTMLCanvasElement>('homeChart'), $('homeLegend'), [{ label: 'champion, alone', color: '--s-best', get: (x) => x.exam }], {
  unit: ' pts',
  zeroBase: false,
  xLabel: (x) => `${x.hours.toFixed(1)} h`,
  tip: (x) => `<b>champion #${x.champion}</b> after ${x.hours.toFixed(1)} h<br>exam ${x.exam.toFixed(1)} · vs no-learning ${sgn(x.vsBase)}<br>${fmt(x.labels)} decisions learned from`,
  empty: 'the first point appears after the no-learning robot’s exam',
});
let chartKey = '';

export function renderHome(): void {
  const H = S.home;
  if (!H) return;
  const sel = $<HTMLSelectElement>('homeProfile');
  setHTML(sel, H.profiles.map((p) => `<option value="${esc(p)}">${esc(profileName(p))}</option>`).join(''));
  if (sel.value !== H.profile) sel.value = H.profile;
  const s = H.status;
  const busy = H.busy.v1 ? `The generational run “${H.busy.v1}” is training: one trainer at a time.` : H.busy.playbook ? `The ${H.busy.playbook} AUTO playbook is being built: it needs every core.` : '';
  $<HTMLButtonElement>('homeTrain').disabled = !!s?.running || !!busy;
  $<HTMLButtonElement>('homePause').disabled = !s?.running;
  sel.disabled = !!s?.running;
  const ex = s?.champion.exam;
  setHTML($('homeExam'), ex ? `${ex.mean.toFixed(1)}<span class="u">PTS</span>` : '—');
  $('homeExam').classList.toggle('none', !ex);
  setHTML(
    $('homeExamLine'),
    !s
      ? '<span class="sub">Press Train: nothing has been learned yet.</span>'
      : ex
        ? `<span class="chip">± ${ex.ci95.toFixed(1)} · ${ex.n} fixed matches</span>${s.champion.learned ? `<span class="chip ${ex.vsBase.mean >= 0 ? 'up' : 'down'}">${sgn(ex.vsBase.mean)} ± ${ex.vsBase.ci95.toFixed(1)} vs no-learning</span>` : '<span class="chip">the no-learning robot: the first network has to beat it</span>'}<span class="chip">worst tenth ${ex.cvar10.toFixed(0)}</span>`
        : '<span class="sub">The no-learning robot takes the exam first.</span>',
  );
  setText($('homeState'), !s ? 'Idle' : s.running ? (s.improving === 'flat' ? 'Flat' : 'Training') : 'Paused');
  $('homeState').className = `v${s?.running ? ' on' : ''}`;
  const a = s?.activity;
  // (while it trains, the live picture says exactly what it is doing: live.ts keeps this current)
  setText($('homeDoing'), !s?.running ? (s ? 'press Train to carry on' : ' ') : S.live?.running ? trainStage(S.live).short : a?.evaluating ? `exam of #${a.evaluating.id} ${a.evaluating.done}/${a.evaluating.total}` : a?.learning ? 'learning a new candidate' : `playing · ${fmt(s.nextLearnIn)} lessons to the next candidate`);
  setText($('homeCpu'), s?.running ? pct(s.cpu) : '—');
  setText($('homeHours'), s ? `${s.totals.hours.toFixed(1)} h · ${fmt(s.totals.matches)} matches` : ' ');
  setText($('homeLabels'), s ? fmt(s.totals.labels) : '0');
  setText($('homeRate'), s?.labelsPerHour ? `${fmt(s.labelsPerHour)} an hour` : 'decisions learned from');
  setText($('homeChamp'), s ? (s.champion.learned ? `#${s.champion.id}` : 'No-learning') : '—');
  setText($('homeChampWhen'), s ? `${s.totals.promotions} promoted, ${s.totals.rejections} not${s.lastPromotion ? ` · last ${ago(s.lastPromotion)}` : ''}` : ' ');
  setText($('homeTrend'), s?.trend !== null && s?.trend !== undefined ? `${sgn(s.trend)} over the last champions` : '');
  const probs = [busy, ...(s?.problems ?? [])].filter(Boolean);
  $('homeProblems').hidden = !probs.length;
  setHTML($('homeProblems'), probs.map((p) => `<p>${esc(p)}</p>`).join(''));
  // a run carried over from an older version (another sim)
  const c = s?.carried;
  $('homeCarried').hidden = !c;
  if (c)
    setHTML(
      $('homeCarried'),
      `<p><b>This run started fresh in DSIM Act 2’s 3D physics.</b> The run you trained before (version ${c.version}${c.champion ? `, champion #${c.champion}` : ''}${c.exam !== null ? `, exam ${c.exam.toFixed(1)} in the old physics` : ''}) is kept as <span class="mono">${esc(c.from)}</span>. ${c.seeded ? 'The learner began from that champion’s network, so the training carries over; a new champion still has to beat the no-learning robot here.' : 'It had no learned network to carry over.'}</p>`,
    );
  const k = `${s?.history.length ?? 0}:${s?.history.at(-1)?.exam ?? ''}:${s?.base ?? ''}`;
  if (k !== chartKey) {
    chartKey = k;
    homeChart.set(s?.history ?? [], s?.base !== null && s?.base !== undefined ? [{ value: s.base, label: `no-learning robot ${s.base.toFixed(0)}` }] : []);
  }
  setHTML(
    $('homePartners'),
    ex
      ? `<table><thead><tr><th class="l">Partner</th><th>Points</th></tr></thead><tbody>${Object.entries(ex.byPartner)
          .map(([k2, v]) => `<tr><td class="l">${esc(PARTNER_LABEL[k2] ?? k2)}</td><td>${v.toFixed(1)}</td></tr>`)
          .join('')}</tbody></table>${s?.searchExam ? `<p class="hint">Thinking ahead (champion #${s.searchExam.champion}, ${s.searchExam.n} solo matches): alone ${s.searchExam.alone.toFixed(1)}, with search ${s.searchExam.search.toFixed(1)} (${sgn(s.searchExam.gain.mean)} ± ${s.searchExam.gain.ci95.toFixed(1)}). The goal: the network alone as good as with search.</p>` : ''}`
      : '<p class="hint">After the first exam.</p>',
  );
  setHTML(
    $('homeOpponents'),
    ex?.byOpponents
      ? `<table><thead><tr><th class="l">Red alliance</th><th>Points</th></tr></thead><tbody>${Object.entries(ex.byOpponents)
          .map(([k2, v]) => `<tr><td class="l">${esc(OPP_LABEL[k2] ?? k2)}</td><td>${v.toFixed(1)}</td></tr>`)
          .join('')}</tbody></table>`
      : '<p class="hint">After the first exam.</p>',
  );
  const dl = $<HTMLAnchorElement>('dlChampV2');
  dl.hidden = !s?.champion.learned;
  dl.href = `/api/export/v2-champion.json?profile=${encodeURIComponent(H.profile)}`;
  const L = s?.learner;
  setText($('homeLearner'), L?.last ? `last lesson: agrees with the search ${pct(L.last.agree)} of held-out decisions, gives away ${L.last.regret.toFixed(1)} pts each · learning rate ${L.lr.toPrecision(2)}` : '');
  setHTML(
    $('homeCands'),
    s?.candidates.length
      ? `<table><thead><tr><th>#</th><th class="l">Verdict</th><th title="paired with the champion on the same exam matches">vs champion</th><th>Matches</th><th title="held-out decisions where its first choice is the search's">Agrees</th></tr></thead><tbody>${[...s.candidates]
          .reverse()
          .map((q) => `<tr><td>${q.id}</td><td class="l">${q.verdict === 'promoted' ? '<span class="badge ok">★ promoted</span>' : '<span class="badge">not better</span>'}</td><td class="${q.diff.mean > 0 ? 'gain' : ''}">${sgn(q.diff.mean)} ± ${q.diff.ci95.toFixed(1)}</td><td>${q.n}</td><td>${pct(q.learn.agree)}</td></tr>`)
          .join('')}</tbody></table>`
      : `<p class="hint">${s?.running ? `The first candidate is learned after ${fmt(s.nextLearnIn)} more decisions.` : 'None yet.'}</p>`,
  );
  setHTML($('homeLog'), (s?.log ?? []).slice().reverse().map((l) => `<div>${esc(l)}</div>`).join('') || '<p class="hint">Nothing yet.</p>');
  bus.emit('pill');
}

export async function loadHome(p?: string): Promise<void> {
  try {
    S.home = await getJSON<HomeV>(`/api/home${p ? `?profile=${encodeURIComponent(p)}` : ''}`);
    renderHome();
  } catch (e) {
    $('homeProblems').hidden = false;
    setHTML($('homeProblems'), `<p>${esc((e as Error).message)}</p>`);
  }
}
/** a status event from the trainer */
export function homeStatus(st: HomeStatusV): void {
  const H = S.home;
  if (H?.status && H.status.champion.id !== st.champion.id) {
    void loadExamSheet();
    void loadSetup(true);
  }
  if (H && (!H.status || H.status.name === st.name)) {
    H.status = st;
    H.profile = st.profile;
    renderHome();
  } else void loadHome();
}

$<HTMLSelectElement>('homeProfile').onchange = () =>
  void loadHome($<HTMLSelectElement>('homeProfile').value).then(() => {
    bus.emit('profile');
    void loadExamSheet();
    void loadSetup(true);
  });
$('homeTrain').onclick = async () => {
  try {
    S.home = await post<HomeV>('/api/home/train', { profile: $<HTMLSelectElement>('homeProfile').value });
    renderHome();
    toast('Training: it keeps going until you pause.');
  } catch (e) {
    toast((e as Error).message, true);
  }
};
$('homePause').onclick = async () => {
  try {
    S.home = await post<HomeV>('/api/home/pause', {});
    renderHome();
    toast('Paused.');
  } catch (e) {
    toast((e as Error).message, true);
  }
};
window.setInterval(() => S.page === 'home' && S.home && renderHome(), 60_000); // "… min ago"

// ─────────────────────────────── ready to train ───────────────────────────────
interface SetupV {
  profile: string;
  robot: { ok: boolean; problems: string[]; build: string } | null;
  envelope: 'measured' | 'nearest' | 'fallback' | null;
  service: boolean;
  notify: boolean;
  run: { champion: number; exam: number | null } | null;
  playbook: { entries: number } | null;
  teamplays: number | null;
}
let setupAt = 0;
export async function loadSetup(force = false): Promise<void> {
  if (!force && Date.now() - setupAt < 20_000) return;
  setupAt = Date.now();
  try {
    const u = await getJSON<SetupV>(`/api/setup${profileQuery()}`);
    const name = profileName(u.profile);
    const items: { ok: boolean; title: string; detail: string; go?: [string, string] }[] = [
      { ok: !!u.robot?.ok, title: `Robot ${name} is valid`, detail: u.robot ? (u.robot.ok ? u.robot.build : (u.robot.problems[0] ?? 'problems')) : 'no such robot', go: u.robot?.ok ? undefined : ['robot', 'Fix it'] },
      { ok: u.envelope === 'measured', title: 'Its shooting envelope is measured', detail: u.envelope === 'measured' ? 'measured for this build in DSIM’s 3D physics' : u.envelope === 'nearest' ? 'measured at another size of this build: close' : 'not measured: training uses REAL-v0’s', go: u.envelope === 'measured' ? undefined : ['robot', 'Measure'] },
      { ok: u.service, title: 'The studio runs by itself', detail: u.service ? 'installed: starts at login, restarts after a crash' : 'in Terminal: ./start.sh --install', go: u.service ? undefined : ['copy:./start.sh --install', 'Copy'] },
      { ok: u.notify, title: 'Notifications are on', detail: u.notify ? 'new champions, a finished playbook, problems' : 'switched off below' },
      { ok: !!u.run, title: 'Training has started', detail: u.run ? `champion ${u.run.champion ? `#${u.run.champion}` : '(no-learning)'}${u.run.exam !== null ? ` · exam ${u.run.exam.toFixed(1)}` : ''}` : 'press Train above' },
      { ok: (u.teamplays ?? 0) >= 3, title: 'Team plays are searched', detail: u.teamplays ? `beside ${u.teamplays} kinds of partner: training plays inside the winners` : 'while training is paused: the plays that win beside each partner', go: (u.teamplays ?? 0) >= 3 ? undefined : ['plays', 'Open'] },
      { ok: (u.playbook?.entries ?? 0) >= 20, title: 'The AUTO playbook is built', detail: u.playbook ? `${u.playbook.entries} current plans` : 'while training is paused', go: (u.playbook?.entries ?? 0) >= 20 ? undefined : ['playbook', 'Open'] },
    ];
    const done = items.filter((i) => i.ok).length;
    setText($('setupScore'), `${done} of ${items.length}`);
    setHTML(
      $('setupList'),
      items
        .map((i, k) => `<li class="${i.ok ? 'ok' : 'todo'}"><span class="tick" aria-hidden="true">${i.ok ? '✓' : k + 1}</span><span class="what"><b>${esc(i.title)}</b><span class="sub" title="${esc(i.detail)}">${esc(i.detail)}</span></span>${i.go ? `<button type="button" class="quiet small" data-go="${esc(i.go[0])}">${esc(i.go[1])}</button>` : '<span></span>'}</li>`)
        .join(''),
    );
    $('setupCard').classList.toggle('done', done === items.length);
  } catch (e) {
    setHTML($('setupList'), `<li class="todo"><span class="tick">!</span><span class="what"><b>${esc((e as Error).message)}</b></span><span></span></li>`);
  }
}
on<HTMLButtonElement>($('setupList'), 'button[data-go]', async (b) => {
  const g = b.dataset.go!;
  if (g.startsWith('copy:')) {
    await navigator.clipboard.writeText(g.slice(5)).catch(() => undefined);
    toast('Copied: paste it in Terminal, in the studio folder.');
  } else bus.emit('go', g);
});

// ─────────────────────────────── watch the champion ───────────────────────────────
export async function loadExamSheet(): Promise<void> {
  try {
    const rows = await getJSON<{ i: number; partner: string; opponents: string; champion: number | null; base: number | null }[]>(`/api/home/exam${profileQuery()}`);
    const sel = $<HTMLSelectElement>('watchSel');
    const keep = sel.value;
    setHTML(sel, rows.length ? rows.map((r) => `<option value="${r.i}">Match ${r.i + 1} · ${esc(PARTNER_LABEL[r.partner] ?? r.partner)} · ${esc(OPP_LABEL[r.opponents] ?? r.opponents)}${r.champion !== null ? ` · ${r.champion.toFixed(0)} pts` : ''}</option>`).join('') : '<option value="">After the first exam</option>');
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
    const ready = !!rows.length && rows[0].champion !== null;
    $<HTMLButtonElement>('watchGo').disabled = !ready;
    $('btnWatchChamp').hidden = !ready;
    setText($('stageEmptyText'), ready ? 'Watch the champion play an exam match, a playbook plan, a route or a mistake, exactly as DSIM played it.' : 'Matches play here exactly as DSIM played them: the champion’s exam, a playbook plan, a route, a mistake. The first exam runs when you press Train.');
  } catch {
    /* no run yet */
  }
}
async function watchExam(match: number): Promise<void> {
  try {
    const f = await simulate<{ frames: Frames; events: [number, string][]; reward: number }>('/api/home/watch', { profile: S.home?.profile, match }, `exam match ${match + 1}`);
    if (!f) return; // (a newer Watch replaced it)
    const c = S.home?.status?.champion;
    watch(f, `${c?.learned ? `Champion #${c.id}` : 'The no-learning robot'} · exam match ${match + 1} · ${f.reward} points`);
  } catch (e) {
    toast((e as Error).message, true);
  }
}
$('watchGo').onclick = () => $<HTMLSelectElement>('watchSel').value !== '' && void watchExam(Number($<HTMLSelectElement>('watchSel').value));
$('btnWatchChamp').onclick = () => void watchExam(Number($<HTMLSelectElement>('watchSel').value || 0));

// ─────────────────────────────── notifications ───────────────────────────────
interface NotifyV {
  settings: Record<string, boolean>;
  recent: { time: string; title: string; body: string }[];
  mac?: boolean;
}
const NT_LABEL: [string, string][] = [['enabled', 'On'], ['champion', 'New champion'], ['playbook', 'Playbook finished'], ['problems', 'Problems and crashes'], ['sound', 'Sound']];
function renderNotify(n: NotifyV): void {
  setHTML($('ntToggles'), NT_LABEL.map(([k, l]) => `<label class="switch${k !== 'enabled' && !n.settings.enabled ? ' off' : ''}"><input type="checkbox" data-nt="${k}" ${n.settings[k] ? 'checked' : ''} ${k !== 'enabled' && !n.settings.enabled ? 'disabled' : ''}/>${l}</label>`).join(''));
  setHTML($('ntRecent'), n.recent.length ? n.recent.slice(0, 4).map((r) => `<div>${new Date(r.time).toLocaleTimeString()} · <b>${esc(r.title)}</b>: ${esc(r.body)}</div>`).join('') : n.mac === false ? 'macOS only.' : 'Nothing sent yet.');
}
on<HTMLInputElement>(
  $('ntToggles'),
  'input[data-nt]',
  async (i) => {
    try {
      renderNotify(await post<NotifyV>('/api/notify', { [i.dataset.nt!]: i.checked }));
    } catch (e) {
      toast((e as Error).message, true);
    }
  },
  'change',
);
export async function loadNotify(): Promise<void> {
  try {
    renderNotify(await getJSON<NotifyV>('/api/notify'));
  } catch {
    /* older server */
  }
}
$('ntTest').onclick = async () => {
  await act(post('/api/notify/test', {}), 'Sent: look at the top right of the screen.');
  void loadNotify();
};
