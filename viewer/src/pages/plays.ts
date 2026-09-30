// TEAM PLAYS — the alliance plays together (train/teamplay.ts, train/teamplaybook.ts): search the
// plays beside every kind of partner, read the winners' roles, watch one on the field.
import { getJSON, post, type Frames } from '../data';
import { simulate, watch } from '../stage';
import { $, PARTNER_LABEL, act, esc, on, setHTML, setText, sgn, toast } from '../ui';
import { S, profileQuery, type TeamStatusV } from '../state';
import { renderJobs } from './jobs';

type Words = { us: Record<string, string>; partner: Record<string, string> };
interface TeamEntryV {
  partner: string;
  stale?: boolean;
  time: string;
  seconds: number;
  evaluated: number;
  generations: number;
  free: { mean: number; cvar10: number };
  ranked: { play: { id: string; label: string; blurb: string; parent?: string; change?: string; roles: unknown }; mean: number; ci95: number; cvar10: number; n: number; vsFree: number }[];
  words: Record<string, Words>;
}
interface TeamV {
  profile: string;
  status: TeamStatusV;
  entries: TeamEntryV[];
  library: { id: string; label: string; blurb: string; solo: boolean; words: Words }[];
}
let TP: TeamV | null = null;
let partner = 'real';
let sel = 0;
const PARTNERS = ['real', 'skimmer', 'sniper', 'hauler', 'parker', 'none'];
const PH: [string, string][] = [['auto', 'AUTO'], ['teleop', 'TELEOP'], ['end', 'Last 30 s']];

export function renderTeam(): void {
  if (!TP) return;
  const st = TP.status;
  setText($('tpStatus'), st.running ? 'Searching…' : TP.entries.length ? `${TP.entries.length} partner kinds searched` : '');
  $<HTMLButtonElement>('tpBuild').disabled = st.running;
  $<HTMLButtonElement>('tpStop').disabled = !st.running;
  renderJobs();
  setHTML(
    $('tpPartners'),
    PARTNERS.map((k) => {
      const e = TP!.entries.find((x) => x.partner === k);
      const b = e?.ranked[0];
      const name = k === 'none' ? 'Alone' : (PARTNER_LABEL[k] ?? k);
      return `<button type="button" role="tab" class="chip2" aria-selected="${k === partner}" data-p="${k}"><b>${esc(name)}${e?.stale ? ' <span class="badge warn">outdated</span>' : ''}</b>${b ? `<span class="${b.vsFree > 0 ? 'up' : ''}">${esc(b.play.label.split(' (')[0])} ${sgn(b.vsFree)}</span>` : `<span>${st.running && st.current === k ? 'searching now…' : 'not searched'}</span>`}</button>`;
    }).join(''),
  );
  const e = TP.entries.find((x) => x.partner === partner);
  setHTML(
    $('tpList'),
    e
      ? `<table><thead><tr><th>#</th><th class="l">Play</th><th title="alliance points per match, fresh luck">Points</th><th title="paired with free play on the same luck">vs free</th><th title="mean of the worst tenth">Worst tenth</th></tr></thead><tbody>${e.ranked
          .map((r, i) => `<tr data-i="${i}" class="pick${i === sel ? ' sel' : ''}"><td>${i + 1}</td><td class="l">${esc(r.play.label)}${r.play.parent ? ' <span class="badge">discovered</span>' : ''}</td><td>${r.mean.toFixed(1)} ± ${r.ci95.toFixed(1)}</td><td class="${r.vsFree > 0 ? 'gain' : ''}">${sgn(r.vsFree)}</td><td>${r.cvar10.toFixed(0)}</td></tr>`)
          .join('')}</tbody></table><p class="hint">${e.evaluated} plays scored over ${e.generations} generations in ${(e.seconds / 60).toFixed(1)} min; the finalists on ${e.ranked[0]?.n ?? 0} fresh luck draws.${e.stale ? ' Searched under older rules: Search plays searches it again.' : ''}</p>`
      : `<p class="hint">${st.running && st.current === partner ? 'Searching now…' : 'Not searched yet beside this partner: press Search plays.'}</p>`,
  );
  const r = e?.ranked[sel];
  $('tpDetail').hidden = !r;
  if (r && e) {
    const lib = TP.library.find((x) => x.id === r.play.id);
    setText($('tpTitle'), r.play.label);
    setHTML($('tpBlurb'), r.play.parent ? `<b>Discovered</b> by the search, from ${esc(r.play.parent)}: ${esc(r.play.change ?? '')}.` : esc(lib?.blurb ?? r.play.blurb ?? ''));
    const w = e.words[r.play.id];
    setHTML(
      $('tpRoles'),
      w
        ? `<table><thead><tr><th class="l"></th><th class="l"><i class="dot us"></i> Our robot</th><th class="l"><i class="dot pa"></i> ${partner === 'none' ? '(no partner)' : 'Partner'}</th></tr></thead><tbody>${PH.map(([k, l]) => `<tr><td class="l ph">${l}</td><td class="l">${esc(w.us[k])}</td><td class="l">${partner === 'none' ? '' : esc(w.partner[k])}</td></tr>`).join('')}</tbody></table>`
        : '',
    );
  }
  setHTML($('tpLib'), TP.library.map((q) => `<div class="libitem"><b>${esc(q.label)}${q.solo ? ' <span class="badge">solo too</span>' : ''}</b><span class="sub">${esc(q.blurb)}</span></div>`).join(''));
}
on<HTMLButtonElement>($('tpPartners'), 'button[data-p]', (b) => {
  partner = b.dataset.p!;
  sel = 0;
  renderTeam();
});
on<HTMLTableRowElement>($('tpList'), 'tr[data-i]', (tr) => {
  sel = Number(tr.dataset.i);
  renderTeam();
});
export async function loadTeam(): Promise<void> {
  try {
    TP = await getJSON<TeamV>(`/api/teamplays${profileQuery()}`);
    S.tpStatus = TP.status;
    renderTeam();
  } catch (e) {
    setHTML($('tpList'), `<p class="hint">${esc((e as Error).message)}</p>`);
  }
}
/** a status event from the search */
export function teamStatus(d: { profile: string; status: TeamStatusV; entry?: boolean }): void {
  if (!TP || d.profile !== TP.profile) {
    if (d.status.running) {
      S.tpStatus = d.status;
      renderJobs();
    }
    return;
  }
  TP.status = d.status;
  S.tpStatus = d.status;
  if (d.entry) void loadTeam();
  else renderTeam();
}
$('tpBuild').onclick = () => TP && void act(post('/api/teamplays/build', { profile: TP.profile, budget: $<HTMLSelectElement>('tpBudget').value }), 'Searching plays beside every kind of partner: results appear as each finishes.');
$('tpStop').onclick = () => void act(post('/api/teamplays/stop', {}), 'Stops after the partner in progress.');
$('tpWatch').onclick = async () => {
  const e = TP?.entries.find((x) => x.partner === partner);
  const r = e?.ranked[sel];
  if (!r || !TP) return;
  try {
    const f = await simulate<{ frames: Frames; events: [number, string][]; reward: number }>('/api/teamplays/watch', { profile: TP.profile, partner, play: r.play }, `the play “${r.play.label}”`);
    if (!f) return;
    watch(f, `Team play · ${r.play.label} · ${(PARTNER_LABEL[partner] ?? partner).toLowerCase()} · ${f.reward} points`);
  } catch (err) {
    toast((err as Error).message, true);
  }
};
