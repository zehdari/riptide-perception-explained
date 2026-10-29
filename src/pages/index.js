import { setup } from '../layout.js';
import { Graph } from '../viz/graph.js';
import '../css/index.css';

setup();
const BASE = import.meta.env.BASE_URL;

// ---------- hero: the mission video, with a button per task ----------
{
  const video = document.getElementById('hero-video');
  const host = document.getElementById('hero-chapters');
  fetch(`${BASE}data/mission_video.json`).then((r) => r.json()).then((d) => {
    for (const [t, name] of d.chapters) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = name;
      b.onclick = () => { video.currentTime = t; video.play().catch(() => {}); };
      host.appendChild(b);
    }
    const mark = () => {
      let on = -1;
      d.chapters.forEach(([t], i) => { if (video.currentTime >= t - 0.2) on = i; });
      host.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === on)));
    };
    video.addEventListener('timeupdate', mark);
    mark();
  });
  // play when on screen (muted), unless the reader prefers less motion
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    new IntersectionObserver((es) => { es[0].isIntersecting ? video.play().catch(() => {}) : video.pause(); }, { threshold: 0.4 }).observe(video);
  }
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
