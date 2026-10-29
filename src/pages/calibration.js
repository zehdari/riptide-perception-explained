import { setup } from '../layout.js';
import { LineChart } from '../viz/chart.js';
import { s, BASE } from '../viz/detector_frames.js';
import '../css/vision.css';

setup();
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function slider(host, label, min, max, step, value, fmt, onInput) {
  const l = document.createElement('label');
  l.innerHTML = `${label} <input type="range" min="${min}" max="${max}" step="${step}" value="${value}"> <output></output>`;
  const input = l.querySelector('input'), out = l.querySelector('output');
  const upd = () => { out.textContent = fmt(+input.value); onInput(+input.value); };
  input.addEventListener('input', upd);
  host.appendChild(l);
  out.textContent = fmt(value);
  return { input, set: (v) => { input.value = v; out.textContent = fmt(v); } };
}
function seg(host, options, value, onPick) {
  const sp = document.createElement('span');
  sp.className = 'seg';
  for (const [v, text] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-pressed', String(v === value));
    b.onclick = () => { sp.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); onPick(v); };
    sp.appendChild(b);
  }
  host.appendChild(sp);
  return sp;
}

// ---------- the pinhole, from the side ----------
{
  const svg = document.getElementById('pin-svg');
  const note = document.getElementById('pin-note');
  const O = [330, 165], M = 90, HALF = 42; // optical centre, px per metre, sensor half-height (= 600 px)
  let f = 1702.4, P = [3.0, 0.7]; // focal length (px); point (z, y) in metres, y down
  const cy = 579.4;
  slider(document.getElementById('pin-controls'), 'Focal length', 800, 2600, 1, f, (v) => `${v.toFixed(0)} px`, (v) => { f = v; draw(); });
  const toSvg = ([z, y]) => [O[0] + z * M, O[1] + y * M];
  const fromSvg = (x, y) => [Math.min(6, Math.max(0.4, (x - O[0]) / M)), Math.min(1.7, Math.max(-1.7, (y - O[1]) / M))];
  function draw() {
    svg.replaceChildren();
    const fs = (HALF * f) / 600; // sensor distance behind the centre, in svg units
    const ink = css('--ink'), muted = css('--muted'), acc = css('--accent');
    // field of view
    for (const sgn of [-1, 1]) {
      const slope = (sgn * 600) / f;
      s('line', { x1: O[0] - fs, y1: O[1] - sgn * HALF, x2: O[0] + 6.2 * M, y2: O[1] + slope * 6.2 * M, stroke: css('--rule'), 'stroke-width': 1.5 }, svg);
    }
    s('line', { x1: 40, y1: O[1], x2: 880, y2: O[1], stroke: css('--rule'), 'stroke-dasharray': '3 4' }, svg);
    // labels keep ~9.5 css px on a phone (the drawing is 900 units wide)
    const fz = Math.max(13, (9.5 * 900) / (svg.clientWidth || 900));
    const label = (attrs, text) => { const e = s('text', { class: 'halo', ...attrs }, svg); e.style.fontSize = `${fz}px`; e.textContent = text; return e; };
    const [px, py] = toSvg(P);
    const t = P[1] / P[0];
    // camera body and sensor
    s('rect', { x: O[0] - fs - 14, y: O[1] - HALF - 10, width: fs + 14, height: 2 * HALF + 20, rx: 6, fill: css('--paper-3'), stroke: muted }, svg);
    s('line', { x1: O[0] - fs, y1: O[1] - HALF, x2: O[0] - fs, y2: O[1] + HALF, stroke: ink, 'stroke-width': 4 }, svg);
    s('circle', { cx: O[0], cy: O[1], r: 4, fill: ink }, svg);
    // f label
    const fy = O[1] + HALF + 31 + fz;
    s('line', { x1: O[0] - fs, y1: fy, x2: O[0], y2: fy, stroke: muted }, svg);
    // the ray
    const ys = O[1] - fs * t;
    const hit = Math.abs(t * f) <= 600;
    s('line', { x1: O[0] - fs, y1: ys, x2: px, y2: py, stroke: hit ? acc : muted, 'stroke-width': 2 }, svg);
    s('line', { x1: px, y1: py, x2: O[0] + 6.4 * M, y2: O[1] + t * 6.4 * M, stroke: acc, 'stroke-width': 1.5, 'stroke-dasharray': '5 5', opacity: 0.6 }, svg);
    if (hit) s('circle', { cx: O[0] - fs, cy: ys, r: 5, fill: acc }, svg);
    const g = s('g', { style: 'cursor:grab' }, svg);
    s('circle', { cx: px, cy: py, r: 16, fill: acc, opacity: 0.15 }, g);
    s('circle', { cx: px, cy: py, r: 7, fill: acc }, g);
    // labels last, so no line runs through them; "optical centre" sits on the side of the axis the ray isn't
    label({ x: 860, y: O[1] - 8, 'text-anchor': 'end' }, 'z (lens axis)');
    label({ x: O[0] - fs - 18, y: O[1] + HALF + 17 + fz, 'text-anchor': 'middle' }, 'sensor');
    label({ x: O[0] + 6, y: t > 0 ? O[1] - 8 : O[1] + 7 + fz }, 'optical centre');
    label({ x: O[0] - fs / 2, y: fy + 5 + fz, 'text-anchor': 'middle' }, 'f');
    const v = f * t + cy;
    note.innerHTML = `Point at <b>z = ${P[0].toFixed(2)} m</b>, <b>y = ${P[1].toFixed(2)} m</b> (below the axis is +y). ` +
      (hit ? `It lands on row <b>v = ${f.toFixed(0)} × ${t.toFixed(3)} + ${cy} = ${v.toFixed(0)}</b> of 1200.` : `It falls outside the 1200-row image: this camera can't see it.`);
  }
  let drag = false;
  const pick = (e) => {
    const r = svg.getBoundingClientRect();
    P = fromSvg(((e.clientX - r.left) / r.width) * 900, ((e.clientY - r.top) / r.height) * 330);
    draw();
  };
  svg.addEventListener('pointerdown', (e) => { drag = true; svg.setPointerCapture(e.pointerId); pick(e); });
  svg.addEventListener('pointermove', (e) => { if (drag) pick(e); });
  svg.addEventListener('pointerup', () => (drag = false));
  svg.style.touchAction = 'none';
  draw();
  new ResizeObserver(() => draw()).observe(svg);
}

// ---------- distortion: a rectified frame run back through the lens model ----------
// The ZED publishes rectified images: the SDK has already undistorted the raw image with the calibration and resampled
// it to the rectified intrinsics (cv2.stereoRectify's P), with zero distortion. Nereus renders exactly that. So to show
// the raw image the sensor records, each raw pixel is undistorted with the RAW intrinsics and D, then looked up in the
// rectified frame with the RECTIFIED intrinsics. Applying D to the rectified image directly would distort it a second time.
{
  const canvas = document.getElementById('dist-canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const note = document.getElementById('dist-note');
  const W = 960, H = 600, S = 0.5; // half-size frames
  // raw lens intrinsics + distortion from the calibration files, and the rectified intrinsics Nereus renders with
  const CAMS = {
    ffc: { raw: [1701.5, 1702.4, 935.2, 579.4], rect: [1863.934, 1863.934, 955.847, 584.796], D: [0.268, 0.0605, 0, 0, -1.036], frame: 'torpedo_near_0' },
    dfc: { raw: [1695.2, 1669.1, 948.0, 616.1], rect: [1857.539, 1857.539, 974.883, 604.222], D: [0.2585, -0.238, -0.0016, -0.00086, 0], frame: 'f0013_dfc' },
  };
  let cam = 'ffc', lens = 'ffc', view = 'raw', gain = 1, D = CAMS.ffc.D.slice();
  const srcs = {};
  const ctl = document.getElementById('dist-controls');
  seg(ctl, [['raw', 'Raw, from the sensor'], ['rect', 'Rectified, what the detector gets']], 'raw', (v) => { view = v; draw(); });
  seg(ctl, [['none', 'Ideal lens'], ['ffc', 'Talos ffc'], ['dfc', 'Talos dfc']], 'ffc', (k) => {
    lens = k;
    if (k !== 'none') cam = k;
    D = k === 'none' ? [0, 0, 0, 0, 0] : CAMS[k].D.slice();
    sync(); load(); draw();
  });
  seg(ctl, [[1, '×1'], [3, '×3']], 1, (g) => { gain = g; draw(); });
  const sl = [
    ['k₁', -0.6, 0.6, 0.001], ['k₂', -0.6, 0.6, 0.001], ['p₁', -0.02, 0.02, 0.0001], ['p₂', -0.02, 0.02, 0.0001], ['k₃', -1.5, 1.5, 0.001],
  ].map(([name, a, b, st], i) => slider(ctl, name, a, b, st, D[i], (v) => v.toFixed(i === 2 || i === 3 ? 4 : 3), (v) => { D[i] = v; draw(); }));
  const sync = () => sl.forEach((x, i) => x.set(D[i]));
  const distort = (x, y, k) => {
    const [k1, k2, p1, p2, k3] = k;
    const r2 = x * x + y * y, rad = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
    return [x * rad + 2 * p1 * x * y + p2 * (r2 + 2 * x * x), y * rad + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y];
  };
  const undistort = (xd, yd, k) => {
    let x = xd, y = yd;
    for (let it = 0; it < 12; it++) { const [dx, dy] = distort(x, y, k); x += xd - dx; y += yd - dy; }
    return [x, y];
  };
  const Ks = () => {
    const c = CAMS[cam];
    const rect = c.rect.map((v) => v * S);
    // an ideal lens has no separate raw intrinsics: raw and rectified are the same image
    const raw = lens === 'none' ? rect : c.raw.map((v) => v * S);
    return { raw, rect };
  };
  function load() {
    const name = CAMS[cam].frame;
    if (srcs[name]) return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, W, H);
      srcs[name] = g.getImageData(0, 0, W, H);
      draw();
    };
    img.src = `${BASE}data/frames/${name}.webp`;
  }
  let pending = false;
  function draw() {
    const src = srcs[CAMS[cam].frame];
    if (!src || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const k = D.map((v) => v * gain);
      const { raw, rect } = Ks();
      const [fx, fy, cx, cy] = raw, [rfx, rfy, rcx, rcy] = rect;
      if (view === 'rect') {
        ctx.putImageData(src, 0, 0);
      } else {
        const out = ctx.createImageData(W, H), o = out.data, si = src.data;
        for (let v = 0; v < H; v++) {
          for (let u = 0; u < W; u++) {
            // raw pixel -> where that ray lands in the rectified image
            const [x, y] = undistort((u - cx) / fx, (v - cy) / fy, k);
            const su = Math.round(rfx * x + rcx), sv = Math.round(rfy * y + rcy);
            const j = (v * W + u) * 4;
            if (su >= 0 && su < W && sv >= 0 && sv < H) {
              const i = (sv * W + su) * 4;
              o[j] = si[i]; o[j + 1] = si[i + 1]; o[j + 2] = si[i + 2]; o[j + 3] = 255;
            } else { o[j] = 15; o[j + 1] = 38; o[j + 2] = 51; o[j + 3] = 255; }
          }
        }
        ctx.putImageData(out, 0, 0);
      }
      // a grid that is straight in the scene, drawn where this view puts it
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.2;
      const toPx = view === 'rect'
        ? (x, y) => [rfx * x + rcx, rfy * y + rcy]
        : (x, y) => { const [a, b] = distort(x, y, k); return [fx * a + cx, fy * b + cy]; };
      for (let i = 0; i <= 12; i++) {
        const X = ((i / 12) * W - rcx) / rfx;
        ctx.beginPath();
        for (let j = 0; j <= 40; j++) { const P = toPx(X, ((j / 40) * H - rcy) / rfy); j ? ctx.lineTo(...P) : ctx.moveTo(...P); }
        ctx.stroke();
      }
      for (let i = 0; i <= 8; i++) {
        const Y = ((i / 8) * H - rcy) / rfy;
        ctx.beginPath();
        for (let j = 0; j <= 60; j++) { const P = toPx(((j / 60) * W - rcx) / rfx, Y); j ? ctx.lineTo(...P) : ctx.moveTo(...P); }
        ctx.stroke();
      }
      if (view === 'rect') {
        note.innerHTML = 'The rectified image: lines that are straight in the pool are straight here. This is what the ZED publishes and what Nereus renders, with the rectified focal length (here f<sub>x</sub> = ' + (rfx / S).toFixed(0) + ' px) and zero distortion.';
      } else if (lens === 'none' && k.every((v) => v === 0)) {
        note.innerHTML = 'An ideal lens: the raw image is already a pinhole image, so rectification has nothing to undo.';
      } else {
        // where the rectified image's corner ray lands on the raw sensor
        const [a, b] = distort((0 - rcx) / rfx, (0 - rcy) / rfy, k);
        const du = (fx * a + cx) / S, dv = (fy * b + cy) / S;
        const out = du < 0 || dv < 0;
        note.innerHTML = `Raw sensor image, before the SDK rectifies it. The ray through the rectified image's top-left corner lands at raw pixel <b>(${du.toFixed(0)}, ${dv.toFixed(0)})</b>${out ? ', off the sensor: the corners of the rectified image are cropped from a wider raw view' : ''}. Dark regions are raw pixels the rectified frame doesn't cover.`;
      }
    });
  }
  load();
}

// ---------- refraction at a flat port ----------
{
  const N = 1.333;
  const svg = document.getElementById('refr-svg');
  let th = 25;
  const chart = new LineChart(document.getElementById('refr-chart'), { height: 200, xLabel: 'angle in the water (°)', yLabel: 'landing / pinhole', digits: 3, xDigits: 0 });
  const ratio = (d) => { const w = (d * Math.PI) / 180; const a = Math.asin(Math.min(1, N * Math.sin(w))); return w < 1e-6 ? 1 : Math.tan(a) / (N * Math.tan(w)); };
  slider(document.getElementById('refr-controls'), 'Ray angle in water', 0, 40, 0.5, th, (v) => `${v.toFixed(1)}°`, (v) => { th = v; draw(); });
  function draw() {
    svg.replaceChildren();
    const X = 330, Y = 150, L = 260;
    s('rect', { x: X, y: 10, width: 260, height: 280, fill: css('--water'), opacity: 0.7 }, svg);
    s('line', { x1: X, y1: 10, x2: X, y2: 290, stroke: css('--ink'), 'stroke-width': 5 }, svg);
    // labels keep ~9.5 css px on a phone (the drawing is 600 units wide)
    const fz = Math.max(13, (9.5 * 600) / (svg.clientWidth || 600));
    const label = (attrs, text) => { const e = s('text', { class: 'halo', ...attrs }, svg); e.style.fontSize = `${fz}px`; e.textContent = text; return e; };
    s('line', { x1: 20, y1: Y, x2: 590, y2: Y, stroke: css('--rule'), 'stroke-dasharray': '3 4' }, svg);
    const w = (th * Math.PI) / 180, a = Math.asin(Math.min(1, N * Math.sin(w)));
    const acc = css('--accent');
    s('line', { x1: X + L * Math.cos(w), y1: Y - L * Math.sin(w), x2: X, y2: Y, stroke: acc, 'stroke-width': 2.5 }, svg);
    s('line', { x1: X, y1: Y, x2: X - L * Math.cos(a), y2: Y + L * Math.sin(a), stroke: acc, 'stroke-width': 2.5 }, svg);
    s('line', { x1: X, y1: Y, x2: X - L * Math.cos(w), y2: Y + L * Math.sin(w), stroke: css('--muted'), 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }, svg);
    // the rays run up-right in the water and down-left in the air, so the angle labels sit on the other side of the axis
    label({ x: X + 12, y: 32 }, 'water, n = 1.33');
    label({ x: X - 12, y: 32, 'text-anchor': 'end' }, 'air, inside the housing');
    label({ x: X + 8, y: 280 }, 'window');
    label({ x: X + 70, y: Y + 10 + fz }, `θw = ${th.toFixed(1)}°`);
    label({ x: X - 14, y: Y - 12, 'text-anchor': 'end' }, `θa = ${((a * 180) / Math.PI).toFixed(1)}°`);
    label({ x: X - 310, y: Y - 12 }, 'dashed: unbent');
    const xs = Array.from({ length: 81 }, (_, i) => i * 0.5);
    chart.set([{ name: 'refracted ÷ scaled pinhole', color: acc, values: xs.map((x) => ({ x, y: ratio(x) })) }], { markers: [{ x: th, label: `${ratio(th).toFixed(3)}` }] });
  }
  draw();
  let lastW = 0;
  new ResizeObserver(() => { if (svg.clientWidth !== lastW) { lastW = svg.clientWidth; draw(); } }).observe(svg);
}

// ---------- depth from disparity ----------
{
  const host = document.getElementById('stereo-chart');
  const note = document.getElementById('stereo-note');
  const F = 1701.5;
  let B = 0.04975, dd = 0.25;
  const chart = new LineChart(host, { height: 240, xLabel: 'range (m)', yLabel: 'depth error (cm)', digits: 1, unit: ' cm', yZero: true });
  const ctl = document.getElementById('stereo-controls');
  slider(ctl, 'Matching error', 0.05, 1, 0.05, dd, (v) => `±${v.toFixed(2)} px`, (v) => { dd = v; draw(); });
  slider(ctl, 'Baseline', 20, 150, 1, B * 1000, (v) => `${v.toFixed(0)} mm`, (v) => { B = v / 1000; draw(); });
  function draw() {
    const zs = Array.from({ length: 76 }, (_, i) => 0.5 + i * 0.1);
    chart.set([
      { name: `this baseline (${(B * 1000).toFixed(0)} mm)`, color: css('--state'), values: zs.map((z) => ({ x: z, y: (100 * z * z * dd) / (F * B) })) },
      { name: 'Talos, 49.75 mm', color: css('--muted'), dash: true, width: 1.2, values: zs.map((z) => ({ x: z, y: (100 * z * z * dd) / (F * 0.04975) })) },
    ]);
    const at = (z) => `at ${z} m the disparity is <b>${((F * B) / z).toFixed(1)} px</b> and the depth error <b>${((100 * z * z * dd) / (F * B)).toFixed(1)} cm</b>`;
    note.innerHTML = `With fB = ${(F * B).toFixed(1)} px·m: ${at(2)}; ${at(4)}; ${at(6)}.`;
  }
  draw();
}

// ---------- a ChArUco board, partly hidden ----------
{
  const canvas = document.getElementById('charuco-canvas');
  const ctx = canvas.getContext('2d');
  const note = document.getElementById('charuco-note');
  const NX = 7, NY = 5, SQ = 1; // squares; corners are (NX-1) x (NY-1)
  let tilt = 35, hide = 0.42;
  const ctl = document.getElementById('charuco-controls');
  slider(ctl, 'Turn the board', 0, 65, 1, tilt, (v) => `${v.toFixed(0)}°`, (v) => { tilt = v; draw(); });
  slider(ctl, 'Hide', 0, 0.9, 0.01, hide, (v) => `${(v * 100).toFixed(0)} %`, (v) => { hide = v; draw(); });
  // a fixed pseudo-random 4x4 bit pattern per marker
  const bits = (id) => { let x = (id + 1) * 2654435761 >>> 0; return Array.from({ length: 16 }, () => ((x = (x * 1103515245 + 12345) >>> 0) >>> 16) & 1); };
  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#9fcbd4';
    ctx.fillRect(0, 0, W, H);
    const a = (tilt * Math.PI) / 180;
    // board in its own plane (x right, y down), centred; turned about its vertical axis; pinhole camera 9 units away
    const P = (x, y) => {
      const X = (x - NX / 2) * Math.cos(a), Z = 9.5 + (x - NX / 2) * Math.sin(a), Y = y - NY / 2;
      return [W / 2 + (700 * X) / Z, H / 2 + (700 * Y) / Z];
    };
    const hidden = (x, y) => P(x, y)[0] > W * (1 - hide);
    let id = 0;
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const quad = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)];
      ctx.beginPath(); quad.forEach((p, k) => (k ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath();
      const black = (i + j) % 2 === 0;
      ctx.fillStyle = black ? '#111' : '#fff';
      ctx.fill();
      if (!black) {
        // marker: a 6x6 grid (border + 4x4 bits) in the middle 70 % of the square
        const b = bits(id++);
        for (let q = 0; q < 6; q++) for (let r = 0; r < 6; r++) {
          const inner = q > 0 && q < 5 && r > 0 && r < 5;
          if (inner && b[(q - 1) * 4 + (r - 1)]) continue;
          const u0 = i + 0.15 + (0.7 * r) / 6, v0 = j + 0.15 + (0.7 * q) / 6, d = 0.7 / 6;
          const c = [P(u0, v0), P(u0 + d, v0), P(u0 + d, v0 + d), P(u0, v0 + d)];
          ctx.beginPath(); c.forEach((p, k) => (k ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath();
          ctx.fillStyle = '#111'; ctx.fill();
        }
      }
    }
    // murk
    const gx = W * (1 - hide);
    const grad = ctx.createLinearGradient(gx - 40, 0, gx + 10, 0);
    grad.addColorStop(0, 'rgba(159,203,212,0)'); grad.addColorStop(1, 'rgba(159,203,212,0.97)');
    ctx.fillStyle = grad;
    ctx.fillRect(gx - 40, 0, W - gx + 40, H);
    // inner corners: identified if a neighbouring white square (with its marker) is entirely visible
    let ok = 0, total = 0, allVisible = true;
    for (let j = 1; j < NY; j++) for (let i = 1; i < NX; i++) {
      total++;
      const vis = !hidden(i, j);
      if (!vis) allVisible = false;
      const whites = [[i - 1, j - 1], [i, j - 1], [i - 1, j], [i, j]].filter(([x, y]) => (x + y) % 2 === 1);
      const id = vis && whites.some(([x, y]) => !hidden(x, y) && !hidden(x + 1, y) && !hidden(x, y + 1) && !hidden(x + 1, y + 1));
      if (id) ok++;
      const [px, py] = P(i, j);
      ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fillStyle = id ? '#1baf7a' : vis ? '#eda100' : 'rgba(15,38,51,0.35)';
      ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
    }
    note.innerHTML = `ChArUco: <b>${ok} of ${total}</b> inner corners found and identified. Plain chessboard: <b>${allVisible ? 'usable' : 'lost'}</b>${allVisible ? '' : ' (it needs every corner to know which is which)'}.`;
  }
  draw();
}
