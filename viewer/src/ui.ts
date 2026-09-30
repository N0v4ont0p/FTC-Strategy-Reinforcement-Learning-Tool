// SMALL UI HELPERS shared by every page: element lookup, escaping, number formats, the toast, the
// confirm dialog, and the two rules that keep the studio fast and its clicks reliable —
//   · setHTML / setText write the DOM only when the content changed (a status event several times a
//     second no longer rebuilds a table under the pointer, which is how clicks used to get lost);
//   · on(root, selector, handler) is ONE delegated listener per container, so rows rebuilt later
//     keep working without re-binding anything.

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from the page`);
  return el as T;
};
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const pct = (v: number | undefined | null): string => (v === undefined || v === null || !Number.isFinite(v) ? '—' : `${(100 * v).toFixed(0)}%`);
export const sgn = (v: number, d = 1): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;
export const f1 = (v: number | null | undefined, d = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));
/** 1 h 5 min · 4 min 10 s · 12 s */
export function dur(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}
/** seconds since an ISO time (NaN without one) */
export const since = (iso?: string | null): number => (iso ? (Date.now() - Date.parse(iso)) / 1000 : NaN);
export const ago = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  return m < 1 ? 'just now' : m < 90 ? `${Math.round(m)} min ago` : m < 60 * 36 ? `${(m / 60).toFixed(1)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** write innerHTML only when it changed; true when it did */
const lastHTML = new WeakMap<Element, string>();
export function setHTML(el: Element, html: string): boolean {
  if (lastHTML.get(el) === html) return false;
  lastHTML.set(el, html);
  el.innerHTML = html;
  return true;
}
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
/** one delegated listener: `fn` gets the element matching `selector` that was clicked (or changed) */
export function on<E extends HTMLElement = HTMLElement>(root: Element, selector: string, fn: (el: E, ev: Event) => void, type: 'click' | 'change' | 'input' = 'click'): void {
  root.addEventListener(type, (ev) => {
    const t = (ev.target as Element | null)?.closest?.(selector) as E | null;
    if (t && root.contains(t)) fn(t, ev);
  });
}

// a dialog's own Cancel button (data-close) closes it without submitting
on(document.body, 'dialog [data-close]', (b) => b.closest('dialog')?.close());

// ─────────────────────────────── the toast ───────────────────────────────
let toastTimer = 0;
export function toast(msg: string, bad = false): void {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${bad ? ' bad' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), bad ? 6000 : 3200);
}
/** await an action; a failure becomes a red toast. True when it went through */
export async function act(p: Promise<unknown>, ok?: string): Promise<boolean> {
  try {
    await p;
    if (ok) toast(ok);
    return true;
  } catch (e) {
    toast((e as Error).message, true);
    return false;
  }
}

// ─────────────────────────────── the confirm dialog ───────────────────────────────
/** `word`: the user types it back (irreversible actions); `input`: asks for a value (resolves to it,
 * or null on cancel) */
export function dialog(title: string, text: string, yes: string, o: { word?: string; input?: { label: string; value: string }; danger?: boolean } = {}): Promise<string | null> {
  const d = $<HTMLDialogElement>('askDlg');
  $('askTitle').textContent = title;
  $('askText').textContent = text;
  const yesBtn = $<HTMLButtonElement>('askYes');
  yesBtn.textContent = yes;
  yesBtn.className = o.danger ? 'danger' : '';
  $('askTypeWrap').hidden = !o.word;
  $('askWord').textContent = o.word ?? '';
  $('askInputWrap').hidden = !o.input;
  $('askInputLabel').textContent = o.input?.label ?? '';
  const typed = $<HTMLInputElement>('askType');
  const inp = $<HTMLInputElement>('askInput');
  typed.value = '';
  inp.value = o.input?.value ?? '';
  const sync = (): void => {
    yesBtn.disabled = (!!o.word && typed.value !== o.word) || (!!o.input && !inp.value.trim());
  };
  typed.oninput = sync;
  inp.oninput = sync;
  sync();
  d.returnValue = '';
  d.showModal();
  if (o.input) inp.select();
  return new Promise((r) => {
    d.onclose = () => r(d.returnValue === 'yes' ? (o.input ? inp.value.trim() : 'yes') : null);
  });
}
export const ask = async (title: string, text: string, yes: string, word?: string, danger = false): Promise<boolean> => (await dialog(title, text, yes, { word, danger })) !== null;

// ─────────────────────────────── names people use ───────────────────────────────
export const PARTNER_LABEL: Record<string, string> = { none: 'No partner', real: 'A second REAL-v1', sniper: 'Sniper', hauler: 'Hauler', skimmer: 'Skimmer', parker: 'Parks only', idle: 'Does nothing' };
export const OPP_LABEL: Record<string, string> = { none: 'No opponents', presets: 'Skimmer + Sniper', mirror: 'Two REAL-v1s', defense: 'A defender + Skimmer' };
export const START_SHORT: Record<string, string> = { F3: 'F3', TOP_REAR: 'top rear', BOTTOM_AUD: 'bottom audience', TOP_SIDE: 'top side', BOTTOM_SIDE: 'bottom side' };
export const profileName = (p: string): string => p.replace('profiles/', '').replace('.json', '');
/** a playbook entry's key (partner|start|partner start|mode) in words */
export const pbLabel = (key: string): string => {
  const [partner, start, pstart, m] = key.split('|');
  return `us at ${START_SHORT[start] ?? start} · ${(PARTNER_LABEL[partner] ?? partner).toLowerCase()}${pstart !== '-' ? ` at ${START_SHORT[pstart] ?? pstart}` : ''}${m === 'joint' ? ' · joint plan' : ''}`;
};

/** is an element on screen (its page shown, and laid out) */
export const shown = (el: HTMLElement): boolean => el.offsetParent !== null || el.getClientRects().length > 0;

/** THE THEME, read once from the CSS tokens (canvas drawing needs real colours, and reading
 * getComputedStyle inside a draw loop is what made the field stutter) */
let theme: Record<string, string> | null = null;
export function color(token: string): string {
  if (!theme) {
    const cs = getComputedStyle(document.documentElement);
    theme = {};
    for (const k of ['--night', '--deck', '--deck-2', '--deck-3', '--rule', '--rule-2', '--chalk', '--mist', '--dust', '--pollen', '--pollen-hi', '--blue', '--red', '--leaf', '--s-best', '--s-mean', '--s-median', '--st-crash', '--st-stall', '--st-survived', '--f-mono', '--f-display', '--f-text'])
      theme[k] = cs.getPropertyValue(k).trim();
  }
  return token.startsWith('--') ? (theme[token] ?? token) : token;
}
