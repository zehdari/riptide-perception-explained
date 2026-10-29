import { setup } from '../layout.js';
import '../css/detector.css';
import { loadFrame, picker, s, BASE } from '../viz/detector_frames.js';
import { runBox } from '../viz/pose_sample.js';
import { Cloud3D } from '../viz/pose3d.js';
import { ray_plane_intersection, fit_plane } from '../engine/geometry.js';

setup();

// Objects to run the path on: a frame from public/data/frames and the class of one of its boxes.
const PICKS = [
  { name: 'f0028_dfc', cls: 'helmet', label: 'Basket over the floor', bleed: 32 },
  { name: 'f0001_ffc', cls: 'fire', label: 'Board at 37°' },
  { name: 'f0003_ffc', cls: 'fire_engine', label: 'Board head-on' },
  { name: 'f0010_ffc', cls: 'fire', label: 'Cut-off symbol' },
  { name: 'f0033_dfc', cls: 'nut_and_bolt', label: 'Cylinder top' },
  { name: 'f0082_dfc', cls: 'blood', label: 'Bin vinyl' },
];

const FATE = {
  kept: ['--state', 'kept, in the fit'],
  gate: ['--accent', 'removed by the depth gate'],
  outlier: ['--s4', 'removed by an outlier pass'],
  nodepth: ['--muted', 'no valid depth'],
};
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
document.getElementById('pose-keys').innerHTML =
  Object.values(FATE).map(([v, t]) => `<span><i style="background:var(${v})"></i>${t}</span>`).join('') +
  '<span><i style="background:transparent;box-shadow:inset 0 0 0 2px var(--s7)"></i>given edge bleed</span>';

const opts = { gate: true, outliers: true, bleed: 0, grow: 0 };
const crop = s('svg', { class: 'diagram', role: 'img', 'aria-label': 'Grid samples on the object' }, document.getElementById('pose-crop'));
crop.style.borderRadius = '6px';
crop.style.overflow = 'hidden';
crop.style.maxHeight = '30rem';
const cloud = new Cloud3D(document.getElementById('pose-3d'));
const readout = document.getElementById('pose-readout');
let frame = null, box = null, ref = null;

const deg = (n) => (Math.acos(Math.min(1, Math.abs(n[2]))) * 180) / Math.PI;
const angle = (a, b) => (Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;

function render() {
  if (!frame) return;
  const r = runBox(frame, box, opts);
  // crop around the box
  const [x0, y0, x1, y1] = box.box;
  const pad = Math.max(40, 0.12 * Math.max(x1 - x0, y1 - y0));
  const vx = Math.max(0, x0 - pad), vy = Math.max(0, y0 - pad);
  const vw = Math.min(frame.size[0], x1 + pad) - vx, vh = Math.min(frame.size[1], y1 + pad) - vy;
  crop.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
  crop.replaceChildren();
  s('image', { href: `${BASE}data/frames/${frame.name}.webp`, x: 0, y: 0, width: frame.size[0], height: frame.size[1], preserveAspectRatio: 'none' }, crop);
  const k = vw / 500; // stroke and dot sizes in screen-ish units
  s('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: 'none', stroke: '#f3f7f7', 'stroke-width': 1.5 * k, 'stroke-dasharray': `${5 * k} ${4 * k}` }, crop);
  if (box.mask.length > 2) s('polygon', { points: box.mask.map((p) => p.join(',')).join(' '), fill: 'rgba(243,247,247,0.12)', stroke: '#f3f7f7', 'stroke-width': 1.5 * k }, crop);
  for (const sm of r.samples) {
    const col = css(FATE[sm.fate][0]);
    const c = s('circle', { cx: sm.px[0], cy: sm.px[1], r: (sm.fate === 'kept' ? 2.6 : 3.4) * k, fill: sm.fate === 'nodepth' ? 'none' : col, stroke: sm.bled ? css('--s7') : sm.fate === 'nodepth' ? col : 'none', 'stroke-width': 1.6 * k }, crop);
    c.style.opacity = sm.fate === 'kept' ? 0.9 : 1;
  }
  // box centre: the pixel the published position is back-projected from
  const [ub, vb] = [(x0 + x1) / 2, (y0 + y1) / 2];
  s('path', { d: `M${ub - 9 * k},${vb}H${ub + 9 * k}M${ub},${vb - 9 * k}V${vb + 9 * k}`, stroke: '#0f2633', 'stroke-width': 3 * k }, crop);
  s('path', { d: `M${ub - 8 * k},${vb}H${ub + 8 * k}M${ub},${vb - 8 * k}V${vb + 8 * k}`, stroke: '#f3f7f7', 'stroke-width': 1.4 * k }, crop);

  cloud.set({ samples: r.samples, fit: r.fit, ref: r.fit && ref && angle(r.fit.normal, ref) > 0.5 ? ref : null });

  const n = { kept: 0, gate: 0, outlier: 0, nodepth: 0 };
  r.samples.forEach((x) => n[x.fate]++);
  const bled = r.samples.filter((x) => x.bled).length;
  let rp = '–';
  if (r.fit) {
    const [nn, , c3] = fit_plane(r.kept.map((x) => x.p));
    const K = [[frame.K[0], 0, frame.K[2]], [0, frame.K[4], frame.K[5]], [0, 0, 1]];
    const [p] = ray_plane_intersection(ub, vb, K, nn, c3);
    if (p) rp = `${(Math.hypot(...r.fit.centroid.map((v, i) => v - p[i])) * 1000).toFixed(1)} mm`;
  }
  readout.innerHTML = [
    ['Samples', `${r.samples.length}${bled ? ` (${bled} bled)` : ''}`],
    ['Gate / outliers', `${n.gate} / ${n.outlier} removed`],
    ['Kept', `${n.kept} points`],
    ['Normal vs camera axis', r.fit ? `${deg(r.fit.normal).toFixed(1)}°` : 'no fit'],
    ['Change from clean fit', r.fit && ref ? `${angle(r.fit.normal, ref).toFixed(1)}°` : '–'],
    ['Centroid depth', r.fit ? `${r.fit.centroid[2].toFixed(3)} m` : '–'],
    ['Centroid vs ray–plane', rp],
  ].map(([a, b]) => `<div>${a}<b>${b}</b></div>`).join('');
}

// controls
{
  const host = document.getElementById('pose-controls');
  const check = (key, label) => {
    const l = document.createElement('label');
    l.innerHTML = `<input type="checkbox" checked> ${label}`;
    const i = l.querySelector('input');
    i.onchange = () => { opts[key] = i.checked; render(); };
    host.appendChild(l);
  };
  const slider = (key, label, max) => {
    const l = document.createElement('label');
    l.innerHTML = `${label} <input type="range" min="0" max="${max}" step="2" value="${opts[key]}"><output></output>`;
    const i = l.querySelector('input'), o = l.querySelector('output');
    const upd = () => { opts[key] = +i.value; o.textContent = `${i.value} px`; };
    i.oninput = () => { upd(); render(); };
    upd();
    host.appendChild(l);
    return { set: (v) => { i.value = v; upd(); } };
  };
  check('gate', 'Depth gate');
  check('outliers', 'Outlier passes');
  const bleed = slider('bleed', 'Edge bleed', 40);
  slider('grow', 'Grow mask', 40);

  const pick = async (name, it) => {
    frame = await loadFrame(name);
    box = frame.boxes.find((b) => b.class === it.cls);
    ref = runBox(frame, box).fit?.normal ?? null;
    opts.bleed = it.bleed ?? 0;
    bleed.set(opts.bleed);
    render();
  };
  picker(document.getElementById('pose-pick'), PICKS, pick);
  pick(PICKS[0].name, PICKS[0]);
}
