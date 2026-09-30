// ROUTES — how the champion scores, cycle by cycle (train/routes.ts), and the openings of TELEOP.
import { AUTO_START, getJSON, post, type Frames, type RouteLibraryV } from '../data';
import { watch } from '../stage';
import { $, OPP_LABEL, PARTNER_LABEL, esc, on, pct, setHTML, setText, toast } from '../ui';
import { profileQuery } from '../state';

let RT: { profile: string; library: RouteLibraryV | null } | null = null;
let sel = -1;

export function renderRoutes(): void {
  const L = RT?.library;
  setText($('rtWhen'), L ? `champion ${L.champion ? `#${L.champion}` : '(no-learning)'} · ${L.cycles} cycles in ${L.matches} exam matches` : '');
  if (!L) {
    setHTML($('rtList'), '<p class="hint">After the first exam on Home.</p>');
    setHTML($('rtOpen'), '');
    $('rtDetail').hidden = true;
    return;
  }
  const rows = L.routes.filter((r) => r.n >= 3);
  setHTML(
    $('rtList'),
    rows.length
      ? `<table><thead><tr><th class="l">Collect</th><th class="l">Shoot from</th><th title="cycles, and their share of all cycles">Cycles</th><th title="mean cycle time, volley to volley">s</th><th title="our robot's elements into the HIVE per cycle">In</th><th title="per minute of the route: the rate">In/min</th><th title="the alliance's points meanwhile (they arrive in lumps when a HIVE tips)">Alliance</th></tr></thead><tbody>${rows
          .map((r, i) => `<tr data-i="${i}" class="pick${i === sel ? ' sel' : ''}"><td class="l">${esc(r.collect)}</td><td class="l">${esc(r.shoot)}</td><td>${r.n} (${pct(r.share)})</td><td>${r.seconds.toFixed(1)}</td><td>${r.mine.toFixed(1)}</td><td>${r.inPerMin.toFixed(1)}</td><td>${r.points.toFixed(1)}</td></tr>`)
          .join('')}</tbody></table>`
      : '<p class="hint">No route was used 3 times yet.</p>',
  );
  const r = rows[sel];
  $('rtDetail').hidden = !r;
  if (r) {
    setText($('rtTitle'), r.sig);
    const list = (o: Record<string, number>, names: Record<string, string>): string =>
      Object.entries(o)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${esc(names[k] ?? k)} ${v}`)
        .join(' · ');
    setHTML(
      $('rtSheet'),
      `<table><tbody>
      <tr><td class="l">When</td><td class="l">AUTO ${r.when.auto} · TELEOP ${r.when.teleop} · last 30 s ${r.when.endgame}</td></tr>
      <tr><td class="l">Beside</td><td class="l">${list(r.byPartner, PARTNER_LABEL)}</td></tr>
      <tr><td class="l">Against</td><td class="l">${list(r.byOpponents, OPP_LABEL)}</td></tr>
      <tr><td class="l">Example</td><td class="l">exam match ${r.example.match + 1}, ${((r.example.t0 - AUTO_START) / 60).toFixed(1)}–${((r.example.t1 - AUTO_START) / 60).toFixed(1)} s</td></tr>
    </tbody></table>`,
    );
  }
  setHTML(
    $('rtOpen'),
    L.openings.length
      ? `<table><thead><tr><th class="l">First TELEOP places</th><th>Matches</th><th title="the match's reward">Points</th></tr></thead><tbody>${L.openings
          .map((o) => `<tr><td class="l">${esc(o.seq)}</td><td>${o.n}</td><td>${o.reward.toFixed(1)}</td></tr>`)
          .join('')}</tbody></table>`
      : '<p class="hint">After the first exam.</p>',
  );
}
on<HTMLTableRowElement>($('rtList'), 'tr[data-i]', (tr) => {
  sel = Number(tr.dataset.i);
  renderRoutes();
});
export async function loadRoutes(): Promise<void> {
  try {
    RT = await getJSON<{ profile: string; library: RouteLibraryV | null }>(`/api/routes${profileQuery()}`);
    renderRoutes();
  } catch (e) {
    setHTML($('rtList'), `<p class="hint">${esc((e as Error).message)}</p>`);
  }
}
$('rtWatch').onclick = async () => {
  const r = RT?.library?.routes.filter((q) => q.n >= 3)[sel];
  if (!r || !RT) return;
  try {
    toast('Playing that exam match in DSIM…');
    const f = await post<{ frames: Frames; events: [number, string][] }>('/api/routes/watch', { profile: RT.profile, match: r.example.match });
    watch(f, `Route · ${r.sig} · the champion’s exam match ${r.example.match + 1}`, { seek: r.example.t0 });
  } catch (e) {
    toast((e as Error).message, true);
  }
};
