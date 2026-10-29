// JavaScript port of the detector's geometry (tensor_detector/src/geometry.py, pointcloud.py, detection.py).

import { dot, norm, vsub, vscale, vadd, eigh, inv, matvec } from './linalg.js';

// The camera-frame normal a flat, front-facing surface would have
export const DEFAULT_NORMAL = [0, 0, 1];

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => vscale(a, 1 / norm(a));
const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
const columns = (a, b, c) => [0, 1, 2].map((i) => [a[i], b[i], c[i]]);

// Back-project a pixel (u, v) at depth z into a 3D camera-frame point
export function pixel_to_3d(u, v, z, fx, fy, cx, cy) {
  return [((u - cx) * z) / fx, ((v - cy) * z) / fy, z];
}

// Intersect the camera ray through pixel (u, v) with the plane (normal, p0). [point, t]; [null, null] when parallel
export function ray_plane_intersection(u, v, K, normal, p0) {
  let d = matvec(inv(K), [u, v, 1]);
  d = unit(d);
  const denominator = dot(normal, d);
  if (denominator === 0) return [null, null];
  const t = dot(normal, p0) / denominator;
  return [vscale(d, t), t];
}

// Least-squares plane fit. The Python takes the last right singular vector of the centered points (SVD); that is the
// eigenvector of the smallest eigenvalue of their scatter matrix, which is what this computes. The sign is arbitrary in
// both (callers flip the normal to face the camera). Returns [normal, d, centroid]
export function fit_plane(points) {
  if (!points.length) return [null, null, null];
  const n = points.length;
  const c = [0, 0, 0];
  for (const p of points) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  const centroid = vscale(c, 1 / n);
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of points) {
    const q = vsub(p, centroid);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i][j] += q[i] * q[j];
  }
  const { vectors } = eigh(S);
  const normal = unit([vectors[0][0], vectors[1][0], vectors[2][0]]);
  return [normal, -dot(normal, centroid), centroid];
}

// Two orthonormal vectors (u, v) spanning the plane with the given normal
export function inplane_basis(normal) {
  const n = unit(normal);
  const ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(n, ref));
  const v = unit(cross(n, u));
  return [u, v];
}

// Rotation matrix -> quaternion (x, y, z, w), the method scipy's Rotation.from_matrix uses
export function quat_from_matrix(m) {
  const tr = m[0][0] + m[1][1] + m[2][2];
  const decision = [m[0][0], m[1][1], m[2][2], tr];
  let choice = 0;
  for (let i = 1; i < 4; i++) if (decision[i] > decision[choice]) choice = i;
  const q = [0, 0, 0, 0];
  if (choice !== 3) {
    const i = choice, j = (i + 1) % 3, k = (j + 1) % 3;
    q[i] = 1 - decision[3] + 2 * m[i][i];
    q[j] = m[j][i] + m[i][j];
    q[k] = m[k][i] + m[i][k];
    q[3] = m[k][j] - m[j][k];
  } else {
    q[0] = m[2][1] - m[1][2];
    q[1] = m[0][2] - m[2][0];
    q[2] = m[1][0] - m[0][1];
    q[3] = 1 + decision[3];
  }
  const l = Math.hypot(...q);
  return q.map((x) => x / l);
}

// Body +z = normal, deterministic roll. No singularity near anti-parallel
export function quat_from_normal_stable(normal) {
  const n = unit(normal);
  const [u, v] = inplane_basis(n);
  let Rm = columns(u, v, n); // columns = body x, y, z in camera frame
  if (det3(Rm) < 0) Rm = columns(vscale(u, -1), v, n); // keep it right-handed
  return quat_from_matrix(Rm);
}

// Body +z = normal, body +x = direction projected into the plane
export function quat_from_normal_and_inplane_dir(normal, direction) {
  const n = unit(normal);
  let d = vsub(direction, vscale(n, dot(direction, n)));
  const dn = norm(d);
  if (dn < 1e-9) return quat_from_normal_stable(n);
  const x = vscale(d, 1 / dn);
  const y = cross(n, x);
  return quat_from_matrix(columns(x, y, n));
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
};

// The robust depth gate (pointcloud._depth_filter): keep points within depth_mad_scale robust stds of the median depth.
// Returns a boolean keep mask, plus the numbers it used
export function depth_gate(points, depth_mad_scale = 3.0, depth_min_spread = 0.05) {
  if (depth_mad_scale <= 0 || points.length < 3) return { keep: points.map(() => true), med: NaN, spread: NaN };
  const z = points.map((p) => p[2]);
  const med = median(z);
  const mad = median(z.map((v) => Math.abs(v - med)));
  // 1.4826 rescales MAD to a Gaussian-equivalent stddev; floor it so a flat, head-on patch (mad ~ 0) keeps its points
  const spread = Math.max(mad * 1.4826, depth_min_spread);
  return { keep: z.map((v) => Math.abs(v - med) <= depth_mad_scale * spread), med, spread };
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// True for points with more than min_neighbors others within radius (the count includes the point itself)
export function radius_outlier_mask(points, radius = 1.0, min_neighbors = 10) {
  return points.map((p) => {
    let count = 0;
    for (const q of points) if (dist(p, q) <= radius) count++;
    return count > min_neighbors;
  });
}

// True for inliers, based on mean distance to k nearest neighbors
export function statistical_outlier_mask(points, k = 10, std_ratio = 1.0) {
  const n = points.length;
  if (n === 0) return [];
  const k_eff = Math.min(k, n - 1);
  if (k_eff < 1) return points.map(() => true);
  const mean_d = points.map((p) => {
    const d = points.map((q) => dist(p, q)).sort((a, b) => a - b);
    let s = 0;
    for (let i = 1; i <= k_eff; i++) s += d[i]; // drop the self column
    return s / k_eff;
  });
  const mu = mean_d.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(mean_d.reduce((a, b) => a + (b - mu) ** 2, 0) / n);
  const threshold = mu + std_ratio * sd;
  return mean_d.map((m) => m < threshold);
}

// pointcloud._outlier_indices: the radius pass, then the statistical pass on its survivors. Surviving indices
export function outlier_indices(points) {
  const n = points.length;
  if (n === 0) return [];
  const k = Math.min(10, Math.max(1, Math.floor(n * 0.8)));
  const radius_idx = radius_outlier_mask(points, 1.0, k).flatMap((ok, i) => (ok ? [i] : []));
  if (!radius_idx.length) return radius_idx;
  const survivors = radius_idx.map((i) => points[i]);
  const k2 = Math.min(10, Math.max(1, Math.floor(survivors.length * 0.8)));
  const stat = statistical_outlier_mask(survivors, k2);
  return radius_idx.filter((_, j) => stat[j]);
}

// detection._plane_from_points: plane through the patch, the bbox centre's ray at the plane's mean depth, the normal
// flipped to face the camera. bbox = [x_min, y_min, x_max, y_max]; intr = {fx, fy, cx, cy}
export function surface_fit(points, bbox, intr, min_points = 5) {
  if (!points || points.length < min_points) return null;
  let [normal, , centroid3] = fit_plane(points);
  if (normal === null) return null;
  const u = (bbox[0] + bbox[2]) / 2, v = (bbox[1] + bbox[3]) / 2;
  const centroid = pixel_to_3d(u, v, centroid3[2], intr.fx, intr.fy, intr.cx, intr.cy);
  if (normal[2] > 0) normal = vscale(normal, -1);
  return { points, normal, centroid, quat: quat_from_normal_stable(normal), center2d: [u, v] };
}

export { cross, unit, vadd };
