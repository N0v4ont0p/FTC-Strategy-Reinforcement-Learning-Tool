// Our own seeded RNG for layers B/C and sampling. Never touches world.rngState, so DSIM's
// random draws (spill scatter, human-player jitter) are unchanged by anything we do.
export type Rng = () => number;
/** a stream that can be copied mid-sequence (train/fork.ts) and restarted from a new seed (the
 * what-if branches draw their own luck, never the real match's future) */
export interface Stream extends Rng {
  fork(): Stream;
  reseed(seed: number): void;
}

export function mulberry32(seed: number): Stream {
  let a = seed >>> 0;
  const f = (() => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Stream;
  f.fork = () => mulberry32(a);
  f.reseed = (s: number) => {
    a = s >>> 0;
  };
  return f;
}

/** stable seed from parts, so (match seed, robot id, purpose) always maps to the same stream */
export function seedOf(...parts: (number | string)[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return h >>> 0;
}
