import { setup } from '../layout.js';
import '../css/tracking.css';
import { LineChart } from '../viz/chart.js';
import { MapEstimator, EstimatorSettings, detection_covariance } from '../engine/estimator.js';
import { cholesky, eigh, matvec, add, scale, eye } from '../engine/linalg.js';

setup();
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const NAME = 'torpedo';
const DEPTH = -1.4;
const PRIOR = [0, 0, DEPTH];
const HALF_FOV = Math.atan(960 / 1863.934);
const MAX_RANGE = 6;
const DT = 0.1; // s between detections (10 Hz)
const UNCONFIRMED_POSITION_VAR = 1.0;

// Seeded RNG so a reload replays the same noise
function rng(seed) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const g = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
  return { u, g };
}

// Camera at `cam` looking at `target` (level): parent <- optical rotation (columns: right, down, forward)
function cameraRotation(cam, target) {
  const th = Math.atan2(target[1] - cam[1], target[0] - cam[0]);
  const c = Math.cos(th), s = Math.sin(th);
  return [[s, 0, c], [-c, 0, s], [0, -1, 0]];
}
const tmul = (R, v) => [0, 1, 2].map((j) => R[0][j] * v[0] + R[1][j] * v[1] + R[2][j] * v[2]);

// A detection of `target` seen from `cam`: [z, R] with z drawn from the noise model
function detect(cam, target, r) {
  const Rpc = cameraRotation(cam, target);
  const pcam = tmul(Rpc, target.map((x, i) => x - cam[i]));
  const R = detection_covariance(pcam, Rpc, 0, 0);
  const L = cholesky(R);
  const n = matvec(L, [r.g(), r.g(), r.g()]);
  return [target.map((x, i) => x + n[i]), R];
}

// Ellipse (semi-axes, angle) of the xy block of a covariance
function ellipse(cov, k) {
  const { values, vectors } = eigh([[cov[0][0], cov[0][1]], [cov[1][0], cov[1][1]]]);
  return [k * Math.sqrt(Math.max(values[1], 0)), k * Math.sqrt(Math.max(values[0], 0)), Math.atan2(vectors[1][1], vectors[0][1])];
}

// Published horizontal sigma (m): the larger of x and y, with the unconfirmed floor
function publishedSigma(est) {
  const [, cov] = est.position(NAME);
  let vx = cov[0][0], vy = cov[1][1];
  if (!est.confirmed(NAME)) { vx = Math.max(vx, UNCONFIRMED_POSITION_VAR); vy = Math.max(vy, UNCONFIRMED_POSITION_VAR); }
  return Math.sqrt(Math.max(vx, vy));
}
const ownSigma = (est) => { const [, c] = est.position(NAME); return Math.sqrt(Math.max(c[0][0], c[1][1])); };
const makeEstimator = () => new MapEstimator({ [NAME]: { parent: 'map', position: PRIOR, yaw: 0, lock_yaw: true } });

// ---------- the live demo ----------
{
  const scene = document.getElementById('trk-scene');
  const zoom = document.getElementById('trk-zoom');
  const status = document.getElementById('trk-status');
  const logEl = document.getElementById('trk-log');
  const controls = document.getElementById('trk-controls');
  const zoomTag = document.getElementById('trk-zoom-tag');

  const TRUE_A = [0.32, -0.24, DEPTH];
  const TRUE_B = [0.42, 0.36, DEPTH];
  const LOOK_OFF = [-0.1, 0.49, 0];
  const ZOOM_W = 1.4;
  zoomTag.textContent = `Around the prop, ${ZOOM_W * 100} cm across`;

  let S;
  function reset() {
    S = { est: makeEstimator(), r: rng(7), t: 0, talos: [-2.3, -1.1, DEPTH], truth: TRUE_A.slice(), look: false, targeted: true,
      stray: 0, dets: [], log: [], moved: 0, lastR: null, id: 0 };
    log('ev', 'targeted torpedo: detections are held until 4 agree');
    syncButtons();
  }
  const lookalike = () => S.truth.map((x, i) => x + LOOK_OFF[i]);

  function log(kind, text, collapse) {
    const last = S.log[S.log.length - 1];
    if (collapse && last && last.collapse === collapse) { last.text = text; last.t = S.t; last.n = (last.n || 1) + 1; return; }
    S.log.push({ t: S.t, kind, text, collapse });
    if (S.log.length > 40) S.log.shift();
  }

  function fuse(z, R, src) {
    const est = S.est;
    const det = { id: S.id++, z, t: S.t, src, status: 'held' };
    S.dets.push(det);
    const [acc, reason] = est.observe(NAME, S.t, z, R, null, null, S.targeted);
    if (reason.includes('acquiring:')) {
      det.status = 'held';
      log('', reason, 'acq');
    } else if (acc) {
      det.status = 'fused';
      if (reason.includes('detections agree')) {
        const m = est.track_mean[NAME];
        for (const d of S.dets) if (d.status === 'held') d.status = Math.hypot(d.z[0] - m[0], d.z[1] - m[1]) <= EstimatorSettings.acquire_radius_m ? 'fused' : 'dropped';
        log('', reason);
      } else if (reason) log('', reason);
    } else {
      det.status = 'rejected';
      if (reason.includes('reacquiring')) {
        for (const d of S.dets) if (d.status === 'fused') d.status = 'old';
        log('rej', `rejected: ${reason}`);
      } else log('rej', `rejected: ${reason} (${est.tracks[NAME].rejects} in a row)`, 'rej');
    }
  }

  function step() {
    S.t = +(S.t + DT).toFixed(3);
    S.est.predict(S.moved, DT);
    S.moved = 0;
    const range = Math.hypot(S.truth[0] - S.talos[0], S.truth[1] - S.talos[1]);
    if (range <= MAX_RANGE) {
      const [z, R] = detect(S.talos, S.truth, S.r);
      S.lastR = R;
      fuse(z, R, 'prop');
      if (S.look) { const [zl, Rl] = detect(S.talos, lookalike(), S.r); fuse(zl, Rl, 'look'); }
      if (S.stray) {
        const a = S.r.u() * 2 * Math.PI, d = 0.6 + 0.5 * S.r.u();
        const target = [S.truth[0] + d * Math.cos(a), S.truth[1] + d * Math.sin(a), DEPTH];
        const [zs, Rs] = detect(S.talos, target, S.r);
        fuse(zs, Rs, 'stray');
        S.stray--;
      }
    }
    // held detections that left the acquisition window were dropped by the estimator
    const held = new Set((S.est.pending.get(NAME) || []).map((d) => d[0]));
    for (const d of S.dets) if (d.status === 'held' && !held.has(d.t)) d.status = 'dropped';
    S.dets = S.dets.filter((d) => S.t - d.t < 12);
  }

  // controls
  const buttons = {};
  const mk = (key, text, onClick, toggle) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn'; b.textContent = text; b.onclick = onClick;
    if (toggle) b.setAttribute('aria-pressed', 'false');
    controls.appendChild(b); buttons[key] = b; return b;
  };
  let playing = true;
  mk('play', 'Pause', () => { playing = !playing; buttons.play.textContent = playing ? 'Pause' : 'Play'; });
  mk('stray', 'Stray detection', () => { S.stray++; log('ev', 'a stray false detection, 0.6–1.1 m off'); });
  mk('look', 'Lookalike', () => { S.look = !S.look; log('ev', S.look ? 'a lookalike 50 cm away starts being detected too' : 'lookalike gone'); syncButtons(); }, true);
  mk('move', 'Move the prop', () => { const toB = S.truth[1] < 0; S.truth = (toB ? TRUE_B : TRUE_A).slice(); log('ev', 'the prop moved 61 cm'); });
  mk('retarget', 'Retarget', () => {
    const was = S.est.tracks[NAME].established;
    S.est.reset(NAME, true);
    log('ev', `retargeted: reset(verify=True), ${was ? 'established, so 3 agreeing detections confirm it' : 'not established, so a full reset'}`);
  });
  mk('targeted', 'Targeted', () => { S.targeted = !S.targeted; log('ev', S.targeted ? 'targeted again' : 'background only: fused, but can no longer confirm'); syncButtons(); }, true);
  mk('reset', 'Start over', () => reset());
  function syncButtons() {
    buttons.look?.setAttribute('aria-pressed', String(!!S.look));
    buttons.targeted?.setAttribute('aria-pressed', String(!!S.targeted));
  }

  // drawing
  const V = { x0: -4.2, x1: 2.4, y0: -2.6, y1: 2.6 };
  const geo = { scene: {}, zoom: {} };
  function size(canvas, g, aspect) {
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth, h = Math.round(w * aspect);
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    Object.assign(g, { w, h, ctx });
  }
  function layout() {
    size(scene, geo.scene, (V.y1 - V.y0) / (V.x1 - V.x0));
    const stacked = matchMedia('(max-width: 640px)').matches;
    size(zoom, geo.zoom, stacked ? 0.8 : geo.scene.h / Math.max(zoom.clientWidth, 1));
  }
  const sceneT = () => { const g = geo.scene, s = g.w / (V.x1 - V.x0); return { s, px: (p) => [(p[0] - V.x0) * s, (V.y1 - p[1]) * s] }; };
  const zoomT = () => { const g = geo.zoom, s = g.w / ZOOM_W, c = S.truth; return { s, px: (p) => [g.w / 2 + (p[0] - c[0]) * s, g.h / 2 - (p[1] - c[1]) * s] }; };

  function drawEllipse(ctx, T, mean, cov, k, stroke, fill, dash) {
    const [a, b, ang] = ellipse(cov, k);
    const [x, y] = T.px(mean);
    ctx.save(); ctx.setLineDash(dash || []);
    ctx.beginPath(); ctx.ellipse(x, y, Math.max(a * T.s, 0.8), Math.max(b * T.s, 0.8), -ang, 0, 2 * Math.PI);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore();
  }
  function square(ctx, [x, y], r, color) { ctx.fillStyle = color; ctx.fillRect(x - r, y - r, 2 * r, 2 * r); }
  function dets(ctx, T, big) {
    for (const d of S.dets) {
      const [x, y] = T.px(d.z);
      const age = Math.min(1, (S.t - d.t) / 12);
      ctx.globalAlpha = 1 - 0.75 * age;
      const r = big ? 3.2 : 2.2;
      if (d.status === 'held') {
        if (big) { ctx.strokeStyle = css('--s7'); ctx.globalAlpha *= 0.35; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(x, y, EstimatorSettings.acquire_radius_m * T.s, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
        ctx.strokeStyle = css('--s7'); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r + 1, 0, 2 * Math.PI); ctx.stroke();
      } else if (d.status === 'rejected') {
        ctx.strokeStyle = css('--s8'); ctx.lineWidth = 1.5; const q = r + 0.5;
        ctx.beginPath(); ctx.moveTo(x - q, y - q); ctx.lineTo(x + q, y + q); ctx.moveTo(x + q, y - q); ctx.lineTo(x - q, y + q); ctx.stroke();
      } else {
        ctx.fillStyle = d.status === 'fused' ? css('--state') : css('--muted');
        if (d.status === 'old') ctx.globalAlpha *= 0.5;
        ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawScene() {
    const { ctx, w, h } = geo.scene, T = sceneT();
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1;
    for (let x = Math.ceil(V.x0); x <= V.x1; x++) { const [px] = T.px([x, 0]); ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke(); }
    for (let y = Math.ceil(V.y0); y <= V.y1; y++) { const [, py] = T.px([0, y]); ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(w, py); ctx.stroke(); }
    // field of view toward the prop
    const th = Math.atan2(S.truth[1] - S.talos[1], S.truth[0] - S.talos[0]);
    const [tx, ty] = T.px(S.talos);
    ctx.fillStyle = 'rgba(42,120,214,0.08)';
    ctx.beginPath(); ctx.moveTo(tx, ty);
    ctx.arc(tx, ty, MAX_RANGE * T.s, -(th + HALF_FOV), -(th - HALF_FOV)); ctx.closePath(); ctx.fill();
    // the map's estimate
    const [mean, cov] = S.est.position(NAME);
    drawEllipse(ctx, T, mean, cov, 2, css('--accent'), 'rgba(217,72,15,0.08)');
    // prior
    const [px, py] = T.px(PRIOR);
    ctx.strokeStyle = css('--ink-2'); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, py - 6); ctx.lineTo(px + 6, py); ctx.lineTo(px, py + 6); ctx.lineTo(px - 6, py); ctx.closePath(); ctx.stroke();
    ctx.font = '12px ' + css('--sans'); ctx.fillStyle = css('--ink-2');
    ctx.fillText('prior', px - 34, py - 7);
    dets(ctx, T, false);
    if (S.look) square(ctx, T.px(lookalike()), 4, css('--muted'));
    square(ctx, T.px(S.truth), 4.5, css('--ink'));
    // zoom box
    const zs = ZOOM_W / 2, zh = zs * geo.zoom.h / geo.zoom.w;
    const [ax, ay] = T.px([S.truth[0] - zs, S.truth[1] + zh]);
    ctx.strokeStyle = css('--ink-2'); ctx.setLineDash([2, 3]); ctx.strokeRect(ax, ay, 2 * zs * T.s, 2 * zh * T.s); ctx.setLineDash([]);
    // Talos
    ctx.save(); ctx.translate(tx, ty); ctx.rotate(-th);
    ctx.fillStyle = css('--accent'); ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(-7, -7); ctx.lineTo(-4, 0); ctx.lineTo(-7, 7); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.fillStyle = css('--ink'); ctx.fillText('Talos', tx - 16, ty + 22);
    const range = Math.hypot(S.truth[0] - S.talos[0], S.truth[1] - S.talos[1]);
    ctx.fillStyle = css('--muted'); ctx.fillText(range > MAX_RANGE ? `${range.toFixed(1)} m: too far to detect` : `${range.toFixed(1)} m`, 8, h - 8);
  }

  function drawZoom() {
    const { ctx, w, h } = geo.zoom, T = zoomT();
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1;
    const c = S.truth;
    for (let k = -10; k <= 10; k++) {
      const [gx] = T.px([Math.round(c[0] * 10) / 10 + k * 0.1, 0]); ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
      const [, gy] = T.px([0, Math.round(c[1] * 10) / 10 + k * 0.1]); ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }
    const est = S.est, tr = est.tracks[NAME];
    if (tr.updates >= EstimatorSettings.gate_min_updates && S.lastR) {
      const Sm = add(est.track_cov[NAME], S.lastR);
      drawEllipse(ctx, T, est.track_mean[NAME], Sm, Math.sqrt(EstimatorSettings.gate_chi2), css('--ink-2'), null, [5, 4]);
    }
    dets(ctx, T, true);
    if (S.look) square(ctx, T.px(lookalike()), 6, css('--muted'));
    square(ctx, T.px(S.truth), 6, css('--ink'));
    const [mean, cov] = est.position(NAME);
    drawEllipse(ctx, T, mean, cov, 2, css('--accent'), 'rgba(217,72,15,0.12)');
    const [mx, my] = T.px(mean);
    ctx.fillStyle = css('--accent'); ctx.beginPath(); ctx.arc(mx, my, 3, 0, 2 * Math.PI); ctx.fill();
    ctx.font = '12px ' + css('--sans'); ctx.fillStyle = css('--muted');
    ctx.fillText('10 cm grid', 8, h - 8);
  }

  function drawStatus() {
    const est = S.est, tr = est.tracks[NAME];
    const held = (est.pending.get(NAME) || []).length;
    const acquiring = tr.updates === 0 && tr.verifying < 0;
    const chip = (on, text, warn) => `<span class="chip${on ? ' on' : ''}${warn ? ' warn' : ''}">${text}</span>`;
    const sig = publishedSigma(est);
    status.innerHTML = chip(acquiring, acquiring ? `acquiring · ${held} held` : 'acquiring')
      + chip(tr.verifying >= 0, tr.verifying >= 0 ? `verifying ${tr.verifying}/${EstimatorSettings.verify_detections}` : 'verifying')
      + chip(tr.established, 'established') + chip(tr.confirmed, 'confirmed')
      + chip(tr.updates >= EstimatorSettings.gate_min_updates, 'gate on')
      + `<span class="num">fused <b>${tr.updates}</b></span>`
      + `<span class="num">rejected in a row <b>${tr.rejects}</b>/${EstimatorSettings.gate_max_rejects}</span>`
      + `<span class="num">published σ <b>${sig >= 0.995 ? (sig * 100).toFixed(0) + ' cm (floor)' : (sig * 100).toFixed(1) + ' cm'}</b></span>`;
    logEl.innerHTML = S.log.slice(-7).map((l) => `<li class="${l.kind}"><span class="t">${l.t.toFixed(1)} s</span> ${l.text}${l.n > 1 && l.collapse === 'acq' ? '' : ''}</li>`).join('');
  }
  const draw = () => { if (!geo.scene.ctx) layout(); drawScene(); drawZoom(); drawStatus(); };

  // drag Talos
  let dragging = false;
  const moveTalos = (e) => {
    const rect = scene.getBoundingClientRect(), T = sceneT();
    const x = V.x0 + (e.clientX - rect.left) / T.s, y = V.y1 - (e.clientY - rect.top) / T.s;
    const nx = Math.min(Math.max(x, V.x0 + 0.1), V.x1 - 0.1), ny = Math.min(Math.max(y, V.y0 + 0.1), V.y1 - 0.1);
    if (Math.hypot(nx - S.truth[0], ny - S.truth[1]) < 0.6) return;
    S.moved += Math.hypot(nx - S.talos[0], ny - S.talos[1]);
    S.talos = [nx, ny, DEPTH];
    draw();
  };
  scene.addEventListener('pointerdown', (e) => { dragging = true; scene.setPointerCapture(e.pointerId); moveTalos(e); });
  scene.addEventListener('pointermove', (e) => { if (dragging) moveTalos(e); });
  scene.addEventListener('pointerup', () => { dragging = false; });

  reset();
  let visible = true, last = performance.now(), acc = 0;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(scene);
  new ResizeObserver(() => { layout(); draw(); }).observe(scene);
  const frame = (now) => {
    const dt = Math.min((now - last) / 1000, 0.25); last = now;
    if (playing && visible) {
      acc += dt;
      let n = 0;
      while (acc >= DT && n++ < 3) { step(); acc -= DT; }
      if (n) draw();
    }
    requestAnimationFrame(frame);
  };
  draw();
  requestAnimationFrame(frame);
}

// ---------- published covariance against detections ----------
{
  const r = rng(3);
  const est = makeEstimator();
  const truth = [0.32, -0.24, DEPTH], cam = [-1.6, -0.9, DEPTH];
  const pub = [], own = [];
  let t = 0, n = 0;
  const sample = () => { pub.push({ x: n, y: publishedSigma(est) * 100 }); own.push({ x: n, y: ownSigma(est) * 100 }); };
  sample();
  const markers = [];
  let confirmedSeen = false;
  const one = () => {
    t += DT; n++;
    est.predict(0, DT);
    const [z, R] = detect(cam, truth, r);
    const [, reason] = est.observe(NAME, t, z, R, null, null, true);
    sample();
    return reason;
  };
  for (let i = 0; i < 16; i++) {
    const reason = one();
    if (reason.includes('detections agree')) markers.push({ x: n, label: '4 agree' });
    if (!confirmedSeen && est.confirmed(NAME)) { markers.push({ x: n, label: 'confirmed' }); confirmedSeen = true; }
  }
  est.reset(NAME, true);
  pub.push({ x: n + 0.001, y: publishedSigma(est) * 100 }); own.push({ x: n + 0.001, y: ownSigma(est) * 100 });
  markers.push({ x: n, label: 'retarget' });
  const before = n;
  for (let i = 0; i < 8; i++) {
    const was = est.confirmed(NAME);
    one();
    if (!was && est.confirmed(NAME)) markers.push({ x: n, label: `confirmed (${n - before})` });
  }
  const kept = markers;
  const chart = new LineChart(document.getElementById('trk-pub-chart'), { height: 240, xLabel: 'detections', yLabel: 'horizontal σ (cm)', digits: 1, unit: ' cm', yDomain: [0, 115], markers: kept });
  chart.set([
    { name: 'published on mapping/torpedo', color: css('--state'), values: pub },
    { name: "estimator's own", color: css('--reference'), dash: true, values: own },
  ]);
}
