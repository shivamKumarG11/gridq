// Exact QAOA statevector for 10 qubits, a line-for-line mirror of engine/qaoa.py `state()`.
// Used for the Quantum Lab landscape and Superposition mode, so clicks answer instantly without a
// Python round trip. tests/test_qsim_parity.mjs checks it against the Python (and so Qiskit) version.
export const N = 10;
export const PLANS = 1 << N;
export const GAMMA_MAX = 3.0;
export const BETA_MAX = Math.PI / 2;

export function state(E, gammas, betas) {
  const re = new Float64Array(PLANS).fill(1 / Math.sqrt(PLANS));
  const im = new Float64Array(PLANS);
  for (let l = 0; l < gammas.length; l++) {
    const g = gammas[l], b = betas[l];
    for (let k = 0; k < PLANS; k++) { // e^{-i g E_k}
      const c = Math.cos(g * E[k]), s = -Math.sin(g * E[k]);
      const r = re[k], i = im[k];
      re[k] = r * c - i * s; im[k] = r * s + i * c;
    }
    const cb = Math.cos(b), sb = Math.sin(b);
    for (let q = 0; q < N; q++) { // RX(2b) = cos b I - i sin b X
      const m = 1 << q;
      for (let k = 0; k < PLANS; k++) {
        if (k & m) continue;
        const j = k | m;
        const ar = re[k], ai = im[k], br = re[j], bi = im[j];
        re[k] = cb * ar + sb * bi; im[k] = cb * ai - sb * br;
        re[j] = cb * br + sb * ai; im[j] = cb * bi - sb * ar;
      }
    }
  }
  return { re, im };
}

export function probs(E, gammas, betas) {
  const { re, im } = state(E, gammas, betas);
  const p = new Float64Array(PLANS);
  for (let k = 0; k < PLANS; k++) p[k] = re[k] * re[k] + im[k] * im[k];
  return p;
}

export function expectation(E, gammas, betas) {
  const p = probs(E, gammas, betas);
  let s = 0;
  for (let k = 0; k < PLANS; k++) s += p[k] * E[k];
  return s;
}

/** p = 1 expectation on an n x n grid; rows = beta (top = largest), columns = gamma. */
export function landscape(E, n = 20) {
  const vals = [];
  for (let j = n - 1; j >= 0; j--) {
    const row = [];
    for (let i = 0; i < n; i++) row.push(expectation(E, [i / (n - 1) * GAMMA_MAX], [j / (n - 1) * BETA_MAX]));
    vals.push(row);
  }
  return vals;
}

/** P(plant i on) for every qubit. */
export function marginals(p) {
  const on = new Array(N).fill(0);
  for (let k = 0; k < PLANS; k++) for (let i = 0; i < N; i++) if (k >> i & 1) on[i] += p[k];
  return on;
}

/** Connected correlation <Z_i Z_j> - <Z_i><Z_j>, the quantity Superposition mode draws as threads. */
export function correlations(p) {
  const z = new Array(N).fill(0);
  const zz = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let k = 0; k < PLANS; k++) {
    const pk = p[k];
    if (pk < 1e-12) continue;
    for (let i = 0; i < N; i++) {
      const zi = (k >> i & 1) ? -1 : 1;
      z[i] += pk * zi;
      for (let j = i + 1; j < N; j++) zz[i][j] += pk * zi * ((k >> j & 1) ? -1 : 1);
    }
  }
  const out = [];
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) out.push({ i, j, c: zz[i][j] - z[i] * z[j] });
  return out;
}

export function sample(p, rand = Math.random) {
  let r = rand(), acc = 0;
  for (let k = 0; k < PLANS; k++) { acc += p[k]; if (r <= acc) return k; }
  return PLANS - 1;
}

export const bitsOf = (plan) => Array.from({ length: N }, (_, i) => (plan >> i) & 1);
export const labelOf = (plan) => bitsOf(plan).join('');
