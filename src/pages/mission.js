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
