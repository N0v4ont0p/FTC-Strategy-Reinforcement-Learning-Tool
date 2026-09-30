// PLAYBOOK — the best AUTO beside every kind of partner (train/playbook.ts): build it, follow the
// search live, read an entry's timing sheet and diagram, watch it on the field.
import { AUTO_START, OPTIONS, getJSON, post, type Frames, type PlaybookStatusV, type PlaybookV } from '../data';
import { drawPlan } from '../plandiagram';
import { watch } from '../stage';
import { $, PARTNER_LABEL, act, esc, on, pbLabel, profileName, setHTML, setText, sgn, shown, toast } from '../ui';
import { S } from '../state';
import { renderJobs } from './jobs';

let selected: string | null = null;
let diagramKey = '';

function renderStatus(st: PlaybookStatusV): void {
  setText($('pbStatus'), st.running ? 'building…' : S.pb?.entries.length ? `${S.pb.entries.length} plans in the playbook` : '');
  $<HTMLButtonElement>('pbBuild').disabled = st.running;
  $<HTMLButtonElement>('pbStop').disabled = !st.running;
  renderJobs();
}
export function renderPlaybook(): void {
  const PB = S.pb;
  if (!PB) return;
  const sel = $<HTMLSelectElement>('pbProfile');
  setHTML(sel, PB.profiles.map((p) => `<option value="${esc(p)}">${esc(profileName(p))}</option>`).join(''));
  if (sel.value !== PB.profile) sel.value = PB.profile;
  const filt = $<HTMLSelectElement>('pbFilter');
  if (filt.options.length === 1) filt.insertAdjacentHTML('beforeend', Object.entries(PARTNER_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join(''));
  $<HTMLAnchorElement>('pbPrint').href = `./print.html?profile=${encodeURIComponent(PB.profile)}${filt.value ? `&partner=${filt.value}` : ''}`;
  renderStatus(PB.status);
  const f = filt.value;
  const rows = PB.entries.filter((e) => !f || e.problem.partner === f).sort((a, b) => a.key.localeCompare(b.key));
  const stale = rows.filter((e) => e.stale).length;
  setHTML(
    $('pbList'),
    rows.length
      ? `${stale ? `<p class="hint"><span class="badge warn">outdated</span> ${stale} of these were planned under older rules (DSIM’s old physics, an older AUTO rule or another shooting zone): Build playbook plans them again.</p>` : ''}<table><thead><tr><th class="l">Entry</th><th title="our nominal robot, 64 fresh luck draws">AUTO pts</th><th title="mean of the worst tenth of those draws">Worst tenth</th><th title="the same draws with no plan (every robot its own brain)">vs no plan</th><th title="robots drawn from the profile's range">Range</th></tr></thead><tbody>${rows
          .map(
            (e) =>
              `<tr data-key="${esc(e.key)}" class="pick${e.key === selected ? ' sel' : ''}"><td class="l">${esc(pbLabel(e.key))}${e.stale ? ' <span class="badge warn">outdated</span>' : ''}</td><td>${e.nominal.mean.toFixed(1)} ± ${e.nominal.ci95.toFixed(1)}</td><td>${e.nominal.cvar10.toFixed(1)}</td><td class="${e.nominal.mean - e.baseline.mean > 0 ? 'gain' : ''}">${sgn(e.nominal.mean - e.baseline.mean)}</td><td>${e.sampled.mean.toFixed(1)}</td></tr>`,
          )
          .join('')}</tbody></table>`
      : `<p class="hint">${PB.status.running ? 'The first entry appears when it is planned.' : 'Nothing planned yet: press Build playbook.'}</p>`,
  );
  if (selected) showEntry(selected, false);
}
on<HTMLTableRowElement>($('pbList'), 'tr[data-key]', (tr) => showEntry(tr.dataset.key!));

async function diagram(e: NonNullable<PlaybookV['entries'][number]>): Promise<void> {
  const cv = $<HTMLCanvasElement>('pbDiagram');
  if (!S.pb || !S.field || diagramKey === e.key || !shown($('pbDetail'))) return;
  diagramKey = e.key;
  try {
    const r = await getJSON<{ frames: Frames }>(`/api/playbook/frames?profile=${encodeURIComponent(S.pb.profile)}&key=${encodeURIComponent(e.key)}`);
    if (diagramKey !== e.key) return;
    cv.hidden = false;
    drawPlan(cv, S.field, r.frames, e.taken, { css: Math.min(460, $('pbDetail').clientWidth - 38) });
  } catch {
    cv.hidden = true;
  }
}
function showEntry(key: string, scroll = true): void {
  const e = S.pb?.entries.find((q) => q.key === key);
  if (!e) return;
  selected = key;
  for (const tr of $('pbList').querySelectorAll<HTMLTableRowElement>('tr[data-key]')) tr.classList.toggle('sel', tr.dataset.key === key);
  $('pbDetail').hidden = false;
  setText($('pbTitle'), pbLabel(key));
  void diagram(e);
  const who = (r: number): string => (r === 0 ? 'our robot' : 'partner');
  const t = (tick: number): string => `${Math.max(0, (tick - AUTO_START) / 60).toFixed(1)} s`;
  setHTML(
    $('pbSheet'),
    `<p class="hint">${e.nominal.mean.toFixed(1)} ± ${e.nominal.ci95.toFixed(1)} AUTO points (worst tenth ${e.nominal.cvar10.toFixed(1)}); with no plan ${e.baseline.mean.toFixed(1)}; across the robot’s range ${e.sampled.mean.toFixed(1)}. ${e.explored} plans scored in ${e.seconds.toFixed(0)} s${e.style ? '; skill settings tuned for it' : ''}.${e.stale ? ' <span class="badge warn">outdated</span>' : ''}</p>
    ${e.taken.length ? '' : '<p><b>No plan beats the robots’ own AUTO here.</b> Run your usual routine (the replay shows it).</p>'}
    <table><thead><tr><th class="l">When</th><th class="l">Robot</th><th class="l">Job</th></tr></thead><tbody>${e.taken
      .map((q) => `<tr><td class="l mono">${t(q.tick)}${q.end ? `–${t(q.end)}` : ''}</td><td class="l">${who(q.robot)}</td><td class="l"><i class="optsw" style="background:${OPTIONS.find((o) => o.key === q.kind)?.color ?? '#888'}"></i>${esc(q.label)}${q.matched ? '' : ' <span class="hint">(not there: it chose itself)</span>'}</td></tr>`)
      .join('')}</tbody></table>
    <p class="hint">After its planned steps each robot plays on with its own brain until AUTO ends.</p>`,
  );
  if (scroll) $('pbDetail').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
export async function loadPlaybook(profile?: string): Promise<void> {
  try {
    S.pb = await getJSON<PlaybookV>(`/api/playbook${profile ? `?profile=${encodeURIComponent(profile)}` : ''}`);
    S.pbStatus = S.pb.status;
    diagramKey = '';
    renderPlaybook();
  } catch (e) {
    setHTML($('pbList'), `<p class="hint">${esc((e as Error).message)}</p>`);
  }
}
/** a status event from the build */
export function playbookStatus(d: { profile: string; status: PlaybookStatusV }): void {
  if (S.pb && d.profile === S.pb.profile) {
    S.pb.status = d.status;
    S.pbStatus = d.status;
    renderStatus(d.status);
  } else if (d.status.running) {
    S.pbStatus = d.status; // (another robot's build: still shown in the pill)
    renderJobs();
  }
}
async function watchEntry(key: string): Promise<void> {
  if (!S.pb) return;
  try {
    const r = await getJSON<{ frames: Frames; events: [number, string][] }>(`/api/playbook/frames?profile=${encodeURIComponent(S.pb.profile)}&key=${encodeURIComponent(key)}`);
    watch(r, `AUTO playbook · ${pbLabel(key)} · luck draw 1`);
  } catch (e) {
    toast((e as Error).message, true);
  }
}
$<HTMLSelectElement>('pbProfile').onchange = () => void loadPlaybook($<HTMLSelectElement>('pbProfile').value);
$<HTMLSelectElement>('pbFilter').onchange = () => renderPlaybook();
$('pbWatch').onclick = () => selected && void watchEntry(selected);
$('pbBuild').onclick = async () => {
  if (!S.pb) return;
  const start = $<HTMLSelectElement>('pbStart').value;
  await act(post('/api/playbook/build', { profile: S.pb.profile, budget: $<HTMLSelectElement>('pbBudget').value, starts: start ? [start] : [] }), 'Building the playbook: entries appear as they are planned.');
};
$('pbStop').onclick = () => void act(post('/api/playbook/stop', {}), 'The build stops after the entry in progress.');

/** the page was opened: the diagram at its real width */
export function showPlaybook(): void {
  diagramKey = '';
  if (selected) showEntry(selected, false);
}
