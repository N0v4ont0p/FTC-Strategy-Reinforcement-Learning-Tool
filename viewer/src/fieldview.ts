// THE FIELD — drawn by DSIM's own BIOBUZZ renderers (read-only imports), from the blue drivers' wall
// exactly as DSIM's camera does (translate → scale(s, −s) → rotate(viewAngle)).
//   · swarm mode: every robot of one generation, replayed from its recorded path
//   · champion mode: the best-ever match re-simulated in DSIM's own ReplayPlayer
import type { Replay } from '../../dsim-main/src/sim/replay';
import type { RobotState, Vec2, World } from '../../dsim-main/src/types';
import { drawBiobuzzField, drawHiveCanopy } from '../../dsim-main/src/games/biobuzz/drawField';
import { drawBiobuzzRobot } from '../../dsim-main/src/games/biobuzz/drawRobot';
import { drawBiobuzzBalls } from '../../dsim-main/src/games/biobuzz/draw';
import { viewAngleOf } from '../../dsim-main/src/sim/field';
import { rot } from '../../dsim-main/src/math';
import { AUTO_START, TRACK_STRIDE, decodeTrack, type GenFile } from './data';

const VIEW = viewAngleOf('blue');
/** world-space "screen up", exactly DSIM's Camera.screenUpWorld(): rot({0, 1}, −viewAngle) */
const UP: Vec2 = rot({ x: 0, y: 1 }, -VIEW);
const css = (v: string): string => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

interface Ghost {
  path: Float32Array;
  deathTick: number;
  death: string;
  rank: number;
  spec: RobotState['spec'];
}

export class FieldView {
  private ctx: CanvasRenderingContext2D;
  private fieldLayer = document.createElement('canvas');
  private w = 0;
  private h = 0;
  private dpr = 1;
  private scale = 1;
  private field: World | null = null;
  private ghosts: Ghost[] = [];
  private template: RobotState | null = null;
  mode: 'swarm' | 'champion' = 'swarm';
  tick = AUTO_START;
  endTick = AUTO_START;
  speed = 4;
  playing = true;
  gen: GenFile | null = null;
  // champion
  private player: import('../../dsim-main/src/sim/replay').ReplayPlayer | null = null;
  private replay: Replay | null = null;
  champMeta: { title?: string; score?: number; replayExact?: boolean } = {};
  onFrame: (info: { alive: number; total: number; tick: number; end: number }) => void = () => {};
  /** called when a swarm replay reaches its end and loops — the place to switch generations */
  onLoop: () => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  setField(w: World): void {
    this.field = w;
    this.template = structuredClone(w.robots[0]);
    this.template.hopper = [];
    this.renderFieldLayer();
  }

  private resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.scale = Math.min(this.w, this.h) / (2 * (72 + 5));
    this.renderFieldLayer();
  }

  private apply(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.w / 2, this.h / 2);
    ctx.scale(this.scale, -this.scale);
    ctx.rotate(VIEW);
  }

  /** the static field (mat, tape, HIVE, FLOWERS, staged elements) once per resize */
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

  loadGeneration(g: GenFile): void {
    this.gen = g;
    this.mode = 'swarm';
    const base = this.template!;
    this.ghosts = g.individuals.map((ind, rank) => {
      const spec = { ...base.spec };
      if (ind.point['spec.length']) spec.length = ind.point['spec.length'];
      if (ind.point['spec.width']) spec.width = ind.point['spec.width'];
      return { path: decodeTrack(ind.track), deathTick: ind.deathTick, death: ind.death, rank, spec };
    });
    this.endTick = Math.max(AUTO_START + 60, ...this.ghosts.map((q) => q.deathTick)) + 90;
    this.tick = AUTO_START;
  }

  async loadChampion(data: { meta: { title?: string; score?: number; replayExact?: boolean }; replay: Replay }): Promise<void> {
    const [{ initPhysics }, { ReplayPlayer }] = await Promise.all([import('../../dsim-main/src/sim/physicsEngine'), import('../../dsim-main/src/sim/replay')]);
    await initPhysics();
    this.replay = data.replay;
    this.champMeta = data.meta;
    this.player = new ReplayPlayer(data.replay);
    this.mode = 'champion';
    this.tick = 0;
    this.endTick = data.replay.ticks;
  }

  /** jump to a tick (champion mode re-simulates from the start when going backwards) */
  async seek(t: number): Promise<void> {
    if (this.mode === 'swarm') {
      this.tick = t;
      return;
    }
    if (!this.replay) return;
    const { ReplayPlayer } = await import('../../dsim-main/src/sim/replay');
    if (!this.player || t < this.player.world.tick) this.player = new ReplayPlayer(this.replay);
    while (this.player.world.tick < t && this.player.stepOnce());
    this.tick = this.player.world.tick;
  }

  /** advance by one animation frame */
  step(dtMs: number): void {
    if (!this.playing) return;
    const ticks = Math.max(1, Math.round((dtMs / 1000) * 60 * this.speed));
    if (this.mode === 'swarm') {
      this.tick += ticks;
      if (this.tick > this.endTick) {
        this.tick = AUTO_START;
        this.onLoop();
      }
    } else if (this.player) {
      for (let k = 0; k < ticks && this.player.stepOnce(); k++);
      this.tick = this.player.world.tick;
    }
  }

  draw(): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0e0b08';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.mode === 'champion' && this.player) return this.drawChampion();
    ctx.drawImage(this.fieldLayer, 0, 0);
    if (!this.gen || !this.template) return;
    this.apply(ctx);
    const T = this.tick;
    const n = this.ghosts.length;
    let alive = 0;
    const r = this.template;
    // back to front: weakest first, champion last (on top)
    for (let k = n - 1; k >= 0; k--) {
      const g = this.ghosts[k];
      const pose = poseAt(g.path, Math.min(T, g.deathTick));
      if (!pose) continue;
      if (T <= g.deathTick) {
        alive++;
        r.pos = { x: pose[0], y: pose[1] };
        r.heading = pose[2];
        r.turretHeading = pose[2];
        r.bbTurret2Heading = pose[2] + Math.PI;
        r.spec = g.spec;
        ctx.save();
        ctx.globalAlpha = k === 0 ? 1 : k < Math.max(3, n * 0.1) ? 0.7 : 0.26;
        if (k === 0) this.halo(pose);
        drawBiobuzzRobot(ctx, r, false, [], UP);
        ctx.restore();
      } else if (g.death !== 'survived' && T - g.deathTick < 120) {
        this.deathMark(pose, g.death, 1 - (T - g.deathTick) / 120);
      }
    }
    if (this.ghosts[0]) this.trail(this.ghosts[0], T);
    if (this.field) drawHiveCanopy(ctx, this.field);
    this.onFrame({ alive, total: n, tick: T, end: this.endTick });
  }

  private halo(p: Float32Array | number[]): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = css('--honey-hi') || '#f6d38a';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private trail(g: Ghost, T: number): void {
    const ctx = this.ctx;
    const end = Math.min(T, g.deathTick);
    const i1 = Math.floor(end / TRACK_STRIDE) - 1;
    const i0 = Math.max(0, i1 - 60);
    if (i1 <= i0) return;
    ctx.save();
    ctx.strokeStyle = css('--honey') || '#e9a23b';
    ctx.lineWidth = 0.9;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    for (let i = i0; i <= i1 && 3 * i + 1 < g.path.length; i++) {
      if (i === i0) ctx.moveTo(g.path[3 * i], g.path[3 * i + 1]);
      else ctx.lineTo(g.path[3 * i], g.path[3 * i + 1]);
    }
    ctx.stroke();
    ctx.restore();
  }

  private deathMark(p: Float32Array | number[], kind: string, a: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = Math.max(0, a);
    if (kind === 'crash') {
      ctx.strokeStyle = css('--st-crash') || '#d03b3b';
      ctx.lineWidth = 1.6;
      const s = 4 + 3 * (1 - a);
      ctx.beginPath();
      ctx.moveTo(p[0] - s, p[1] - s);
      ctx.lineTo(p[0] + s, p[1] + s);
      ctx.moveTo(p[0] - s, p[1] + s);
      ctx.lineTo(p[0] + s, p[1] - s);
      ctx.stroke();
    } else {
      ctx.strokeStyle = css('--st-stall') || '#fab219';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 3 + 4 * (1 - a), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawChampion(): void {
    const ctx = this.ctx;
    const w = this.player!.world;
    this.apply(ctx);
    drawBiobuzzField(ctx, w, UP);
    for (const r of w.robots) {
      const held = w.balls.filter((b) => b.state.kind === 'held' && (b.state as { robot: number }).robot === r.id);
      drawBiobuzzRobot(ctx, r, false, held, UP, w);
    }
    drawBiobuzzBalls(ctx, w, UP);
    this.onFrame({ alive: 1, total: 1, tick: w.tick, end: this.endTick });
  }

  champWorld(): World | null {
    return this.player?.world ?? null;
  }
}

/** interpolated pose at tick t from a path sampled every TRACK_STRIDE ticks (first sample = tick 6) */
function poseAt(path: Float32Array, t: number): number[] | null {
  const n = path.length / 3;
  if (n === 0) return null;
  const f = t / TRACK_STRIDE - 1;
  const i = Math.max(0, Math.min(n - 1, Math.floor(f)));
  const j = Math.min(n - 1, i + 1);
  const a = Math.max(0, Math.min(1, f - i));
  const h0 = path[3 * i + 2];
  const dh = Math.atan2(Math.sin(path[3 * j + 2] - h0), Math.cos(path[3 * j + 2] - h0));
  return [path[3 * i] + (path[3 * j] - path[3 * i]) * a, path[3 * i + 1] + (path[3 * j + 1] - path[3 * i + 1]) * a, h0 + dh * a];
}
