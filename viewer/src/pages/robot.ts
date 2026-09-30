// ROBOT — the robot lab (train/robots.ts): the team's robots as training sees them. Import a build
// from DSIM, narrow its ranges against what DSIM builds, see its build and its measured shooting
// envelope, set the shooting zone, save.
import type { ProfileFile } from '../../../harness/profiles';
import { BB_HALF_X } from '../../../dsim-main/src/games/biobuzz/config';
import { getJSON, post } from '../data';
import { drawBuild, drawEnvelope, drawZone } from '../plandiagram';
import { cellCentre, zoneActive, zoneSpots, type ShootZone } from '../../../train/zone';
import { $, act, dialog, esc, on, setHTML, setText, shown, toast } from '../ui';
import { S } from '../state';

type Rng = { min: number; max: number; nominal: number; unit?: string };
interface RobotRow {
  file: string;
  id: string;
  label: string;
  status: string;
  build: string;
  ok: boolean;
  problems: string[];
}
interface Inspection {
  problems: string[];
  build: string;
  nominal: { length: number; width: number };
  small: { length: number; width: number };
  big: { length: number; width: number };
  floors: Record<string, { min: number; max: number }>;
  envelope: { key: string; quality: 'measured' | 'nearest' | 'fallback'; spots: { north: { x: number; y: number }[]; south: { x: number; y: number }[] } };
  start: { x: number; y: number; h: number };
  intake?: { kind: string; reachesFlower: boolean };
  info: Record<string, { label: string; unit: string; help: string }>;
}
let RB: { robots: RobotRow[]; replays: { label: string; file: string }[] } | null = null;
let RE: { file: string | null; p: ProfileFile; insp: Inspection | null; err: string | null } | null = null;
const isRng = (v: unknown): v is Rng => typeof v === 'object' && v !== null && 'min' in v && 'max' in v && 'nominal' in v;

export async function loadRobots(): Promise<void> {
  try {
    RB = await getJSON('/api/robots');
    const tpl = $<HTMLSelectElement>('rbTemplate');
    const keep = tpl.value;
    setHTML(tpl, RB!.robots.map((r) => `<option value="${esc(r.file)}">${esc(r.id)}</option>`).join(''));
    tpl.value = keep || 'profiles/real-v1.json';
    setHTML($('rbReplay'), '<option value="">—</option>' + RB!.replays.map((r, i) => `<option value="${i}">${esc(r.label)}</option>`).join(''));
    renderRobotList();
    if (!RE && RB!.robots.length) void openRobot(S.home?.profile && RB!.robots.some((r) => r.file === S.home!.profile) ? S.home.profile : RB!.robots[0].file);
  } catch (e) {
    setHTML($('rbList'), `<p class="hint">${esc((e as Error).message)}</p>`);
  }
}
export function renderRobotList(): void {
  if (!RB) return;
  const training = S.home?.status?.running ? S.home.status.profile : null;
  setHTML(
    $('rbList'),
    RB.robots
      .map(
        (r) => `<button type="button" class="rbcard" aria-selected="${RE?.file === r.file}" data-file="${esc(r.file)}">
        <span class="rbname">${esc(r.id)}${training === r.file ? ' <span class="badge on">training</span>' : ''}</span>
        <span class="badge ${r.ok ? 'ok' : 'warn'}">${r.ok ? 'valid' : `${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}`}</span>
        <span class="rbbuild">${esc(r.build)}</span></button>`,
      )
      .join(''),
  );
}
on<HTMLButtonElement>($('rbList'), '.rbcard', (b) => void openRobot(b.dataset.file!));

async function openRobot(file: string): Promise<void> {
  try {
    RE = { file, p: await getJSON<ProfileFile>(`/api/robots/profile?file=${encodeURIComponent(file)}`), insp: null, err: null };
    renderRobotList();
    renderEditor();
    void inspectNow();
  } catch (e) {
    toast((e as Error).message, true);
  }
}
let inspTimer = 0;
function inspectSoon(): void {
  clearTimeout(inspTimer);
  inspTimer = window.setTimeout(() => void inspectNow(), 350);
}
export async function inspectNow(): Promise<void> {
  if (!RE) return;
  const mine = RE;
  try {
    const r = await post<Inspection>('/api/robots/inspect', { profile: RE.p });
    if (RE !== mine) return;
    const first = !RE.insp;
    RE.insp = r;
    RE.err = null;
    if (first) return renderEditor(); // (the labels come with the first check)
  } catch (e) {
    if (RE !== mine) return;
    RE.err = (e as Error).message;
  }
  renderInspection();
}
const GROUPS: [string, 'spec' | 'limits' | 'perturb', string][] = [
  ['The build', 'spec', 'what DSIM builds: its floor and ceiling under each'],
  ['How it performs', 'limits', 'what the real robot will do (measure it, then narrow the range)'],
  ['How it misses', 'perturb', ''],
];
const SPEC_NUMS = ['driveRpm', 'massLb', 'length', 'width'];
function renderEditor(): void {
  const E = RE;
  $('rbEditor').hidden = !E;
  if (!E) return;
  setText($('rbTitle'), E.file ? E.file.replace('profiles/', '') : 'New robot (not saved)');
  $<HTMLInputElement>('rbId').value = String(E.p.id ?? '');
  $<HTMLTextAreaElement>('rbLabel').value = String(E.p.label ?? '');
  const info = E.insp?.info ?? {};
  const rows = GROUPS.map(([title, g, help]) => {
    const keys = Object.keys(E.p[g] as Record<string, unknown>).filter((k) => (g !== 'spec' || SPEC_NUMS.includes(k)) && (isRng((E.p[g] as Record<string, unknown>)[k]) || typeof (E.p[g] as Record<string, unknown>)[k] === 'number'));
    return `<div class="rgroup"><h3>${title}</h3>${help ? `<p class="hint">${help}</p>` : ''}${keys
      .map((k) => {
        const v = (E.p[g] as Record<string, unknown>)[k];
        const id = `${g}.${k}`;
        const inf = info[id];
        const r: Rng = isRng(v) ? v : { min: v as number, max: v as number, nominal: v as number };
        const exact = !isRng(v);
        return `<div class="rrow" data-id="${id}">
          <div class="rlabel"><b>${esc(inf?.label ?? k)}</b><span class="sub">${esc(inf?.help ?? r.unit ?? '')}</span></div>
          <div class="rin">${exact ? `<input type="number" step="any" data-f="nominal" value="${r.nominal}" aria-label="${esc(inf?.label ?? k)}"/><button type="button" class="link" data-mk="range">make a range</button>` : `<input type="number" step="any" data-f="min" value="${r.min}" aria-label="${esc(inf?.label ?? k)}: lowest"/><input type="number" step="any" class="nom" data-f="nominal" value="${r.nominal}" aria-label="${esc(inf?.label ?? k)}: nominal"/><input type="number" step="any" data-f="max" value="${r.max}" aria-label="${esc(inf?.label ?? k)}: highest"/>`}<span class="unit">${esc(inf?.unit ?? '')}</span></div>
          <div class="rbar" data-bar="${id}"></div>
        </div>`;
      })
      .join('')}</div>`;
  });
  $('rbRanges').innerHTML = `<div class="rhead"><span></span><span>lowest · nominal · highest</span></div>` + rows.join('');
  renderInspection();
}
// one listener for every range input and "make a range" link, whatever was rebuilt since
on<HTMLInputElement>(
  $('rbRanges'),
  'input[data-f]',
  (inp) => {
    if (!RE) return;
    const row = inp.closest<HTMLElement>('.rrow')!;
    const [g, k] = row.dataset.id!.split('.') as ['spec' | 'limits' | 'perturb', string];
    const grp = RE.p[g] as Record<string, unknown>;
    const x = Number(inp.value);
    if (inp.value === '' || !Number.isFinite(x)) return;
    const cur = grp[k];
    if (isRng(cur)) cur[inp.dataset.f as 'min' | 'max' | 'nominal'] = x;
    else grp[k] = x;
    drawBar(row.dataset.id!);
    inspectSoon();
  },
  'input',
);
on<HTMLButtonElement>($('rbRanges'), 'button[data-mk]', (b) => {
  if (!RE) return;
  const row = b.closest<HTMLElement>('.rrow')!;
  const [g, k] = row.dataset.id!.split('.') as ['spec' | 'limits' | 'perturb', string];
  const grp = RE.p[g] as Record<string, unknown>;
  const x = grp[k] as number;
  grp[k] = { min: x, max: x, nominal: x };
  renderEditor();
  inspectSoon();
});
function drawBar(id: string): void {
  const E = RE;
  const el = document.querySelector<HTMLElement>(`[data-bar="${id}"]`);
  if (!E || !el) return;
  const [g, k] = id.split('.') as ['spec' | 'limits' | 'perturb', string];
  const v = (E.p[g] as Record<string, unknown>)[k];
  const fl = E.insp?.floors[id];
  const r: Rng = isRng(v) ? v : { min: v as number, max: v as number, nominal: v as number };
  if (!fl) {
    setHTML(el, '');
    return;
  }
  const lo = Math.min(fl.min, r.min);
  const hi = Math.max(fl.max, r.max);
  const x = (t: number): number => (hi > lo ? ((t - lo) / (hi - lo)) * 100 : 50);
  const out = r.min < fl.min || r.max > fl.max;
  setHTML(el, `<div class="track"><div class="dsim" style="left:${x(fl.min)}%;width:${x(fl.max) - x(fl.min)}%"></div><div class="span${out ? ' out' : ''}" style="left:${x(r.min)}%;width:${Math.max(0.8, x(r.max) - x(r.min))}%"></div><div class="nomk" style="left:${x(r.nominal)}%"></div></div><div class="barlabels"><span>DSIM builds ${fl.min} to ${fl.max}</span>${out ? '<span class="warnt">outside what DSIM builds</span>' : ''}</div>`);
}
const INTAKE_WORDS: Record<string, string> = { sweeper: 'a sweeper', siderollers: 'side rollers', ramp: 'a ramp' };
export function renderInspection(): void {
  const E = RE;
  if (!E) return;
  const I = E.insp;
  const probs = E.err ? [E.err] : (I?.problems ?? []);
  const badge = $('rbBadge');
  badge.className = `badge ${!I && !E.err ? '' : probs.length ? 'warn' : 'ok'}`;
  setText(badge, !I && !E.err ? 'checking…' : probs.length ? `${probs.length} problem${probs.length === 1 ? '' : 's'}` : 'valid over its whole range');
  setHTML($('rbProblems'), probs.length ? `<div><b>Training refuses it until these are fixed:</b><ul>${probs.slice(0, 8).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
  const q = I?.envelope.quality;
  setHTML(
    $('rbFacts'),
    I
      ? `<dt>Build</dt><dd>${esc(I.build)}</dd>` +
          (I.intake ? `<dt>FLOWERs</dt><dd>${I.intake.kind === 'sweeper' ? `${INTAKE_WORDS.sweeper}: its roller cannot reach into a FLOWER, so it never pulls POLLEN out of one (DSIM Act 2); it can still place NECTAR on one` : I.intake.reachesFlower ? `${esc(INTAKE_WORDS[I.intake.kind] ?? I.intake.kind)}: it could reach into a FLOWER, but the skills do not drive this intake yet, so training never sends it there` : esc(I.intake.kind)}</dd>` : '') +
          `<dt>Envelope</dt><dd>${q === 'measured' ? '<span class="badge ok">measured</span> for this build, in DSIM’s 3D physics' : q === 'nearest' ? '<span class="badge">close</span> measured for this build at another size' : '<span class="badge warn">not measured</span> training would use REAL-v0’s envelope'}</dd>`
      : '',
  );
  for (const id of ['spec.driveRpm', 'spec.massLb', 'spec.length', 'spec.width']) drawBar(id);
  if (I && S.field && shown($('rbEditor'))) {
    const fig = $('rbPreview').parentElement!;
    const w = Math.max(140, fig.clientWidth - 22);
    drawBuild($<HTMLCanvasElement>('rbPreview'), S.field, I.nominal, I.small, I.big, w);
    drawEnvelope($<HTMLCanvasElement>('rbEnvelope'), S.field, I.nominal, I.envelope.spots, I.start, w);
    setText($('rbEnvCap'), `where one shot after another settles in the cell · blue: aiming at the north cell, gold: the south (${I.envelope.spots.north.length + I.envelope.spots.south.length} spots)`);
    $<HTMLButtonElement>('rbMeasure').hidden = q === 'measured';
  }
  setHTML($('rbEnvQ'), '');
  renderZone();
}

// ── the shooting zone (train/zone.ts): distance limits and a drawn area, blue frame ──
let zMap: ReturnType<typeof drawZone> | null = null;
let zDrag = -1;
let zHot = -1;
const zoneOf = (): ShootZone => (RE?.p.shootZone ?? {}) as ShootZone;
/** set the robot's zone (nothing limited = no zone at all) and check it again */
function setZone(z: ShootZone, check = true): void {
  if (!RE) return;
  const clean: ShootZone = {};
  if ((z.maxDist ?? 0) > 0) clean.maxDist = z.maxDist;
  if ((z.minDist ?? 0) > 0) clean.minDist = z.minDist;
  if (z.area?.length) clean.area = z.area;
  RE.p.shootZone = Object.keys(clean).length ? clean : null;
  renderZone();
  if (check) inspectSoon();
}
function renderZone(): void {
  const E = RE;
  const I = E?.insp;
  if (!E || !I || !S.field || !shown($('rbEditor'))) return;
  const z = zoneOf();
  const active = zoneActive(z);
  const kept = zoneSpots(active ? z : null, I.envelope.spots);
  // side by side when the editor is wide enough, else the field on top and the controls under it
  const wide = $('rbEditor').clientWidth;
  const stack = wide < 700;
  $('rbZoneCanvas').parentElement!.classList.toggle('stack', stack);
  const css = stack ? Math.max(200, Math.min(440, wide - 36)) : Math.min(420, wide - 330);
  zMap = drawZone($<HTMLCanvasElement>('rbZoneCanvas'), S.field, I.envelope.spots, kept, z, { north: cellCentre('north'), south: cellCentre('south') }, css, zDrag >= 0 ? zDrag : zHot);
  const mx = $<HTMLInputElement>('rbZoneMax');
  const mn = $<HTMLInputElement>('rbZoneMin');
  if (document.activeElement !== mx) mx.value = String(z.maxDist ?? 0);
  if (document.activeElement !== mn) mn.value = String(z.minDist ?? 0);
  setText($('rbZoneMaxV'), (z.maxDist ?? 0) > 0 ? `${z.maxDist} IN` : 'NO LIMIT');
  setText($('rbZoneMinV'), (z.minDist ?? 0) > 0 ? `${z.minDist} IN` : 'NO LIMIT');
  const all = I.envelope.spots.north.length + I.envelope.spots.south.length;
  const k = kept.north.length + kept.south.length;
  const sum = $('rbZoneSum');
  sum.className = `badge ${!active ? '' : kept.north.length && kept.south.length ? 'ok' : 'warn'}`;
  setText(sum, active ? `${k} of ${all} scoring spots kept` : 'off: everything DSIM scores');
  const far = (side: 'north' | 'south'): string => {
    const c = cellCentre(side);
    const d = kept[side].reduce((m, p) => Math.max(m, Math.hypot(p.x - c.x, p.y - c.y)), 0);
    return kept[side].length ? `${kept[side].length} of ${I.envelope.spots[side].length} spots, farthest <b>${d.toFixed(0)} in</b>` : '<b>no spot left: widen the zone</b>';
  };
  setHTML($('rbZoneStats'), `<span class="n">● North cell: ${far('north')}</span><span class="s">● South cell: ${far('south')}</span>${(z.area?.length ?? 0) > 0 && (z.area?.length ?? 0) < 3 ? '<span>The area needs 3 corners to count.</span>' : ''}`);
  $<HTMLButtonElement>('rbZoneClear').hidden = !(z.area?.length ?? 0);
}
$<HTMLInputElement>('rbZoneMax').oninput = () => setZone({ ...zoneOf(), maxDist: Number($<HTMLInputElement>('rbZoneMax').value) });
$<HTMLInputElement>('rbZoneMin').oninput = () => setZone({ ...zoneOf(), minDist: Number($<HTMLInputElement>('rbZoneMin').value) });
$('rbZoneClear').onclick = () => setZone({ ...zoneOf(), area: null });
const H = Math.floor(BB_HALF_X * 10) / 10; // the field's half-width (DSIM's CAD field)
on<HTMLButtonElement>($('rbEditor'), '[data-zp]', (b) => {
  const v = b.dataset.zp!;
  setZone(v === 'off' ? {} : v === 'ours' ? { area: [{ x: 0, y: -H }, { x: H, y: -H }, { x: H, y: H }, { x: 0, y: H }] } : { maxDist: Number(v) });
});
{
  const cv = $<HTMLCanvasElement>('rbZoneCanvas');
  const snap = (p: { x: number; y: number }): { x: number; y: number } => ({ x: Math.max(-H, Math.min(H, Math.round(p.x))), y: Math.max(-H, Math.min(H, Math.round(p.y))) });
  /** the pointer on the canvas, CSS px */
  const at = (e: MouseEvent): { x: number; y: number } => {
    const R = cv.getBoundingClientRect();
    return { x: e.clientX - R.left, y: e.clientY - R.top };
  };
  /** the corner under the pointer (within 9 px), or −1 */
  const hit = (e: PointerEvent | MouseEvent): number => {
    if (!zMap) return -1;
    const m = at(e);
    const a = zoneOf().area ?? [];
    let best = -1;
    let bd = 81;
    a.forEach((p, i) => {
      const q = zMap!.toCss(p.x, p.y);
      const d = (q.x - m.x) ** 2 + (q.y - m.y) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  const segDist = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number => {
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / (ex * ex + ey * ey || 1)));
    return Math.hypot(a.x + ex * t - p.x, a.y + ey * t - p.y);
  };
  cv.onpointerdown = (e) => {
    if (!zMap || !RE?.insp) return;
    const i = hit(e);
    cv.setPointerCapture(e.pointerId);
    if (i >= 0) {
      zDrag = i;
      cv.classList.add('drag');
      return renderZone();
    }
    // a new corner, on the edge it is nearest to (so the shape grows the way it is clicked)
    const m = at(e);
    const p = snap(zMap.toField(m.x, m.y));
    const a = [...(zoneOf().area ?? [])];
    let ins = a.length;
    if (a.length >= 3) {
      let bd = Infinity;
      a.forEach((q, k) => {
        const d = segDist(p, q, a[(k + 1) % a.length]);
        if (d < bd) {
          bd = d;
          ins = k + 1;
        }
      });
    }
    a.splice(ins, 0, p);
    zDrag = ins;
    cv.classList.add('drag');
    setZone({ ...zoneOf(), area: a }, false);
  };
  cv.onpointermove = (e) => {
    if (!zMap) return;
    if (zDrag < 0) {
      const h = hit(e);
      if (h !== zHot) {
        zHot = h;
        renderZone();
      }
      return;
    }
    const a = [...(zoneOf().area ?? [])];
    if (!a[zDrag]) return;
    const m = at(e);
    a[zDrag] = snap(zMap.toField(m.x, m.y));
    setZone({ ...zoneOf(), area: a }, false);
  };
  const end = (): void => {
    if (zDrag < 0) return;
    zDrag = -1;
    cv.classList.remove('drag');
    setZone(zoneOf());
  };
  cv.onpointerup = end;
  cv.onpointercancel = end;
  cv.ondblclick = (e) => {
    const i = hit(e);
    if (i < 0) return;
    const a = [...(zoneOf().area ?? [])];
    a.splice(i, 1);
    zHot = -1;
    setZone({ ...zoneOf(), area: a.length ? a : null });
  };
}
$<HTMLInputElement>('rbId').oninput = () => {
  if (!RE) return;
  RE.p.id = $<HTMLInputElement>('rbId').value;
  inspectSoon();
};
$<HTMLTextAreaElement>('rbLabel').oninput = () => {
  if (RE) RE.p.label = $<HTMLTextAreaElement>('rbLabel').value;
};
async function saveRobotAs(asNew: boolean): Promise<void> {
  if (!RE) return;
  if (asNew) {
    const name = await dialog('Save as a new robot', 'Its name (the file is named after it).', 'Save', { input: { label: 'Name', value: `${RE.p.id} copy` } });
    if (!name) return;
    RE.p.id = name;
    $<HTMLInputElement>('rbId').value = name;
  }
  const cur = RE.file;
  const same = !!cur && cur === `profiles/${String(RE.p.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.json`;
  try {
    const r = await post<{ file: string }>('/api/robots/save', { profile: RE.p, overwrite: same && !asNew });
    RE.file = r.file;
    toast(`Saved ${r.file}.`);
    await loadRobots();
    renderEditor();
  } catch (e) {
    toast((e as Error).message, true);
  }
}
$('rbSave').onclick = () => void saveRobotAs(false);
$('rbSaveAs').onclick = () => void saveRobotAs(true);
$('rbMeasure').onclick = () => RE && void act(post('/api/robots/measure', { profile: RE.p }), 'Measuring its envelope in DSIM (a few minutes on every core)…');
$('rbImportBtn').onclick = () => {
  $('rbImport').hidden = !$('rbImport').hidden;
  if (!$('rbImport').hidden) $('rbPaste').focus();
};
$('rbImportClose').onclick = () => ($('rbImport').hidden = true);
$('rbCopy').onclick = async () => {
  await navigator.clipboard.writeText($('rbSnippet').textContent ?? '').catch(() => undefined);
  toast('Copied: paste it in DSIM’s console.');
};
async function importPick(body: Record<string, unknown>): Promise<void> {
  try {
    const r = await post<{ profile: ProfileFile }>('/api/robots/import', { ...body, template: $<HTMLSelectElement>('rbTemplate').value });
    RE = { file: null, p: r.profile, insp: null, err: null };
    $('rbImport').hidden = true;
    renderRobotList();
    renderEditor();
    void inspectNow();
    toast('A draft: check the ranges, then Save.');
  } catch (e) {
    toast((e as Error).message, true);
  }
}
$('rbFind').onclick = async () => {
  const text = $<HTMLTextAreaElement>('rbPaste').value.trim();
  if (!text) return toast('Paste what DSIM copied first.', true);
  try {
    const r = await post<{ candidates: string[] }>('/api/robots/import', { text, pick: -1 });
    if (r.candidates.length === 1) return void importPick({ text, pick: 0 });
    setHTML($('rbCands'), r.candidates.map((c, i) => `<button type="button" class="rbcard" data-i="${i}"><span class="rbname">${esc(c)}</span></button>`).join(''));
  } catch (e) {
    toast((e as Error).message, true);
  }
};
on<HTMLButtonElement>($('rbCands'), 'button[data-i]', (b) => void importPick({ text: $<HTMLTextAreaElement>('rbPaste').value.trim(), pick: Number(b.dataset.i) }));
$<HTMLSelectElement>('rbReplay').onchange = () => {
  const v = $<HTMLSelectElement>('rbReplay').value;
  if (v !== '') void importPick({ pick: Number(v) });
};

/** the page was opened: the list, and the previews at their real width */
export function showRobot(): void {
  void loadRobots();
  requestAnimationFrame(() => renderInspection());
}
