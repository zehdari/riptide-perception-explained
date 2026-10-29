import { setup } from '../layout.js';
import { LineChart } from '../viz/chart.js';
import { CourseView, PROPS, colorOf } from '../viz/course.js';
import '../css/mission.css';
import '../css/mapping.css';

setup();
const BASE = import.meta.env.BASE_URL;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const cm = (m) => `${Math.round(m * 100)} cm`;
const NAMES = { gate: 'gate', slalom_parent: 'slalom', torpedo: 'torpedo', bin: 'bins', table: 'table' };

const [full, heroShift, heroExact] = await Promise.all(
  ['mission_full.json', 'mission_hero.json', 'mission_hero_exact.json'].map((f) => fetch(`${BASE}data/${f}`).then((r) => r.json())),
);
const heroes = { shifted: heroShift, exact: heroExact };
const phaseBands = (phases) => phases.map(([s, e, name], i) => ({ x0: s, x1: e, color: i % 2 ? 'rgba(15,38,51,0.035)' : 'rgba(15,38,51,0.07)', name }));

// ---------- replay ----------
{
  const canvas = document.getElementById('replay-canvas');
  const play = document.getElementById('play'), scrub = document.getElementById('scrub'), out = document.getElementById('replay-t');
  let run = 'exact', t = 0, playing = false, last = 0;
  let view = new CourseView(canvas, heroes[run], { box: heroes.shifted.box, insets: [10, 10, 10, 10] });
  const cardImg = document.getElementById('card-img'), cardText = document.getElementById('card-text'), cardTree = document.getElementById('card-tree');
  let shown = null;
  const lastAt = (rows, t) => { let r = null; for (const x of rows || []) { if (x[0] > t) break; r = x; } return r; };
  const draw = () => {
    view.set(t); scrub.value = t; out.textContent = fmtT(t);
    const h = heroes[run], card = lastAt(h.cards, t);
    if (card !== shown) {
      shown = card;
      cardImg.src = card ? `${BASE}img/events/${card[1]}` : '';
      cardImg.style.visibility = card ? 'visible' : 'hidden';
      cardText.textContent = card ? `${fmtT(card[0])}  ${card[3] === 'tree' ? 'Tree' : 'Mapping'}: ${card[2]}` : '\u00a0';
    }
    const tl = lastAt((h.tree_log || []).filter((x) => !x[1].startsWith('Message from')), t);
    cardTree.textContent = tl ? `Tree is: ${tl[1].replace(/ and (not )?locking map$/, '')}` : '\u00a0';
  };
  const phaseHost = document.getElementById('phase-jump');
  const buildPhases = () => {
    phaseHost.innerHTML = '';
    for (const [s0, , name] of heroes[run].phases) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = name;
      b.onclick = () => { t = s0; draw(); };
      phaseHost.appendChild(b);
    }
  };
  const setRun = (r) => {
    run = r;
    view = new CourseView(canvas, heroes[run], { box: heroes.shifted.box, insets: [10, 10, 10, 10] });
    scrub.max = heroes[run].duration;
    t = Math.min(t, heroes[run].duration);
    shown = undefined;
    buildPhases();
    draw();
  };
  const tick = (now) => {
    if (!playing) return;
    t = Math.min(heroes[run].duration, t + Math.min((now - last) / 1000, 0.1) * 16);
    last = now;
    draw();
    if (t >= heroes[run].duration) { playing = false; play.textContent = 'Replay'; return; }
    requestAnimationFrame(tick);
  };
  play.onclick = () => {
    playing = !playing;
    play.textContent = playing ? 'Pause' : 'Play';
    if (playing) { if (t >= heroes[run].duration) t = 0; last = performance.now(); requestAnimationFrame(tick); }
  };
  scrub.oninput = () => { t = +scrub.value; draw(); };
  document.querySelectorAll('#run-pick button').forEach((b) => (b.onclick = () => {
    document.querySelectorAll('#run-pick button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
    setRun(b.dataset.run);
  }));
  scrub.max = heroes[run].duration;
  // Start on the torpedo
  const torp = heroes[run].phases.find((p) => p[2] === 'Torpedo');
  t = torp ? torp[0] + 30 : 0;
  buildPhases();
  draw();
  window.__jump = (s) => { if (run !== 'shifted') document.querySelector('#run-pick button[data-run="shifted"]').click(); t = s; draw(); canvas.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
}

// ---------- the offset ----------
{
  const s = full.shifted;
  const chart = new LineChart(document.getElementById('offset-chart'), { height: 240, xLabel: 'mission time (s)', yLabel: 'offset (m)', digits: 2, unit: ' m', xDigits: 0, bands: phaseBands(s.phases) });
  const T = s.duration;
  chart.set([
    { name: 'east (x)', color: css('--state'), values: s.offset.map((r) => ({ x: r[0], y: r[1] })) },
    { name: 'north (y)', color: css('--reference'), values: s.offset.map((r) => ({ x: r[0], y: r[2] })) },
    { name: 'Nereus shift', color: css('--state'), dash: true, width: 1.2, noLegend: true, values: [{ x: 0, y: s.shift[0] }, { x: T, y: s.shift[0] }] },
    { name: 'Nereus shift, north', color: css('--reference'), dash: true, width: 1.2, noLegend: true, values: [{ x: 0, y: s.shift[1] }, { x: T, y: s.shift[1] }] },
  ], { markers: s.phases.map(([x, , label]) => ({ x, label })) });
}

// ---------- error per prop ----------
{
  const chart = new LineChart(document.getElementById('error-chart'), { height: 280, xLabel: 'mission time (s)', yLabel: 'error (m)', digits: 2, unit: ' m', xDigits: 0, yZero: true });
  const show = (run) => {
    const r = full[run];
    const series = [];
    for (const [name, p] of Object.entries(r.props)) {
      series.push({ name: NAMES[name], color: colorOf(name), values: p.series.map(([x, y]) => ({ x, y })) });
    }
    chart.set(series, { bands: phaseBands(r.phases), markers: r.phases.map(([x, , label]) => ({ x, label })) });
    const tbl = document.getElementById('final-table');
    tbl.innerHTML = `<thead><tr><th>Prop</th><th>Prior off by</th><th>Estimate off by, at the end</th><th>Confirmed at the end</th></tr></thead><tbody>${Object.entries(r.props)
      .map(([n, p]) => `<tr><td><i class="dot" style="background:${colorOf(n)}"></i>${NAMES[n]}</td><td>${cm(p.prior_err)}</td><td>${cm(p.final_err)}</td><td>${p.confirmed ? 'yes' : 'no (published σ floored at 1 m)'}</td></tr>`)
      .join('')}</tbody>`;
  };
  document.querySelectorAll('#err-run button').forEach((b) => (b.onclick = () => {
    document.querySelectorAll('#err-run button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
    show(b.dataset.run);
  }));
  show('shifted');
}

// ---------- the log ----------
{
  const s = full.shifted;
  const items = [
    ...s.log.map(([t, lvl, msg]) => ({ t, msg, kind: lvl === 'WARN' ? 'warn' : 'map' })),
    ...s.tree_log.filter(([, m]) => m.startsWith('Setting mapping to target') && !/target\s+and/.test(m)).map(([t, msg]) => ({ t, msg: msg.replace(' and not locking map', ''), kind: 'tree' })),
  ].sort((a, b) => a.t - b.t);
  const ol = document.getElementById('maplog');
  ol.innerHTML = items.map((it) => `<li class="${it.kind}" data-t="${it.t}"><time>${fmtT(Math.max(it.t, 0))}</time><span>${it.msg.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c])}</span></li>`).join('');
  ol.addEventListener('click', (e) => { const li = e.target.closest('li'); if (li) window.__jump(+li.dataset.t); });
}


// ---------- the warning basket ----------
{
  const w = await fetch(`${BASE}data/mission_warning.json`).then((r) => r.json());
  const det = w.detections.filter((d) => d[1] === 'warning');
  const search = w.tree.find((x) => x[1].startsWith('Searching for warning'));
  const t0 = search ? search[0] : 220, t1 = Math.min(w.t1, t0 + 62);
  // detections inside the trailing acquisition window
  const counts = [];
  for (let t = t0; t <= t1; t += 0.1) counts.push({ x: t, y: det.filter((d) => d[0] <= t && d[0] > t - w.acquire.window_s).length });
  const bands = [];
  let start = null;
  for (const [t, m] of w.tree) {
    if (m.startsWith('warning in view')) start = t;
    if (m.startsWith('Lost sight of warning') && start !== null) { bands.push({ x0: start, x1: t, color: 'rgba(232,123,164,0.16)' }); start = null; }
  }
  const chart = new LineChart(document.getElementById('warning-chart'), { height: 220, xLabel: 'mission time (s)', yLabel: 'detections in the last 4 s', digits: 0, xDigits: 1, xDomain: [t0, t1], yDomain: [0, 5], bands,
    markers: [{ x: t0, label: 'search starts' }, { x: t0 + 60, label: 'gives up' }] });
  chart.set([
    { name: 'in the 4 s window', color: '#e87ba4', values: counts },
    { name: 'needed to acquire', color: css('--ink-2'), dash: true, width: 1.2, values: [{ x: t0, y: w.acquire.n }, { x: t1, y: w.acquire.n }] },
    { name: 'a detection', color: '#e87ba4', points: true, r: 3.4, opacity: 0.9, values: det.map((d) => ({ x: d[0], y: 0.25 })) },
  ]);

  // top-down zoom on the table
  const cv = document.getElementById('warning-map');
  const ctx = cv.getContext('2d');
  const tt = w.truth_table;
  const wf = w.estimates.warning.find((r) => r[0] >= t0) || w.estimates.warning[0];
  const hf = w.estimates.helmet.at(-1);
  const pts = det.map((d) => [d[2], d[3]]);
  const path = w.path.filter((r) => r[0] >= t0 && r[0] <= t1);
  const xs = [tt.position_m[0], wf[1], hf[1], ...pts.map((p) => p[0]), ...path.map((r) => r[1])];
  const ys = [tt.position_m[1], wf[2], hf[2], ...pts.map((p) => p[1]), ...path.map((r) => r[2])];
  const box = [Math.min(...xs) - 0.4, Math.min(...ys) - 0.4, Math.max(...xs) + 0.4, Math.max(...ys) + 0.4];
  const drawMap = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2), W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sc = Math.min(W / (box[2] - box[0]), H / (box[3] - box[1]));
    const ox = (W - (box[2] - box[0]) * sc) / 2, oy = (H - (box[3] - box[1]) * sc) / 2;
    const P = (x, y) => [ox + (x - box[0]) * sc, oy + (box[3] - y) * sc];
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(15,38,51,0.08)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = Math.ceil(box[0] * 5) / 5; x <= box[2]; x += 0.2) { ctx.moveTo(...P(x, box[1])); ctx.lineTo(...P(x, box[3])); }
    for (let y = Math.ceil(box[1] * 5) / 5; y <= box[3]; y += 0.2) { ctx.moveTo(...P(box[0], y)); ctx.lineTo(...P(box[2], y)); }
    ctx.stroke();
    // table footprint (0.9 x 1.2 m) where Nereus put it
    const yaw = (tt.yaw_deg * Math.PI) / 180, c = Math.cos(yaw), s = Math.sin(yaw);
    const [tx, ty] = tt.position_m;
    ctx.beginPath();
    [[0.45, 0.6], [-0.45, 0.6], [-0.45, -0.6], [0.45, -0.6]].forEach(([u, v], i) => { const p = P(tx + c * u - s * v, ty + s * u + c * v); i ? ctx.lineTo(...p) : ctx.moveTo(...p); });
    ctx.closePath(); ctx.fillStyle = 'rgba(15,38,51,0.14)'; ctx.fill(); ctx.strokeStyle = 'rgba(15,38,51,0.45)'; ctx.stroke();
    // path
    ctx.strokeStyle = 'rgba(15,38,51,0.75)'; ctx.lineWidth = 1.5; ctx.beginPath();
    path.forEach((r, i) => (i ? ctx.lineTo(...P(r[1], r[2])) : ctx.moveTo(...P(r[1], r[2]))));
    ctx.stroke();
    // detections
    ctx.fillStyle = '#e87ba4';
    for (const p of pts) { ctx.beginPath(); ctx.arc(...P(p[0], p[1]), 4, 0, 2 * Math.PI); ctx.fill(); }
    // estimates
    const label = (x, y, text) => { ctx.font = '600 12px Archivo Variable, system-ui, sans-serif'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(243,247,247,0.9)'; ctx.strokeText(text, x + 10, y + 4); ctx.fillStyle = '#0f2633'; ctx.fillText(text, x + 10, y + 4); };
    let [px, py] = P(wf[1], wf[2]);
    ctx.lineWidth = 2.2; ctx.strokeStyle = '#e87ba4'; ctx.fillStyle = '#f3f7f7';
    ctx.beginPath(); ctx.arc(px, py, 7, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    label(px, py, 'warning_frame (mapping)');
    const m = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
    const [mx, my] = P(...m);
    ctx.setLineDash([4, 3]); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(mx, my); ctx.stroke(); ctx.setLineDash([]);
    label(mx, my + 16, `real basket, ${Math.round(Math.hypot(m[0] - wf[1], m[1] - wf[2]) * 100)} cm away`);
    [px, py] = P(hf[1], hf[2]);
    ctx.fillStyle = '#e87ba4'; ctx.beginPath(); ctx.arc(px, py, 6, 0, 2 * Math.PI); ctx.fill();
    label(px, py, 'helmet (found)');
  };
  new ResizeObserver(drawMap).observe(cv);
}

// ---------- the exact-course run as a video, with a button per task ----------
{
  const video = document.getElementById('run-video');
  const host = document.getElementById('run-video-chapters');
  fetch(`${BASE}data/mission_video.json`).then((r) => r.json()).then((d) => {
    for (const [t, name] of d.chapters) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = name;
      b.onclick = () => { video.currentTime = t; video.play().catch(() => {}); };
      host.appendChild(b);
    }
    video.addEventListener('timeupdate', () => {
      let on = -1;
      d.chapters.forEach(([t], i) => { if (video.currentTime >= t - 0.2) on = i; });
      host.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === on)));
    });
  });
}
