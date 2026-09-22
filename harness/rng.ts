// Our own seeded RNG for layers B/C and sampling. Never touches world.rngState, so DSIM's
// random draws (spill scatter, human-player jitter) are unchanged by anything we do.
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** stable seed from parts, so (match seed, robot id, purpose) always maps to the same stream */
export function seedOf(...parts: (number | string)[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return h >>> 0;
}
