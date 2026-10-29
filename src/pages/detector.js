import { setup } from '../layout.js';
import '../css/vision.css';
import { Graph } from '../viz/graph.js';
import { FrameView, loadFrame, picker, classColor } from '../viz/detector_frames.js';

setup();

// ---------- class tables (config/yolo_orientation.yaml) ----------
{
  const ffc = ['blood', 'buoy', 'compass', 'circle', 'fire', 'hammer_and_wrench', 'slalom', 'sos', 'ambulance', 'fire_engine', 'magnet'];
  const dfc = ['bandage', 'blood', 'fire', 'helmet', 'nut_and_bolt', 'pill', 'plug', 'warning'];
  const task = {
    blood: 'torpedo board symbol (bins on the dfc)', fire: 'torpedo board symbol (bins on the dfc)', circle: 'torpedo opening',
    ambulance: 'torpedo board symbol', fire_engine: 'torpedo board symbol', buoy: 'gate half (rescue)', sos: 'gate half (rescue)',
    compass: 'gate half (repair)', hammer_and_wrench: 'gate half (repair)', slalom: 'slalom pole', magnet: 'bin magnet',
    bandage: 'table item', helmet: 'table basket', nut_and_bolt: 'table item', pill: 'table item', plug: 'table item', warning: 'table basket',
  };
  const host = document.getElementById('class-tables');
  for (const [title, names, model, th] of [['Forward camera (ffc)', ffc, 'rs26_ffc_finals', 'conf 0.65 · IoU 0.7'], ['Downward camera (dfc)', dfc, 'dfc_rs_26', 'conf 0.8 · IoU 0.9']]) {
    const div = document.createElement('div');
    div.innerHTML = `<h3 style="margin:0 0 .2rem;font-size:1.05rem">${title}</h3><div class="src"><code>${model}.pt</code> · ${th}</div>
      <table class="params classes"><thead><tr><th>id</th><th>class</th><th>what it is</th></tr></thead><tbody>${names
        .map((n, i) => `<tr><td>${i}</td><td><i class="sw" style="background:${classColor(n)}"></i><code>${n}</code></td><td>${task[n]}</td></tr>`)
        .join('')}</tbody></table>`;
    host.appendChild(div);
  }
}

// ---------- frames with masks ----------
// Frames from tools/frame_pipeline.py (public/data/frames). Add a frame here to show it.
const FRAMES = [
  { name: 'gate_far_0', label: 'Gate (false slalom)' },
  { name: 'slalom_0', label: 'Slalom' },
  { name: 'f0003_ffc', label: 'Torpedo board' },
  { name: 'f0001_ffc', label: 'Board at 37°' },
  { name: 'f0010_ffc', label: 'Board up close' },
  { name: 'f0017_dfc', label: 'Table' },
  { name: 'f0033_dfc', label: 'Table items' },
  { name: 'f0025_dfc', label: 'Basket' },
  { name: 'f0082_dfc', label: 'Bins' },
];
{
  const view = new FrameView(document.getElementById('det-view'));
  const note = document.getElementById('det-note');
  const show = async (name) => {
    const f = await loadFrame(name);
    view.show(f);
    view.drawDetections();
    const counts = {};
    f.boxes.forEach((b) => (counts[b.class] = (counts[b.class] || 0) + 1));
    const list = Object.entries(counts).map(([c, n]) => (n > 1 ? `${n}× ${c}` : c)).join(', ');
    note.innerHTML = `<b>${f.cam === 'ffc' ? 'Forward' : 'Downward'} camera</b>, ${f.boxes.length} detection${f.boxes.length === 1 ? '' : 's'}: ${list || 'none'}. Published after the pose fits: ${f.published.map((p) => `<code>${p.class}</code>`).join(' ') || 'nothing'}.`;
  };
  picker(document.getElementById('det-pick'), FRAMES, show, 2);
  show(FRAMES[2].name);
}

// ---------- routing graph ----------
{
  const note = document.getElementById('route-note');
  const txt = {
    yolo: 'YOLO results: boxes, masks, classes and confidences for the frame. Every mask is painted into one full-frame mask image before any box is processed.',
    torpedo: 'Forward camera only (torpedo_task_camera): fire, blood, circle, ambulance, fire_engine are held until the frame is done, then resolved together into the torpedo center and its four labeled openings.',
    pairs: 'compass + hammer_and_wrench → gate_repair, buoy + sos → gate_rescue (and warning + helmet → table, which the current tree switches off). Both members in one frame: one combined detection. Only one: each goes down the generic path under its own name.',
    slalom: 'Slalom poles: a single depth sample at the box centre, the closest pole kept, orientation taken from the slalom_parent_frame TF.',
    plane: 'Everything else: grid-sample the mask inside the box, back-project with the depth image, filter, fit a plane by SVD. One detection per box. Chapter 4.',
    out: 'detected_objects: a Detection3DArray in the camera optical frame, stamped with the image stamp.',
  };
  new Graph(document.getElementById('route-graph'), {
    width: 900,
    height: 300,
    nodes: [
      { id: 'yolo', x: 90, y: 150, label: 'YOLO results', sub: 'boxes + masks' },
      { id: 'torpedo', x: 420, y: 40, label: 'torpedo board', sub: 'held, resolved per frame' },
      { id: 'pairs', x: 420, y: 115, label: 'pairs', sub: 'held, resolved per frame' },
      { id: 'slalom', x: 420, y: 190, label: 'slalom', sub: 'closest pole' },
      { id: 'plane', x: 420, y: 265, label: 'plane fit', sub: 'one per box', bold: true },
      { id: 'out', x: 790, y: 150, label: 'detected_objects', sub: 'Detection3DArray' },
    ],
    edges: [
      { from: 'yolo', to: 'torpedo', label: 'fire, blood, circle…' },
      { from: 'yolo', to: 'pairs' },
      { from: 'yolo', to: 'slalom' },
      { from: 'yolo', to: 'plane', label: 'all other classes' },
      { from: 'torpedo', to: 'out' },
      { from: 'pairs', to: 'out' },
      { from: 'pairs', to: 'plane', label: 'one member only' },
      { from: 'slalom', to: 'out' },
      { from: 'plane', to: 'out' },
    ],
    info: (n) => (note.textContent = n ? txt[n.id] : 'Hover or tap a node.'),
  });
}
