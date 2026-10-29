import { setup } from '../layout.js';
import { Graph } from '../viz/graph.js';
import { BinaryClassifier, State } from '../engine/cluster.js';
import '../css/frames.css';
import '../css/mapping.css';

setup();
const BASE = import.meta.env.BASE_URL;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// ---------- the TF tree ----------
function tfTree() {
  const host = document.getElementById('tf-graph');
  const note = document.createElement('div');
  note.className = 'frames-note';
  const hint = 'Tap a frame.';
  const N = (id, x, y, label, info, sub) => ({ id, x, y, label, sub, info });
  const nodes = [
    N('world', 60, 205, 'world', 'The fixed frame of the stack. Navigation publishes odom as identical to it.'),
    N('odom', 180, 355, 'odom', 'Odometry: the EKF (DVL, fibre-optic gyro, depth) places Talos here. It drifts slowly from the real pool.'),
    N('base', 315, 355, 'talos/base_link', 'Talos itself, from the EKF.'),
    N('cam', 470, 355, 'ffc · dfc optical', 'The two cameras\' optical frames (z forward). Detections arrive in these; mapping looks up the transform to each object\'s parent at the detection\'s stamp.'),
    N('map', 180, 135, 'map', 'Set once by the AprilTag calibration: a chameleon_tf node averages the board\'s observed pose and adopts it for world → map (x, y and yaw free; z, roll, pitch locked). The odometry frame re-anchored to the course. Map objects\' detections are fused here.'),
    N('offset', 315, 135, 'offset', 'map → offset, published by mapping: a pure translation, where the course sits in odometry (Chapter 8). Every map object hangs off it.'),
    N('gate', 470, 30, 'gate', 'gate_frame: prior + deviation from offset. The estimate autonomy drives through.'),
    N('slalom', 470, 82, 'slalom_parent', 'slalom_parent_frame: orientation locked to the config; the three pole sets hang off it.'),
    N('torpedo', 470, 135, 'torpedo', 'torpedo_frame: the board centre the detector computes from its symbols (Chapter 5).'),
    N('bin', 470, 188, 'bin', 'bin_frame: seen by the down camera, orientation from the config.'),
    N('table', 470, 240, 'table', 'table_frame: moved and turned by center_table_on_baskets once the baskets are mapped.'),
    N('pre', 470, 292, 'pre_* waypoints', 'pre_torpedo_pose, pre_bin_pose, pre_table_pose, pre_return_home: map objects nothing ever detects. They exist to move with the offset, so a waypoint near a prop shifts with it.'),
    N('gatec', 640, 30, 'gate_repair, gate_rescue', 'The two halves of the gate, 0.75 m either side of its centre, each filtered in gate_frame.'),
    N('slalomc', 640, 82, 'front → middle, back', 'slalom_front at the parent; middle and back are children of slalom_front, 2.1 m and 4.2 m on.'),
    N('torpc', 640, 135, '4 holes', 'fire_hole_large/small and blood_hole_large/small, each a 3-state filter in torpedo_frame. The large/small pairs are what the 0.0005 shooting checks wait on.'),
    N('binc', 640, 188, 'targets, CAD geometry', 'bin_target1/2 (from the binary classifier) and bin_cad_geometry, whose children are the magnets and vinyls where the CAD puts them.'),
    N('tablec', 640, 240, 'items, baskets, octagon', 'pill, plug, nut_and_bolt, bandage, the helmet and warning baskets, and the octagon above the table (with its four symbols as its children).'),
  ];
  const E = (from, to, mine = false, label) => ({ from, to, color: mine ? 'var(--accent)' : undefined, width: mine ? 2 : undefined, label });
  const edges = [
    E('world', 'odom', false, 'static'), E('odom', 'base'), E('base', 'cam'), E('world', 'map', false, 'AprilTag'),
    E('map', 'offset', true),
    ...['gate', 'slalom', 'torpedo', 'bin', 'table', 'pre'].map((n) => E('offset', n, true)),
    E('gate', 'gatec', true), E('slalom', 'slalomc', true), E('torpedo', 'torpc', true), E('bin', 'binc', true), E('table', 'tablec', true),
  ];
  new Graph(host, { width: 740, height: 390, nodes, edges, info: (n) => { note.textContent = n ? n.info : hint; } });
  host.appendChild(note);
  note.textContent = hint;
}

// ---------- the competition tree's thresholds ----------
function thresholds() {
  const rows = [
    ['Magnet search', 'MagnetTreeMpc', 1.25],
    ['Surface', 'SurfaceTree', 1],
    ['Table items', 'NewTableTreeMpc', 0.5],
    ['Slalom search', 'SlalomPathMpc', 0.3],
    ['Gate', 'GateTreeMpc', 0.1],
    ['Bins', 'BinTreeMpc', 0.02],
    ['Return home', 'ReturnHomeTree', 0.01],
    ['Torpedo board', 'TorpedoTreeMpc', 0.0025],
    ['Torpedo holes, before shooting', 'ShootBothObjectsMpc', 0.0005],
    ['Baskets, before the table fit', 'NewTableTreeMpc', 0.0005],
    ['Dropper and claw hover', 'ShootDownwardObjectMpc, pickupObjectMpc', 0.0005],
  ];
  const sig = (e) => Math.sqrt(e / Math.sqrt(3)) * 100;
  document.getElementById('threshold-table').innerHTML = `<table class="params frames-thr"><thead><tr><th>Check</th><th>Error below</th><th>σ ≈</th></tr></thead><tbody>
    <tr class="group"><td>Unconfirmed object</td><td>1.73</td><td>(1 m)</td></tr>
    ${rows.map(([what, tree, e]) => `<tr><td>${what}<small>${tree.split(', ').map((t) => `<code>${t}</code>`).join(' ')}</small></td><td>${e}</td><td>${sig(e) >= 10 ? sig(e).toFixed(0) : sig(e).toFixed(1)} cm</td></tr>`).join('')}</tbody></table>`;
}

// ---------- the binary classifier ----------
function rng(seed) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { u, n: () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u()) };
}

async function binaryClassifier() {
  const layout = await fetch(`${BASE}data/map_layout.json`).then((r) => r.json());
  const canvas = document.getElementById('bc-canvas');
  const ctx = canvas.getContext('2d');
  const status = document.getElementById('bc-status');
  const controls = document.getElementById('bc-controls');
  const vinyls = ['bin_vinyl1', 'bin_vinyl2', 'bin_vinyl3', 'bin_vinyl4'].map((n) => ({ n, p: layout[n].p, fire: n === 'bin_vinyl2' || n === 'bin_vinyl3' }));
  const X0 = -1.25, X1 = 1.25, Y0 = -0.95, Y1 = 0.95;
  const FOOT = [0.9, 0.7];
  let bc, cam, t, results, r, message;

  function reset() {
    bc = new BinaryClassifier({ buffer_ttl_sec: 8.0 }); // binary_classifier.yaml
    cam = [layout.bin_vinyl2.p[0] - 0.05, layout.bin_vinyl2.p[1] - 0.05];
    t = 0; results = []; r = rng(3); message = 'Stopped. Start it the way the bins tree does: fire → bin_target1, bin_target2.';
  }

  // state machine
  const gHost = document.getElementById('bc-graph');
  const S = (id, x, y, label) => ({ id, x, y, label });
  const nodes = [
    S(State.STOPPED, 250, 30, 'stopped'), S(State.ACQUIRE_FIRST, 90, 30, 'acquire_first'), S(State.TRACK_FIRST, 90, 100, 'track_first'),
    S(State.FROZEN, 90, 170, 'frozen'), S(State.ACQUIRE_SECOND, 250, 100, 'acquire_second'), S(State.TRACK_SECOND, 250, 170, 'track_second'),
  ];
  const graph = new Graph(gHost, {
    width: 340, height: 200, nodes,
    edges: [
      { from: State.STOPPED, to: State.ACQUIRE_FIRST }, { from: State.ACQUIRE_FIRST, to: State.TRACK_FIRST },
      { from: State.TRACK_FIRST, to: State.FROZEN }, { from: State.FROZEN, to: State.ACQUIRE_SECOND },
      { from: State.TRACK_FIRST, to: State.ACQUIRE_SECOND }, { from: State.ACQUIRE_SECOND, to: State.TRACK_SECOND },
      { from: State.TRACK_SECOND, to: State.STOPPED, bend: 60 },
    ],
  });
  const showState = () => {
    graph.nodes.forEach((n, id) => {
      const shape = n.g.firstChild;
      const on = id === bc.state;
      shape.style.fill = on ? css('--ink') : '';
      n.g.querySelector('text').style.fill = on ? css('--paper') : '';
    });
  };

  const call = (fn) => { const [ok, msg] = fn(); message = (ok ? '' : 'refused: ') + msg; };
  const buttons = [
    ['Start', () => call(() => bc.start('fire', 'bin_target1', 'bin_target2'))],
    ['Freeze buffer', () => call(() => bc.freeze_buffer())],
    ['Start second', () => call(() => bc.start_second())],
    ['Stop', () => call(() => bc.stop())],
    ['Reset', () => reset()],
  ];
  for (const [label, fn] of buttons) {
    const b = document.createElement('button');
    b.className = 'btn' + (label === 'Start' ? ' primary' : '');
    b.textContent = label;
    b.onclick = fn;
    controls.appendChild(b);
  }

  let W = 0, H = 0, k = 1;
  const sx = (x) => (x - X0) * k, sy = (y) => H - (y - Y0) * k;
  function resize() {
    W = canvas.clientWidth; k = W / (X1 - X0); H = Math.round((Y1 - Y0) * k);
    const dpr = devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function pick(e) {
    const b = canvas.getBoundingClientRect();
    return [(e.clientX - b.left) / k + X0, (H - (e.clientY - b.top)) / k + Y0];
  }
  let drag = null;
  const onCam = (p) => Math.abs(p[0] - cam[0]) < FOOT[0] / 2 && Math.abs(p[1] - cam[1]) < FOOT[1] / 2;
  canvas.addEventListener('touchstart', (e) => { if (onCam(pick(e.touches[0]))) e.preventDefault(); }, { passive: false });
  canvas.addEventListener('pointerdown', (e) => { const p = pick(e); if (onCam(p)) { drag = [p[0] - cam[0], p[1] - cam[1]]; canvas.setPointerCapture(e.pointerId); } });
  canvas.addEventListener('pointermove', (e) => {
    const p = pick(e);
    canvas.style.cursor = drag || onCam(p) ? 'grab' : 'default';
    if (drag) cam = [Math.min(Math.max(p[0] - drag[0], X0 + 0.3), X1 - 0.3), Math.min(Math.max(p[1] - drag[1], Y0 + 0.3), Y1 - 0.3)];
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('pointercancel', () => { drag = null; });

  function tick() {
    t += 0.1;
    const inside = (p) => Math.abs(p[0] - cam[0]) < FOOT[0] / 2 && Math.abs(p[1] - cam[1]) < FOOT[1] / 2;
    const dets = vinyls.filter((v) => v.fire && inside(v.p)).map((v) => [v.p[0] + 0.025 * r.n(), v.p[1] + 0.025 * r.n(), v.p[2] + 0.05 * r.n()]);
    if (r.u() < 0.05) dets.push([cam[0] + (r.u() - 0.5) * FOOT[0], cam[1] + (r.u() - 0.5) * FOOT[1], 0.3]);
    for (const p of dets) {
      const res = bc.observe({ x: p[0], y: p[1], z: p[2], score: 0.9, stamp_sec: t }, t);
      if (bc.running) results.push({ p, t, who: res.accepted ? res.target_name : '' });
    }
    results = results.filter((x) => t - x.t < 8);
  }

  function draw() {
    const ink = css('--ink'), muted = css('--muted');
    const c1 = css('--state'), c2 = css('--prediction');
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = css('--water'); ctx.fillRect(0, 0, W, H);
    // the bin and its vinyls
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.strokeStyle = css('--ink-2'); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.rect(sx(-0.75), sy(0.55), 1.5 * k, 1.1 * k); ctx.fill(); ctx.stroke();
    ctx.font = '11px Archivo Variable, system-ui, sans-serif';
    for (const v of vinyls) {
      ctx.fillStyle = v.fire ? 'rgba(217,72,15,0.25)' : 'rgba(42,120,214,0.18)';
      ctx.fillRect(sx(v.p[0]) - 0.1 * k, sy(v.p[1]) - 0.1 * k, 0.2 * k, 0.2 * k);
      ctx.fillStyle = css('--ink-2');
      ctx.fillText(v.fire ? 'fire' : 'blood', sx(v.p[0]) - 0.1 * k, sy(v.p[1]) + 0.1 * k + 12);
    }
    // buffer contents: rings
    ctx.strokeStyle = muted; ctx.lineWidth = 1;
    for (const s of bc.samples) { ctx.beginPath(); ctx.arc(sx(s.x), sy(s.y), 3.5, 0, 2 * Math.PI); ctx.stroke(); }
    // recent assignments: dots
    for (const x of results) {
      ctx.globalAlpha = Math.max(0.2, 1 - (t - x.t) / 8);
      ctx.fillStyle = x.who === 'bin_target1' ? c1 : x.who === 'bin_target2' ? c2 : muted;
      ctx.beginPath(); ctx.arc(sx(x.p[0]), sy(x.p[1]), 2.2, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.globalAlpha = 1;
    const centroid = (c, color, label, excl) => {
      if (!c) return;
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx(c[0]), sy(c[1]), bc.params.assignment_gate_m * k, 0, 2 * Math.PI); ctx.stroke();
      if (excl) { ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.arc(sx(c[0]), sy(c[1]), bc.params.exclusion_radius_m * k, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]); }
      ctx.beginPath(); ctx.moveTo(sx(c[0]) - 7, sy(c[1])); ctx.lineTo(sx(c[0]) + 7, sy(c[1])); ctx.moveTo(sx(c[0]), sy(c[1]) - 7); ctx.lineTo(sx(c[0]), sy(c[1]) + 7); ctx.stroke();
      ctx.fillStyle = color; ctx.font = '600 12px Archivo Variable, system-ui, sans-serif';
      ctx.fillText(label, sx(c[0]) + 0.2 * k + 4, sy(c[1]) - 4);
    };
    centroid(bc.instance1_centroid, c1, 'bin_target1', bc.state === State.ACQUIRE_SECOND || bc.state === State.TRACK_SECOND);
    centroid(bc.instance2_centroid, c2, 'bin_target2', false);
    // the down camera's view
    ctx.strokeStyle = css('--accent'); ctx.lineWidth = 2; ctx.fillStyle = 'rgba(217,72,15,0.06)';
    ctx.beginPath(); ctx.rect(sx(cam[0] - FOOT[0] / 2), sy(cam[1] + FOOT[1] / 2), FOOT[0] * k, FOOT[1] * k); ctx.fill(); ctx.stroke();
    ctx.fillStyle = css('--accent'); ctx.font = '11px Archivo Variable, system-ui, sans-serif';
    ctx.fillText('down camera (drag)', sx(cam[0] - FOOT[0] / 2), sy(cam[1] + FOOT[1] / 2) - 5);
    ctx.fillStyle = ink;
  }

  function renderStatus() {
    const f = (c) => (c ? `(${c[0].toFixed(2)}, ${c[1].toFixed(2)})` : '–');
    status.innerHTML = `<div><small>State</small><b>${bc.state}</b></div>
      <div><small>Buffer</small><b>${bc.samples.length}</b>${bc.buffer_frozen ? ' frozen' : ''}</div>
      <div><small>bin_target1</small><b>${f(bc.instance1_centroid)}</b></div>
      <div><small>bin_target2</small><b>${f(bc.instance2_centroid)}</b></div>
      <div class="wide"><small>Last service call</small>${message}</div>`;
    showState();
  }

  reset();
  resize();
  new ResizeObserver(resize).observe(canvas);
  let visible = true, acc = 0, prev = performance.now(), lastStatus = 0;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(canvas);
  const frame = (now) => {
    const dt = Math.min((now - prev) / 1000, 0.2);
    prev = now;
    if (visible) {
      acc += dt;
      while (acc >= 0.1) { tick(); acc -= 0.1; }
      draw();
      if (now - lastStatus > 200) { lastStatus = now; renderStatus(); }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

tfTree();
thresholds();
binaryClassifier();

// ---------- RepairCompMpcTree, task by task ----------
{
  const X = 'https://github.com/osu-uwrt/riptide_autonomy/blob/autonomy-mapping/trees/RepairCompMpcTree.xml';
  const sig = (e) => `${e} (≈${(Math.sqrt(e / Math.sqrt(3)) * 100).toFixed(e < 0.01 ? 1 : 0)} cm)`;
  const tasks = [
    ['Start', 'none', 'none, map locked', 'nothing', 'Waits for the kill switch, locks the map with an empty target, dives.', 1807],
    ['Gate', 'ffc (default)', 'none, map stays locked', 'nothing: its searches are disabled', 'Flies a path through the prior <code>gate_repair_frame</code>; a false detection here (a gate leg called a slalom pole) is ignored because the map is locked.', 1174],
    ['Slalom', 'ffc (assumed)', '<code>slalom_parent</code>', `MiniSearchMpc, ${sig(0.3)}, 15 s`, 'Carries on regardless, locks the map, follows a path through the three pole frames.', 2492],
    ['Random pinger', 'n/a', 'none, map locked', 'acoustics, 10 s at each candidate', 'Defaults to torpedo first.', 1884],
    ['Torpedo', 'ffc', '<code>torpedo</code>', `SearchMpc, ${sig(0.0025)}, 100 s`, 'Logs an error and goes on to the shot anyway.', 2996],
    ['Torpedo holes', 'ffc', '<code>fire_hole_large,fire_hole_small,</code>', `both ${sig(0.0005)}, hold up to 30 s`, 'Locks the map and shoots at whatever the estimates are.', 2383],
    ['Table baskets', 'dfc', '<code>helmet</code>, then <code>warning</code> (all six table props as background targets)', `DownwardSearchMpc each, ${sig(0.0005)}, 60 s; then both within 1 s`, 'No <code>center_table_on_baskets</code>: "the table keeps its prior". Table pair mode is switched off.', 1706],
    ['Table pickups ×4', 'dfc', 'the item (<code>bandage</code>, <code>pill</code>, <code>nut_and_bolt</code>, <code>plug</code>)', `DownwardSearchMpc ${sig(0.5)}, 180 s; hover ${sig(0.0005)} up to 5 s`, 'Locks the map and grabs on the current estimate; drops in the helmet or warning basket.', 3219],
    ['Bins', 'dfc', 'binary classifier on <code>fire</code> → <code>bin_target1</code>, then <code>bin_target2</code>', `DownwardSearchMpc ${sig(0.02)}, 120 s; hover ${sig(0.0005)} 3 s`, 'If starting the classifier fails, the whole bins task is skipped.', 178],
    ['Magnets', 'ffc', '<code>fit_bin_geometry</code>, classifier on <code>magnet</code>', `MiniSearchMpc ${sig(1.25)}, 20 s`, 'A classifier left running by the bins makes this task fail at the start.', 1379],
    ['Return home', 'n/a', 'none', 'nothing', 'Path through the prior <code>pre_return_home</code> and <code>gate_frame</code>.', 543],
  ];
  const host = document.getElementById('task-cards');
  host.innerHTML = tasks.map(([name, cam, target, wait, fail, line]) => `
    <section class="task">
      <h3><a href="${X}#L${line}">${name}</a></h3>
      <dl>
        <dt>Camera</dt><dd>${cam}</dd>
        <dt>Target</dt><dd>${target}</dd>
        <dt>Waits for</dt><dd>${wait}</dd>
        <dt>Then</dt><dd>${fail}</dd>
      </dl>
    </section>`).join('');
}
