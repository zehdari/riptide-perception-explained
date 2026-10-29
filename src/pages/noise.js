import { setup } from '../layout.js';
import '../css/noise.css';
import { LineChart } from '../viz/chart.js';
import { detection_covariance, NoiseSettings, EstimatorSettings, MapEstimator } from '../engine/estimator.js';
import { eye, eigh } from '../engine/linalg.js';

setup();
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const cm = (m) => (m * 100).toFixed(1);
const HALF_FOV = Math.atan(960 / 1863.934); // Nereus ffc: 1920 px wide, fx 1864 px

function slider(host, label, min, max, step, value, fmt, onInput) {
  const l = document.createElement('label');
  l.innerHTML = `${label} <input type="range" min="${min}" max="${max}" step="${step}" value="${value}"> <output></output>`;
  const input = l.querySelector('input'), out = l.querySelector('output');
  const update = () => { out.textContent = fmt(+input.value); onInput(+input.value); };
  input.addEventListener('input', update);
  host.appendChild(l);
  out.textContent = fmt(value);
  return input;
}

function seg(host, label, options, value, onPick) {
  const wrap = document.createElement('label');
  wrap.textContent = label + ' ';
  const s = document.createElement('span');
  s.className = 'seg';
  for (const [v, text] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-pressed', String(v === value));
    b.onclick = () => { s.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); onPick(v); };
    s.appendChild(b);
  }
  wrap.appendChild(s);
  host.appendChild(wrap);
}

// Ellipse of a 2x2 covariance: [semi-axis a, semi-axis b, angle of a]
function ellipse2(c) {
  const { values, vectors } = eigh(c);
  return [Math.sqrt(Math.max(values[1], 0)), Math.sqrt(Math.max(values[0], 0)), Math.atan2(vectors[1][1], vectors[0][1])];
}

// ---------- the draggable top-down ellipse ----------
{
  const canvas = document.getElementById('ell-canvas');
  const ctx = canvas.getContext('2d');
  const readout = document.getElementById('ell-readout');
  const controls = document.getElementById('ell-controls');
  const st = { x: 0.9, z: 3.0, w: 0, v: 0, mag: 5 };
  slider(controls, 'Yaw rate', 0, 1, 0.05, 0, (v) => `${v.toFixed(2)} rad/s`, (v) => { st.w = v; draw(); });
  slider(controls, 'Speed', 0, 0.6, 0.05, 0, (v) => `${v.toFixed(2)} m/s`, (v) => { st.v = v; draw(); });
  seg(controls, 'Ellipses', [[1, '×1'], [5, '×5'], [20, '×20']], 5, (v) => { st.mag = v; draw(); });

  const ZMAX = 6.2; // m shown ahead of the camera
  let W = 0, H = 0, s = 1, ox = 0, oy = 0;
  function layout() {
    const dpr = devicePixelRatio || 1;
    W = canvas.clientWidth;
    H = Math.round(Math.min(W * 0.62, 460));
    canvas.style.height = H + 'px';
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    s = (H - 28) / ZMAX; ox = W / 2; oy = H - 14;
  }
  const toPx = (x, z) => [ox + x * s, oy - z * s];
  const fromPx = (px, py) => [(px - ox) / s, (oy - py) / s];

  function draw() {
    if (!W) layout();
    ctx.clearRect(0, 0, W, H);
    // field of view
    const far = ZMAX / Math.cos(HALF_FOV) * 1.2;
    ctx.fillStyle = 'rgba(42,120,214,0.07)';
    ctx.beginPath(); ctx.moveTo(ox, oy);
    ctx.lineTo(...toPx(-Math.sin(HALF_FOV) * far, Math.cos(HALF_FOV) * far));
    ctx.lineTo(...toPx(Math.sin(HALF_FOV) * far, Math.cos(HALF_FOV) * far));
    ctx.closePath(); ctx.fill();
    // range rings
    ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1;
    ctx.fillStyle = css('--muted'); ctx.font = '12px ' + css('--sans');
    for (let r = 1; r <= 6; r++) {
      ctx.beginPath(); ctx.arc(ox, oy, r * s, Math.PI, 2 * Math.PI); ctx.stroke();
      ctx.fillText(`${r} m`, ox + 4, oy - r * s - 3);
    }
    // camera
    ctx.fillStyle = css('--ink');
    ctx.beginPath(); ctx.moveTo(ox, oy - 9); ctx.lineTo(ox - 8, oy + 5); ctx.lineTo(ox + 8, oy + 5); ctx.closePath(); ctx.fill();

    const p = [st.x, 0, st.z];
    const r = Math.hypot(st.x, st.z);
    const cov = detection_covariance(p, eye(3), st.w, st.v, NoiseSettings);
    const c2 = [[cov[0][0], cov[0][2]], [cov[2][0], cov[2][2]]];
    const [a, b, ang] = ellipse2(c2);
    const [px, py] = toPx(st.x, st.z);
    // ray
    ctx.strokeStyle = css('--ink-2'); ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(px, py); ctx.stroke(); ctx.setLineDash([]);
    for (const [k, alpha] of [[2, 0.18], [1, 0.32]]) {
      ctx.fillStyle = `rgba(217,72,15,${alpha})`;
      ctx.strokeStyle = css('--accent'); ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(px, py, Math.max(a * k * st.mag * s, 0.5), Math.max(b * k * st.mag * s, 0.5), -ang, 0, 2 * Math.PI);
      ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = css('--accent');
    ctx.beginPath(); ctx.arc(px, py, 5, 0, 2 * Math.PI); ctx.fill();
    ctx.strokeStyle = css('--paper'); ctx.lineWidth = 2; ctx.stroke();

    const n = NoiseSettings;
    const along = n.base_std + n.range_std_per_m * r + n.range_std_per_m2 * r * r;
    const across = Math.sqrt((n.base_std + n.lateral_std_per_m * r) ** 2 + (st.w * n.timing_std * r) ** 2);
    const iso = st.v * n.timing_std;
    const inView = Math.abs(Math.atan2(st.x, st.z)) <= HALF_FOV;
    readout.innerHTML = `<span>Range <b>${r.toFixed(2)} m</b>${inView ? '' : ' (outside the field of view)'}</span>`
      + `<span>Along the ray <b>${cm(Math.hypot(along, iso))} cm</b></span>`
      + `<span>Across it <b>${cm(Math.hypot(across, iso))} cm</b></span>`
      + `<span>Ellipses drawn <b>×${st.mag}</b></span>`;
  }
  const pick = (e) => {
    const rect = canvas.getBoundingClientRect();
    let [x, z] = fromPx(e.clientX - rect.left, e.clientY - rect.top);
    z = Math.min(Math.max(z, 0.3), ZMAX - 0.2);
    x = Math.max(Math.min(x, (W / 2 - 8) / s), -(W / 2 - 8) / s);
    st.x = x; st.z = z; draw();
  };
  let dragging = false;
  canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); pick(e); });
  canvas.addEventListener('pointermove', (e) => { if (dragging) pick(e); });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  new ResizeObserver(() => { layout(); draw(); }).observe(canvas);
}

// ---------- std against range ----------
{
  const chart = new LineChart(document.getElementById('range-chart'), { height: 240, xLabel: 'range (m)', yLabel: 'σ (cm)', digits: 1, unit: ' cm', yZero: true });
  const at = (r, w) => {
    const c = detection_covariance([0, 0, r], eye(3), w, 0, NoiseSettings);
    return { along: Math.sqrt(c[2][2]) * 100, across: Math.sqrt(c[0][0]) * 100 };
  };
  const rs = Array.from({ length: 61 }, (_, i) => i * 0.1);
  chart.set([
    { name: 'along the ray (depth)', color: css('--state'), values: rs.map((r) => ({ x: r, y: at(r, 0).along })) },
    { name: 'across the ray, at rest', color: css('--prediction'), values: rs.map((r) => ({ x: r, y: at(r, 0).across })) },
    { name: 'across, yawing 0.5 rad/s', color: css('--prediction'), dash: true, values: rs.map((r) => ({ x: r, y: at(r, 0.5).across })) },
  ]);
}

// ---------- inflation: how fast the estimate tightens ----------
{
  const host = document.getElementById('inf-chart');
  const controls = document.getElementById('inf-controls');
  const note = document.createElement('div');
  note.className = 'noise-note';
  const chart = new LineChart(host, { height: 240, xLabel: 'seconds of looking', yLabel: 'σ along the ray (cm)', digits: 2, unit: ' cm', yDomain: [0, 4] });
  host.appendChild(note);
  const T = 5, R0 = 1.5;
  const R = detection_covariance([0, 0, R0], eye(3), 0, 0, NoiseSettings);
  function run(rate, inflate) {
    const est = new MapEstimator({ hole: { parent: 'torpedo_frame', position: [0, 0, R0], yaw: 0, lock_yaw: true } }, {},
      inflate ? {} : { correlation_time: 0 });
    const out = [];
    for (let k = 0; k * (1 / rate) <= T + 1e-9; k++) {
      const t = k / rate;
      est.observe('hole', t, [0, 0, R0], R, null, null, true);
      const [, cov] = est.position('hole');
      if (est.tracks.hole.updates > 0) out.push({ x: t, y: Math.sqrt(cov[2][2]) * 100 });
    }
    return out;
  }
  const thr = Math.sqrt(0.0005) * 100;
  function update(rate) {
    const on = run(rate, true), off = run(rate, false);
    const slow = run(3, true);
    chart.set([
      { name: 'with inflation (mapping)', color: css('--state'), values: on },
      { name: 'without inflation', color: css('--reference'), values: off },
      { name: '3 Hz, with inflation', color: css('--muted'), dash: true, width: 1.5, values: slow },
      { name: 'old torpedo-hole check (0.0005 m²)', color: css('--s8'), dash: true, width: 1.2, values: [{ x: 0, y: thr }, { x: T, y: thr }] },
    ]);
    const at2 = (v) => v.reduce((best, p) => (Math.abs(p.x - 2) < Math.abs(best.x - 2) ? p : best), v[0]).y;
    note.textContent = `After 2 s at ${rate} Hz: ${at2(on).toFixed(2)} cm with inflation, ${at2(off).toFixed(2)} cm without. The first ${EstimatorSettings.acquire_detections} detections wait for agreement (Chapter 5) before any of them count.`;
  }
  slider(controls, 'Frame rate', 1, 30, 1, 15, (v) => `${v} Hz`, update);
  update(15);
}

// ---------- measured scatter (Nereus holds, tools/noise_measure.py) ----------
{
  const chart = new LineChart(document.getElementById('measured-chart'), { height: 250, xLabel: 'range (m)', yLabel: 'σ (cm)', digits: 2, unit: ' cm', yZero: true, xDomain: [1, 4.5] });
  const n = NoiseSettings;
  const rs = Array.from({ length: 36 }, (_, i) => 1 + i * 0.1);
  fetch(`${import.meta.env.BASE_URL}data/noise_measured.json`).then((r) => r.json()).then((d) => {
    const rows = d.rows.filter((r) => r.class === 'torpedo' || r.class.includes('_hole_'));
    chart.set([
      { name: 'model, along the ray', color: css('--state'), values: rs.map((r) => ({ x: r, y: 100 * (n.base_std + n.range_std_per_m * r + n.range_std_per_m2 * r * r) })) },
      { name: 'model, across', color: css('--reference'), values: rs.map((r) => ({ x: r, y: 100 * (n.base_std + n.lateral_std_per_m * r) })) },
      { name: 'Nereus, along', color: css('--state'), points: true, r: 3.2, opacity: 0.8, values: rows.map((r) => ({ x: r.range, y: 100 * r.std_along })) },
      { name: 'Nereus, across', color: css('--reference'), points: true, r: 3.2, opacity: 0.8, values: rows.map((r) => ({ x: r.range, y: 100 * r.std_across })) },
    ]);
  });
}
