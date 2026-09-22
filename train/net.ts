// A small multilayer perceptron with a flat parameter vector (what evolution mutates).
// tanh hidden layers, linear output. Float32 end to end; deterministic.
export interface NetShape {
  sizes: number[]; // e.g. [N_OBS, 64, 64, N_ACT]
}

export function paramCount(s: NetShape): number {
  let n = 0;
  for (let l = 0; l + 1 < s.sizes.length; l++) n += s.sizes[l] * s.sizes[l + 1] + s.sizes[l + 1];
  return n;
}

/** Xavier-style initialization from a seeded normal source */
export function initParams(s: NetShape, gauss: () => number): Float32Array {
  const p = new Float32Array(paramCount(s));
  let o = 0;
  for (let l = 0; l + 1 < s.sizes.length; l++) {
    const fin = s.sizes[l];
    const fout = s.sizes[l + 1];
    const k = Math.sqrt(1 / fin);
    for (let j = 0; j < fin * fout; j++) p[o++] = gauss() * k;
    o += fout; // biases start at 0
  }
  return p;
}

export class Mlp {
  private bufs: Float32Array[];
  constructor(readonly shape: NetShape, readonly p: Float32Array) {
    if (p.length !== paramCount(shape)) throw new Error(`params ${p.length} ≠ ${paramCount(shape)}`);
    this.bufs = shape.sizes.map((n) => new Float32Array(n));
  }
  forward(x: Float32Array): Float32Array {
    const S = this.shape.sizes;
    this.bufs[0].set(x);
    let o = 0;
    for (let l = 0; l + 1 < S.length; l++) {
      const a = this.bufs[l];
      const z = this.bufs[l + 1];
      const nin = S[l];
      const nout = S[l + 1];
      const bias = o + nin * nout;
      for (let j = 0; j < nout; j++) {
        let v = this.p[bias + j];
        const row = o + j * nin;
        for (let i = 0; i < nin; i++) v += this.p[row + i] * a[i];
        z[j] = l + 2 < S.length ? Math.tanh(v) : v;
      }
      o = bias + nout;
    }
    return this.bufs[S.length - 1];
  }
}

/** Float32Array ⇄ base64, for jobs and checkpoints (exact round trip) */
export const toB64 = (p: Float32Array): string => Buffer.from(p.buffer, p.byteOffset, p.byteLength).toString('base64');
export function fromB64(s: string): Float32Array {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
