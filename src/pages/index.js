import { setup } from '../layout.js';
import { Graph } from '../viz/graph.js';
import { CourseView, at } from '../viz/course.js';
import '../css/index.css';

setup();
const BASE = import.meta.env.BASE_URL;

// ---------- hero: the mission replay ----------
{
  const canvas = document.getElementById('hero-canvas');
  const play = document.getElementById('play');
  const scrub = document.getElementById('scrub');
  const hudT = document.getElementById('hud-t'), hudTarget = document.getElementById('hud-target');
  const hudOffset = document.getElementById('hud-offset'), hudLog = document.getElementById('hud-log');
  const video = document.getElementById('cam-video'), inset = document.getElementById('cam-inset');
  const phone = matchMedia('(max-width: 720px)');
  let view, data, speed = 16, playing = false, last = 0, t = 0, end = 1;

  const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const insets = () => (phone.matches ? [150, 10, 280, 10] : [40, 30, 120, Math.min(520, innerWidth * 0.36)]);

  function update() {
    view.o.insets = insets();
    view.set(t);
    scrub.value = t;
    hudT.textContent = fmtT(t);
    const tg = at(data.targets, t);
    hudTarget.textContent = tg ? (tg[1] ? tg[1].replace(/,\s*$/, '') : tg[2] ? 'none, map locked' : 'closest object') : '–';
    const off = at(data.offset, t);
    hudOffset.textContent = off ? `${(Math.hypot(off[1], off[2]) * 100).toFixed(0)} cm` : '–';
    const line = at(data.log, t);
    hudLog.textContent = line && t - line[0] < 25 ? line[2] : ' ';
    if (data.video && video.readyState >= 1) {
      const vt = Math.min(Math.max(t - data.video.t0, 0), video.duration);
      const rate = playing && speed <= 16 ? speed : 0;
      if (rate) {
        if (video.playbackRate !== rate) video.playbackRate = rate;
        if (video.paused) video.play().catch(() => {});
      } else if (!video.paused) video.pause();
      // resync when the replay and the video drift apart (always, when paused or too fast to play)
      if (!video.seeking && Math.abs(video.currentTime - vt) > (rate ? 2 + rate * 0.2 : 0.3)) video.currentTime = vt;
    }
  }

  function frame(now) {
    if (!playing) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    t = Math.min(end, t + dt * speed);
    update();
    if (t >= end) { setPlaying(false); return; }
    requestAnimationFrame(frame);
  }
  function setPlaying(on) {
    playing = on;
    if (!on && data?.video) video.pause();
    play.textContent = on ? 'Pause' : t >= end ? 'Replay' : 'Play';
    play.setAttribute('aria-pressed', String(on));
    if (on) {
      if (t >= end) t = 0;
      last = performance.now();
      requestAnimationFrame(frame);
    }
  }
  play.onclick = () => setPlaying(!playing);
  scrub.oninput = () => { t = +scrub.value; update(); };
  document.querySelectorAll('#speed button').forEach((b) => {
    b.onclick = () => {
      speed = +b.dataset.v;
      document.querySelectorAll('#speed button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
    };
  });

  fetch(`${BASE}data/mission_hero.json`).then((r) => r.json()).then((d) => {
    data = d;
    end = d.duration;
    scrub.max = end;
    view = new CourseView(canvas, d, { insets: insets(), box: d.box });
    // the mission's phases under the scrubber
    const ph = document.getElementById('phases');
    for (const [s, e, name] of d.phases || []) {
      const el = document.createElement('span');
      el.style.left = `${(s / end) * 100}%`;
      el.style.width = `${((e - s) / end) * 100}%`;
      el.textContent = name;
      el.title = name;
      ph.appendChild(el);
    }
    if (d.video) {
      video.src = `${BASE}${d.video.src}`;
      inset.hidden = false;
    }
    t = d.start || 0;
    update();
    addEventListener('resize', update);
    // Start playing once the hero is on screen
    new IntersectionObserver((es, ob) => {
      if (es[0].isIntersecting && !matchMedia('(prefers-reduced-motion: reduce)').matches) { setPlaying(true); ob.disconnect(); }
    }).observe(canvas);
  });
}

// ---------- the pipeline graph ----------
{
  const SRC = 'https://github.com/osu-uwrt/riptide_perception/blob/mapping-estimator';
  const nodes = [
    { id: 'cam', label: 'ZED X Mini', sub: 'RGB + depth', x: 0, y: 0, info: 'Two stereo cameras: ffc looks forward, dfc down. Each publishes a compressed colour image and a depth map registered to it, 1920 × 1200.' },
    { id: 'sync', label: 'Pair by stamp', sub: 'depth ring buffer', x: 1, y: 0, info: 'Depth arrives after the colour frame, so the detector keeps the last 15 depth maps (at most 1 s old) and uses the one taken closest to each image.', href: `${SRC}/tensor_detector/src/yolo_orientation.py` },
    { id: 'yolo', label: 'YOLO26n-seg', sub: 'TensorRT', x: 2, y: 0, info: 'A segmentation network: for each object, a class, a confidence, a box and a pixel mask. One model per camera, exported to a TensorRT engine on the robot.', href: `${SRC}/tensor_detector/src/yolo_model.py` },
    { id: 'fit', label: 'Mask → pose', sub: 'sample, gate, SVD', x: 3, y: 0, info: 'Grid-sample the mask, back-project each sample through its depth, drop background and outliers, fit a plane: centroid plus surface normal.', href: `${SRC}/tensor_detector/src/detection.py` },
    { id: 'comp', label: 'Composites', sub: 'torpedo, pairs, slalom', x: 4, y: 0, info: 'Props made of several detections: the torpedo board and its four holes, the gate halves and table from pairs of symbols, the nearest slalom pole.', href: `${SRC}/tensor_detector/src/detection.py` },
    { id: 'det', label: 'detected_objects', sub: 'camera frame', x: 4, y: 1, info: 'vision_msgs/Detection3DArray: class, score and pose of each detection, in the camera\'s optical frame, stamped with the image time.' },
    { id: 'tf', label: 'Into the parent frame', sub: 'TF at the stamp', x: 3, y: 1, info: 'Each detection is transformed into its object\'s parent frame (map, or another prop\'s frame) with TF looked up at the image stamp, and given a covariance from the noise model.', href: `${SRC}/riptide_mapping/riptide_mapping2/mapping.py` },
    { id: 'track', label: 'Per-object filter', sub: 'agree, gate, update', x: 2, y: 1, info: 'A 3-state Kalman filter per object. New detections wait until a few agree; later ones far from the estimate are rejected.', href: `${SRC}/riptide_mapping/riptide_mapping2/map_estimator.py` },
    { id: 'solve', label: 'Course map', sub: 'offset + deviations', x: 1, y: 1, info: 'A robust least-squares solve over every sighting: where the course sits in odometry (the offset), how far each prop is from the layout, and the course\'s heading error.', href: `${SRC}/riptide_mapping/riptide_mapping2/map_estimator.py` },
    { id: 'pub', label: 'TF + covariance', sub: 'mapping/<object>', x: 0, y: 1, info: 'Every object as a TF frame (map → offset → <object>_frame) and a PoseWithCovarianceStamped. Autonomy and the MPC steer by these frames.' },
    { id: 'auto', label: 'Autonomy', sub: 'behaviour trees', x: 0, y: 2, info: 'The behaviour trees set mapping\'s target (which props it may update), wait for the covariance to shrink, and drive to the frames.' },
  ];
  const edges = [['cam', 'sync'], ['sync', 'yolo'], ['yolo', 'fit'], ['fit', 'comp'], ['comp', 'det'], ['det', 'tf'], ['tf', 'track'], ['track', 'solve'], ['solve', 'pub'], ['pub', 'auto'], ['auto', 'track', 'target']];
  const host = document.getElementById('pipeline-graph');
  const note = document.createElement('div');
  note.className = 'graph-note';
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const say = (id) => {
    const n = byId[id || 'track'];
    note.innerHTML = `<b>${n.label}.</b> ${n.info}${n.href ? ` <a href="${n.href}">${n.href.split('/').pop()}</a>` : ''}`;
  };
  const g = new Graph(host, {
    width: 900,
    height: 340,
    nodes: nodes.map((n) => ({ id: n.id, label: n.label, sub: n.sub, x: 90 + n.x * 180, y: 50 + n.y * 125, w: 150 })),
    edges: edges.map(([from, to, label]) => ({ from, to, label, dash: label === 'target', bend: label === 'target' ? -40 : 0 })),
    onSelect: say,
  });
  host.appendChild(note);
  say(null);
  g.highlight(null);
  g.pulse((e) => !e.dash, 2.4);
}
