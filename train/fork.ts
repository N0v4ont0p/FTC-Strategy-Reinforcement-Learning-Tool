// FORKING A MATCH — the whole state of a running episode (DSIM's world, the rule filter, the miss
// model, the rule guards, the robot's brain and its skills) copied in one call, so the robot can
// ask "what if I did X instead?" and play it out without touching the real match.
//
// A deep copy that keeps every object's class (its prototype), shares nothing by accident and
// REFUSES hidden state: a function stored as data is a closure over variables no copy can reach, so
// meeting one throws — unless it knows how to fork itself (a `fork()` method, e.g. harness/rng.ts
// streams). Objects registered with `share()` (never mutated during a match: network weights, the
// robot profile, measured tables) are passed by reference. Aliasing is kept: an object reached
// twice is copied once.
// train/check.ts proves the copy exact: a forked match played on finishes bit-identical to the
// original, and a branch played differently leaves the original untouched.

const SHARED = new WeakSet<object>();
/** mark an object as immutable during a match: forks reference it instead of copying it */
export function share<T extends object>(o: T): T {
  SHARED.add(o);
  return o;
}

type Forkable = { fork(): unknown };

export function deepClone<T>(x: T): T {
  return copy(x, new Map(), 'root') as T;
}

function copy(v: unknown, memo: Map<object, unknown>, path: string): unknown {
  if (v === null || typeof v !== 'object') {
    if (typeof v !== 'function') return v;
    const f = v as unknown as Partial<Forkable>;
    if (typeof f.fork === 'function') {
      if (memo.has(v as object)) return memo.get(v as object);
      const c = f.fork();
      memo.set(v as object, c);
      return c;
    }
    throw new Error(`cannot fork ${path}: a function holding hidden state (make it a class, or give it fork())`);
  }
  if (SHARED.has(v)) return v;
  const hit = memo.get(v);
  if (hit !== undefined) return hit;
  if (ArrayBuffer.isView(v)) {
    const c = (v as unknown as { slice(): unknown }).slice();
    memo.set(v, c);
    return c;
  }
  if (Array.isArray(v)) {
    const c: unknown[] = new Array(v.length);
    memo.set(v, c);
    for (let i = 0; i < v.length; i++) c[i] = copy(v[i], memo, path);
    return c;
  }
  if (v instanceof Map) {
    const c = new Map();
    memo.set(v, c);
    for (const [k, x] of v) c.set(copy(k, memo, path), copy(x, memo, `${path}.get(${String(k)})`));
    return c;
  }
  if (v instanceof Set) {
    const c = new Set();
    memo.set(v, c);
    for (const x of v) c.add(copy(x, memo, path));
    return c;
  }
  const c = Object.create(Object.getPrototypeOf(v)) as Record<string, unknown>;
  memo.set(v, c);
  for (const k of Object.keys(v)) c[k] = copy((v as Record<string, unknown>)[k], memo, `${path}.${k}`);
  return c;
}
