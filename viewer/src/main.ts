// BIOBUZZ STUDIO — the entry: the pages and their router (#home, #robot, …), the pill at the top,
// the menu, the live event stream from the server, and quitting.
import type { World } from '../../dsim-main/src/types';
import { getJSON, post, type CheckpointMeta, type EvalResult, type GenSummary, type HomeStatusV, type LiveMsg, type PlaybookStatusV, type Progress, type RunState, type State, type Status, type TrainLive } from './data';
import { initStage, simProgress } from './stage';
import { loadLive, onLive } from './stream';
import './live';
import { $, ask, esc, setText, toast } from './ui';
import { S, bus, type MeasureV, type SimV, type TeamStatusV } from './state';
import { homeStatus, loadExamSheet, loadHome, loadNotify, loadSetup } from './pages/home';
import { inspectNow, loadRobots, measureProgress, renderRobotList, showRobot } from './pages/robot';
import { loadPlaybook, playbookStatus, showPlaybook } from './pages/playbook';
import { loadTeam, renderTeam, teamStatus } from './pages/plays';
import { loadRoutes, renderRoutes } from './pages/routes';
import { loadMistakes, renderMistakes } from './pages/mistakes';
import { log } from './pages/log';
import { renderJobs } from './pages/jobs';
import * as v1 from './pages/legacy';

// ─────────────────────────────── pages ───────────────────────────────
const V1_PAGES = ['overview', 'race', 'report', 'runs', 'checkpoints', 'settings', 'data', 'evaluate'];
const ALL = ['home', 'robot', 'playbook', 'plays', 'routes', 'mistakes', 'log', ...V1_PAGES];
/** what a page does when it is opened (its lists fresh, its canvases at their real size) */
const onShow: Record<string, () => void> = {
  home: () => {
    void loadSetup();
  },
  robot: () => showRobot(),
  playbook: () => showPlaybook(),
  plays: () => renderTeam(),
  routes: () => renderRoutes(),
  mistakes: () => renderMistakes(),
};
function go(page: string, push = true): void {
  if (!ALL.includes(page)) page = 'home';
  if (V1_PAGES.includes(page) && !v1.v1On) v1.setV1(true);
  S.page = page;
  for (const p of document.querySelectorAll<HTMLElement>('.page')) p.hidden = p.dataset.page !== page;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[role=tab][data-page]')) b.setAttribute('aria-selected', String(b.dataset.page === page));
  $('pages').scrollTop = 0;
  if (push && location.hash !== `#${page}`) history.replaceState(null, '', `#${page}`);
  onShow[page]?.();
  if (V1_PAGES.includes(page)) v1.showV1Page();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[role=tab][data-page]')) b.onclick = () => go(b.dataset.page!);
window.addEventListener('hashchange', () => go(location.hash.slice(1) || 'home', false));
bus.on('go', (p) => go(String(p)));
bus.on('log', (x) => {
  if (typeof x === 'string') log(x);
  else if (x && typeof x === 'object') log((x as { text: string }).text, new Date((x as { time: string }).time));
});
// the robot changed on Home: every page that shows a robot's results reloads
bus.on('profile', () => {
  void loadRoutes();
  void loadMistakes();
  void loadTeam();
  void loadPlaybook(S.home?.profile);
});

// ─────────────────────────────── the pill: training at a glance ───────────────────────────────
function renderPill(): void {
  const s = S.home?.status;
  const ex = s?.champion.exam;
  // a long search in the background shows here too, wherever you are in the studio
  const pb = S.pbStatus;
  const tp = S.tpStatus;
  const job = pb?.running
    ? `AUTO playbook ${pb.done}/${pb.total} · ${((100 * (pb.done + (pb.frac ?? 0))) / Math.max(1, pb.total)).toFixed(0)} %`
    : tp?.running
      ? `Team plays ${tp.done}/${tp.total} · ${((100 * (tp.done + (tp.matchesTotal ? (tp.matches ?? 0) / tp.matchesTotal : 0))) / Math.max(1, tp.total)).toFixed(0)} %`
      : '';
  const t = job || (!s ? 'Not training' : `${s.name} · ${s.running ? 'training' : 'paused'}${ex ? ` · exam ${ex.mean.toFixed(1)}` : ''}${s.champion.learned ? ` · #${s.champion.id}` : ''}`);
  setText($('pillText'), t);
  $('pill').className = `pill${job ? ' busy' : s?.running ? ' on' : ''}`;
  $('pill').dataset.go = pb?.running ? 'playbook' : tp?.running ? 'plays' : 'home';
}
bus.on('pill', renderPill);
$('pill').onclick = () => go($('pill').dataset.go ?? 'home');

// ─────────────────────────────── the menu ───────────────────────────────
function menu(open: boolean): void {
  $('menu').hidden = !open;
  $('menuBtn').setAttribute('aria-expanded', String(open));
}
$('menuBtn').onclick = (e) => {
  e.stopPropagation();
  menu($('menu').hidden);
};
document.addEventListener('click', (e) => {
  if (!$('menu').hidden && !(e.target as Element).closest('#menu')) menu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('menu').hidden) menu(false);
});
$('mV1').onclick = () => {
  menu(false);
  v1.setV1(!v1.v1On);
  if (v1.v1On) go('overview');
};
$('mDsim').onclick = () => {
  menu(false);
  window.open('http://localhost:5173', '_blank', 'noopener');
};
let closed = false;
function showClosed(): void {
  if (closed) return;
  closed = true;
  $('closed').hidden = false;
  window.close(); // works when the browser allows it; otherwise the page says the studio is closed
}
$('mQuit').onclick = async () => {
  menu(false);
  const trainingV2 = !!S.home?.status?.running;
  if (!(await ask('Quit the studio?', `Everything stops: ${trainingV2 ? 'training (it carries on by itself the next time you start the studio — pause first if you do not want that), ' : ''}any search in progress, DSIM, and the studio itself. Start again with ./start.sh.`, 'Quit studio', undefined, true))) return;
  try {
    await post('/api/quit');
    showClosed();
  } catch (e) {
    toast((e as Error).message, true);
  }
};

// ─────────────────────────────── the live stream ───────────────────────────────
function connect(): void {
  const es = new EventSource('/api/events');
  const on = <T,>(type: string, fn: (d: T) => void): void => es.addEventListener(type, (e) => fn(JSON.parse((e as MessageEvent).data) as T));
  on<State>('reset', (s) => void v1.reset(s));
  on<Status | null>('status', (s) => v1.onStatus(s));
  on<Progress>('progress', (p) => v1.onProgress(p));
  on<GenSummary>('generation', (g) => void v1.onGeneration(g));
  on<RunState['champion']>('best', (b) => v1.onBest(b));
  on<string>('log', (s) => log(s));
  on<CheckpointMeta[]>('checkpoints', (l) => v1.onCheckpoints(l));
  on<State['runs']>('runs', (r) => v1.onRuns(r));
  on<State['data']>('data', (d) => v1.onData(d));
  on<EvalResult>('eval', (e) => v1.onEval(e));
  on<{ profile: string; status: PlaybookStatusV }>('playbook', (d) => playbookStatus(d));
  on<{ profile: string; key: string }>('playbookEntry', (d) => {
    if (S.pb && d.profile === S.pb.profile) void loadPlaybook(S.pb.profile);
  });
  on<HomeStatusV>('home', (st) => {
    homeStatus(st);
    renderRobotList(); // (the "training" badge)
  });
  on<unknown>('routes', () => void loadRoutes());
  on<{ profile: string; status: TeamStatusV; entry?: boolean }>('teamplays', (d) => teamStatus(d));
  on<unknown>('mistakes', () => void loadMistakes());
  on<unknown>('robots', () => {
    void loadRobots();
    void inspectNow();
    void loadSetup(true);
  });
  // what is running now: the trainer's live picture, the match it streams to the field, a match
  // played again in DSIM to watch it, an envelope being measured
  on<TrainLive | null>('train', (t) => {
    S.live = t;
    bus.emit('train');
  });
  on<LiveMsg>('live', (m) => onLive(m));
  on<SimV>('sim', (d) => simProgress(d));
  on<MeasureV>('measure', (m) => measureProgress(m));
  es.addEventListener('quit', () => {
    es.close();
    showClosed();
  });
  es.onopen = () => {
    v1.onConnected();
    renderPill();
    void loadLive(); // (a studio opening mid-match joins the streamed match here)
  };
  es.onerror = () => {
    if (closed) return es.close();
    v1.onReconnecting();
    setText($('pillText'), 'Reconnecting to the studio…');
    $('pill').className = 'pill';
    // nothing live is known until it answers again
    S.live = null;
    bus.emit('train');
  };
}

async function boot(): Promise<void> {
  try {
    S.field = await getJSON<World>('/api/field');
    initStage(S.field);
  } catch (e) {
    toast(`The field could not be loaded: ${(e as Error).message}`, true);
  }
  v1.setV1(v1.v1On);
  go(location.hash.slice(1) || 'home', false);
  connect();
  await loadHome();
  void loadSetup(true);
  void loadExamSheet();
  void loadNotify();
  void loadPlaybook(S.home?.profile);
  void loadTeam();
  void loadRoutes();
  void loadMistakes();
  renderJobs();
  void esc;
}
void boot();
