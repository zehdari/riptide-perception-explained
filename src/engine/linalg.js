// Small dense linear algebra for the estimator: vectors are arrays, matrices arrays of rows.

export const zeros = (n, m = n) => Array.from({ length: n }, () => new Array(m).fill(0));
export const eye = (n) => { const A = zeros(n); for (let i = 0; i < n; i++) A[i][i] = 1; return A; };
export const diag = (v) => { const A = zeros(v.length); v.forEach((x, i) => { A[i][i] = x; }); return A; };
export const copy = (A) => A.map((r) => r.slice());
export const vcopy = (v) => Array.from(v);

export const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
export const norm = (a) => Math.sqrt(dot(a, a));
export const vadd = (a, b) => a.map((x, i) => x + b[i]);
export const vsub = (a, b) => a.map((x, i) => x - b[i]);
export const vscale = (a, s) => a.map((x) => x * s);

export const add = (A, B) => A.map((r, i) => r.map((x, j) => x + B[i][j]));
export const sub = (A, B) => A.map((r, i) => r.map((x, j) => x - B[i][j]));
export const scale = (A, s) => A.map((r) => r.map((x) => x * s));
export const transpose = (A) => A[0].map((_, j) => A.map((r) => r[j]));
export const sym = (A) => A.map((r, i) => r.map((x, j) => 0.5 * (x + A[j][i])));
export const outer = (a, b) => a.map((x) => b.map((y) => x * y));

export function matmul(A, B) {
  const n = A.length, m = B[0].length, k = B.length;
  const C = zeros(n, m);
  for (let i = 0; i < n; i++) {
    const Ai = A[i], Ci = C[i];
    for (let p = 0; p < k; p++) {
      const a = Ai[p];
      if (a === 0) continue;
      const Bp = B[p];
      for (let j = 0; j < m; j++) Ci[j] += a * Bp[j];
    }
  }
  return C;
}
export const matvec = (A, v) => A.map((r) => dot(r, v));
// A @ B @ A.T
export const sandwich = (A, B) => matmul(matmul(A, B), transpose(A));
// v @ A^-1 @ v
export const quadSolve = (A, v) => dot(v, solve(A, v));

// LU with partial pivoting (as LAPACK gesv). B: vector or matrix.
export function lu(A) {
  const n = A.length;
  const M = copy(A);
  const piv = Array.from({ length: n }, (_, i) => i);
  for (let k = 0; k < n; k++) {
    let p = k, best = Math.abs(M[k][k]);
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > best) { best = Math.abs(M[i][k]); p = i; }
    if (best === 0) throw new Error('singular matrix');
    if (p !== k) { [M[p], M[k]] = [M[k], M[p]]; [piv[p], piv[k]] = [piv[k], piv[p]]; }
    const Mk = M[k], d = Mk[k];
    for (let i = k + 1; i < n; i++) {
      const Mi = M[i];
      const f = (Mi[k] /= d);
      if (f === 0) continue;
      for (let j = k + 1; j < n; j++) Mi[j] -= f * Mk[j];
    }
  }
  return { M, piv };
}

function luSolveVec({ M, piv }, b) {
  const n = M.length;
  const y = piv.map((p) => b[p]);
  for (let i = 0; i < n; i++) { const Mi = M[i]; let s = y[i]; for (let j = 0; j < i; j++) s -= Mi[j] * y[j]; y[i] = s; }
  for (let i = n - 1; i >= 0; i--) { const Mi = M[i]; let s = y[i]; for (let j = i + 1; j < n; j++) s -= Mi[j] * y[j]; y[i] = s / Mi[i]; }
  return y;
}

export function solve(A, b) {
  const f = lu(A);
  if (!Array.isArray(b[0])) return luSolveVec(f, b);
  const cols = transpose(b).map((c) => luSolveVec(f, c));
  return transpose(cols);
}

export function inv(A) {
  const f = lu(A);
  const n = A.length;
  const cols = [];
  for (let j = 0; j < n; j++) { const e = new Array(n).fill(0); e[j] = 1; cols.push(luSolveVec(f, e)); }
  return transpose(cols);
}

// Eigen-decomposition of a small symmetric matrix (cyclic Jacobi). Ascending eigenvalues; vectors as columns.
export function eigh(A) {
  const n = A.length;
  const a = copy(A);
  const V = eye(n);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i][i] - a[j][j]);
  return { values: order.map((i) => a[i][i]), vectors: V.map((r) => order.map((i) => r[i])) };
}
export const eigvalsh = (A) => eigh(A).values;

// Lower Cholesky factor (for sampling and drawing ellipses)
export function cholesky(A) {
  const n = A.length;
  const L = zeros(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 0)) : s / L[j][j];
    }
  }
  return L;
}

// Sub-block A[idx][idx]
export const block = (A, idx) => idx.map((i) => idx.map((j) => A[i][j]));
