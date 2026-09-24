// CMA-ES (Hansen 2016, "The CMA Evolution Strategy: A Tutorial") for the skill settings — the
// standard tool for tuning a few dozen continuous numbers from noisy, rank-only comparisons.
// (μ/μ_w, λ) with weighted recombination, cumulative step-size adaptation and rank-one + rank-μ
// covariance updates. It MAXIMIZES. The state is plain data (checkpointed with the run) and every
// random draw comes from (seed, generation, index), so a resumed or rewound run asks exactly the
// same candidates again.
import { mulberry32, seedOf } from '../harness/rng';

export interface CmaState {
  n: number;
  gen: number;
  mean: number[];
  sigma: number;
  C: number[][]; // covariance
  pc: number[];
  ps: number[];
  seed: number;
}

const params = (n: number, lambda = 4 + Math.floor(3 * Math.log(n))) => {
  const mu = Math.floor(lambda / 2);
  const raw = Array.from({ length: mu }, (_, i) => Math.log(mu + 0.5) - Math.log(i + 1));
  const s = raw.reduce((a, b) => a + b, 0);
  const w = raw.map((x) => x / s);
  const mueff = 1 / w.reduce((a, b) => a + b * b, 0);
  const cc = (4 + mueff / n) / (n + 4 + (2 * mueff) / n);
  const cs = (mueff + 2) / (n + mueff + 5);
  const c1 = 2 / ((n + 1.3) ** 2 + mueff);
  const cmu = Math.min(1 - c1, (2 * (mueff - 2 + 1 / mueff)) / ((n + 2) ** 2 + mueff));
  const damps = 1 + 2 * Math.max(0, Math.sqrt((mueff - 1) / (n + 1)) - 1) + cs;
  const chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
  return { lambda, mu, w, mueff, cc, cs, c1, cmu, damps, chiN };
};
/** the default population size for n numbers */
export const cmaLambda = (n: number): number => params(n).lambda;

export function cmaInit(mean: ArrayLike<number>, sigma: number, seed: number): CmaState {
  const n = mean.length;
  return { n, gen: 0, mean: Array.from(mean), sigma, C: Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))), pc: new Array(n).fill(0), ps: new Array(n).fill(0), seed };
}

/** symmetric eigen-decomposition (cyclic Jacobi): C = B diag(d) Bᵀ, columns of B are eigenvectors */
function eig(C: number[][]): { B: number[][]; d: number[] } {
  const n = C.length;
  const A = C.map((r) => [...r]);
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue;
        const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p];
          const akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k];
          const aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p];
          const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
  }
  return { B: V, d: A.map((r, i) => Math.max(1e-20, r[i])) };
}

/** this generation's λ candidates (and the standard-normal draws z behind them) */
export function cmaAsk(S: CmaState, lambda = cmaLambda(S.n)): { x: number[][]; z: number[][] } {
  const { B, d } = eig(S.C);
  const sd = d.map(Math.sqrt);
  const rng = mulberry32(seedOf(S.seed, 'cma', S.gen));
  const gauss = (): number => {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
  const x: number[][] = [];
  const z: number[][] = [];
  for (let k = 0; k < lambda; k++) {
    const zk = Array.from({ length: S.n }, gauss);
    const y = B.map((row) => row.reduce((a, b, j) => a + b * sd[j] * zk[j], 0));
    z.push(zk);
    x.push(S.mean.map((m, i) => m + S.sigma * y[i]));
  }
  return { x, z };
}

/** update from the candidates' fitness (higher is better); returns the new state */
export function cmaTell(S0: CmaState, x: number[][], fitness: number[]): CmaState {
  const S: CmaState = JSON.parse(JSON.stringify(S0));
  const n = S.n;
  const P = params(n, x.length);
  const { mu, w, mueff } = P;
  const order = fitness.map((f, i) => [f, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(([, i]) => i);
  const old = [...S.mean];
  const Y = order.slice(0, mu).map((i) => x[i].map((v, j) => (v - old[j]) / S.sigma));
  S.mean = old.map((m, j) => m + S.sigma * Y.reduce((a, y, k) => a + w[k] * y[j], 0));
  const yw = old.map((_, j) => Y.reduce((a, y, k) => a + w[k] * y[j], 0));
  // C^-1/2 · yw
  const { B, d } = eig(S.C);
  const tmp = d.map((dj, j) => B.reduce((a, row, i) => a + row[j] * yw[i], 0) / Math.sqrt(dj));
  const invsq = B.map((row) => row.reduce((a, b, j) => a + b * tmp[j], 0));
  S.ps = S.ps.map((p, i) => (1 - P.cs) * p + Math.sqrt(P.cs * (2 - P.cs) * mueff) * invsq[i]);
  const psn = Math.sqrt(S.ps.reduce((a, b) => a + b * b, 0));
  const hsig = psn / Math.sqrt(1 - (1 - P.cs) ** (2 * (S.gen + 1))) / P.chiN < 1.4 + 2 / (n + 1) ? 1 : 0;
  S.pc = S.pc.map((p, i) => (1 - P.cc) * p + hsig * Math.sqrt(P.cc * (2 - P.cc) * mueff) * yw[i]);
  const c1a = P.c1 * (1 - (1 - hsig * hsig) * P.cc * (2 - P.cc));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const rankMu = Y.reduce((a, y, k) => a + w[k] * y[i] * y[j], 0);
      S.C[i][j] = (1 - c1a - P.cmu) * S.C[i][j] + P.c1 * S.pc[i] * S.pc[j] + P.cmu * rankMu;
    }
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) S.C[i][j] = S.C[j][i] = (S.C[i][j] + S.C[j][i]) / 2;
  S.sigma *= Math.exp((P.cs / P.damps) * (psn / P.chiN - 1));
  S.sigma = Math.min(Math.max(S.sigma, 1e-4), 10);
  S.gen++;
  return S;
}

/** re-centre on a new starting point (a new champion) keeping what was learned about the shape */
export function cmaRecenter(S: CmaState, mean: ArrayLike<number>): CmaState {
  return { ...JSON.parse(JSON.stringify(S)), mean: Array.from(mean), ps: new Array(S.n).fill(0), pc: new Array(S.n).fill(0) };
}
