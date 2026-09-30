// THE ONLY FILE THAT IMPORTS DSIM. Every other harness module goes through here, so the
// boundary with the pinned snapshot (harness/dsim-pin.json) is one file. Nothing in dsim-main
// is edited; this only calls its exported functions.
import type { Alliance, Physics, RobotCommand, RobotSpec, RobotState, StartPose, Vec2, World } from '../dsim-main/src/types';
import * as C from '../dsim-main/src/config';
import * as BB from '../dsim-main/src/games/biobuzz/config';
import { initPhysics } from '../dsim-main/src/sim/physicsEngine';
import { coerceSpec, type RobotSetup } from '../dsim-main/src/sim/spawn';
import { footprintCorners, footprintExtents } from '../dsim-main/src/sim/field';
import { driveParams } from '../dsim-main/src/sim/drivetrain';
import { BB_DEFAULT_SPEC } from '../dsim-main/src/games/biobuzz/coerce';
import { createBiobuzzWorld } from '../dsim-main/src/games/biobuzz/spawn';
import { disposePhysics3dFor, initPhysics3d, physics3dImpl } from '../dsim-main/src/games/biobuzz/sim3d/engine';
import { biobuzzStep } from '../dsim-main/src/games/biobuzz/step';
import { bbSettled } from '../dsim-main/src/games/biobuzz/settle';
import { bbActiveStartLegal, bbEvalStart, bbSnapStart } from '../dsim-main/src/games/biobuzz/start';
import { bbAimTarget, bbCellSideOf, bbFlowerAtIntake } from '../dsim-main/src/games/biobuzz/play';
import { bbFlowerInReach, bbIntakeAct, bbIntakeExtraReach, bbMouths, bbPlacePointLocal } from '../dsim-main/src/games/biobuzz/robot';
import { bbIntakeAccepts, bbIntakeKindOf, bbIsTurreted, bbLauncherOf, bbLiftOf } from '../dsim-main/src/games/biobuzz/mechs';
import { BB_TIP_RELEASE_S, BB_TIP_SWING_S } from '../dsim-main/src/games/biobuzz/hive';
import { newSettleClock, settleStep } from '../dsim-main/src/sim/settle';
import { ReplayRecorder, verifyReplay, worldResult, type Replay, type ReplayResult } from '../dsim-main/src/sim/replay';
import { localizeCommand } from '../dsim-main/src/net/protocol';
import { ZERO_CMD } from '../dsim-main/src/sim/goal';

export type { Alliance, Physics, Replay, ReplayResult, RobotCommand, RobotSpec, RobotState, StartPose, Vec2, World };
export { BB, BB_TIP_RELEASE_S, BB_TIP_SWING_S, C, ZERO_CMD, bbActiveStartLegal, bbAimTarget, bbCellSideOf, bbEvalStart, bbFlowerAtIntake, bbFlowerInReach, bbIntakeAccepts, bbIntakeAct, bbIntakeExtraReach, bbIntakeKindOf, bbIsTurreted, bbLauncherOf, bbLiftOf, bbMouths, bbPlacePointLocal, bbSnapStart, biobuzzStep, driveParams, footprintCorners, footprintExtents, localizeCommand, verifyReplay, worldResult };

export const DT = C.SIM_DT;

/** Assists every harness robot gets. The SIM reads the SETUP's assists (sim/spawn.ts, robot
 * init); `spec.assists` is only the UI's mirror, so both are set to this to leave no doubt.
 * Robot-centric drive: controllers speak in the robot's own frame. */
export const ASSISTS = { fieldCentric: false, aimAssist: true, autoIntake: false, autoFire: false };

/** THE PHYSICS EVERY MATCH HERE IS SOLVED IN: DSIM's 3D solve (BIOBUZZ Act 2), the one every online
 * match runs — elements, the HIVE's see-saw trays and the FLOWERs are real rigid bodies, so a shot
 * goes in (or clips the cell's wall and bounces out) the way it does on the site. DSIM keeps its 2D
 * pipeline for light practice; nothing here uses it for a match. */
export const PHYSICS: Physics = '3d';

/** both of DSIM's physics engines: the 2D robot solve and the 3D (Rapier 3D, deterministic build) */
export const init = async (): Promise<void> => {
  await initPhysics();
  await initPhysics3d();
};

/** the physics a world is solved in (absent = DSIM's 2D pipeline: the team's older replays) */
export const physicsOf = (w: World): Physics => ((w as unknown as { biobuzz?: { physics?: Physics } }).biobuzz?.physics === '3d' ? '3d' : '2d');

// ─────────────────────────────── 3D engines: exact forks ───────────────────────────────
// DSIM keeps ONE Rapier engine per World object (sim3d/engineImpl.ts) and builds it on a world's
// first step. A fork's world is a deep copy, a new object, so its first step would build a FRESH
// engine from the JSON — not the running one: contacts, the solver's warm start and which bodies
// sleep live only in the engine, and a copy of a match played on finished points away from it.
// DSIM's rollback API (the client's reconcile) moves an engine to another World object and
// restores it EXACTLY from a save of that tick (saveEngineState + rewindEngineTo). So a fork
// BORROWS its match's engine, restored to the fork tick, on its first step; the match takes it back
// the same way when it steps again, and a disposed fork returns it. Every what-if plays its fork
// before its match moves on. A fork stepped after its match has (or a fork of a fork) builds a
// fresh engine instead: approximate, and the match's own engine is never touched.
const forkOf = new WeakMap<World, { home: World; tick: number }>(); // a registered fork → its match, and the tick
const engineOf = new WeakMap<World, 'own' | { from: World }>(); // who holds an engine, and whose
const lentTo = new WeakMap<World, World>(); // a match → the fork holding its engine

/** move `from`'s engine to `to`, restored to the save of `to`'s tick; then save that tick again
 * (the move clears every save): whoever takes the engine next comes back to exactly this */
function moveEngine(from: World, to: World): void {
  const p = physics3dImpl();
  if (!p.rewindEngineTo(from, to)) throw new Error(`3D engine: could not move it from tick ${from.tick} to tick ${to.tick}`);
  p.saveEngineState(to, 0);
}

/** `fork` is a copy of `home` taken now (train/episode.ts fork): its first step borrows `home`'s
 * engine. Saves `home`'s engine at this tick (~1.2 MB, ~0.5 ms) for that. */
export function registerFork(home: World, fork: World): void {
  if (physicsOf(home) !== '3d') return;
  forkOf.set(fork, { home, tick: home.tick });
  // (a match that never stepped has no engine: its fork builds the very one it would; a lent
  // engine carries this tick's save already; a borrowed one is never lent on)
  if (engineOf.get(home) === 'own') physics3dImpl().saveEngineState(home, 0);
}

/** before `w` steps: its engine back from a fork, or a fork's first engine borrowed */
function engineBeforeStep(w: World): void {
  const holder = lentTo.get(w);
  if (holder) {
    moveEngine(holder, w);
    lentTo.delete(w);
    engineOf.delete(holder); // (should it step again, it builds a fresh one)
    engineOf.set(w, 'own');
    return;
  }
  if (engineOf.has(w)) return;
  const f = forkOf.get(w);
  // only a fork at its fork tick, of a match still there (never a fork's borrowed engine: its
  // match's save would be lost)
  if (!f || w.tick !== f.tick || f.home.tick !== f.tick) return;
  const cur = lentTo.get(f.home);
  const src = engineOf.get(f.home) === 'own' ? f.home : cur;
  if (!src) return;
  moveEngine(src, w);
  if (src !== f.home) engineOf.delete(src); // taken from a sibling fork of the same tick
  lentTo.set(f.home, w);
  engineOf.delete(f.home);
  engineOf.set(w, { from: f.home });
}

/**
 * FREE a world's 3D engine (its Rapier world lives in wasm memory). DSIM keeps one per World
 * object and builds it on the first step, so every world stepped here — a match, a fork played
 * out, a lab snapshot — is disposed when it is done. A fork gives a borrowed engine back to its
 * match instead (restored to the fork tick). Idempotent; a no-op for a world never stepped.
 * ⚠️ The world must be dead: stepping it again builds a fresh engine from its JSON.
 */
export function dispose(w: World): void {
  const e = engineOf.get(w);
  if (e && e !== 'own' && lentTo.get(e.from) === w) {
    moveEngine(w, e.from);
    lentTo.delete(e.from);
    engineOf.delete(w);
    engineOf.set(e.from, 'own');
    return;
  }
  const holder = lentTo.get(w);
  if (holder) {
    disposePhysics3dFor(holder);
    engineOf.delete(holder);
    lentTo.delete(w);
  }
  disposePhysics3dFor(w);
  engineOf.delete(w);
}

/** DSIM's own coercion of a BIOBUZZ spec — the exact robot DSIM would build. */
export const coerce = (raw: Partial<RobotSpec>): RobotSpec =>
  coerceSpec({ ...raw, assists: { ...ASSISTS } }, BB_DEFAULT_SPEC, 'biobuzz');

export interface Seat {
  id: number;
  alliance: Alliance;
  spec: RobotSpec;
  startIndex: number;
  startPose?: StartPose;
}

export const cmd = (p: Partial<RobotCommand> = {}): RobotCommand => ({ ...ZERO_CMD, ...p });

function setupsOf(seats: Seat[]): RobotSetup[] {
  return seats.map((s) => ({
    id: s.id,
    alliance: s.alliance,
    spec: s.spec,
    assists: { ...ASSISTS },
    startIndex: s.startIndex,
    startPose: s.startPose,
  }));
}

/** A fresh match, as DSIM's own record runner starts one. Custom start poses are checked for
 * G304 here because DSIM only fits them inside the field (PLAN.md §7 guard 1). */
export function newMatch(seed: number, seats: Seat[], physics: Physics = PHYSICS): World {
  for (const s of seats)
    if (!bbActiveStartLegal(s.spec, s.alliance, s.startPose))
      throw new Error(`G304: illegal start pose for robot ${s.id}: ${JSON.stringify(s.startPose)}`);
  const w = createBiobuzzWorld('match', seed, setupsOf(seats), undefined, physics);
  w.match.preCountdown = C.PRE_COUNTDOWN;
  return w;
}

/** A LAB world: DSIM's own free-drive mode (phase 'freeplay', robots always enabled, no clock),
 * for measurements only (S1). Not a match: nothing scored here is ever reported as a score. */
export function labWorld(seed: number, seats: Seat[], keepElements = false, physics: Physics = PHYSICS): World {
  const w = createBiobuzzWorld('free', seed, setupsOf(seats), undefined, physics);
  if (!keepElements) {
    w.balls.length = 0; // DSIM's own smoke scenes clear a field this way
    for (const r of w.robots) r.hopper = []; // no held element may point at a removed ball
  }
  return w;
}

/** Intent → what reaches the sim. `filter` is layer B (harness/filters.ts); what it returns is
 * what gets recorded, so replays stay exact. `perturb` is layer C: it edits the world AFTER a
 * step, so a run that used it cannot be reproduced from its replay (flagged in the result). */
export interface Hooks {
  filter?: (w: World, intents: Map<number, RobotCommand>) => Map<number, RobotCommand>;
  perturb?: (w: World) => boolean; // returns true if it changed anything this tick
  after?: (w: World, applied: Map<number, RobotCommand>) => void;
  /** end the run now (a training episode's early "death"); the world is left as it is */
  stop?: (w: World) => boolean;
}

export type Controller = (w: World) => Map<number, RobotCommand>;

export interface MatchRun {
  world: World;
  replay: Replay | null;
  /** false once layer C touched the world — the replay then only reproduces the commands */
  replayExact: boolean;
  settled: boolean;
  stopped: boolean; // ended by hooks.stop
}

/** One match, a tick at a time: exactly runMatch's loop, with its state (world, replay recorder,
 * settle clock) held as plain data so a running match can be forked (train/fork.ts). The
 * controller and hooks are passed to every step, never stored. */
export class Match {
  readonly w: World;
  rec: ReplayRecorder | null;
  private clock = newSettleClock();
  exact = true;
  settled = false;
  stopped = false;
  private n = 0;
  constructor(
    seed: number,
    private seats: Seat[],
    opts: { record?: boolean; from?: World; maxTicks?: number } = {},
    private cap = opts.maxTicks ?? 20000,
  ) {
    this.w = opts.from ?? newMatch(seed, seats);
    this.rec = opts.record === false ? null : new ReplayRecorder(seed, setupsOf(seats), 'match', 'biobuzz', physicsOf(this.w));
  }
  get done(): boolean {
    return this.settled || this.stopped || this.n >= this.cap;
  }
  /** one tick; returns false once the match is over (settled, stopped or at the cap) */
  step(controller: Controller, hooks: Hooks = {}): boolean {
    if (this.done) return false;
    this.n++;
    const w = this.w;
    const tick = w.tick + 1;
    const intents = controller(w);
    const chosen = hooks.filter ? hooks.filter(w, intents) : intents;
    const applied = new Map<number, RobotCommand>();
    for (const s of this.seats) {
      const c = chosen.get(s.id);
      applied.set(s.id, c ? localizeCommand(c) : { ...ZERO_CMD });
    }
    const is3d = physicsOf(w) === '3d';
    if (is3d) engineBeforeStep(w);
    biobuzzStep(w, DT, applied);
    if (is3d && !engineOf.has(w)) engineOf.set(w, 'own'); // (DSIM built it)
    this.rec?.record(tick, applied);
    if (hooks.perturb?.(w)) this.exact = false;
    hooks.after?.(w, applied);
    if (hooks.stop?.(w)) {
      this.stopped = true;
      return false;
    }
    if (settleStep(this.clock, w, bbSettled)) {
      this.settled = true;
      return false;
    }
    return !this.done;
  }
  result(): MatchRun {
    return { world: this.w, replay: this.rec ? this.rec.finish() : null, replayExact: this.exact, settled: this.settled, stopped: this.stopped };
  }
  /** free the 3D engine: the match is over (see `dispose`) */
  dispose(): void {
    dispose(this.w);
  }
}

/** Step one match to DSIM's own "final" moment: through `post` until the settle clock decides,
 * exactly as solo practice finalizes (game.ts frameLogic → harvestPracticeRun). */
export function runMatch(
  seed: number,
  seats: Seat[],
  controller: Controller,
  hooks: Hooks = {},
  opts: { record?: boolean; from?: World; maxTicks?: number } = {},
): MatchRun {
  const m = new Match(seed, seats, opts);
  while (m.step(controller, hooks));
  m.dispose(); // (the world stays readable: only its 3D engine goes)
  return m.result();
}

/** The solo record score DSIM shows: own total minus the fouls the OTHER alliance earned off us. */
export function recordScore(w: World, a: Alliance): number {
  const opp: Alliance = a === 'blue' ? 'red' : 'blue';
  return Math.max(0, w.match.scores[a].total - w.match.scores[opp].foulPoints);
}

export const snapshot = <T>(w: T): T => structuredClone(w);

/** BIOBUZZ game state (plain JSON on world.biobuzz). Typed loosely on purpose: DSIM owns it. */
export interface BbState {
  hives: Record<Alliance, { up: 'north' | 'south'; contents: number[]; tips: number; tipping: number; released: boolean }>;
  nectarStock: Record<Alliance, number>;
  nectarDue: Record<Alliance, number>;
  /** 'ok' = the human-player button would enter a NECTAR now */
  nectarWhy: Record<Alliance, string>;
  /** FLOWER stacks, bottom first (element ids), in BB.BB_FLOWERS order */
  flowers: { stack: number[] }[];
}
export const bb = (w: World): BbState => (w as unknown as { biobuzz: BbState }).biobuzz;
