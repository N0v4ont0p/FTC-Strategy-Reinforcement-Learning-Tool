// Two canvas charts, built to the dataviz method: thin 2 px lines, recessive grid, a legend plus
// direct end labels, crosshair + tooltip on hover; stacked status bars with 2 px gaps.
import type { GenSummary } from './data';

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

const SERIES = [
  { key: 'best', label: 'best', color: '--s-best' },
  { key: 'mean', label: 'mean', color: '--s-mean' },
  { key: 'median', label: 'median', color: '--s-median' },
] as const;

export class FitnessChart {
  private hist: GenSummary[] = [];
  private hover = -1;
  constructor(private canvas: HTMLCanvasElement, legend: HTMLElement) {
    legend.innerHTML = SERIES.map((s) => `<span><i style="background:var(${s.color})"></i>${s.label} fitness</span>`).join('');
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerleave', () => {
      this.hover = -1;
      hideTip();
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  set(h: GenSummary[]): void {
    this.hist = h;
    this.draw();
  }
  private geom(w: number, h: number) {
    const L = 34;
    const R = 84; // room for direct end labels
    const T = 8;
    const B = 18;
    const H = this.hist;
    let lo = Infinity;
    let hi = -Infinity;
    for (const g of H) for (const s of SERIES) {
      lo = Math.min(lo, g[s.key]);
      hi = Math.max(hi, g[s.key]);
    }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    if (hi - lo < 1e-9) hi = lo + 1;
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
    // recessive grid + y ticks
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
      ctx.fillText(v.toFixed(0), g.L - 6, yy + 4);
    }
    ctx.textAlign = 'left';
    if (H.length) {
      ctx.fillText(`gen ${H[0].gen}`, g.L, h - 3);
      ctx.textAlign = 'right';
      ctx.fillText(`gen ${H[H.length - 1].gen}`, w - g.R, h - 3);
    } else {
      ctx.textAlign = 'center';
      ctx.fillText('the first generation is being evaluated…', w / 2, h / 2);
      return;
    }
    // lines
    for (const s of SERIES) {
      ctx.strokeStyle = css(s.color);
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      H.forEach((q, i) => (i ? ctx.lineTo(g.x(i), g.y(q[s.key])) : ctx.moveTo(g.x(i), g.y(q[s.key]))));
      ctx.stroke();
    }
    // direct end labels (text in text ink, a colored tick carries identity), nudged apart
    const last = H[H.length - 1];
    const ys = SERIES.map((s) => ({ s, y: g.y(last[s.key]) })).sort((a, b) => a.y - b.y);
    for (let k = 1; k < ys.length; k++) if (ys[k].y - ys[k - 1].y < 12) ys[k].y = ys[k - 1].y + 12;
    ctx.textAlign = 'left';
    for (const { s, y } of ys) {
      ctx.fillStyle = css(s.color);
      ctx.fillRect(w - g.R + 6, y - 1, 8, 2);
      ctx.fillStyle = css('--wax');
      ctx.fillText(`${s.label} ${last[s.key].toFixed(1)}`, w - g.R + 17, y + 4);
    }
    // crosshair
    if (this.hover >= 0 && this.hover < H.length) {
      const xx = g.x(this.hover);
      ctx.strokeStyle = css('--ash');
      ctx.beginPath();
      ctx.moveTo(xx, g.T);
      ctx.lineTo(xx, h - g.B);
      ctx.stroke();
      for (const s of SERIES) {
        ctx.fillStyle = css(s.color);
        ctx.strokeStyle = css('--comb');
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(xx, g.y(H[this.hover][s.key]), 4, 0, Math.PI * 2);
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
    showTip(e.clientX, e.clientY, `<b>generation ${q.gen}</b> <span class="t">(${q.stage === 'auto' ? 'AUTO only' : 'full match'})</span><br>best ${q.best.toFixed(1)} · mean ${q.mean.toFixed(1)} · median ${q.median.toFixed(1)}<br><span class="t">best DSIM score</span> ${q.bestScore}`);
    this.draw();
  }
}

const DEATHS = [
  { key: 'crash', label: 'crashed into the HIVE frame', color: '--st-crash' },
  { key: 'stall', label: 'stalled (20 s without progress)', color: '--st-stall' },
  { key: 'survived', label: 'lived the whole episode', color: '--st-survived' },
] as const;

export class DeathChart {
  private hist: GenSummary[] = [];
  constructor(private canvas: HTMLCanvasElement, legend: HTMLElement) {
    legend.innerHTML = DEATHS.map((d) => `<span><i class="box" style="background:var(${d.color})"></i>${d.label}</span>`).join('');
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
      const tot = q.deaths.crash + q.deaths.stall + q.deaths.survived || 1;
      let y = h;
      for (const d of DEATHS) {
        const hh = (h * q.deaths[d.key]) / tot;
        if (hh <= 0) continue;
        ctx.fillStyle = css(d.color);
        ctx.fillRect(i * bw, y - hh + (y < h ? gap : 0), Math.max(1, bw - gap), hh - (y < h ? gap : 0));
        y -= hh;
      }
    });
  }
  private move(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const S = this.shown(r.width);
    if (!S.length) return;
    const i = Math.max(0, Math.min(S.length - 1, Math.floor(((e.clientX - r.left) / r.width) * S.length)));
    const q = S[i];
    const tot = q.deaths.crash + q.deaths.stall + q.deaths.survived;
    showTip(e.clientX, e.clientY, `<b>generation ${q.gen}</b> · ${tot} robots<br>${DEATHS.map((d) => `${d.key} ${q.deaths[d.key]}`).join(' · ')}<br><span class="t">average life</span> ${q.meanLifeS.toFixed(1)} s`);
  }
}

/** the table view (accessibility: every charted number, as text) */
export function historyTable(h: GenSummary[]): string {
  const rows = h.slice(-200).reverse();
  return `<table><thead><tr><th>gen</th><th>stage</th><th>best</th><th>mean</th><th>median</th><th>score</th><th>crash</th><th>stall</th><th>lived</th></tr></thead><tbody>${rows
    .map((q) => `<tr><td>${q.gen}</td><td>${q.stage}</td><td>${q.best.toFixed(1)}</td><td>${q.mean.toFixed(1)}</td><td>${q.median.toFixed(1)}</td><td>${q.bestScore}</td><td>${q.deaths.crash}</td><td>${q.deaths.stall}</td><td>${q.deaths.survived}</td></tr>`)
    .join('')}</tbody></table>`;
}
