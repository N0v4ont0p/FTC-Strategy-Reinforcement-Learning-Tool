// THE FIELD — drawn by DSIM's own BIOBUZZ renderers (read-only imports), from the blue drivers' wall
// exactly as DSIM's camera does (translate → scale(s, −s) → rotate(viewAngle)).
//   · swarm: every robot of one generation from its recorded path — turrets, hopper, and a line to
//     what it chose to do next, coloured by the option
//   · focus: ONE life redrawn EXACTLY as it was trained — every element, the HIVE, the score —
//     from frames recorded inside the training episode itself (so forced misses are shown as they
//     happened; a DSIM replay can differ there)
import type { Artifact, RobotState, Vec2, World } from '../../dsim-main/src/types';
import { drawBiobuzzField, drawHiveCanopy } from '../../dsim-main/src/games/biobuzz/drawField';
import { drawBiobuzzRobot } from '../../dsim-main/src/games/biobuzz/drawRobot';
import { drawBiobuzzBalls } from '../../dsim-main/src/games/biobuzz/draw';
import { viewAngleOf } from '../../dsim-main/src/sim/field';
import { rot } from '../../dsim-main/src/math';
import { BB_HALF_X } from '../../dsim-main/src/games/biobuzz/config';
import { AUTO_START, OPTIONS, TRACK_FIELDS, TRACK_STRIDE, decodeTrack, type FocusFile, type Frames, type GenFile, type Individual } from './data';
import { color as css } from './ui';

const VIEW = viewAngleOf('blue');
/** world-space "screen up", exactly DSIM's Camera.screenUpWorld(): rot({0, 1}, −viewAngle) */
const UP: Vec2 = rot({ x: 0, y: 1 }, -VIEW);
const COLOR: Record<string, string> = { y: 'yellow', r: 'red', b: 'blue' };

interface Ghost {
  ind: Individual;
  path: Float32Array;
  spec: RobotState['spec'];
  shots: number[]; // ticks of shots that went in
}

export interface FrameInfo {
  mode: 'swarm' | 'focus';
  tick: number;
  end: number;
  alive: number;
  total: number;
  // focus only
  phase?: string;
  phaseLeft?: number;
  score?: number;
  hopper?: string;
  option?: string;
  optionKind?: number;
  tips?: number;
}

export class FieldView {
  private ctx: CanvasRenderingContext2D;
  private fieldLayer = document.createElement('canvas');
  private w = 0;
  private h = 0;
  private dpr = 1;
  private scale = 1;
  private field: World | null = null;
  private template: RobotState | null = null;
  private ghosts: Ghost[] = [];
  mode: 'swarm' | 'focus' = 'swarm';
  tick = AUTO_START;
  endTick = AUTO_START;
  speed = 4;
  gen: GenFile | null = null;
  /** nothing loaded yet: the field alone */
  empty = true;
  // THE LOOP: a frame is drawn only while a replay plays, or once after something changed (a seek, a
  // load, a resize) — never 60 times a second over a paused or empty field — and not at all while the
  // tab is hidden
  private raf = 0;
  private last = 0;
  private dirty = true;
  private _playing = false;
  get playing(): boolean {
    return this._playing;
  }
  set playing(v: boolean) {
    this._playing = v;
    if (v) this.kick();
  }
  // focus
  focus: FocusFile | null = null;
  private fw: World | null = null;
  private fi = -1; // index of the last applied frame
  private fr: Frames | null = null;
  private tipsAt: number[] = [];
  onFrame: (info: FrameInfo) => void = () => {};
  /** a replay reached its end and loops — the place to switch generations */
  onLoop: () => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    document.addEventListener('visibilitychange', () => {
      this.last = 0;
      if (!document.hidden) this.requestDraw();
    });
    this.resize();
  }

  /** draw once, on the next frame */
  requestDraw(): void {
    this.dirty = true;
    this.kick();
  }
  private kick(): void {
    if (this.raf || document.hidden) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }
  private frame(now: number): void {
    this.raf = 0;
    const dt = this.last ? Math.min(100, now - this.last) : 1000 / 60;
    this.last = now;
    if (this._playing) this.step(dt);
    if (this._playing || this.dirty) {
      this.dirty = false;
      this.draw();
    }
    if (this._playing) this.kick();
    else this.last = 0;
  }

  setField(w: World): void {
    this.field = w;
    this.template = structuredClone(w.robots[0]);
    this.template.hopper = [];
    this.renderFieldLayer();
    this.requestDraw();
  }

  private resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.scale = Math.min(this.w, this.h) / (2 * (BB_HALF_X + 3));
    this.renderFieldLayer();
    this.requestDraw();
  }

  private apply(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.w / 2, this.h / 2);
    ctx.scale(this.scale, -this.scale);
    ctx.rotate(VIEW);
  }

  /** the static field (mat, tape, HIVE, FLOWERS, staged elements) once per resize — swarm backdrop */
  private renderFieldLayer(): void {
    if (!this.field || !this.w) return;
    this.fieldLayer.width = this.canvas.width;
    this.fieldLayer.height = this.canvas.height;
    const c = this.fieldLayer.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.fieldLayer.width, this.fieldLayer.height);
    this.apply(c);
    drawBiobuzzField(c, this.field, UP);
  }

  // ─────────────────────────────── loading ───────────────────────────────
  loadGeneration(g: GenFile): void {
    this.gen = g;
    this.mode = 'swarm';
    const base = this.template!;
    this.ghosts = g.individuals.map((ind) => {
      const spec = { ...base.spec };
      if (ind.point['spec.length']) spec.length = ind.point['spec.length'];
      if (ind.point['spec.width']) spec.width = ind.point['spec.width'];
      return { ind, path: decodeTrack(ind.track), spec, shots: (ind.events ?? []).filter((e) => e[1] === 'shotIn').map((e) => e[0]) };
    });
    this.endTick = Math.max(AUTO_START + 60, ...this.ghosts.map((q) => q.ind.deathTick)) + 60;
    this.tick = AUTO_START;
    this.empty = false;
    this.requestDraw();
  }

  loadFocus(f: FocusFile): void {
    this.focus = f;
    this.fr = f.frames;
    this.mode = 'focus';
    this.tipsAt = f.events.filter((e) => e[1] === 'tip').map((e) => e[0]);
    this.resetFocus();
    this.tick = f.frames.f[0]?.t ?? 0;
    this.endTick = f.frames.f[f.frames.f.length - 1]?.t ?? 0;
    this.seekFocus(this.tick);
    this.empty = false;
    this.requestDraw();
  }

  private resetFocus(): void {
    const fr = this.fr!;
    const w = structuredClone(this.field!);
    const r = w.robots[0];
    r.spec = fr.spec as RobotState['spec'];
    r.hopper = [];
    // a match with an alliance partner: a second robot, its build from the frames
    w.robots.length = 1;
    if (fr.spec2) w.robots.push({ ...structuredClone(r), id: 1, spec: fr.spec2 as RobotState['spec'], hopper: [] });
    // …and a red alliance (phase 5 opponents)
    (fr.oppSpecs ?? []).forEach((s, i) => w.robots.push({ ...structuredClone(r), id: 2 + i, alliance: 'red', spec: s as RobotState['spec'], hopper: [] }));
    w.balls = fr.meta.map(([id, color, rad]) => {
      const b = { id, color, pos: { x: 0, y: 0 }, z: 0, vel: { x: 0, y: 0 }, vz: 0, state: { kind: 'ground' } } as unknown as Artifact & { r?: number };
      if (rad !== null) b.r = rad;
      return b;
    });
    this.fw = w;
    this.fi = -1;
  }

  /** apply recorded frames up to tick t (going backwards re-applies from the start) */
  private seekFocus(t: number): void {
    const fr = this.fr!;
    if (this.fi >= 0 && fr.f[this.fi].t > t) this.resetFocus();
    const w = this.fw!;
    const r = w.robots[0];
    while (this.fi + 1 < fr.f.length && fr.f[this.fi + 1].t <= t) {
      const q = fr.f[++this.fi];
      r.pos = { x: q.r[0], y: q.r[1] };
      r.heading = q.r[2];
      r.turretHeading = q.r[3];
      r.bbTurret2Heading = q.r[4];
      r.bbTurretPitch = q.r[5];
      r.bbTurret2Pitch = q.r[6];
      r.hopper = [...q.h].map((c) => COLOR[c] ?? 'yellow') as RobotState['hopper'];
      const p2 = w.robots[1];
      if (p2 && q.p) {
        p2.pos = { x: q.p[0], y: q.p[1] };
        p2.heading = q.p[2];
        p2.turretHeading = q.p[3];
        p2.bbTurret2Heading = q.p[4];
        p2.bbTurretPitch = q.p[5];
        p2.bbTurret2Pitch = q.p[6];
        p2.hopper = [...(q.ph ?? '')].map((c) => COLOR[c] ?? 'yellow') as RobotState['hopper'];
      }
      q.opp?.forEach((o, i) => {
        const x = w.robots.find((z) => z.id === 2 + i);
        if (!x) return;
        x.pos = { x: o[0], y: o[1] };
        x.heading = o[2];
        x.turretHeading = o[3];
        x.bbTurret2Heading = o[4];
        x.bbTurretPitch = o[5];
        x.bbTurret2Pitch = o[6];
        x.hopper = [...(q.oh?.[i] ?? '')].map((c) => COLOR[c] ?? 'yellow') as RobotState['hopper'];
      });
      for (let i = 0; i < w.balls.length && 3 * i + 2 < q.b.length; i++) {
        const b = w.balls[i];
        b.pos = { x: q.b[3 * i], y: q.b[3 * i + 1] };
        b.z = q.b[3 * i + 2];
      }
      for (const [i, st] of q.s ?? []) if (w.balls[i]) w.balls[i].state = st as Artifact['state'];
      if (q.g) (w as unknown as { biobuzz: unknown }).biobuzz = structuredClone(q.g);
      w.tick = q.t;
    }
  }

  /** jump to a tick */
  seek(t: number): void {
    this.tick = Math.max(0, Math.min(this.endTick, t));
    if (this.mode === 'focus' && this.fr) this.seekFocus(this.tick);
    this.requestDraw();
  }

  /** the start of the replay (the swarm starts at AUTO; exact frames at their first frame) */
  get startTick(): number {
    return this.mode === 'swarm' ? AUTO_START : (this.fr?.f[0]?.t ?? 0);
  }

  /** advance by one animation frame. `loop` (LIVE) wraps and calls onLoop; otherwise (a replay you
   * analyse) it stops on the last frame and calls onEnd. Real match time: 60 ticks a second × speed. */
  step(dtMs: number): void {
    if (!this._playing) return;
    this.acc += (dtMs / 1000) * 60 * this.speed;
    const ticks = Math.floor(this.acc);
    if (ticks < 1) return;
    this.acc -= ticks;
    this.tick += ticks;
    if (this.tick > this.endTick) {
      if (this.loop) {
        this.tick = this.startTick;
        if (this.mode === 'focus') this.resetFocus();
        this.onLoop();
      } else {
        this.tick = this.endTick;
        this._playing = false;
        this.onEnd();
      }
    }
    if (this.mode === 'focus' && this.fr) this.seekFocus(this.tick);
  }
  private acc = 0;
  /** LIVE loops; a replay stops at its end */
  loop = true;
  onEnd: () => void = () => {};

  // ─────────────────────────────── drawing ───────────────────────────────
  draw(): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.mode === 'focus' && !this.empty) return this.drawFocus();
    if (this.fieldLayer.width && this.fieldLayer.height) ctx.drawImage(this.fieldLayer, 0, 0); // not before the first resize
    if (!this.gen || !this.template) return;
    this.apply(ctx);
    const T = this.tick;
    const n = this.ghosts.length;
    let alive = 0;
    const r = this.template;
    const lines = Math.min(n, 24); // the top robots show what they are going for
    // back to front: weakest first, the generation's best last (on top)
    for (let k = n - 1; k >= 0; k--) {
      const g = this.ghosts[k];
      const p = sampleAt(g.path, Math.min(T, g.ind.deathTick));
      if (!p) continue;
      if (T <= g.ind.deathTick) {
        alive++;
        const a = k === 0 ? 1 : k < Math.max(3, n * 0.1) ? 0.75 : 0.3;
        if (k < lines) this.intent(g, p, T, a);
        r.pos = { x: p[0], y: p[1] };
        r.heading = p[2];
        r.turretHeading = p[3];
        r.bbTurret2Heading = p[4];
        r.hopper = Array.from({ length: Math.round(p[5]) }, () => 'yellow') as RobotState['hopper'];
        r.spec = g.spec;
        ctx.save();
        ctx.globalAlpha = a;
        if (k === 0) this.halo(p);
        drawBiobuzzRobot(ctx, r, false, [], UP);
        ctx.restore();
        if (g.shots.some((s) => s <= T && T - s < 12)) this.flash(p, a);
      } else if (g.ind.death !== 'survived' && T - g.ind.deathTick < 120) {
        this.deathMark(p, g.ind.death, 1 - (T - g.ind.deathTick) / 120);
      }
    }
    if (this.ghosts[0]) this.trail(this.ghosts[0], T);
    if (this.field) drawHiveCanopy(ctx, this.field);
    this.onFrame({ mode: 'swarm', alive, total: n, tick: T, end: this.endTick });
  }

  /** a thin line from the robot to what it is going for, in that option's colour */
  private intent(g: Ghost, p: ArrayLike<number>, T: number, a: number): void {
    const d = g.ind.decisions;
    if (!d?.length) return;
    let lo = 0;
    let hi = d.length - 1;
    if (d[0][0] > T) return;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (d[m][0] <= T) lo = m;
      else hi = m - 1;
    }
    // a human-player press happens alongside the robot's job: show the job it is doing
    while (lo > 0 && d[lo][1] === 4) lo--;
    const q = d[lo];
    const opt = OPTIONS[q[1]];
    if (!opt) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = a * 0.9;
    ctx.strokeStyle = opt.color;
    ctx.fillStyle = opt.color;
    ctx.lineWidth = 0.6;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(q[2], q[3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(q[2], q[3], 1.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private flash(p: ArrayLike<number>, a: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = css('--pollen-hi');
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private halo(p: ArrayLike<number>): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = css('--pollen');
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private trail(g: Ghost, T: number): void {
    const ctx = this.ctx;
    const F = TRACK_FIELDS;
    const end = Math.min(T, g.ind.deathTick);
    const i1 = Math.floor(end / TRACK_STRIDE) - 1;
    const i0 = Math.max(0, i1 - 100);
    if (i1 <= i0) return;
    ctx.save();
    ctx.strokeStyle = css('--pollen');
    ctx.lineWidth = 0.9;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    for (let i = i0; i <= i1 && F * i + 1 < g.path.length; i++) {
      if (i === i0) ctx.moveTo(g.path[F * i], g.path[F * i + 1]);
      else ctx.lineTo(g.path[F * i], g.path[F * i + 1]);
    }
    ctx.stroke();
    ctx.restore();
  }

  private deathMark(p: ArrayLike<number>, kind: string, a: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = Math.max(0, a);
    if (kind === 'crash') {
      ctx.strokeStyle = css('--st-crash');
      ctx.lineWidth = 1.6;
      const s = 4 + 3 * (1 - a);
      ctx.beginPath();
      ctx.moveTo(p[0] - s, p[1] - s);
      ctx.lineTo(p[0] + s, p[1] + s);
      ctx.moveTo(p[0] - s, p[1] + s);
      ctx.lineTo(p[0] + s, p[1] - s);
      ctx.stroke();
    } else {
      ctx.strokeStyle = css('--st-stall');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 3 + 4 * (1 - a), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawFocus(): void {
    const ctx = this.ctx;
    const w = this.fw;
    const fr = this.fr;
    if (!w || !fr || this.fi < 0) return;
    this.apply(ctx);
    drawBiobuzzField(ctx, w, UP);
    const q = fr.f[this.fi];
    // what it is going for
    if (q.o) {
      const opt = OPTIONS[q.o[0]];
      if (opt) {
        const r0 = w.robots[0];
        ctx.save();
        ctx.strokeStyle = opt.color;
        ctx.fillStyle = opt.color;
        ctx.lineWidth = 0.9;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.moveTo(r0.pos.x, r0.pos.y);
        ctx.lineTo(q.o[2], q.o[3]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(q.o[2], q.o[3], 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    for (const r of w.robots) {
      const held = w.balls.filter((b) => b.state.kind === 'held' && (b.state as { robot: number }).robot === r.id);
      drawBiobuzzRobot(ctx, r, r.id === 0 ? q.r[7] === 1 : r.id === 1 ? (q.p?.[7] ?? 0) === 1 : false, held, UP, w);
    }
    drawBiobuzzBalls(ctx, w, UP);
    drawHiveCanopy(ctx, w);
    this.onFrame({
      mode: 'focus',
      alive: 1,
      total: 1,
      tick: q.t,
      end: this.endTick,
      phase: q.m[0],
      phaseLeft: q.m[1],
      score: Math.max(0, q.m[2] - q.m[3]),
      hopper: q.h,
      option: q.o?.[1],
      optionKind: q.o?.[0],
      tips: this.tipsAt.filter((t) => t <= q.t).length,
    });
  }
}

/** interpolated sample at tick t from a track sampled every TRACK_STRIDE ticks (first = tick 3) */
function sampleAt(path: Float32Array, t: number): number[] | null {
  const F = TRACK_FIELDS;
  const n = path.length / F;
  if (n === 0) return null;
  const f = t / TRACK_STRIDE - 1;
  const i = Math.max(0, Math.min(n - 1, Math.floor(f)));
  const j = Math.min(n - 1, i + 1);
  const a = Math.max(0, Math.min(1, f - i));
  const lerpA = (k: number): number => {
    const h0 = path[F * i + k];
    return h0 + Math.atan2(Math.sin(path[F * j + k] - h0), Math.cos(path[F * j + k] - h0)) * a;
  };
  return [
    path[F * i] + (path[F * j] - path[F * i]) * a,
    path[F * i + 1] + (path[F * j + 1] - path[F * i + 1]) * a,
    lerpA(2),
    lerpA(3),
    lerpA(4),
    path[F * i + 5],
    path[F * i + 6],
  ];
}
