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

export interface Series {
  key: keyof GenSummary;
  label: string;
  color: string; // a CSS variable name
}
export interface RefLine {
  value: number;
  label: string;
}

export class LineChart {
  private hist: GenSummary[] = [];
  private refs: RefLine[] = [];
  private hover = -1;
  constructor(
    private canvas: HTMLCanvasElement,
    legend: HTMLElement,
    private series: Series[],
    private unit: string,
    private zeroBase = false, // the axis starts at 0 (scores)
  ) {
    legend.innerHTML = series.map((s) => `<span><i style="background:var(${s.color})"></i>${s.label}</span>`).join('');
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerleave', () => {
      this.hover = -1;
      hideTip();
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  set(h: GenSummary[], refs: RefLine[] = this.refs): void {
    this.hist = h;
    this.refs = refs;
    this.draw();
  }
  private val(g: GenSummary, s: Series): number {
    return Number(g[s.key]);
  }
  private geom(w: number, h: number) {
    const L = 40;
    const R = 96; // room for direct end labels
    const T = 8;
    const B = 18;
    const H = this.hist;
    let lo = Infinity;
    let hi = -Infinity;
    for (const g of H)
      for (const s of this.series) {
        lo = Math.min(lo, this.val(g, s));
        hi = Math.max(hi, this.val(g, s));
      }
    for (const r of this.refs) {
      lo = Math.min(lo, r.value);
      hi = Math.max(hi, r.value);
    }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    if (this.zeroBase) lo = Math.min(lo, 0);
    if (hi - lo < 1e-9) {
      lo -= 1;
      hi += 1;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const n = Math.max(1, H.length - 1);
    const x = (i: number): number => L + ((w - L - R) * i) / n;
    const y = (v: number): number => T + (h - T - B) * (1 - (v - lo) / (hi - lo));
    return { L, R, T, B, lo, hi, x, y, n };
  }
  draw(): void {
    const { ctx, w, h } = setup(this.canvas);
    const H = this.hist;
    const g = this.geom(w, h);
    ctx.font = `11px ${css('--f-mono')}`;
    ctx.fillStyle = css('--smoke');
    if (!H.length && !this.refs.length) {
      ctx.textAlign = 'center';
      ctx.fillText('press Start — the first generation appears here', w / 2, h / 2);
      return;
    }
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
      ctx.fillText(v.toFixed(0), g.L - 6, yy + 4);
    }
    // reference lines: dashed, labelled in text ink
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
    ctx.fillStyle = css('--smoke');
    ctx.textAlign = 'left';
    if (!H.length) {
      ctx.textAlign = 'center';
      ctx.fillText('press Start — the first generation appears here', (w - g.R + g.L) / 2, h / 2);
      return;
    }
    ctx.fillText(`gen ${H[0].gen}`, g.L, h - 3);
    ctx.textAlign = 'right';
    ctx.fillText(`gen ${H[H.length - 1].gen}`, w - g.R, h - 3);
    for (const s of this.series) {
      ctx.strokeStyle = css(s.color);
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      H.forEach((q, i) => (i ? ctx.lineTo(g.x(i), g.y(this.val(q, s))) : ctx.moveTo(g.x(i), g.y(this.val(q, s)))));
      ctx.stroke();
    }
    const last = H[H.length - 1];
    const ys = this.series.map((s) => ({ s, y: g.y(this.val(last, s)) })).sort((a, b) => a.y - b.y);
    for (let k = 1; k < ys.length; k++) if (ys[k].y - ys[k - 1].y < 12) ys[k].y = ys[k - 1].y + 12;
    ctx.textAlign = 'left';
    for (const { s, y } of ys) {
      ctx.fillStyle = css(s.color);
      ctx.fillRect(w - g.R + 6, y - 1, 8, 2);
      ctx.fillStyle = css('--wax');
      ctx.fillText(`${s.label} ${this.val(last, s).toFixed(1)}`, w - g.R + 17, y + 4);
    }
    if (this.hover >= 0 && this.hover < H.length) {
      const xx = g.x(this.hover);
      ctx.strokeStyle = css('--ash');
      ctx.beginPath();
      ctx.moveTo(xx, g.T);
      ctx.lineTo(xx, h - g.B);
      ctx.stroke();
      for (const s of this.series) {
        ctx.fillStyle = css(s.color);
        ctx.strokeStyle = css('--comb');
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(xx, g.y(this.val(H[this.hover], s)), 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }
  private move(e: PointerEvent): void {
    const H = this.hist;
    if (!H.length) return;
    const r = this.canvas.getBoundingClientRect();
    const g = this.geom(r.width, r.height);
    const i = Math.max(0, Math.min(H.length - 1, Math.round(((e.clientX - r.left - g.L) / (r.width - g.L - g.R)) * g.n)));
    this.hover = i;
    const q = H[i];
    showTip(
      e.clientX,
      e.clientY,
      `<b>generation ${q.gen}</b><br>${this.series.map((s) => `${s.label} ${this.val(q, s).toFixed(1)}${this.unit}`).join(' · ')}<br><span class="t">best robot made by</span> ${q.bestOp ?? '—'}`,
    );
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

export const DEATH_PARTS = [
  { label: 'crashed into the HIVE frame', color: '--st-crash', get: (g: GenSummary) => g.deaths.crash },
  { label: 'stalled (20 s without progress)', color: '--st-stall', get: (g: GenSummary) => g.deaths.stall },
  { label: 'lived the whole match', color: '--st-survived', get: (g: GenSummary) => g.deaths.survived },
];
export const CHOICE_PARTS = OPTIONS.map((o, k) => ({ label: o.label, color: o.color, get: (g: GenSummary) => g.choices?.[k] ?? 0 }));

/** the table view (accessibility: every charted number, as text) */
export function historyTable(h: GenSummary[]): string {
  const rows = h.slice(-200).reverse();
  return `<table><thead><tr><th>gen</th><th>best fit</th><th>mean fit</th><th>best score</th><th>mean score</th><th>tips</th><th>crash</th><th>stall</th><th>lived</th><th>best made by</th></tr></thead><tbody>${rows
    .map(
      (q) =>
        `<tr><td>${q.gen}</td><td>${q.best.toFixed(1)}</td><td>${q.mean.toFixed(1)}</td><td>${q.bestScore}</td><td>${q.meanScore.toFixed(1)}</td><td>${(q.meanTips ?? 0).toFixed(1)}</td><td>${q.deaths.crash}</td><td>${q.deaths.stall}</td><td>${q.deaths.survived}</td><td>${q.bestOp ?? ''}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}
