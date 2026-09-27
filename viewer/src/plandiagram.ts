// PLAN DIAGRAMS — an AUTO plan on DSIM's own field drawing (read-only renderers, the blue drivers'
// view exactly as the studio shows it): each robot's path from its exact replay, where it started
// and ended, and a numbered marker where each step of the plan began. Used by the Playbook tab and
// the printable playbook; the robot preview (Robot tab) draws a build and its shooting envelope.
import type { RobotState, Vec2, World } from '../../dsim-main/src/types';
import { drawBiobuzzField } from '../../dsim-main/src/games/biobuzz/drawField';
import { drawBiobuzzRobot } from '../../dsim-main/src/games/biobuzz/drawRobot';
import { viewAngleOf } from '../../dsim-main/src/sim/field';
import { rot } from '../../dsim-main/src/math';
import type { Frames } from './data';

const VIEW = viewAngleOf('blue');
const UP: Vec2 = rot({ x: 0, y: 1 }, -VIEW);
export const PLAN_COLORS = { ours: '#f6b73c', partner: '#7cc4ff', step: '#15110d' };

export interface StepMark {
  robot: number;
  tick: number;
  end?: number;
  label: string;
}

/** a canvas sized for `css` px at `dpr`, its context set to the field transform (world inches) */
function setup(canvas: HTMLCanvasElement, css: number, dpr: number, span = 72 + 4): { ctx: CanvasRenderingContext2D; s: number } {
  canvas.width = Math.round(css * dpr);
  canvas.height = Math.round(css * dpr);
  canvas.style.width = `${css}px`;
  canvas.style.height = `${css}px`;
  const ctx = canvas.getContext('2d')!;
  const s = css / (2 * span);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0e0b08';
  ctx.fillRect(0, 0, css, css);
  ctx.translate(css / 2, css / 2);
  ctx.scale(s, -s);
  ctx.rotate(VIEW);
  return { ctx, s };
}
/** a world point → canvas pixels (for text, which must not be mirrored) */
const toPx = (ctx: CanvasRenderingContext2D, x: number, y: number): DOMPoint => ctx.getTransform().transformPoint(new DOMPoint(x, y));

function robotAt(field: World, spec: unknown, x: number, y: number, h: number, t1 = h, t2 = h + Math.PI, alliance: 'blue' | 'red' = 'blue'): RobotState {
  const r = structuredClone(field.robots[0]);
  r.spec = spec as RobotState['spec'];
  r.alliance = alliance;
  r.pos = { x, y };
  r.heading = h;
  r.turretHeading = t1;
  r.bbTurret2Heading = t2;
  r.hopper = [];
  return r;
}

function path(ctx: CanvasRenderingContext2D, pts: [number, number][], color: string, width: number, dash: number[] = []): void {
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
  ctx.stroke();
  // direction: a small chevron every ~30 in
  ctx.setLineDash([]);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    const d = Math.hypot(dx, dy);
    acc += d;
    if (acc < 30 || d < 0.2) continue;
    acc = 0;
    const a = Math.atan2(dy, dx);
    const [x, y] = pts[i];
    ctx.beginPath();
    ctx.moveTo(x - 3 * Math.cos(a - 0.55), y - 3 * Math.sin(a - 0.55));
    ctx.lineTo(x, y);
    ctx.lineTo(x - 3 * Math.cos(a + 0.55), y - 3 * Math.sin(a + 0.55));
    ctx.stroke();
  }
  ctx.restore();
}

/** an AUTO plan: paths, start and end poses, numbered steps */
export function drawPlan(canvas: HTMLCanvasElement, field: World, fr: Frames, steps: StepMark[], o: { css?: number; dpr?: number } = {}): void {
  const css = o.css ?? 360;
  const dpr = o.dpr ?? window.devicePixelRatio ?? 1;
  const { ctx, s } = setup(canvas, css, dpr);
  const w = structuredClone(field);
  drawBiobuzzField(ctx, w, UP);
  const f = fr.f.filter((q) => q.m[0] === 'auto' || q.m[0] === 'pre');
  const px = 1 / s; // one css pixel in inches
  // the planned stretch bold, what a robot does by itself afterwards faint (no plan: all of it plain)
  for (const robot of [1, 0]) {
    const mine = steps.filter((st) => st.robot === robot);
    const planEnd = mine.length ? Math.max(...mine.map((st) => st.end ?? st.tick)) : -1;
    const pts = (a: typeof f): [number, number][] => a.filter((q) => robot === 0 || q.p).map((q) => (robot === 0 ? [q.r[0], q.r[1]] : [q.p![0], q.p![1]]) as [number, number]);
    const color = robot === 0 ? PLAN_COLORS.ours : PLAN_COLORS.partner;
    const dash = robot === 0 ? [] : [5 * px, 3.5 * px];
    const planned = pts(f.filter((q) => q.t <= planEnd));
    const after = pts(f.filter((q) => q.t >= planEnd));
    ctx.save();
    ctx.globalAlpha = planEnd < 0 ? 0.8 : 0.35;
    path(ctx, after, color, 1.4 * px, dash);
    ctx.restore();
    path(ctx, planned, color, 3 * px, dash);
  }
  const first = f[0];
  const last = f[f.length - 1];
  if (first) {
    if (first.p && fr.spec2) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      drawBiobuzzRobot(ctx, robotAt(w, fr.spec2, first.p[0], first.p[1], first.p[2], first.p[3], first.p[4]), false, [], UP, w);
      ctx.restore();
    }
    drawBiobuzzRobot(ctx, robotAt(w, fr.spec, first.r[0], first.r[1], first.r[2], first.r[3], first.r[4]), false, [], UP, w);
  }
  if (last && last !== first) {
    ctx.save();
    ctx.globalAlpha = 0.45;
    drawBiobuzzRobot(ctx, robotAt(w, fr.spec, last.r[0], last.r[1], last.r[2], last.r[3], last.r[4]), false, [], UP, w);
    if (last.p && fr.spec2) drawBiobuzzRobot(ctx, robotAt(w, fr.spec2, last.p[0], last.p[1], last.p[2], last.p[3], last.p[4]), false, [], UP, w);
    ctx.restore();
  }
  // numbered steps where each began (text drawn unmirrored, in pixels)
  const marks = steps.map((st, i) => {
    const q = f.find((z) => z.t >= st.tick) ?? last;
    const xy = st.robot === 0 ? [q.r[0], q.r[1]] : q.p ? [q.p[0], q.p[1]] : null;
    return xy ? { i, robot: st.robot, p: toPx(ctx, xy[0], xy[1]) } : null;
  });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const R = 8.5 * dpr;
  for (const m of marks) {
    if (!m) continue;
    ctx.beginPath();
    ctx.arc(m.p.x, m.p.y, R, 0, Math.PI * 2);
    ctx.fillStyle = m.robot === 0 ? PLAN_COLORS.ours : PLAN_COLORS.partner;
    ctx.fill();
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = '#0e0b08';
    ctx.stroke();
    ctx.fillStyle = PLAN_COLORS.step;
    ctx.font = `700 ${10 * dpr}px 'Avenir Next', 'Segoe UI', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(m.i + 1), m.p.x, m.p.y + 0.5 * dpr);
  }
}

/** a build, big, front up: nominal footprint solid, the range's smallest and largest dashed */
export function drawBuild(canvas: HTMLCanvasElement, field: World, spec: unknown, small: { length: number; width: number }, big: { length: number; width: number }, css = 200): void {
  const dpr = window.devicePixelRatio || 1;
  const L = Math.max(big.length, big.width) * 0.95;
  const { ctx, s } = setup(canvas, css, dpr, L);
  ctx.fillStyle = '#1d1813';
  ctx.fillRect(-2 * L, -2 * L, 4 * L, 4 * L);
  const up = Math.atan2(UP.y, UP.x);
  const box = (l: number, wd: number, dash: number[], color: string): void => {
    ctx.save();
    ctx.rotate(up);
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2 / s;
    ctx.strokeRect(-l / 2, -wd / 2, l, wd);
    ctx.restore();
  };
  box(big.length, big.width, [4 / s, 3 / s], '#e9a23b');
  box(small.length, small.width, [1.5 / s, 2.5 / s], '#a89c8a');
  const w = structuredClone(field);
  drawBiobuzzRobot(ctx, robotAt(w, spec, 0, 0, up, up, up + Math.PI), true, [], UP, w);
}

/** the whole field with a build's shooting envelope: every 2-in spot a shot goes in from */
export function drawEnvelope(canvas: HTMLCanvasElement, field: World, spec: unknown, spots: { north: Vec2[]; south: Vec2[] }, start: { x: number; y: number; h: number } | null, css = 200): void {
  const dpr = window.devicePixelRatio || 1;
  const { ctx } = setup(canvas, css, dpr);
  const w = structuredClone(field);
  drawBiobuzzField(ctx, w, UP);
  const paint = (pts: Vec2[], color: string): void => {
    ctx.fillStyle = color;
    for (const p of pts) ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
  };
  paint(spots.north, 'rgba(124, 196, 255, 0.55)');
  paint(spots.south, 'rgba(246, 183, 60, 0.55)');
  if (start) drawBiobuzzRobot(ctx, robotAt(w, spec, start.x, start.y, start.h), false, [], UP, w);
}
