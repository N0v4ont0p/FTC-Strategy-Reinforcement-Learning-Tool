// Canvas charts, built to the dataviz method: thin 2 px lines, recessive grid, a legend plus direct
// end labels, crosshair + tooltip on hover; stacked bars with 2 px gaps; reference lines dashed and
// labelled in text ink. Every chart also has a table view (historyTable).
import type { GenSummary } from './data';
import { OPTIONS } from './data';

const css = (v: string): string => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const tip = (): HTMLElement => document.getElementById('tip')!;

function setup(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  // the LOGICAL height, read once: canvas.height below IS the height attribute, so reading it again
  // after scaling by the pixel ratio made the chart grow on every redraw
  const h = Number((canvas.dataset.h ??= canvas.getAttribute('height') ?? '150'));
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export function showTip(x: number, y: number, html: string): void {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const r = t.getBoundingClientRect();
  t.style.left = `${Math.min(window.innerWidth - r.width - 8, x + 14)}px`;
  t.style.top = `${Math.max(8, y - r.height - 10)}px`;
}
export const hideTip = (): void => {
  tip().hidden = true;
};

export interface Series<T> {
  label: string;
  color: string; // a CSS variable name or a hex colour
  get: (row: T) => number | null | undefined; // null: no point for this row
}
export interface RefLine {
  value: number;
  label: string;
}
const col = (c: string): string => (c.startsWith('--') ? css(c) : c);

/** a line chart over rows (generations, exams): 2 px lines, direct end labels, a crosshair tooltip */
export class LineChart<T> {
  private rows: T[] = [];
  private refs: RefLine[] = [];
  private hover = -1;
  constructor(
    private canvas: HTMLCanvasElement,
    legend: HTMLElement,
    private series: Series<T>[],
    private o: { unit: string; zeroBase?: boolean; xLabel: (r: T) => string; tip: (r: T) => string; empty?: string; digits?: number },
  ) {
    legend.innerHTML = series.map((s) => `<span><i style="background:${s.color.startsWith('--') ? `var(${s.color})` : s.color}"></i>${s.label}</span>`).join('');
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerleave', () => {
      this.hover = -1;
      hideTip();
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  set(rows: T[], refs: RefLine[] = this.refs): void {
    this.rows = rows;
    this.refs = refs;
    this.draw();
  }
  private v(r: T, s: Series<T>): number | null {
    const x = s.get(r);
    return x === null || x === undefined || !Number.isFinite(x) ? null : x;
  }
  private geom(w: number, h: number) {
    const L = 40;
    const R = 112; // room for direct end labels
    const T = 8;
    const B = 18;
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of this.rows)
      for (const s of this.series) {
        const x = this.v(r, s);
        if (x === null) continue;
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
    for (const r of this.refs) {
      lo = Math.min(lo, r.value);
      hi = Math.max(hi, r.value);
    }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    if (this.o.zeroBase) lo = Math.min(lo, 0);
    if (hi - lo < 1e-9) {
      lo -= 1;
      hi += 1;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const n = Math.max(1, this.rows.length - 1);
    const x = (i: number): number => (this.rows.length === 1 ? (L + w - R) / 2 : L + ((w - L - R) * i) / n);
    const y = (v: number): number => T + (h - T - B) * (1 - (v - lo) / (hi - lo));
    return { L, R, T, B, lo, hi, x, y, n };
  }
  draw(): void {
    const { ctx, w, h } = setup(this.canvas);
    const H = this.rows;
    const g = this.geom(w, h);
    const d = this.o.digits ?? 1;
    ctx.font = `11px ${css('--f-mono')}`;
    ctx.fillStyle = css('--smoke');
    ctx.strokeStyle = '#2c241c';
    ctx.lineWidth = 1;
    for (let k = 0; k <= 3; k++) {
      const v = g.lo + ((g.hi - g.lo) * k) / 3;
      const yy = Math.round(g.y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(g.L, yy);
      ctx.lineTo(w - g.R, yy);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(Math.abs(g.hi - g.lo) < 10 ? v.toFixed(1) : v.toFixed(0), g.L - 6, yy + 4);
    }
    for (const r of this.refs) {
      const yy = Math.round(g.y(r.value)) + 0.5;
      ctx.save();
      ctx.strokeStyle = css('--ash');
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(g.L, yy);
      ctx.lineTo(w - g.R, yy);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = css('--smoke');
      ctx.textAlign = 'left';
      ctx.fillText(r.label, g.L + 4, yy - 4);
    }
    if (!H.length) {
      ctx.fillStyle = css('--smoke');
      ctx.textAlign = 'center';
      ctx.fillText(this.o.empty ?? 'press Start — the first generation appears here', (w - g.R + g.L) / 2, h / 2);
      return;
    }
    ctx.fillStyle = css('--smoke');
    ctx.textAlign = 'left';
    ctx.fillText(this.o.xLabel(H[0]), g.L, h - 3);
    ctx.textAlign = 'right';
    if (H.length > 1) ctx.fillText(this.o.xLabel(H[H.length - 1]), w - g.R, h - 3);
    for (const s of this.series) {
      ctx.strokeStyle = col(s.color);
      ctx.fillStyle = col(s.color);
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let open = false;
      H.forEach((r, i) => {
        const v = this.v(r, s);
        if (v === null) {
          open = false;
          return;
        }
        if (open) ctx.lineTo(g.x(i), g.y(v));
        else ctx.moveTo(g.x(i), g.y(v));
        open = true;
      });
      ctx.stroke();
      if (H.length <= 40)
        H.forEach((r, i) => {
          const v = this.v(r, s);
          if (v === null) return;
          ctx.beginPath();
          ctx.arc(g.x(i), g.y(v), 2.5, 0, Math.PI * 2);
          ctx.fill();
        });
    }
    // direct labels at each series' last point
    const ends = this.series
      .map((s) => {
        for (let i = H.length - 1; i >= 0; i--) {
          const v = this.v(H[i], s);
          if (v !== null) return { s, v, y: g.y(v) };
        }
        return null;
      })
      .filter((q): q is { s: Series<T>; v: number; y: number } => !!q)
      .sort((a, b) => a.y - b.y);
    for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 12) ends[k].y = ends[k - 1].y + 12;
    ctx.textAlign = 'left';
    for (const { s, v, y } of ends) {
      ctx.fillStyle = col(s.color);
      ctx.fillRect(w - g.R + 6, y - 1, 8, 2);
      ctx.fillStyle = css('--wax');
      ctx.fillText(`${s.label} ${v.toFixed(d)}`, w - g.R + 17, y + 4);
    }
    if (this.hover >= 0 && this.hover < H.length) {
      const xx = g.x(this.hover);
      ctx.strokeStyle = css('--ash');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xx, g.T);
      ctx.lineTo(xx, h - g.B);
      ctx.stroke();
      for (const s of this.series) {
        const v = this.v(H[this.hover], s);
        if (v === null) continue;
        ctx.fillStyle = col(s.color);
        ctx.strokeStyle = css('--comb');
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(xx, g.y(v), 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }
  private move(e: PointerEvent): void {
    const H = this.rows;
    if (!H.length) return;
    const r = this.canvas.getBoundingClientRect();
    const g = this.geom(r.width, r.height);
    const i = H.length === 1 ? 0 : Math.max(0, Math.min(H.length - 1, Math.round(((e.clientX - r.left - g.L) / (r.width - g.L - g.R)) * g.n)));
    this.hover = i;
    const q = H[i];
    const d = this.o.digits ?? 1;
    showTip(e.clientX, e.clientY, `${this.o.tip(q)}<br>${this.series.map((s) => `${s.label} ${this.v(q, s)?.toFixed(d) ?? '—'}${this.o.unit}`).join('<br>')}`);
    this.draw();
  }
}

/** stacked 100 % bars per generation: how each generation's robots end, or what they choose */
export class StackChart {
  private hist: GenSummary[] = [];
  constructor(
    private canvas: HTMLCanvasElement,
    legend: HTMLElement,
    private parts: { label: string; color: string; get: (g: GenSummary) => number }[],
    private title: (g: GenSummary) => string,
  ) {
    legend.innerHTML = parts.map((d) => `<span><i class="box" style="background:${d.color.startsWith('--') ? `var(${d.color})` : d.color}"></i>${d.label}</span>`).join('');
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerleave', hideTip);
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  set(h: GenSummary[]): void {
    this.hist = h;
    this.draw();
  }
  private shown(w: number): GenSummary[] {
    return this.hist.slice(-Math.max(1, Math.floor(w / 3)));
  }
  draw(): void {
    const { ctx, w, h } = setup(this.canvas);
    const S = this.shown(w);
    if (!S.length) return;
    const bw = w / S.length;
    const gap = bw >= 6 ? 2 : 0;
    S.forEach((q, i) => {
      const vals = this.parts.map((p) => Math.max(0, p.get(q) || 0));
      const tot = vals.reduce((a, b) => a + b, 0) || 1;
      let y = h;
      this.parts.forEach((d, k) => {
        const hh = (h * vals[k]) / tot;
        if (hh <= 0) return;
        ctx.fillStyle = d.color.startsWith('--') ? css(d.color) : d.color;
        ctx.fillRect(i * bw, y - hh + (y < h ? gap : 0), Math.max(1, bw - gap), hh - (y < h ? gap : 0));
        y -= hh;
      });
    });
  }
  private move(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const S = this.shown(r.width);
    if (!S.length) return;
    const i = Math.max(0, Math.min(S.length - 1, Math.floor(((e.clientX - r.left) / r.width) * S.length)));
    const q = S[i];
    const vals = this.parts.map((p) => Math.max(0, p.get(q) || 0));
    const tot = vals.reduce((a, b) => a + b, 0) || 1;
    showTip(e.clientX, e.clientY, `<b>${this.title(q)}</b><br>${this.parts.map((d, k) => `${d.label} ${((100 * vals[k]) / tot).toFixed(0)}%`).join('<br>')}`);
  }
}

export const CHOICE_PARTS = OPTIONS.map((o, k) => ({ label: o.label, color: o.color, get: (g: GenSummary) => g.choices?.[k] ?? 0 }));

/** the table view (accessibility: every charted number, as text) */
export function historyTable(h: GenSummary[]): string {
  const rows = h.slice(-200).reverse();
  const f = (v: number | null | undefined, d = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));
  return `<table><thead><tr><th>gen</th><th>hours</th><th>lesson matches</th><th>lessons</th><th>choice regret</th><th>net regret before → after</th><th>champion</th><th>on fresh matches</th><th>exam</th><th>vs no-learning</th><th>thinking ahead</th></tr></thead><tbody>${rows
    .map(
      (q) =>
        `<tr><td>${q.gen}</td><td>${f(q.hours, 2)}</td><td>${f(q.meanScore)}</td><td>${q.lessons}</td><td>${f(q.regret)}</td><td>${q.fit ? `${f(q.fit.startRegret)} → ${f(q.fit.regret)}` : '—'}</td><td>#${q.champId}${q.newChamp ? ' new' : ''}</td><td>${f(q.champScore)} ± ${f(q.champCi)}</td><td>${q.exam ? f(q.exam.net.mean) : ''}</td><td>${q.exam ? `${q.exam.vsBase.mean >= 0 ? '+' : ''}${f(q.exam.vsBase.mean)}` : ''}</td><td>${q.exam?.search ? f(q.exam.search.mean) : ''}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}
