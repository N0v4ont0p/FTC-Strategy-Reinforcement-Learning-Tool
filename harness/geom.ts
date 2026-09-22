import type { Vec2 } from './dsim';

/** Separating-axis test for two convex polygons; `slop` > 0 counts near-touching as overlap. */
export function polysOverlap(a: Vec2[], b: Vec2[], slop = 0): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const nx = q.y - p.y;
      const ny = p.x - q.x;
      const len = Math.hypot(nx, ny) || 1;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const v of a) {
        const d = (v.x * nx + v.y * ny) / len;
        if (d < aMin) aMin = d;
        if (d > aMax) aMax = d;
      }
      for (const v of b) {
        const d = (v.x * nx + v.y * ny) / len;
        if (d < bMin) bMin = d;
        if (d > bMax) bMax = d;
      }
      if (aMax < bMin - slop || bMax < aMin - slop) return false;
    }
  }
  return true;
}

export const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

/** is point p inside convex polygon (CCW or CW) by at least `depth` inches? */
export function pointDepthInside(p: Vec2, poly: Vec2[]): number {
  let minDist = Infinity;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey) || 1;
    const cross = (ex * (p.y - a.y) - ey * (p.x - a.x)) / len;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign && cross !== 0) return -1; // outside
    minDist = Math.min(minDist, Math.abs(cross));
  }
  return minDist;
}
