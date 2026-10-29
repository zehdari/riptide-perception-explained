// The detector's sampling path in the browser, on a frame from tools/frame_pipeline.py: the union of every mask in the
// frame (optionally grown by `grow` px), sampled on the box's 8 px grid, back-projected, then the depth gate, the two
// outlier passes and the plane fit from src/engine/geometry.js. detection._extract_bbox_points and
// pointcloud.PointCloudBuilder.extract, step for step.
import { pixel_to_3d, depth_gate, outlier_indices, surface_fit } from '../engine/geometry.js';

function insidePoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function nearPoly(x, y, poly, d) {
  const d2 = d * d;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i];
    const vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy;
    const t = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / L)) : 0;
    const ex = ax + t * vx - x, ey = ay + t * vy - y;
    if (ex * ex + ey * ey <= d2) return true;
  }
  return false;
}

export const inMask = (frame, x, y, grow = 0) =>
  frame.boxes.some((b) => b.mask.length > 2 && (insidePoly(x, y, b.mask) || (grow > 0 && nearPoly(x, y, b.mask, grow))));

export function intrinsics(frame) {
  const K = frame.K;
  return { fx: K[0], fy: K[4], cx: K[2], cy: K[5] };
}

// One box through the pipeline. Returns every sample with its fate: 'nodepth' | 'gate' | 'outlier' | 'kept'
// bleed (px, synthetic): what a real stereo camera does at a depth edge. Samples within `bleed` px of the box's own
// mask outline read a depth part-way to the depth just outside it, a per-pixel fraction in [0, 1)
const hash = (x, y) => { const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return v - Math.floor(v); };

export function runBox(frame, box, { grow = 0, gate = true, outliers = true, cap = 500, bleed = 0 } = {}) {
  const g = box.grid, intr = intrinsics(frame);
  const [x_min, y_min, x_max, y_max] = box.box.map((v) => Math.trunc(v));
  // ROI = the box (class_detect_shrink 0 on Talos); the grid starts at its corner, every 8 px
  const pts = [];
  for (let y = y_min; y < y_max; y += g.step) {
    for (let x = x_min; x < x_max; x += g.step) {
      if (inMask(frame, x, y, grow)) pts.push([x, y]);
    }
  }
  let samples = pts;
  if (cap > 0 && pts.length > cap) {
    samples = [];
    for (let i = 0; i < cap; i++) samples.push(pts[Math.trunc((i * (pts.length - 1)) / (cap - 1))]);
  }
  const zAt = (x, y) => {
    const i = Math.round((x - g.x0) / g.step), j = Math.round((y - g.y0) / g.step);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return 0;
    return g.z[j * g.nx + i];
  };
  const out = samples.map(([x, y]) => ({ px: [x, y], p: null, fate: 'nodepth' }));
  const live = [];
  const bx = (x_min + x_max) / 2, by = (y_min + y_max) / 2;
  // the farthest depth in the ring around the box: what lies behind the object
  const ring = g.z.filter((z, k) => z > 0 && !inMask(frame, g.x0 + (k % g.nx) * g.step, g.y0 + Math.floor(k / g.nx) * g.step));
  const behind = ring.length ? Math.max(...ring) : 0;
  out.forEach((s) => {
    let z = zAt(s.px[0], s.px[1]);
    if (bleed > 0 && z > 0 && box.mask.length > 2 && nearPoly(s.px[0], s.px[1], box.mask, bleed)) {
      const dx = s.px[0] - bx, dy = s.px[1] - by, L = Math.hypot(dx, dy) || 1;
      let zo = zAt(s.px[0] + (dx / L) * (bleed + 24), s.px[1] + (dy / L) * (bleed + 24));
      if (!(zo > 0)) zo = behind;
      if (zo > z) { z += hash(s.px[0], s.px[1]) * (zo - z); s.bled = true; }
    }
    if (z > 0) { s.p = pixel_to_3d(s.px[0], s.px[1], z, intr.fx, intr.fy, intr.cx, intr.cy); s.fate = 'kept'; live.push(s); }
  });
  let cur = live;
  let gateInfo = null;
  if (gate) {
    gateInfo = depth_gate(cur.map((s) => s.p));
    cur.forEach((s, i) => { if (!gateInfo.keep[i]) s.fate = 'gate'; });
    cur = cur.filter((s, i) => gateInfo.keep[i]);
  }
  if (outliers && cur.length) {
    const idx = new Set(outlier_indices(cur.map((s) => s.p)));
    cur.forEach((s, i) => { if (!idx.has(i)) s.fate = 'outlier'; });
    cur = cur.filter((s, i) => idx.has(i));
  }
  const fit = cur.length >= 5 ? surface_fit(cur.map((s) => s.p), [x_min, y_min, x_max, y_max], intr) : null;
  return { samples: out, kept: cur, fit, gate: gateInfo, intr };
}
