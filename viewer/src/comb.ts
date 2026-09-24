// THE HONEYCOMB — every generation so far as one hex cell, filled on a single-hue honey ramp by its
// best DSIM score (validated ordinal ramp, brighter = higher). Past ~8 rows, one cell covers several
// generations (their max). Click a cell to replay that generation's swarm.
import { hideTip, showTip } from './charts';
import type { GenSummary } from './data';

const RAMP = ['#7a3f0b', '#b86b16', '#e9a23b', '#f6d38a']; // validated: monotone, one hue, light end ≥ 2:1
function honey(t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const a = RAMP[i].match(/\w\w/g)!.map((h) => parseInt(h, 16));
  const b = RAMP[i + 1].match(/\w\w/g)!.map((h) => parseInt(h, 16));
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`;
}

export class Comb {
  private hist: GenSummary[] = [];
  private onDisk = new Set<number>();
  private cells: { x: number; y: number; g0: number; g1: number; score: number; best: number }[] = [];
  private R = 9;
  selected = -1;
  onPick: (gen: number) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerleave', hideTip);
    canvas.addEventListener('click', (e) => {
      const c = this.hit(e);
      if (!c) return;
      const g = [...this.onDisk].filter((q) => q >= c.g0 && q <= c.g1).pop();
      if (g !== undefined) this.onPick(g);
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  set(h: GenSummary[], onDisk: number[]): void {
    this.hist = h;
    this.onDisk = new Set(onDisk);
    this.draw();
  }

  draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const R = this.R;
    const dx = Math.sqrt(3) * R;
    const dy = 1.5 * R;
    const cols = Math.max(1, Math.floor((w - dx / 2) / dx));
    const maxRows = 8;
    const per = Math.max(1, Math.ceil(this.hist.length / (cols * maxRows)));
    const nCells = Math.ceil(this.hist.length / per);
    const rows = Math.max(1, Math.ceil(nCells / cols));
    const h = Math.ceil(rows * dy + R + 4);
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const top = Math.max(1, ...this.hist.map((q) => q.bestScore));
    this.cells = [];
    for (let c = 0; c < nCells; c++) {
      const slice = this.hist.slice(c * per, (c + 1) * per);
      const score = Math.max(...slice.map((q) => q.bestScore));
      const best = slice.reduce((a, q) => a + q.meanScore, 0) / slice.length;
      const row = Math.floor(c / cols);
      const col = c % cols;
      const x = dx / 2 + col * dx + (row % 2 ? dx / 2 : 0);
      const y = R + 2 + row * dy;
      this.cells.push({ x, y, g0: slice[0].gen, g1: slice[slice.length - 1].gen, score, best });
      const has = slice.some((q) => this.onDisk.has(q.gen));
      hex(ctx, x, y, R - 1);
      ctx.fillStyle = honey(score / top);
      ctx.globalAlpha = has ? 1 : 0.35;
      ctx.fill();
      ctx.globalAlpha = 1;
      const isSel = this.selected >= slice[0].gen && this.selected <= slice[slice.length - 1].gen;
      const isLast = c === nCells - 1;
      if (isSel || isLast) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = isSel ? '#efe6d2' : '#f6d38a';
        ctx.stroke();
      }
    }
    if (!nCells) {
      ctx.fillStyle = '#a89c8a';
      ctx.font = '12px Avenir Next, sans-serif';
      ctx.fillText('The comb fills in one cell per generation as training runs.', 4, 16);
    }
  }

  private hit(e: PointerEvent | MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best: (typeof this.cells)[number] | null = null;
    let bd = this.R * this.R;
    for (const c of this.cells) {
      const d = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  private move(e: PointerEvent): void {
    const c = this.hit(e);
    if (!c) return hideTip();
    const range = c.g0 === c.g1 ? `generation ${c.g0}` : `generations ${c.g0}–${c.g1} (best of the group)`;
    const disk = [...this.onDisk].some((q) => q >= c.g0 && q <= c.g1);
    showTip(e.clientX, e.clientY, `<b>${range}</b><br>the champion's lesson matches: best ${c.score} · mean ${c.best.toFixed(1)} DSIM points<br><span class="t">${disk ? 'click to replay this swarm' : 'paths pruned from disk (the last 300 and every 100th are kept)'}</span>`);
  }
}

function hex(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 3) * k + Math.PI / 6;
    const px = x + r * Math.cos(a);
    const py = y + r * Math.sin(a);
    if (k) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  }
  ctx.closePath();
}
