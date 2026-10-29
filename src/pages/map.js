import { setup } from '../layout.js';
import { LineChart, el } from '../viz/chart.js';
import { Graph } from '../viz/graph.js';
import { MapEstimator, detection_covariance, _rotate } from '../engine/estimator.js';
import { cholesky } from '../engine/linalg.js';
import '../css/map.css';

setup();
const BASE = import.meta.env.BASE_URL;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// Seeded randomness so a preset always flies the same way
function rng(seed) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
}

// Map-parented objects Talos detects, how to draw them and where its camera looks from
const PROPS = [
  { name: 'gate', label: 'Gate', color: '--state', view: 'front' },
  { name: 'slalom_parent', label: 'Slalom', color: '--prediction', view: 'front' },
  { name: 'torpedo', label: 'Torpedo', color: '--s8', view: 'front' },
  { name: 'bin', label: 'Bins', color: '--s7', view: 'down' },
  { name: 'table', label: 'Table', color: '--s4', view: 'down' },
];
const WAYPOINTS = ['pre_torpedo_pose', 'pre_bin_pose', 'pre_table_pose', 'pre_return_home'];

function specsFrom(layout, names) {
  const specs = {};
  for (const n of names) specs[n] = { parent: 'map', position: layout[n].p, yaw: rad(layout[n].yaw), lock_yaw: !!layout[n].lock_orientation_to_config };
  return specs;
}

// A camera on Talos: optical axes (x right, y down, z forward) as columns, in the odometry frame
function cameraAxes(view, heading) {
  const f = [Math.cos(heading), Math.sin(heading), 0], r = [Math.sin(heading), -Math.cos(heading), 0], down = [0, 0, -1];
  return view === 'down' ? [r, f.map((v) => -v), down] : [r, down, f];
}
const toCam = (axes, v) => axes.map((a) => a[0] * v[0] + a[1] * v[1] + a[2] * v[2]);
const colsToMatrix = (axes) => [0, 1, 2].map((i) => axes.map((a) => a[i]));
function inView(view, pc) {
  if (view === 'down') return pc[2] > 0.3 && pc[2] < 4 && Math.abs(pc[0]) < 0.8 * pc[2] && Math.abs(pc[1]) < 0.6 * pc[2];
  return pc[2] > 0.6 && pc[2] < 6.5 && Math.abs(pc[0]) < 0.9 * pc[2] && Math.abs(pc[1]) < 0.6 * pc[2];
}

// ---------- footprints (prop frame, metres) ----------
function footprint(ctx, name, layout) {
  const seg = (x0, y0, x1, y1) => { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); };
  ctx.beginPath();
  if (name === 'gate') { seg(0, -1.5, 0, 1.5); }
  else if (name === 'torpedo') { seg(0, -0.3, 0, 0.3); }
  else if (name === 'slalom_parent') {
    const mid = layout.slalom_middle.p, back = layout.slalom_back.p;
    for (const [x, y] of [[0, 0], mid, back]) { ctx.moveTo(x + 0.09, y); ctx.arc(x, y, 0.09, 0, 2 * Math.PI); }
  } else if (name === 'bin') { ctx.rect(-0.6, -0.45, 1.5, 0.9); }
  else if (name === 'table') {
    ctx.rect(-0.5, -0.5, 1, 1);
    const o = layout.octagon.p;
    for (let k = 0; k <= 8; k++) {
      const a = (k / 8) * 2 * Math.PI + Math.PI / 8, x = o[0] + 1.38 * Math.cos(a), y = o[1] + 1.38 * Math.sin(a);
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
  }
}

// ---------- the course figure ----------
function courseFigure(layout) {
  const canvas = document.getElementById('course');
  const ctx = canvas.getContext('2d');
  const readout = document.getElementById('course-readout');
  const presetsHost = document.getElementById('course-presets');
  const flyHost = document.getElementById('course-fly');
  const names = [...PROPS.map((p) => p.name), ...WAYPOINTS];
  const prior = Object.fromEntries(names.map((n) => [n, layout[n].p]));
  const priorYaw = Object.fromEntries(names.map((n) => [n, rad(layout[n].yaw)]));
  const colors = {};
  const X0 = -1.2, X1 = 22.9, Y0 = -4.6, Y1 = 14.0;
  const START = [0.5, 0, -1.0];

  const PRESETS = {
    exact: { label: 'Layout exact', offset: [0, 0, 0], yaw: 0, dev: {} },
    offset: { label: 'Odometry offset', offset: [0.7, -0.5, 0], yaw: 0, dev: {} },
    bad: { label: 'Offset + torpedo moved', offset: [0.7, -0.5, 0], yaw: 0, dev: { torpedo: [1.3, 1.0, 0] } },
    yaw: { label: 'Course turned 3°', offset: [0, 0, 0], yaw: rad(3), dev: {} },
  };
  let preset = 'bad';
  let truth, est, talos, sim, chartData, log;
  let drift = true, speed = 10, playing = false, queue = [], dragging = null;

  const truthOffset = () => [truth.offset[0] + truth.walk[0], truth.offset[1] + truth.walk[1], truth.offset[2]];
  const truthOf = (n) => {
    const [r] = _rotate(truth.yaw, prior[n]);
    const o = truthOffset(), d = truth.dev[n] || [0, 0, 0];
    return [r[0] + o[0] + d[0], r[1] + o[1] + d[1], r[2] + o[2] + d[2]];
  };

  function restart(keepTruth = false) {
    if (!keepTruth) {
      const p = PRESETS[preset];
      truth = { offset: [...p.offset], yaw: p.yaw, dev: Object.fromEntries(Object.entries(p.dev).map(([k, v]) => [k, [...v]])), walk: [0, 0] };
    } else truth.walk = [0, 0];
    est = new MapEstimator(specsFrom(layout, names));
    talos = { p: [...START], h: 0, trail: [[START[0], START[1]]], dist: 0 };
    sim = { t: 0, nextDet: 0, leg: null, dets: [], noise: rng(7), walk: rng(11), released: new Set() };
    chartData = { ex: [], ey: [], tx: [], ty: [] };
    log = [];
    queue = [];
    playing = false;
    sampleChart();
    renderFly();
  }

  // ----- the flight -----
  function startLeg(name) {
    // A new target: mapping's target_callback resets it with verify (an object known well only needs a few agreeing detections)
    est.reset(name, true);
    sim.leg = { name, view: PROPS.find((p) => p.name === name).view, dwell: 0 };
  }
  function goal(leg) {
    const [m] = est.position(leg.name);
    const yaw = priorYaw[leg.name] + est.course_yaw()[0];
    if (leg.view === 'down') return { p: [m[0], m[1], m[2] + 1.3], h: null };
    return { p: [m[0] + 2.6 * Math.cos(yaw), m[1] + 2.6 * Math.sin(yaw), m[2]], h: yaw + Math.PI };
  }
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  function step(dt) {
    if (!sim.leg) {
      if (!queue.length) { playing = false; renderFly(); return false; }
      startLeg(queue.shift());
      renderFly();
    }
    const leg = sim.leg, g = goal(leg);
    const d = [g.p[0] - talos.p[0], g.p[1] - talos.p[1], g.p[2] - talos.p[2]];
    const horiz = Math.hypot(d[0], d[1]), dist = Math.hypot(horiz, d[2]);
    const v = 0.5, moveStep = Math.min(dist, v * dt);
    let ang = 0, lin = 0;
    if (dist > 1e-4) {
      for (let i = 0; i < 3; i++) talos.p[i] += (d[i] / dist) * moveStep;
      lin = moveStep / dt;
    }
    const wantH = horiz > 1.5 ? Math.atan2(d[1], d[0]) : g.h ?? talos.h;
    const dh = wrap(wantH - talos.h), turn = Math.sign(dh) * Math.min(Math.abs(dh), 0.6 * dt);
    talos.h = wrap(talos.h + turn);
    ang = Math.abs(turn) / dt;
    talos.dist += moveStep;
    const last = talos.trail[talos.trail.length - 1];
    if (Math.hypot(talos.p[0] - last[0], talos.p[1] - last[1]) > 0.2) talos.trail.push([talos.p[0], talos.p[1]]);
    // Odometry drift: the course slides in the odometry frame as Talos travels
    if (drift && moveStep > 0) {
      const s = Math.sqrt(est.settings.drift_var_per_m_xy * moveStep);
      truth.walk[0] += s * sim.walk();
      truth.walk[1] += s * sim.walk();
    }
    est.predict(moveStep, dt);
    sim.t += dt;

    // The camera: 10 detections a second of the target while it is in view (only targets are fused)
    if (sim.t >= sim.nextDet) {
      sim.nextDet = sim.t + 0.1;
      const T = truthOf(leg.name);
      const axes = cameraAxes(leg.view, talos.h);
      const pc = toCam(axes, [T[0] - talos.p[0], T[1] - talos.p[1], T[2] - talos.p[2]]);
      if (inView(leg.view, pc)) {
        const R = detection_covariance(pc, colsToMatrix(axes), ang, lin, est.noise);
        const L = cholesky(R);
        const n = [sim.noise(), sim.noise(), sim.noise()];
        const z = T.map((t, i) => t + L[i][0] * n[0] + L[i][1] * n[1] + L[i][2] * n[2]);
        const [ok, reason] = est.observe(leg.name, sim.t, z, R, null, null, true);
        sim.dets.push({ z, ok, name: leg.name, t: sim.t });
        if (sim.dets.length > 90) sim.dets.shift();
        if (reason && (ok || /moved|reacquiring/.test(reason))) addLog(`${leg.name} ${reason}`);
        if (ok) reportReleased();
      }
    }
    if (dist < 0.08 && (g.h === null || Math.abs(wrap(g.h - talos.h)) < 0.05)) {
      leg.dwell += dt;
      if (leg.dwell > 4) sim.leg = null;
    }
    return true;
  }

  function reportReleased() {
    for (const { name } of PROPS) {
      const r = est.released(name);
      if (r && !sim.released.has(name)) { sim.released.add(name); addLog(`${name}'s prior disagrees with the other props, released (it no longer moves the map)`, true); }
      if (!r && sim.released.has(name)) { sim.released.delete(name); addLog(`${name}'s prior agrees with the other props again`); }
    }
  }
  function addLog(text, warn = false) {
    log.push({ text, warn, t: sim.t });
    if (log.length > 4) log.shift();
  }
  function sampleChart() {
    const [o] = est.offset(), t = truthOffset(), s = +talos.dist.toFixed(2);
    chartData.ex.push({ x: s, y: o[0] }); chartData.ey.push({ x: s, y: o[1] });
    chartData.tx.push({ x: s, y: t[0] }); chartData.ty.push({ x: s, y: t[1] });
  }

  // ----- drawing -----
  let W = 0, H = 0, k = 1;
  const sx = (x) => (x - X0) * k, sy = (y) => H - (y - Y0) * k;
  const wx = (px) => px / k + X0, wy = (py) => (H - py) / k + Y0;
  function resize() {
    const w = canvas.parentElement.clientWidth - 2;
    W = w; k = W / (X1 - X0); H = Math.round((Y1 - Y0) * k);
    const dpr = devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function inProp(x, y, yaw, draw) {
    ctx.save();
    ctx.translate(sx(x), sy(y));
    ctx.scale(k, -k);
    ctx.rotate(yaw);
    draw();
    ctx.restore();
  }
  function ellipse(m, P, color, alpha) {
    // 2-sigma ellipse of the horizontal covariance
    const a = P[0][0], b = P[0][1], c = P[1][1];
    const tr = (a + c) / 2, det = Math.sqrt(Math.max(((a - c) / 2) ** 2 + b * b, 0));
    const l1 = tr + det, l2 = Math.max(tr - det, 0), th = Math.atan2(l1 - a, b || 1e-12);
    const r1 = 2 * Math.sqrt(l1) * k, r2 = 2 * Math.sqrt(l2) * k;
    ctx.save();
    ctx.translate(sx(m[0]), sy(m[1]));
    ctx.rotate(-(Math.abs(b) < 1e-12 ? (a >= c ? 0 : Math.PI / 2) : th));
    ctx.beginPath();
    ctx.ellipse(0, 0, Math.max(r1, 1.5), Math.max(r2, 1.5), 0, 0, 2 * Math.PI);
    ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.fill();
    ctx.globalAlpha = 1; ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.restore();
  }
  function arrow(x0, y0, x1, y1, color, dash = []) {
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.setLineDash([]);
    const a = Math.atan2(y1 - y0, x1 - x0), len = Math.hypot(x1 - x0, y1 - y0);
    if (len > 6) {
      ctx.beginPath(); ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - 8 * Math.cos(a - 0.4), y1 - 8 * Math.sin(a - 0.4));
      ctx.lineTo(x1 - 8 * Math.cos(a + 0.4), y1 - 8 * Math.sin(a + 0.4));
      ctx.fill();
    }
    ctx.restore();
  }

  function draw() {
    const ink = css('--ink'), ink2 = css('--ink-2'), muted = css('--muted'), accent = css('--accent');
    ctx.clearRect(0, 0, W, H);
    // water and the pool walls (x = 0 has the AprilTag board at the map origin)
    ctx.fillStyle = css('--water'); ctx.fillRect(sx(0), 0, sx(22.86) - sx(0), H);
    ctx.strokeStyle = 'rgba(15,38,51,0.07)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= 22; x++) { ctx.moveTo(sx(x), 0); ctx.lineTo(sx(x), H); }
    for (let y = Math.ceil(Y0); y <= Y1; y++) { ctx.moveTo(sx(0), sy(y)); ctx.lineTo(sx(22.86), sy(y)); }
    ctx.stroke();
    ctx.strokeStyle = ink2; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx(0), 0); ctx.lineTo(sx(0), H); ctx.moveTo(sx(22.86), 0); ctx.lineTo(sx(22.86), H); ctx.stroke();
    ctx.fillStyle = ink; ctx.fillRect(sx(0) - 3, sy(0.6), 6, 1.2 * k);
    ctx.font = '11px Archivo Variable, system-ui, sans-serif'; ctx.fillStyle = ink2;
    ctx.fillText('AprilTag board', sx(0) + 6, sy(-0.9));
    // scale bar
    ctx.fillStyle = ink2; ctx.fillRect(sx(19), sy(-4), 2 * k, 2); ctx.fillText('2 m', sx(19), sy(-4) - 5);

    // Talos's path
    ctx.strokeStyle = 'rgba(15,38,51,0.35)'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 4]);
    ctx.beginPath(); talos.trail.forEach(([x, y], i) => (i ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y)))); ctx.lineTo(sx(talos.p[0]), sy(talos.p[1])); ctx.stroke();
    ctx.setLineDash([]);

    const [cy] = est.course_yaw();
    for (const p of PROPS) {
      const c = colors[p.name];
      // prior
      inProp(prior[p.name][0], prior[p.name][1], priorYaw[p.name], () => { footprint(ctx, p.name, layout); ctx.setLineDash([0.12, 0.1]); ctx.strokeStyle = muted; ctx.lineWidth = 2 / k; ctx.stroke(); });
      // truth
      const T = truthOf(p.name);
      inProp(T[0], T[1], priorYaw[p.name] + truth.yaw, () => { footprint(ctx, p.name, layout); ctx.strokeStyle = ink; ctx.lineWidth = (p.name === 'gate' || p.name === 'torpedo' ? 4 : 2.2) / k; ctx.stroke(); });
      // estimate
      const [m, P] = est.position(p.name);
      ellipse(m, P, c, 0.12);
      inProp(m[0], m[1], priorYaw[p.name] + cy, () => { footprint(ctx, p.name, layout); ctx.strokeStyle = c; ctx.lineWidth = 2 / k; ctx.stroke(); });
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(sx(m[0]), sy(m[1]), 3, 0, 2 * Math.PI); ctx.fill();
      // drag handle on the truth
      ctx.beginPath(); ctx.arc(sx(T[0]), sy(T[1]), dragging === p.name ? 9 : 7, 0, 2 * Math.PI);
      ctx.fillStyle = accent; ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 1;
      ctx.strokeStyle = css('--paper'); ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = ink; ctx.font = '600 12px Archivo Variable, system-ui, sans-serif';
      const lab = p.label + (est.released(p.name) ? ' · released' : '');
      const lw = ctx.measureText(lab).width;
      let lx = sx(Math.max(prior[p.name][0], T[0], m[0])) + 12;
      if (lx + lw > W - 4) lx = sx(Math.min(prior[p.name][0], T[0], m[0])) - 12 - lw;
      ctx.fillText(lab, lx, sy(prior[p.name][1]) - 10);
    }
    // waypoints ride along on the offset, unseen
    for (const n of WAYPOINTS) {
      const [m] = est.position(n);
      ctx.strokeStyle = ink2; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(sx(m[0]) - 4, sy(m[1])); ctx.lineTo(sx(m[0]) + 4, sy(m[1])); ctx.moveTo(sx(m[0]), sy(m[1]) - 4); ctx.lineTo(sx(m[0]), sy(m[1]) + 4); ctx.stroke();
    }
    // fixes: filled while live, hollow once frozen
    for (const f of est._fixes()) {
      const live = est.live.has(f.name) && est.track_mean[f.name] === f.mean;
      ctx.save(); ctx.translate(sx(f.mean[0]), sy(f.mean[1])); ctx.rotate(Math.PI / 4);
      ctx.strokeStyle = colors[f.name] || ink; ctx.fillStyle = colors[f.name] || ink; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.rect(-3.5, -3.5, 7, 7); live ? ctx.fill() : ctx.stroke();
      ctx.restore();
    }
    // recent detections
    for (const d of sim.dets) {
      ctx.globalAlpha = Math.max(0.15, 1 - (sim.t - d.t) / 8);
      ctx.fillStyle = d.ok ? colors[d.name] : muted;
      ctx.fillRect(sx(d.z[0]) - 1.5, sy(d.z[1]) - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;
    // offset arrows from the map origin, drawn 4x so they read at course scale
    const [o] = est.offset(), to = truthOffset(), M = 4;
    arrow(sx(0), sy(0), sx(M * to[0]), sy(M * to[1]), ink, [4, 3]);
    arrow(sx(0), sy(0), sx(M * o[0]), sy(M * o[1]), accent);
    ctx.fillStyle = ink2; ctx.font = '11px Archivo Variable, system-ui, sans-serif';
    ctx.fillText('offset ×4', sx(M * o[0]) + 6, sy(M * o[1]) + 14);

    // Talos and its camera's view
    const leg = sim.leg;
    ctx.save(); ctx.translate(sx(talos.p[0]), sy(talos.p[1])); ctx.rotate(-talos.h);
    if (leg && leg.view === 'front') {
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 6.5 * k, -0.73, 0.73); ctx.closePath();
      ctx.fillStyle = 'rgba(217,72,15,0.08)'; ctx.fill();
    } else if (leg) {
      ctx.fillStyle = 'rgba(217,72,15,0.12)'; ctx.fillRect(-0.75 * k, -1.0 * k, 1.5 * k, 2.0 * k);
    }
    ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-6, 6); ctx.lineTo(-3, 0); ctx.lineTo(-6, -6); ctx.closePath();
    ctx.fillStyle = ink; ctx.fill();
    ctx.restore();
  }

  // ----- readout -----
  let lastReadout = -1;
  function renderReadout() {
    const [o, oP] = est.offset(), to = truthOffset();
    const [cy, cyv] = est.course_yaw();
    const sol = est._solve();
    const rows = PROPS.map((p) => {
      const [m, P] = est.position(p.name), T = truthOf(p.name);
      const err = Math.hypot(m[0] - T[0], m[1] - T[1]) * 100;
      const sig = 2 * Math.sqrt(Math.max(P[0][0], P[1][1])) * 100;
      const nfix = est._fixes().filter((f) => f.name === p.name).length;
      const pend = est.pending.get(p.name)?.length || 0;
      let state = nfix ? `${nfix} fix${nfix > 1 ? 'es' : ''}` : est.acquiring.has(p.name) ? 'tracking' : pend ? `acquiring (${pend} held)` : 'unseen';
      if (sim.leg?.name === p.name) state += ' · target';
      const w = sol && p.name in sol.weights ? sol.weights[p.name] : null;
      const rel = est.released(p.name);
      return `<tr><td><i class="map-dot" style="background:${colors[p.name]}"></i>${p.label}</td><td>${state}${rel ? ' <span class="map-badge">released</span>' : ''}</td>
        <td>${err.toFixed(0)} <span class="map-muted">(${sig.toFixed(0)})</span></td>
        <td>${w === null ? '<span class="map-muted">–</span>' : `<span class="map-w"><span style="width:${(w * 100).toFixed(0)}%;background:${rel ? css('--accent') : colors[p.name]}"></span></span> ${w.toFixed(2)}`}</td></tr>`;
    }).join('');
    readout.innerHTML = `
      <div class="map-summary">
        <div><small>Offset estimate</small><b>${o[0].toFixed(2)}, ${o[1].toFixed(2)} m</b> ± ${(2 * Math.sqrt(Math.max(oP[0][0], oP[1][1]))).toFixed(2)}</div>
        <div><small>True offset</small><b>${to[0].toFixed(2)}, ${to[1].toFixed(2)} m</b></div>
        <div><small>Course yaw</small><b>${deg(cy).toFixed(1)}°</b> ± ${(2 * deg(Math.sqrt(cyv))).toFixed(1)} (true ${deg(truth.yaw).toFixed(1)}°)</div>
        <div><small>Travelled</small><b>${talos.dist.toFixed(0)} m</b></div>
      </div>
      <div class="table-scroll"><table class="params map-table"><thead><tr><th>Prop</th><th>State</th><th>Error (2σ), cm</th><th>Layout weight</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="map-log">${log.length ? log.map((l) => `<div class="${l.warn ? 'warn' : ''}">${l.text}</div>`).join('') : '<div class="map-muted">mapping log</div>'}</div>`;
  }

  // ----- controls -----
  const seg = document.createElement('div');
  seg.className = 'seg';
  for (const [key, p] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.textContent = p.label;
    b.setAttribute('aria-pressed', String(key === preset));
    b.onclick = () => { preset = key; seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); restart(); };
    seg.appendChild(b);
  }
  presetsHost.appendChild(seg);
  const driftLab = document.createElement('label');
  driftLab.innerHTML = '<input type="checkbox" checked> Odometry drift';
  driftLab.querySelector('input').onchange = (e) => { drift = e.target.checked; };
  presetsHost.appendChild(driftLab);

  function renderFly() {
    flyHost.innerHTML = '';
    const mk = (text, fn, primary = false, pressed) => {
      const b = document.createElement('button');
      b.className = 'btn' + (primary ? ' primary' : '');
      b.textContent = text;
      if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
      b.onclick = fn;
      flyHost.appendChild(b);
      return b;
    };
    mk(queue.length || sim.leg ? (playing ? 'Pause' : 'Resume') : 'Fly the course', () => {
      if (!queue.length && !sim.leg) { queue = PROPS.map((p) => p.name).concat('gate'); playing = true; }
      else playing = !playing;
      renderFly();
    }, true);
    const lab = document.createElement('span');
    lab.className = 'map-muted';
    lab.textContent = 'or look at:';
    flyHost.appendChild(lab);
    for (const p of PROPS) mk(p.label, () => { queue.push(p.name); playing = true; renderFly(); }, false, sim.leg?.name === p.name);
    mk('Restart', () => restart(true));
    const sp = document.createElement('div');
    sp.className = 'seg';
    for (const v of [5, 10, 25]) {
      const b = document.createElement('button');
      b.textContent = `${v}×`;
      b.setAttribute('aria-pressed', String(v === speed));
      b.onclick = () => { speed = v; renderFly(); };
      sp.appendChild(b);
    }
    flyHost.appendChild(sp);
  }

  // dragging the true positions
  function pick(e) {
    const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    let best = null, bd = 24;
    for (const p of PROPS) {
      const T = truthOf(p.name), d = Math.hypot(sx(T[0]) - px, sy(T[1]) - py);
      if (d < bd) { bd = d; best = p.name; }
    }
    return best;
  }
  canvas.addEventListener('touchstart', (e) => { const t = e.touches[0]; if (pick(t)) e.preventDefault(); }, { passive: false });
  canvas.addEventListener('pointerdown', (e) => {
    dragging = pick(e);
    if (dragging) canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    if (!dragging) { canvas.style.cursor = pick(e) ? 'grab' : 'default'; return; }
    const x = wx(e.clientX - r.left), y = wy(e.clientY - r.top);
    const [rp] = _rotate(truth.yaw, prior[dragging]), o = truthOffset();
    truth.dev[dragging] = [x - rp[0] - o[0], y - rp[1] - o[1], 0];
  });
  const drop = () => { dragging = null; };
  canvas.addEventListener('pointerup', drop);
  canvas.addEventListener('pointercancel', drop);

  // offset chart
  const chartHost = document.createElement('div');
  chartHost.className = 'map-chart';
  readout.after(chartHost);
  const chart = new LineChart(chartHost, { height: 170, xLabel: 'distance travelled, m', yLabel: 'offset, m', digits: 2, xDigits: 0 });
  function renderChart() {
    chart.set([
      { name: 'offset x, estimate', color: css('--state'), values: chartData.ex },
      { name: 'x, true', color: css('--state'), values: chartData.tx, dash: true },
      { name: 'offset y, estimate', color: css('--s4'), values: chartData.ey },
      { name: 'y, true', color: css('--s4'), values: chartData.ty, dash: true },
    ]);
  }

  for (const p of PROPS) colors[p.name] = css(p.color);
  resize();
  new ResizeObserver(() => { resize(); draw(); }).observe(canvas.parentElement);
  restart();
  renderReadout();
  renderChart();
  let prev = performance.now(), lastChart = 0, lastChartSim = -1;
  const visible = { on: true };
  new IntersectionObserver(([e]) => { visible.on = e.isIntersecting; }).observe(canvas);
  function frame(now) {
    const dtReal = Math.min((now - prev) / 1000, 0.1);
    prev = now;
    if (playing && visible.on) {
      let budget = dtReal * speed;
      while (budget > 0 && playing) { const dt = Math.min(0.05, budget); if (!step(dt)) break; budget -= dt; }
      if (sim.t - lastChartSim >= 1) { lastChartSim = sim.t; sampleChart(); }
    }
    if (visible.on) {
      draw();
      if (now - lastReadout > 250) { lastReadout = now; renderReadout(); }
      if (now - lastChart > 1000 && playing) { lastChart = now; renderChart(); }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ---------- the factor graph ----------
function factorGraph() {
  const host = document.getElementById('factor-graph');
  const note = document.createElement('div');
  note.className = 'map-note';
  const info = {
    psi: 'Course yaw ψ: one number for the whole run, prior σ = 2°. Every fix depends on it through R(ψ)·prior.',
    o1: 'Offset node 1: the offset when the gate was first fixed, after ~5 m of travel. Tied to the start prior (σ = 1 m) widened by the drift so far.',
    o2: 'Offset node 2: the offset at the slalom fix, ~9 m.',
    o3: 'Offset node 3: the offset at the second gate fix, on the way home, ~60 m. The newest node is the offset mapping publishes now.',
    dg: 'Deviation of the gate: how far its prior is off. Shared by both gate fixes, so the difference between them can only be offset.',
    ds: 'Deviation of the slalom.',
    pr: 'Start prior on the first offset node.',
    q12: 'Drift between nodes 1 and 2: Q(Δs = 4 m) = 0.008 m² in x and y.',
    q23: 'Drift between nodes 2 and 3: Q(Δs = 51 m) ≈ 0.10 m², σ ≈ 0.32 m.',
    f1: 'Fix: the gate where its track put it at ~5 m. Ties ψ, offset node 1 and the gate\'s deviation.',
    f2: 'Fix: the slalom at ~9 m.',
    f3: 'Fix: the gate again at ~60 m.',
    yp: 'Yaw prior, σ = 2°.',
    lg: 'Layout term on the gate deviation: Cauchy-robust, σ = 0.25 m, scale 2.',
    ls: 'Layout term on the slalom deviation.',
  };
  const V = (id, x, y, label, shape = 'circle') => ({ id, x, y, label, shape, r: 19, info: info[id] });
  const F = (id, x, y, sub) => ({ id, x, y, shape: 'square', r: 7, info: info[id], sub });
  const nodes = [
    V('psi', 320, 40, 'ψ'),
    F('yp', 400, 40),
    F('f1', 140, 120), F('f2', 320, 120), F('f3', 500, 120),
    V('o1', 140, 200, 'o₁'), V('o2', 320, 200, 'o₂'), V('o3', 500, 200, 'o₃'),
    F('pr', 60, 200), F('q12', 230, 200), F('q23', 410, 200),
    V('dg', 230, 290, 'd gate', 'rect'), V('ds', 440, 290, 'd slalom', 'rect'),
    F('lg', 120, 290), F('ls', 560, 290),
  ];
  const E = (from, to) => ({ from, to });
  const edges = [
    E('yp', 'psi'), E('f1', 'psi'), E('f2', 'psi'), E('f3', 'psi'),
    E('f1', 'o1'), E('f2', 'o2'), E('f3', 'o3'), E('f1', 'dg'), E('f3', 'dg'), E('f2', 'ds'),
    E('pr', 'o1'), E('q12', 'o1'), E('q12', 'o2'), E('q23', 'o2'), E('q23', 'o3'), E('lg', 'dg'), E('ls', 'ds'),
  ];
  new Graph(host, { width: 620, height: 330, nodes, edges, arrows: false, info: (n) => { note.textContent = n ? n.info : 'Circles are unknowns; small squares are cost terms. Tap one.'; } });
  host.appendChild(note);
  note.textContent = 'Circles are unknowns; small squares are cost terms. Tap one.';
}

// ---------- who gets the blame ----------
function blameFigure(layout) {
  const controls = document.getElementById('blame-controls');
  const bars = document.getElementById('blame-bars');
  const note = document.getElementById('blame-note');
  const NAMES = ['gate', 'slalom_parent', 'torpedo'];
  const LABEL = { gate: 'Gate', slalom_parent: 'Slalom', torpedo: 'Torpedo' };
  const state = { shift: 0.6, err: 0, seen: { gate: true, slalom_parent: true, torpedo: true } };
  const slider = (label, key, min, max, stepv) => {
    const l = document.createElement('label');
    l.innerHTML = `${label} <input type="range" min="${min}" max="${max}" step="${stepv}" value="${state[key]}"><output></output>`;
    const inp = l.querySelector('input'), out = l.querySelector('output');
    const upd = () => { state[key] = +inp.value; out.textContent = `${(+inp.value).toFixed(2)} m`; run(); };
    inp.oninput = upd;
    out.textContent = `${state[key].toFixed(2)} m`;
    controls.appendChild(l);
  };
  slider('Shared shift', 'shift', -1, 1, 0.05);
  slider('Torpedo prior error', 'err', 0, 2, 0.05);
  for (const n of NAMES) {
    const l = document.createElement('label');
    l.innerHTML = `<input type="checkbox" checked> ${LABEL[n]}`;
    l.querySelector('input').onchange = (e) => { state.seen[n] = e.target.checked; run(); };
    controls.appendChild(l);
  }

  function run() {
    const est = new MapEstimator(specsFrom(layout, NAMES));
    let t = 0, last = [0, 0];
    for (const n of NAMES) {
      const p = layout[n].p;
      const truthP = [p[0] + state.shift + (n === 'torpedo' ? state.err : 0), p[1], p[2]];
      const travelled = Math.hypot(p[0] - last[0], p[1] - last[1]);
      last = p;
      est.predict(travelled, travelled / 0.5);
      t += travelled / 0.5;
      if (!state.seen[n]) continue;
      // 25 detections over 2.5 s from 2.5 m straight ahead, no noise: the fix is exactly the truth (a prop far from where
      // the map expects it needs 12 agreeing detections over 2 s before it is accepted)
      const yaw = rad(layout[n].yaw) + Math.PI;
      const axes = cameraAxes('front', yaw);
      const R = detection_covariance([0, 0, 2.5], colsToMatrix(axes), 0, 0, est.noise);
      est.reset(n, true);
      for (let i = 0; i < 25; i++) { t += 0.1; est.observe(n, t, truthP, R, null, null, true); }
    }
    const sol = est._solve();
    const [o] = est.offset();
    const rows = [{ label: 'Offset', est: o[0], truth: state.shift, w: null, color: css('--accent') }];
    for (const n of NAMES) {
      const has = sol && n in sol.d;
      rows.push({ label: `${LABEL[n]} deviation`, est: has ? sol.x[sol.d[n]] : null, truth: n === 'torpedo' ? state.err : 0, w: has ? sol.weights[n] : null, color: css(PROPS.find((p) => p.name === n).color), released: has && sol.weights[n] < 0.5 });
    }
    drawBars(rows);
    const seenN = NAMES.filter((n) => state.seen[n]);
    let text;
    if (!seenN.length) text = 'Nothing seen: the offset stays at zero, with its 1 m prior, and every prop is predicted at its prior.';
    else if (seenN.length === 1) {
      const frac = Math.abs(state.shift + (seenN[0] === 'torpedo' ? state.err : 0)) > 1e-3 ? o[0] / (state.shift + (seenN[0] === 'torpedo' ? state.err : 0)) : null;
      text = `One prop seen: the offset takes ${frac === null ? 'nearly all' : `${(frac * 100).toFixed(0)} %`} of its shift, because the offset prior (1 m) is far wider than the layout's (0.25 m). Every unseen prop moves with it.`;
    } else {
      const rel = rows.filter((r) => r.released).map((r) => r.label.replace(' deviation', ''));
      text = rel.length
        ? `${rel.join(' and ')} released: weight below one half, so its prior no longer moves the map. The other props set the offset, and the released prop is placed by its own fix.`
        : 'The props agree well enough that every prior keeps most of its weight; the shared part of the shift goes to the offset.';
    }
    note.textContent = text;
  }

  function drawBars(rows) {
    bars.innerHTML = '';
    const Wd = 420, rowH = 40, labelW = 132, x0 = labelW, x1 = Wd - 56, lo = -1.2, hi = 2.4;
    const svg = el('svg', { class: 'chart', viewBox: `0 0 ${Wd} ${rows.length * rowH + 22}` }, bars);
    const sxv = (v) => x0 + ((v - lo) / (hi - lo)) * (x1 - x0);
    for (const v of [-1, 0, 1, 2]) {
      el('line', { x1: sxv(v), x2: sxv(v), y1: 4, y2: rows.length * rowH, stroke: v ? 'var(--grid)' : 'var(--muted)' }, svg);
      el('text', { class: 'label', x: sxv(v), y: rows.length * rowH + 16, 'text-anchor': 'middle' }, svg).textContent = `${v} m`;
    }
    rows.forEach((r, i) => {
      const y = i * rowH + 8;
      el('text', { class: 'label', x: labelW - 10, y: y + 13, 'text-anchor': 'end' }, svg).textContent = r.label;
      if (r.est !== null) {
        const a = sxv(Math.min(0, r.est)), b = sxv(Math.max(0, r.est));
        el('rect', { x: a, y, width: Math.max(b - a, 1), height: 18, rx: 3, fill: r.color, opacity: r.released ? 0.55 : 0.9 }, svg);
        el('text', { class: 'label', x: Wd - 2, y: y + 13, 'text-anchor': 'end', style: 'font-variant-numeric: tabular-nums' }, svg).textContent = r.est.toFixed(2);
      } else {
        el('text', { class: 'label', x: Wd - 2, y: y + 13, 'text-anchor': 'end' }, svg).textContent = 'unseen';
      }
      el('line', { x1: sxv(r.truth), x2: sxv(r.truth), y1: y - 3, y2: y + 21, stroke: 'var(--ink)', 'stroke-width': 2.5 }, svg);
      if (r.w !== null) el('text', { class: 'label', x: labelW - 10, y: y + 27, 'text-anchor': 'end', style: `font-size:11px;fill:${r.released ? 'var(--accent)' : 'var(--muted)'}` }, svg).textContent = r.released ? `weight ${r.w.toFixed(2)} · released` : `weight ${r.w.toFixed(2)}`;
    });
  }
  run();
}

// ---------- the robust penalty ----------
function robustChart() {
  const host = document.getElementById('robust-chart');
  const s = 2, g = [], c = [], w = [];
  for (let r = 0; r <= 6.001; r += 0.05) {
    const r2 = r * r;
    g.push({ x: r, y: r2 });
    c.push({ x: r, y: s * s * Math.log1p(r2 / (s * s)) });
    w.push({ x: r, y: 1 / (1 + r2 / (s * s)) });
  }
  const cols = document.createElement('div');
  cols.className = 'cols';
  host.appendChild(cols);
  const a = document.createElement('div'), b = document.createElement('div');
  cols.append(a, b);
  new LineChart(a, { height: 200, xLabel: 'deviation, layout σ', yLabel: 'penalty', digits: 2, yDomain: [0, 16] }).set([
    { name: 'Gaussian r²', color: css('--muted'), values: g.filter((p) => p.y <= 16), dash: true },
    { name: 'Cauchy, s = 2', color: css('--accent'), values: c },
  ]);
  new LineChart(b, { height: 200, xLabel: 'deviation, layout σ', yLabel: 'weight', digits: 2, yDomain: [0, 1.05], forceLegend: true }).set([
    { name: 'IRLS weight w', color: css('--state'), values: w },
  ], { markers: [{ x: 2, label: 'released below ½' }] });
}

async function main() {
  const layout = await fetch(`${BASE}data/map_layout.json`).then((r) => r.json());
  courseFigure(layout);
  factorGraph();
  blameFigure(layout);
  robustChart();
}
main();

// ---------- the offset through the Nereus run (Chapter 8's data) ----------
{
  const host = document.getElementById('nereus-offset-chart');
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  fetch(`${import.meta.env.BASE_URL}data/mission_full.json`).then((r) => r.json()).then(({ shifted: s }) => {
    const chart = new LineChart(host, { height: 230, xLabel: 'mission time (s)', yLabel: 'offset (m)', digits: 2, unit: ' m', xDigits: 0,
      bands: s.phases.map(([x0, x1], i) => ({ x0, x1, color: i % 2 ? 'rgba(15,38,51,0.035)' : 'rgba(15,38,51,0.07)' })), markers: s.phases.map(([x, , label]) => ({ x, label })) });
    chart.set([
      { name: 'east', color: css('--state'), values: s.offset.map((r) => ({ x: r[0], y: r[1] })) },
      { name: 'north', color: css('--reference'), values: s.offset.map((r) => ({ x: r[0], y: r[2] })) },
      { name: 'true', color: css('--state'), dash: true, width: 1.2, noLegend: true, values: [{ x: 0, y: s.shift[0] }, { x: s.duration, y: s.shift[0] }] },
      { name: 'true north', color: css('--reference'), dash: true, width: 1.2, noLegend: true, values: [{ x: 0, y: s.shift[1] }, { x: s.duration, y: s.shift[1] }] },
    ]);
    const t = s.props.torpedo, last = s.offset.at(-1);
    document.getElementById('nereus-offset-text').textContent = `The offset ends at (${last[1].toFixed(2)}, ${last[2].toFixed(2)}) m. The torpedo, whose prior was ${Math.round(t.prior_err * 100)} cm off, ends ${Math.round(t.final_err * 100)} cm from where Nereus put it. The first step is the slalom, and lands on the true shift. The second is the torpedo: rather than release it, the solve explains part of its 1.27 m as odometry drift since the slalom, so the offset overshoots and the props still unseen move away from the truth again. Chapter 8 goes through why.`;
  });
}
