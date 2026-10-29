import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as g from '../src/engine/geometry.js';
import { BinaryClassifier } from '../src/engine/cluster.js';
import { close } from './close.js';

const golden = JSON.parse(readFileSync(new URL('../public/data/golden_geometry.json', import.meta.url)));
const sameUpToSign = (a, b, path) => {
  const d = a.reduce((s, v, i) => s + v * b[i], 0);
  close(d < 0 ? a.map((v) => -v) : a, b, path);
};

test('patch pipeline: depth gate, outlier passes, plane fit', () => {
  const [fx, fy, cx, cy] = golden.intr;
  golden.patches.forEach((p, i) => {
    const { keep } = g.depth_gate(p.points);
    assert.deepEqual(keep.map(Number), p.keep, `patch ${i} keep`);
    const gated = p.points.filter((_, j) => keep[j]);
    assert.deepEqual(g.radius_outlier_mask(gated, 1.0, 7).map(Number), p.radius_mask, `patch ${i} radius`);
    assert.deepEqual(g.statistical_outlier_mask(gated, 6).map(Number), p.stat_mask, `patch ${i} stat`);
    const idx = g.outlier_indices(gated);
    assert.deepEqual(idx, p.inliers, `patch ${i} inliers`);
    const inl = idx.map((j) => gated[j]);
    let [normal, , centroid] = g.fit_plane(inl);
    if (normal[2] > 0) normal = normal.map((v) => -v);
    close(normal, p.normal, `patch ${i} normal`, 1e-6, 1e-9);
    close(centroid, p.centroid, `patch ${i} centroid`);
    sameUpToSign(g.quat_from_normal_stable(normal), p.quat, `patch ${i} quat`);
    close(g.inplane_basis(normal), p.basis, `patch ${i} basis`);
    const [hit, t] = g.ray_plane_intersection((p.bbox[0] + p.bbox[2]) / 2, (p.bbox[1] + p.bbox[3]) / 2, golden.K, normal, centroid);
    close(hit, p.hit, `patch ${i} hit`);
    close(t, p.t, `patch ${i} t`);
    const fit = g.surface_fit(inl, p.bbox, { fx, fy, cx, cy });
    close(fit.normal, p.normal, `patch ${i} surface_fit normal`);
  });
});

test('quaternions from normals', () => {
  golden.normals.forEach((c, i) => {
    sameUpToSign(g.quat_from_normal_stable(c.n), c.quat, `normal ${i}`);
    sameUpToSign(g.quat_from_normal_and_inplane_dir(c.n, c.dir), c.quat_dir, `normal ${i} dir`);
    close(g.inplane_basis(c.n), c.basis, `normal ${i} basis`);
  });
});

test('binary classifier replays like binary_classifier.py', () => {
  const bc = new BinaryClassifier(golden.classifier.params);
  bc.start('fire', 'bin_target1', 'bin_target2');
  golden.classifier.steps.forEach((s, i) => {
    if (s.op === 'freeze') return close(bc.freeze_buffer(), s.ret, `step ${i}`);
    if (s.op === 'start_second') return close(bc.start_second(), s.ret, `step ${i}`);
    const [x, y, z, score, stamp_sec] = s.sample;
    const r = bc.observe({ x, y, z, score, stamp_sec }, s.now);
    close([r.accepted, r.target_name, r.reason, bc.state], [s.accepted, s.target, s.reason, s.state], `step ${i}`);
    if (s.distance !== null) close(r.distance_m, s.distance, `step ${i} distance`);
    close(bc.instance1_centroid, s.c1, `step ${i} c1`);
    close(bc.instance2_centroid, s.c2, `step ${i} c2`);
  });
});
