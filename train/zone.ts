// THE SHOOTING ZONE — where the team lets its robot shoot from, drawn in the studio's Robot tab and
// kept in the profile (profiles/<robot>.json "shootZone"). DSIM scores a shot from wherever the
// physics lands it; a real robot is less sure far out, so the team narrows it: a distance band from
// the CELL being shot at, and/or an area drawn on the field. Both are in the BLUE frame (the
// alliance's own: red sees the field turned 180°). The robot then only goes to measured scoring spots
// inside the zone and only holds fire inside it. No zone (or an empty one) = everything DSIM scores.
// Plain math, no Node: the studio imports it too.
import { BB_HIVE_CELL_DY, BB_HIVE_X } from '../dsim-main/src/games/biobuzz/config';

type P = { x: number; y: number };
export type ZoneSide = 'north' | 'south';
export interface ShootZone {
  /** farthest from the target CELL's centre (in, plan view); null / 0 = no limit */
  maxDist?: number | null;
  /** nearest to it (in); null / 0 = no limit */
  minDist?: number | null;
  /** an area drawn on the field (blue frame, ≥ 3 corners); null = anywhere */
  area?: P[] | null;
}

/** does this zone limit anything */
export const zoneActive = (z: ShootZone | null | undefined): z is ShootZone => !!z && ((z.maxDist ?? 0) > 0 || (z.minDist ?? 0) > 0 || (z.area?.length ?? 0) >= 3);

/** the centre of a CELL in plan (blue frame) */
export const cellCentre = (side: ZoneSide): P => ({ x: BB_HIVE_X, y: (side === 'north' ? 1 : -1) * BB_HIVE_CELL_DY });

/** point in polygon (even–odd rule; any winding) */
export function inPoly(p: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** may the robot shoot at `side`'s CELL from (x, y), blue frame */
export function zoneAllows(z: ShootZone | null | undefined, side: ZoneSide, x: number, y: number): boolean {
  if (!zoneActive(z)) return true;
  const c = cellCentre(side);
  const d = Math.hypot(x - c.x, y - c.y);
  if ((z.maxDist ?? 0) > 0 && d > z.maxDist!) return false;
  if ((z.minDist ?? 0) > 0 && d < z.minDist!) return false;
  if ((z.area?.length ?? 0) >= 3 && !inPoly({ x, y }, z.area!)) return false;
  return true;
}

/** what is wrong with a zone as typed (a profile is refused with these) */
export function zoneProblems(z: unknown): string[] {
  if (z === undefined || z === null) return [];
  if (typeof z !== 'object') return ['shooting zone: not a zone'];
  const q = z as ShootZone;
  const out: string[] = [];
  const num = (v: unknown, name: string): void => {
    if (v === undefined || v === null) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 250) out.push(`shooting zone: ${name} must be 0–250 in`);
  };
  num(q.maxDist, 'the farthest distance');
  num(q.minDist, 'the nearest distance');
  if ((q.maxDist ?? 0) > 0 && (q.minDist ?? 0) > 0 && q.minDist! >= q.maxDist!) out.push('shooting zone: the nearest distance must be less than the farthest');
  if (q.area !== undefined && q.area !== null) {
    if (!Array.isArray(q.area) || q.area.length > 64 || q.area.some((p) => typeof p?.x !== 'number' || typeof p?.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 72 || Math.abs(p.y) > 72))
      out.push('shooting zone: the area is up to 64 corners on the field (±72 in)');
    // (fewer than 3 corners is an area still being drawn: it limits nothing yet)
  }
  return out;
}

/** a zone as a stable string (what a playbook entry was planned under); 'all' = no zone */
export function zoneStamp(z: ShootZone | null | undefined): string {
  if (!zoneActive(z)) return 'all';
  const r = (v: number): number => Math.round(v * 10) / 10;
  return JSON.stringify([r(z.maxDist ?? 0), r(z.minDist ?? 0), (z.area?.length ?? 0) >= 3 ? z.area!.map((p) => [r(p.x), r(p.y)]) : []]);
}

/** a measured envelope's spots cut to the zone */
export function zoneSpots(z: ShootZone | null | undefined, spots: Record<ZoneSide, P[]>): Record<ZoneSide, P[]> {
  if (!zoneActive(z)) return spots;
  return { north: spots.north.filter((s) => zoneAllows(z, 'north', s.x, s.y)), south: spots.south.filter((s) => zoneAllows(z, 'south', s.x, s.y)) };
}
