import { setup } from '../layout.js';
import { s, BASE, classColor, picker } from '../viz/detector_frames.js';
import '../css/vision.css';

setup();
const samples = await fetch(`${BASE}data/train_samples.json`).then((r) => r.json());
const byName = Object.fromEntries(samples.map((x) => [x.name, x]));
const LABEL = { torpedo: 'Torpedo board', slalom: 'Slalom', gate: 'Gate', bins: 'Bins (forward)', surface: 'Octagon', background: 'Background', table: 'Table (down)' };
const labelOf = (x) => (x.cam === 'dfc' && x.name.startsWith('bins') ? 'Bins (down)' : LABEL[x.name.split('_')[0]] || x.name);
const images = {};
const loadImg = (name) => (images[name] ||= new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = `${BASE}img/train/${name}.webp`; }));

// ---------- gallery: images with their label polygons ----------
{
  const host = document.getElementById('gallery-view');
  const note = document.getElementById('gallery-note');
  const wrap = document.createElement('div');
  wrap.className = 'frameview';
  const img = document.createElement('img');
  const svg = s('svg', { viewBox: '0 0 1920 1200', preserveAspectRatio: 'none' });
  wrap.append(img, svg);
  host.appendChild(wrap);
  const show = (name) => {
    const x = byName[name];
    img.src = `${BASE}img/train/${name}.webp`;
    img.alt = `Nereus synthetic ${x.cam} training image, labels: ${x.labels.map((l) => l[0]).join(', ') || 'none'}`;
    svg.replaceChildren();
    for (const [cls, pts] of x.labels) {
      const P = [];
      for (let i = 0; i < pts.length; i += 2) P.push(`${(pts[i] * 1920).toFixed(1)},${(pts[i + 1] * 1200).toFixed(1)}`);
      s('polygon', { points: P.join(' '), fill: 'none', stroke: 'rgba(255,255,255,0.9)', 'stroke-width': 6, 'vector-effect': 'non-scaling-stroke' }, svg);
      s('polygon', { points: P.join(' '), fill: classColor(cls, 0.28), stroke: classColor(cls), 'stroke-width': 2.5, 'vector-effect': 'non-scaling-stroke' }, svg);
    }
    const counts = {};
    x.labels.forEach(([c]) => (counts[c] = (counts[c] || 0) + 1));
    note.innerHTML = `<b>${x.cam === 'ffc' ? 'Forward' : 'Downward'} camera</b>, <code>${x.name}.jpg</code>: ${Object.entries(counts).map(([c, n]) => `${n} × <code>${c}</code>`).join(', ') || 'no labels (a background image)'}.`;
  };
  picker(document.getElementById('gallery-pick'), samples.map((x) => ({ name: x.name, label: labelOf(x) })), show, 0);
  show(samples[0].name);
}

// ---------- augmentation playground ----------
{
  const canvas = document.getElementById('aug-canvas');
  const ctx = canvas.getContext('2d');
  const note = document.getElementById('aug-note');
  const W = 960, H = 600;
  const pool = samples.filter((x) => x.labels.length && x.cam === 'ffc');
  const st = { name: pool[0].name, rot: 0, zoom: 1, flip: false, hue: 0, sat: 1, val: 1, mode: 'single', seed: 1 };
  const NO_ROT = (x) => x.labels.some(([c]) => c === 'slalom');
  await Promise.all(pool.map((p) => loadImg(p.name))); // all loaded up front, so a redraw never interleaves with another

  const ctl = document.getElementById('aug-controls');
  const mk = (label, min, max, step, key, fmt) => {
    const l = document.createElement('label');
    l.innerHTML = `${label} <input type="range" min="${min}" max="${max}" step="${step}" value="${st[key]}"> <output>${fmt(st[key])}</output>`;
    const inp = l.querySelector('input'), out = l.querySelector('output');
    inp.oninput = () => { st[key] = +inp.value; out.textContent = fmt(st[key]); draw(); };
    ctl.appendChild(l);
    return { l, inp, out, reset: () => { inp.value = st[key]; out.textContent = fmt(st[key]); } };
  };
  const rot = mk('Rotate', -30, 30, 1, 'rot', (v) => `${v}°`);
  const rotNote = document.createElement('span');
  rotNote.className = 'disabled-note';
  rot.l.appendChild(rotNote);
  const zoom = mk('Zoom', 0.6, 2, 0.01, 'zoom', (v) => `${v.toFixed(2)}×`);
  const hue = mk('Hue', -30, 30, 1, 'hue', (v) => `${v}°`);
  const sat = mk('Saturation', 0.3, 1.7, 0.01, 'sat', (v) => `${v.toFixed(2)}×`);
  const val = mk('Brightness', 0.6, 1.4, 0.01, 'val', (v) => `${v.toFixed(2)}×`);
  const btn = (text, on) => { const b = document.createElement('button'); b.className = 'btn'; b.type = 'button'; b.textContent = text; b.onclick = on; ctl.appendChild(b); return b; };
  const flipB = btn('Mirror', () => { st.flip = !st.flip; flipB.setAttribute('aria-pressed', String(st.flip)); draw(); });
  const modeSeg = document.createElement('span');
  modeSeg.className = 'seg';
  for (const [m, t] of [['single', 'One image'], ['mosaic', 'Mosaic'], ['paste', 'Copy-paste']]) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = t; b.setAttribute('aria-pressed', String(m === st.mode));
    b.onclick = () => { st.mode = m; modeSeg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); draw(); };
    modeSeg.appendChild(b);
  }
  ctl.appendChild(modeSeg);
  btn('Shuffle', () => { st.seed++; draw(); });
  btn('Reset', () => { Object.assign(st, { rot: 0, zoom: 1, flip: false, hue: 0, sat: 1, val: 1 }); [rot, zoom, hue, sat, val].forEach((c) => c.reset()); flipB.setAttribute('aria-pressed', 'false'); draw(); });

  picker(document.getElementById('aug-pick'), pool.map((x) => ({ name: x.name, label: labelOf(x) })), (n) => { st.name = n; draw(); }, 0);

  let rng;
  const rand = () => ((rng = (rng * 1103515245 + 12345) >>> 0) >>> 8) / 16777216;

  // Draw one sample into a rectangle with the current geometric transform; return its polygons in canvas pixels.
  function drawSample(im, x, rect, { geo = true, clipTo = null, paint = true, box = true } = {}) {
    const [rx, ry, rw, rh] = rect;
    const T = new DOMMatrix().translate(rx + rw / 2, ry + rh / 2);
    if (geo) {
      T.rotateSelf(st.rot).scaleSelf(st.zoom * (st.flip ? -1 : 1), st.zoom);
    }
    T.scaleSelf(rw / 1920, rh / 1200).translateSelf(-960, -600);
    if (paint) {
      ctx.save();
      if (box) { ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip(); }
      if (clipTo) { ctx.beginPath(); clipTo.forEach((poly) => { poly.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b))); ctx.closePath(); }); ctx.clip(); }
      ctx.setTransform(T);
      ctx.drawImage(im, 0, 0, 1920, 1200);
      ctx.restore();
    }
    return x.labels.map(([cls, pts]) => {
      const poly = [];
      for (let i = 0; i < pts.length; i += 2) { const p = T.transformPoint(new DOMPoint(pts[i] * 1920, pts[i + 1] * 1200)); poly.push([p.x, p.y]); }
      return [cls, poly];
    });
  }
  const strokePolys = (polys, rect) => {
    ctx.save();
    if (rect) { ctx.beginPath(); ctx.rect(...rect); ctx.clip(); }
    for (const [cls, poly] of polys) {
      ctx.beginPath(); poly.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b))); ctx.closePath();
      ctx.fillStyle = classColor(cls, 0.22); ctx.fill();
      ctx.lineWidth = 4.5; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke();
      ctx.lineWidth = 2; ctx.strokeStyle = classColor(cls); ctx.stroke();
    }
    ctx.restore();
  };
  // Colour jitter on the pixels (as the trainer's HSV augmentation does): hue rotation, saturation, brightness.
  // Done by hand because canvas filters don't work in Safari.
  function colour() {
    if (st.hue === 0 && st.sat === 1 && st.val === 1) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const img = ctx.getImageData(0, 0, W, H), d = img.data;
    const a = (st.hue * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    // hue rotation in YIQ, then saturation about the luma, then brightness
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      let I = 0.596 * r - 0.274 * g - 0.322 * b, Q = 0.211 * r - 0.523 * g + 0.312 * b;
      [I, Q] = [(I * c - Q * s) * st.sat, (I * s + Q * c) * st.sat];
      d[i] = (y + 0.956 * I + 0.621 * Q) * st.val;
      d[i + 1] = (y - 0.272 * I - 0.647 * Q) * st.val;
      d[i + 2] = (y - 1.106 * I + 1.703 * Q) * st.val;
    }
    ctx.putImageData(img, 0, 0);
  }
  // A stand-in "unrelated" scene: sky, floor and simple shapes that are not RoboSub props
  function unrelated() {
    ctx.fillStyle = '#d8cfc0'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#9db7c9'; ctx.fillRect(0, 0, W, H * 0.45);
    ctx.fillStyle = '#7d6a55'; ctx.fillRect(0, H * 0.72, W, H * 0.28);
    const cols = ['#c0392b', '#2e86c1', '#f1c40f', '#27ae60', '#8e44ad', '#e67e22', '#34495e'];
    for (let i = 0; i < 14; i++) {
      ctx.fillStyle = cols[Math.floor(rand() * cols.length)];
      const x = rand() * W, y = H * 0.3 + rand() * H * 0.6, r = 18 + rand() * 60;
      ctx.beginPath();
      if (rand() < 0.5) ctx.arc(x, y, r, 0, Math.PI * 2); else ctx.rect(x - r, y - r * 1.4, r * (1 + rand()), r * 2);
      ctx.fill();
    }
  }

  async function draw() {
    const x = byName[st.name];
    const locked = NO_ROT(x);
    rot.inp.disabled = locked;
    rotNote.textContent = locked ? ' locked: slalom is never rotated' : '';
    if (locked && st.rot !== 0) { st.rot = 0; rot.reset(); }
    rng = st.seed * 7919;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgb(114,114,114)'; // the trainer pads with grey
    ctx.fillRect(0, 0, W, H);
    let polys = [], used = [x.name];
    if (st.mode === 'single') {
      polys = drawSample(await loadImg(x.name), x, [0, 0, W, H]);
      colour();
      strokePolys(polys, [0, 0, W, H]);
    } else if (st.mode === 'mosaic') {
      // Ultralytics' mosaic: four images around a random centre point
      const others = pool.filter((p) => p.name !== x.name);
      const four = [x, ...[0, 1, 2].map(() => others[Math.floor(rand() * others.length)])];
      used = four.map((p) => p.name);
      const cx = W * (0.3 + 0.4 * rand()), cy = H * (0.3 + 0.4 * rand());
      const rects = [[0, 0, cx, cy], [cx, 0, W - cx, cy], [0, cy, cx, H - cy], [cx, cy, W - cx, H - cy]];
      const all = [];
      for (let i = 0; i < 4; i++) {
        const im = await loadImg(four[i].name);
        const [rx, ry, rw, rh] = rects[i];
        // each quadrant shows its image at mosaic scale, cropped to the quadrant
        const sc = Math.max(rw / W, rh / H, 0.5);
        const full = [rx + rw / 2 - (W * sc) / 2, ry + rh / 2 - (H * sc) / 2, W * sc, H * sc];
        ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip();
        const p = drawSample(im, four[i], full, { geo: i === 0 });
        ctx.restore();
        all.push([p, rects[i]]);
      }
      colour();
      all.forEach(([p, r]) => strokePolys(p, r));
      polys = all.flatMap(([p]) => p);
    } else {
      unrelated();
      const im = await loadImg(x.name);
      // paste the props, smaller, somewhere random
      const sc = 0.45 + 0.35 * rand();
      const rect = [rand() * W * (1 - sc), rand() * H * (1 - sc), W * sc, H * sc];
      const T0 = drawSample(im, x, rect, { geo: true, paint: false });
      // clip only to the masks (not the paste box), so a zoomed paste and its labels stay together
      drawSample(im, x, rect, { geo: true, clipTo: T0.map(([, p]) => p), box: false });
      colour();
      strokePolys(T0, [0, 0, W, H]);
      polys = T0;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const n = polys.filter(([, p]) => p.some(([a, b]) => a >= 0 && a <= W && b >= 0 && b <= H)).length;
    note.innerHTML = `${st.mode === 'mosaic' ? `Mosaic of <code>${used.join('</code>, <code>')}</code>. ` : ''}<b>${n}</b> label${n === 1 ? '' : 's'} in the result${st.mode === 'paste' ? ', on a scene with nothing to detect: everything outside them is an example of "not a prop"' : ''}. Labels that leave the image are clipped or dropped, as the trainer does.`;
  }
  draw();
}
