import { setup } from '../layout.js';
import '../css/vision.css';
import { FrameView, loadFrame, picker, classColor, s } from '../viz/detector_frames.js';
import { runBox } from '../viz/pose_sample.js';
import { fit_plane, ray_plane_intersection, cross, unit } from '../engine/geometry.js';

setup();

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b) => a.map((v, i) => v + b[i]);
const mul = (a, k) => a.map((v) => v * k);
const dist = (a, b) => Math.hypot(...sub(a, b));
const Kmat = (f) => [[f.K[0], 0, f.K[2]], [0, f.K[4], f.K[5]], [0, 0, 1]];
const center = (b) => [(b.box[0] + b.box[2]) / 2, (b.box[1] + b.box[3]) / 2];
const HOLES = ['fire_hole_large', 'fire_hole_small', 'blood_hole_large', 'blood_hole_small'];
const HOLE_LABEL = { fire_hole_large: 'fire L', fire_hole_small: 'fire S', blood_hole_large: 'blood L', blood_hole_small: 'blood S' };

// ---------- torpedo layout from a head-on frame ----------
// Board coordinates (metres, x right, y up, origin at the published torpedo centre) of every symbol and opening,
// measured by running the detector's own steps on frame f0003_ffc.
async function boardLayout(name) {
  const f = await loadFrame(name);
  const K = Kmat(f);
  const fits = {};
  for (const b of f.boxes) if (b.class !== 'circle') fits[b.class] = runBox(f, b);
  const pts = Object.values(fits).flatMap((r) => r.kept.map((x) => x.p));
  let [n] = fit_plane(pts);
  if (n[2] > 0) n = mul(n, -1);
  const anchor = mul(add(fits.fire.fit.centroid, fits.blood.fit.centroid), 0.5);
  const proj = (b) => ray_plane_intersection(...center(b), K, n, anchor)[0];
  const up = unit(sub([0, -1, 0], mul(n, -dot(n, [0, -1, 0]))));
  const right = cross(up, n);
  const c = f.published.find((p) => p.class === 'torpedo').p;
  const at = (p) => [dot(sub(p, c), right), dot(sub(p, c), up)];
  const items = [];
  for (const b of f.boxes) {
    const p = proj(b);
    const r = (((b.box[2] - b.box[0]) + (b.box[3] - b.box[1])) / 4) * (p[2] / f.K[0]);
    items.push({ cls: b.class, xy: at(p), r, p });
  }
  // truth names for the openings: the published hole nearest each circle (head-on, where the rule is certain)
  for (const it of items.filter((i) => i.cls === 'circle')) {
    let best = null;
    for (const h of f.published.filter((p) => HOLES.includes(p.class))) if (!best || dist(h.p, it.p) < dist(best.p, it.p)) best = h;
    it.truth = best.class;
  }
  return items;
}

{
  const svg = document.getElementById('torp-diagram');
  const note = document.getElementById('torp-note');
  const st = { roll: 0, yaw: 0 };
  const fx = 1864, cx = 960, cy = 600, D = 1.5;
  let items = [];
  const host = document.getElementById('torp-controls');
  for (const [key, label, min, max] of [['roll', 'Board roll', -180, 180], ['yaw', 'Board turned', -60, 60]]) {
    const l = document.createElement('label');
    l.innerHTML = `${label} <input type="range" min="${min}" max="${max}" step="1" value="0"><output>0°</output>`;
    const i = l.querySelector('input'), o = l.querySelector('output');
    i.oninput = () => { st[key] = +i.value; o.textContent = `${i.value}°`; draw(); };
    host.appendChild(l);
  }
  const place = ([x, y]) => {
    const r = (st.roll * Math.PI) / 180, w = (st.yaw * Math.PI) / 180;
    const xr = Math.cos(r) * x - Math.sin(r) * y, yr = Math.sin(r) * x + Math.cos(r) * y;
    // board right/up in the camera frame (y down), turned about the board's vertical axis
    const right = [Math.cos(w), 0, Math.sin(w)], up = [0, -1, 0];
    return [right[0] * xr + up[0] * yr, right[1] * xr + up[1] * yr, D + right[2] * xr + up[2] * yr];
  };
  const px = (p) => [(fx * p[0]) / p[2] + cx, (fx * p[1]) / p[2] + cy];

  function draw() {
    svg.replaceChildren();
    s('rect', { x: 410, y: 160, width: 1100, height: 880, rx: 14, fill: '#2b6f7d' }, svg);
    if (!items.length) return;
    // board outline: the layout's extent plus a margin
    const xs = items.map((i) => i.xy[0]), ys = items.map((i) => i.xy[1]);
    const m = 0.07, x0 = Math.min(...xs) - m, x1 = Math.max(...xs) + m, y0 = Math.min(...ys) - m, y1 = Math.max(...ys) + m;
    const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((q) => px(place(q)));
    s('polygon', { points: corners.map((q) => q.join(',')).join(' '), fill: '#dfeff1', stroke: '#9fcbd4', 'stroke-width': 10 }, svg);
    const P = items.map((i) => ({ ...i, p3: place(i.xy) }));
    // a circle of radius rr on the board, as the camera sees it
    const disc = (it, rr) => Array.from({ length: 36 }, (_, k) => {
      const a = (k / 36) * 2 * Math.PI;
      return px(place([it.xy[0] + rr * Math.cos(a), it.xy[1] + rr * Math.sin(a)])).join(',');
    }).join(' ');
    const fire = P.find((i) => i.cls === 'fire'), blood = P.find((i) => i.cls === 'blood');
    const circles = P.filter((i) => i.cls === 'circle');
    // the detector's rule (process_torpedo_task, all in 3D on the board)
    const sep = unit(sub(blood.p3, fire.p3));
    circles.forEach((c) => (c.s = dot(sub(c.p3, fire.p3), sep)));
    const sorted = [...circles].sort((a, b) => a.s - b.s);
    const name = (pair, sym, label) => {
      const [a, b] = pair;
      const [large, small] = dist(a.p3, sym.p3) <= dist(b.p3, sym.p3) ? [a, b] : [b, a];
      large.got = `${label}_hole_large`;
      small.got = `${label}_hole_small`;
    };
    name(sorted.slice(0, 2), fire, 'fire');
    name(sorted.slice(2), blood, 'blood');
    // for comparison: each opening to the symbol nearer it in the image, then large = the nearer of that symbol's
    const near = new Map();
    for (const c of circles) {
      const q = px(c.p3), df = Math.hypot(...px(fire.p3).map((v, i) => v - q[i])), db = Math.hypot(...px(blood.p3).map((v, i) => v - q[i]));
      near.set(c, df <= db ? 'fire' : 'blood');
    }
    const colName = new Map();
    for (const label of ['fire', 'blood']) {
      const sym = label === 'fire' ? fire : blood;
      const mine = circles.filter((c) => near.get(c) === label).sort((a, b) => dist(px(a.p3), px(sym.p3)) - dist(px(b.p3), px(sym.p3)));
      mine.forEach((c, i) => colName.set(c, i === 0 ? `${label}_hole_large` : i === 1 ? `${label}_hole_small` : 'unnamed'));
    }
    const colRight = circles.filter((c) => colName.get(c) === c.truth).length;
    const split = ['fire', 'blood'].map((l) => circles.filter((c) => near.get(c) === l).length).join('–');

    // axis + ticks
    const ext = 0.12, a0 = px(sub(fire.p3, mul(sep, ext))), a1 = px(add(blood.p3, mul(sep, ext)));
    s('line', { x1: a0[0], y1: a0[1], x2: a1[0], y2: a1[1], stroke: '#0f2633', 'stroke-width': 4, 'stroke-dasharray': '18 12', opacity: 0.6 }, svg);
    // Labels narrow with the board as it turns (as if painted on it), so neighbours' labels don't run together.
    const squeeze = (t, [x, y]) => {
      const k = Math.max(0.5, Math.cos((st.yaw * Math.PI) / 180));
      if (k < 0.999) t.setAttribute('transform', `translate(${x} 0) scale(${k} 1) translate(${-x} 0)`);
    };
    // symbols
    for (const it of P.filter((i) => i.cls !== 'circle')) {
      const q = px(it.p3);
      s('polygon', { points: disc(it, it.r * 0.85), fill: classColor(it.cls, 0.55), stroke: classColor(it.cls), 'stroke-width': 6 }, svg);
      const t = s('text', { x: q[0], y: q[1] + 12, 'text-anchor': 'middle', 'font-size': 38 }, svg);
      t.textContent = it.cls.replace('_', ' ');
      squeeze(t, q);
      t.style.fontSize = '38px';
      t.style.fill = '#0f2633';
      t.style.fontWeight = 600;
    }
    // openings
    for (const c of circles) {
      const q = px(c.p3);
      const ok = c.got === c.truth;
      const col = c.got.startsWith('fire') ? classColor('fire') : classColor('blood_hole_large');
      s('polygon', { points: disc(c, c.r), fill: 'rgba(43,111,125,0.6)', stroke: '#7a3b2e', 'stroke-width': 14 }, svg);
      s('polygon', { points: disc(c, c.r * 1.12), fill: 'none', stroke: col, 'stroke-width': 7 }, svg);
      // tick on the axis
      const foot = px(add(fire.p3, mul(sep, c.s)));
      s('line', { x1: q[0], y1: q[1], x2: foot[0], y2: foot[1], stroke: col, 'stroke-width': 3, opacity: 0.7 }, svg);
      s('circle', { cx: foot[0], cy: foot[1], r: 9, fill: col }, svg);
      const t = s('text', { x: q[0], y: q[1] + 14, 'text-anchor': 'middle', 'font-size': 40 }, svg);
      t.textContent = `${HOLE_LABEL[c.got]} ${ok ? '✓' : '✗'}`;
      squeeze(t, q);
      t.style.fontSize = '40px';
      t.style.fill = '#f3f7f7';
      t.style.fontWeight = 700;
      t.style.paintOrder = 'stroke';
      t.style.stroke = '#0f2633';
      t.style.strokeWidth = '8px';
    }
    const right = circles.filter((c) => c.got === c.truth).length;
    note.innerHTML = `<b>Axis sort: ${right} of 4 named right.</b> Nearest symbol in the image instead: ${colRight} of 4 (a ${split} split).`;
  }
  boardLayout('f0003_ffc').then((it) => { items = it; draw(); });
}

// ---------- published board on real frames ----------
{
  const FRAMES = [
    { name: 'f0003_ffc', label: 'Head-on' },
    { name: 'torpedo_near_0', label: 'Close' },
    { name: 'f0001_ffc', label: 'Board at 37°' },
    { name: 'torpedo_roll_0', label: 'Oblique' },
    { name: 'f0011_ffc', label: 'Passing' },
  ];
  const view = new FrameView(document.getElementById('torp-view'));
  const note = document.getElementById('torp-frame-note');
  const show = async (name) => {
    const f = await loadFrame(name);
    const g = view.show(f);
    view.drawDetections({ masks: false, labels: false, dim: true });
    const pubs = f.published.filter((p) => p.class === 'torpedo' || HOLES.includes(p.class));
    for (const p of pubs) {
      const [u, v] = view.project(p.p);
      const col = classColor(p.class);
      if (p.class === 'torpedo') {
        s('path', { d: `M${u - 34},${v}H${u + 34}M${u},${v - 34}V${v + 34}`, stroke: '#0f2633', 'stroke-width': 12 }, g);
        s('path', { d: `M${u - 30},${v}H${u + 30}M${u},${v - 30}V${v + 30}`, stroke: col, 'stroke-width': 6 }, g);
        view.tag(g, u + 20, v + 20, 'torpedo', col, true);
      } else {
        s('circle', { cx: u, cy: v, r: 14, fill: col, stroke: '#0f2633', 'stroke-width': 4 }, g);
        view.tag(g, u + 18, v - 4, HOLE_LABEL[p.class], col, true);
      }
    }
    const t = f.published.find((p) => p.class === 'torpedo');
    const q = t?.q;
    let tilt = '';
    if (q) {
      // body +z of the published orientation is the board normal
      const [x, y, z, w] = q;
      const nz = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
      tilt = `, board normal ${((Math.acos(Math.abs(nz[2])) * 180) / Math.PI).toFixed(0)}° from the camera axis`;
    }
    note.innerHTML = t ? `<b>torpedo</b> at ${t.p[2].toFixed(2)} m${tilt}; ${pubs.length - 1} openings named.` : 'No board published in this frame.';
  };
  picker(document.getElementById('torp-pick'), FRAMES, show);
  show(FRAMES[0].name);
}

// ---------- slalom ----------
{
  const view = new FrameView(document.getElementById('slalom-view'));
  loadFrame('slalom_0').then((f) => {
    const g = view.show(f);
    view.drawDetections({ labels: false });
    const pub = f.published.find((p) => p.class.startsWith('slalom'));
    const poles = f.boxes.filter((b) => b.class === 'slalom');
    let chosen = null;
    if (pub) {
      const [u, v] = view.project(pub.p);
      chosen = poles.reduce((a, b) => (Math.hypot(...center(b).map((c, i) => c - [u, v][i])) < Math.hypot(...center(a).map((c, i) => c - [u, v][i])) ? b : a));
    }
    for (const b of poles) {
      const [u, v] = center(b);
      s('circle', { cx: u, cy: v, r: 12, fill: '#f3f7f7', stroke: '#0f2633', 'stroke-width': 4 }, g);
      view.tag(g, b.box[2] + 10, b.box[1], b === chosen ? `published · ${pub.p[2].toFixed(2)} m` : `slalom ${b.score.toFixed(2)} · farther`, classColor('slalom'), true);
    }
    document.getElementById('slalom-note').innerHTML = pub
      ? `<b>${poles.length} poles</b> detected; the published one is ${pub.p[2].toFixed(2)} m away, depth read at its box's centre pixel (white dot).`
      : 'No slalom published in this frame.';
  });
}
