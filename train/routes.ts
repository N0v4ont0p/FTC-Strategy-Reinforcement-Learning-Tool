// THE ROUTE LIBRARY (MASTERPLAN §6, phase 5) — how the champion actually scores, mined from its
// exam matches (every partner kind, every opponent kind, the same matches for every champion). A
// CYCLE runs volley to volley (train/episode.ts Cycle); a ROUTE is a kind of cycle: where it picked up
// (a field region, the loading zone, a FLOWER, the tip cycle by the HIVE) and where it shot from. For
// each route: how often, how long, its own elements into the HIVE per cycle and PER MINUTE (the
// rate: alliance points arrive in lumps when a HIVE tips, so they are context, not the measure), and
// when it is used (AUTO, TELEOP, the last 30 s; beside which partner, against whom) — with one exam
// match to watch it in. Also the GROUP ORDER: the first places of TELEOP, match by match.
import type { Cycle } from './episode';

/** a named region of the field, in our (blue) frame: our HIVE is at +x, our wall at x = +72 */
export function regionOf(x: number, y: number): string {
  const row = y > 24 ? 'top' : y < -24 ? 'bottom' : 'middle';
  const col = x > 40 ? 'our wall' : x > 0 ? 'our half' : 'far half';
  return `${row}, ${col}`;
}
/** where a pickup happened, as a route names it: by the job it was doing, else the field region */
export function placeOf(c: Cycle['collect'][number]): string {
  if (c.kind === 'lz') return 'loading zone';
  if (c.kind === 'cycle') return 'tip cycle at the HIVE';
  if (c.kind === 'flower') return c.label.match(/FLOWER \S+/)?.[0] ?? 'a FLOWER';
  return `field (${regionOf(c.x, c.y)})`;
}
export function routeOf(c: Cycle): { collect: string; shoot: string; sig: string } {
  const names: string[] = [];
  for (const k of c.collect.map(placeOf)) if (!names.includes(k)) names.push(k);
  const collect = names.length ? names.join(' + ') : 'preloads / what it held';
  const shoot = c.collect.some((q) => q.kind === 'cycle') ? 'at the HIVE' : regionOf(c.shoot.x, c.shoot.y);
  return { collect, shoot, sig: `${collect} → shoot ${shoot}` };
}

export interface MinedMatch {
  match: number; // exam index
  partner: string;
  opponents: string;
  reward: number;
  cycles: Cycle[];
  teleopStart: number; // tick TELEOP starts
  end: number; // tick TELEOP ends
}
export interface RouteStat {
  sig: string;
  collect: string;
  shoot: string;
  n: number;
  share: number; // of all cycles
  seconds: number; // mean cycle length
  points: number; // mean alliance points while it runs
  mine: number; // mean elements our robot put in the HIVE per cycle
  inPerMin: number; // …per minute of the route
  when: { auto: number; teleop: number; endgame: number }; // cycles in AUTO, TELEOP before the last 30 s, the last 30 s
  byPartner: Record<string, number>; // cycles beside each partner kind
  byOpponents: Record<string, number>; // …against each opponent kind
  example: { match: number; t0: number; t1: number };
}
export interface RouteLibrary {
  champion: number;
  time: string;
  matches: number;
  cycles: number;
  routes: RouteStat[];
  openings: { seq: string; n: number; reward: number }[]; // the first TELEOP places (the group order) → mean match reward
}

export function mineRoutes(ms: MinedMatch[], champion: number): RouteLibrary {
  const by = new Map<string, { r: ReturnType<typeof routeOf>; cs: { c: Cycle; m: MinedMatch }[] }>();
  let total = 0;
  const openings = new Map<string, number[]>();
  for (const m of ms) {
    const tele: string[] = [];
    for (const c of m.cycles) {
      if (c.t1 <= c.t0) continue;
      const r = routeOf(c);
      const e = by.get(r.sig) ?? { r, cs: [] };
      e.cs.push({ c, m });
      by.set(r.sig, e);
      total++;
      if (c.t0 >= m.teleopStart) for (const k of c.collect.map(placeOf)) if (tele.length < 4 && tele[tele.length - 1] !== k) tele.push(k);
    }
    if (tele.length) {
      const k = tele.join('  ⟶  ');
      openings.set(k, [...(openings.get(k) ?? []), m.reward]);
    }
  }
  const mean = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
  const routes: RouteStat[] = [...by.values()]
    .map(({ r, cs }) => {
      const secs = mean(cs.map(({ c }) => (c.t1 - c.t0) / 60));
      const pts = mean(cs.map(({ c }) => c.points));
      const inn = mean(cs.map(({ c }) => c.mine));
      const count = (f: (x: { c: Cycle; m: MinedMatch }) => string): Record<string, number> => {
        const o: Record<string, number> = {};
        for (const x of cs) o[f(x)] = (o[f(x)] ?? 0) + 1;
        return o;
      };
      // the example: the cycle closest to the route's typical length (not a fluke)
      const ex = [...cs].sort((a, b) => Math.abs((a.c.t1 - a.c.t0) / 60 - secs) - Math.abs((b.c.t1 - b.c.t0) / 60 - secs))[0];
      return {
        ...r,
        n: cs.length,
        share: cs.length / Math.max(1, total),
        seconds: secs,
        points: pts,
        mine: inn,
        inPerMin: secs > 0 ? (inn / secs) * 60 : 0,
        when: {
          auto: cs.filter(({ c, m }) => c.t0 < m.teleopStart).length,
          teleop: cs.filter(({ c, m }) => c.t0 >= m.teleopStart && c.t0 < m.end - 30 * 60).length,
          endgame: cs.filter(({ c, m }) => c.t0 >= m.end - 30 * 60).length,
        },
        byPartner: count((x) => x.m.partner),
        byOpponents: count((x) => x.m.opponents),
        example: { match: ex.m.match, t0: ex.c.t0, t1: ex.c.t1 },
      };
    })
    .sort((a, b) => b.n - a.n || b.inPerMin - a.inPerMin);
  return {
    champion,
    time: new Date().toISOString(),
    matches: ms.length,
    cycles: total,
    routes,
    openings: [...openings.entries()].map(([seq, v]) => ({ seq, n: v.length, reward: mean(v) })).sort((a, b) => b.n - a.n || b.reward - a.reward).slice(0, 12),
  };
}
