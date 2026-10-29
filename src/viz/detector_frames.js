// A Nereus frame (tools/frame_pipeline.py output) with YOLO's masks, boxes and labels drawn over it in SVG.
// Shared by chapters 1–3.
const NS = 'http://www.w3.org/2000/svg';
export const BASE = import.meta.env.BASE_URL;

// tensor_detector/src/colors.py COLOR_MAP (RViz marker colours, keyed by class), as CSS
const C = {
  slalom: [1, 0, 0], slalom_front: [0, 1, 0.4], gate_repair: [0, 1, 0], gate_rescue: [0, 0.5, 1], torpedo: [0, 1, 1],
  fire_hole_large: [1, 0.4, 0], fire_hole_small: [1, 0.7, 0], blood_hole_large: [0.6, 0, 0], blood_hole_small: [1, 0, 0.4],
  ambulance: [1, 0, 1], fire_engine: [1, 0.2, 0.2], buoy: [0.2, 0.8, 1], compass: [0.9, 0.6, 0.1],
  hammer_and_wrench: [0.4, 0.4, 0.45], sos: [1, 0.1, 0.3], bandage: [0.95, 0.85, 0.7], blood: [0.8, 0, 0], fire: [1, 0.5, 0],
  helmet: [1, 1, 0], nut_and_bolt: [0.5, 0.5, 0.5], pill: [0.7, 0.2, 0.9], plug: [0, 0.4, 1], warning: [1, 0, 1],
  circle: [0.95, 0.95, 0.95], magnet: [1, 0.2, 0.2], table: [0.3, 0.9, 0.5],
};
export const classColor = (name, a = 1) => {
  const c = C[name] || [1, 1, 1];
  return `rgba(${c.map((v) => Math.round(v * 255)).join(',')},${a})`;
};

export const s = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

const cache = new Map();
export function loadFrame(name) {
  if (!cache.has(name)) cache.set(name, fetch(`${BASE}data/frames/${name}.json`).then((r) => r.json()));
  return cache.get(name);
}

// A frame view: image + an SVG in image pixel coordinates (1920×1200) on top.
export class FrameView {
  constructor(host) {
    this.wrap = document.createElement('div');
    this.wrap.className = 'frameview';
    this.img = document.createElement('img');
    this.img.alt = '';
    this.img.decoding = 'async';
    this.svg = s('svg', { viewBox: '0 0 1920 1200', preserveAspectRatio: 'none' });
    this.wrap.append(this.img, this.svg);
    host.appendChild(this.wrap);
  }
  show(frame) {
    this.frame = frame;
    const [W, H] = frame.size;
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.wrap.style.aspectRatio = `${W} / ${H}`;
    this.img.src = `${BASE}data/frames/${frame.name}.webp`;
    this.img.alt = `Nereus ${frame.cam} camera frame: ${frame.boxes.map((b) => b.class).join(', ') || 'no detections'}`;
    this.svg.replaceChildren();
    this.layer = s('g', {}, this.svg);
    return this.layer;
  }
  // YOLO's output: masks (filled), boxes (outlined) and "class 0.95" tags.
  drawDetections({ masks = true, boxes = true, labels = true, dim = false, only } = {}) {
    const g = s('g', { class: 'dets' }, this.svg);
    for (const b of this.frame.boxes) {
      if (only && !only(b)) continue;
      const col = classColor(b.class);
      if (masks && b.mask.length > 2) {
        s('polygon', { points: b.mask.map((p) => p.join(',')).join(' '), fill: classColor(b.class, dim ? 0.12 : 0.3), stroke: col, 'stroke-width': 3, 'vector-effect': 'non-scaling-stroke' }, g);
      }
      const [x0, y0, x1, y1] = b.box;
      if (boxes) s('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: 'none', stroke: col, 'stroke-width': 2, 'stroke-dasharray': dim ? '6 6' : 'none', 'vector-effect': 'non-scaling-stroke' }, g);
      if (labels) this.tag(g, x0, y0, `${b.class} ${b.score.toFixed(2)}`, col);
    }
    return g;
  }
  tag(g, x, y, text, col, below = false) {
    const fs = 30, w = text.length * fs * 0.56 + 16;
    const ty = below ? y + 4 : Math.max(0, y - fs - 10);
    const t = s('g', { class: 'tag' }, g);
    s('rect', { x, y: ty, width: w, height: fs + 10, rx: 6, fill: 'rgba(15,38,51,0.82)' }, t);
    s('rect', { x, y: ty, width: 8, height: fs + 10, rx: 3, fill: col }, t);
    const tx = s('text', { x: x + 14, y: ty + fs - 2, fill: '#f3f7f7', 'font-size': fs, 'font-family': 'Archivo Variable, sans-serif' }, t);
    tx.textContent = text;
    return t;
  }
  // camera-frame point -> image pixel
  project(p) {
    const K = this.frame.K;
    return [(K[0] * p[0]) / p[2] + K[2], (K[4] * p[1]) / p[2] + K[5]];
  }
}

// Segmented frame picker: [{name, label}], calls onPick(name)
export function picker(host, items, onPick, start = 0) {
  const seg = document.createElement('div');
  seg.className = 'seg';
  seg.setAttribute('role', 'group');
  const buttons = items.map((it, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = it.label;
    b.setAttribute('aria-pressed', String(i === start));
    b.onclick = () => {
      buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      onPick(it.name, it);
    };
    seg.appendChild(b);
    return b;
  });
  host.appendChild(seg);
  return seg;
}
