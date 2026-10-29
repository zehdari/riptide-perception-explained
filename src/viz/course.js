// Top-down replay of a Nereus mission: the true course, mapping's priors and estimates (2σ ellipses), the detections
// as they arrive, and Talos with its forward camera's field of view. Data: public/data/mission*.json
// (tools/bag_to_mission.py). Pure canvas 2D, redrawn on demand.

const TAU = Math.PI * 2;
// Map-parented objects drawn on the course, with a footprint (length along the prop's yaw, width) in metres.
export const PROPS = {
  gate: { task: 'gate', size: [0.15, 3.0], label: 'gate' },
  slalom_parent: { task: 'slalom', size: [0.1, 0.1], label: 'slalom' },
  torpedo: { task: 'torpedo', size: [0.1, 0.6], label: 'torpedo' },
  bin: { task: 'bins', size: [0.6, 1.2], label: 'bins' },
  table: { task: 'table', size: [0.9, 1.2], label: 'table' },
};
const COLORS = { gate: '#2a78d6', slalom_parent: '#1baf7a', torpedo: '#eb6834', bin: '#6250d6', table: '#e87ba4' };
export const colorOf = (name) => COLORS[name] || '#3f5b67';

// The last row of a time-sorted table at or before t (binary search on column 0).
export function at(rows, t) {
  if (!rows || !rows.length || rows[0][0] > t) return null;
  let lo = 0, hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid][0] <= t) lo = mid; else hi = mid - 1;
  }
  return rows[lo];
}

// Axes of the 2σ ellipse of a 2x2 covariance [[a, b], [b, c]].
export function ellipse(a, b, c, k = 2) {
  const tr = (a + c) / 2, d = Math.sqrt(Math.max(((a - c) / 2) ** 2 + b * b, 0));
  const l1 = Math.max(tr + d, 0), l2 = Math.max(tr - d, 0);
  const ang = Math.abs(b) < 1e-12 && a >= c ? 0 : Math.atan2(l1 - a, b);
  return { rx: k * Math.sqrt(l1), ry: k * Math.sqrt(l2), ang };
}

export class CourseView {
  constructor(canvas, data, opts = {}) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.d = data;
    this.o = { trail: 90, detFade: 4, pad: 1.2, fov: 54.5, fovRange: 6, showPriors: true, showDets: true, focus: null, ...opts };
    this.t = 0;
    // Truth placements keyed by task name
    this.truth = Object.fromEntries((data.course || []).map((p) => [p.task, p]));
    this.bounds();
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  bounds() {
    const xs = [], ys = [];
    for (const p of this.d.course || []) { xs.push(p.position_m[0]); ys.push(p.position_m[1]); }
    for (const r of this.d.truth_path || []) { xs.push(r[1]); ys.push(r[2]); }
    for (const [name] of Object.entries(PROPS)) {
      const pr = this.d.priors?.[name];
      if (pr) { xs.push(pr.p[0]); ys.push(pr.p[1]); }
    }
    const pad = this.o.pad;
    this.box = this.o.box || [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
  }

  // World (x east, y north) to canvas pixels. Portrait canvases turn the course a quarter turn so it fills them.
  layout() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = this.c.clientWidth, h = this.c.clientHeight;
    if (this.c.width !== Math.round(w * dpr) || this.c.height !== Math.round(h * dpr)) {
      this.c.width = Math.round(w * dpr);
      this.c.height = Math.round(h * dpr);
    }
    const [x0, y0, x1, y1] = this.box;
    const ins = this.o.insets || [0, 0, 0, 0]; // top, right, bottom, left in css px kept clear
    const aw = w - ins[1] - ins[3], ah = h - ins[0] - ins[2];
    this.rot = this.o.rotate ?? (ah > aw * 1.1);
    const bw = this.rot ? y1 - y0 : x1 - x0, bh = this.rot ? x1 - x0 : y1 - y0;
    const s = Math.min(aw / bw, ah / bh);
    const ox = ins[3] + (aw - bw * s) / 2, oy = ins[0] + (ah - bh * s) / 2;
    this.s = s;
    this.px = this.rot
      ? (x, y) => [ox + (y1 - y) * s, oy + (x1 - x) * s]
      : (x, y) => [ox + (x - x0) * s, oy + (y1 - y) * s];
    // Screen angle of a world heading
    this.ang = this.rot ? (a) => -a - Math.PI / 2 : (a) => -a;
    this.dpr = dpr;
  }

  set(t) { this.t = t; this.draw(); }

  draw() {
    const { ctx } = this;
    this.layout();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.c.clientWidth, this.c.clientHeight);
    this.grid();
    this.course();
    if (this.o.showPriors) this.priors();
    this.estimates();
    if (this.o.showDets) this.detections();
    this.robot();
  }

  grid() {
    const { ctx } = this;
    const [x0, y0, x1, y1] = this.box;
    ctx.strokeStyle = 'rgba(15,38,51,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.ceil(x0); x <= x1; x++) { const a = this.px(x, y0), b = this.px(x, y1); ctx.moveTo(...a); ctx.lineTo(...b); }
    for (let y = Math.ceil(y0); y <= y1; y++) { const a = this.px(x0, y), b = this.px(x1, y); ctx.moveTo(...a); ctx.lineTo(...b); }
    ctx.stroke();
    // A 1 m scale bar, bottom right
    const [bx, by] = [this.c.clientWidth - 16 - this.s, this.c.clientHeight - 14 - (this.o.insets?.[2] || 0)];
    ctx.fillStyle = 'rgba(15,38,51,0.55)';
    ctx.fillRect(bx, by, this.s * 2, 2);
    ctx.font = '600 11px Archivo Variable, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('2 m', bx + this.s, by - 5);
  }

  footprint(x, y, yaw, size) {
    const { ctx } = this;
    const [L, W] = size;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const pts = [[L / 2, W / 2], [-L / 2, W / 2], [-L / 2, -W / 2], [L / 2, -W / 2]].map(([u, v]) => this.px(x + c * u - s * v, y + s * u + c * v));
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
    ctx.closePath();
  }

  course() {
    const { ctx } = this;
    for (const [name, p] of Object.entries(PROPS)) {
      const tr = this.truth[p.task];
      if (!tr) continue;
      const [x, y] = tr.position_m;
      const yaw = (tr.yaw_deg * Math.PI) / 180;
      ctx.fillStyle = 'rgba(15,38,51,0.16)';
      ctx.strokeStyle = 'rgba(15,38,51,0.45)';
      ctx.lineWidth = 1.2;
      if (p.size[0] < 0.2 && p.size[1] < 0.2) {
        const [cx, cy] = this.px(x, y);
        ctx.beginPath(); ctx.arc(cx, cy, Math.max(3, 0.12 * this.s), 0, TAU); ctx.fill(); ctx.stroke();
      } else {
        this.footprint(x, y, yaw, p.size.map((v) => Math.max(v, 0.12)));
        ctx.fill(); ctx.stroke();
      }
    }
  }

  priors() {
    const { ctx } = this;
    ctx.setLineDash([4, 3]);
    for (const name of Object.keys(PROPS)) {
      const pr = this.d.priors?.[name];
      if (!pr || pr.parent !== 'map') continue;
      const [cx, cy] = this.px(pr.p[0], pr.p[1]);
      ctx.strokeStyle = colorOf(name);
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(cx, cy, 6, 0, TAU); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  estimates() {
    const { ctx } = this;
    for (const name of Object.keys(PROPS)) {
      const e = this.d.estimates?.[name];
      const r = e && at(e.rows, this.t);
      if (!r) continue;
      const [, x, y, , vx, vy, , cxy] = r;
      const unconfirmed = vx >= 0.999 && vy >= 0.999;
      const col = colorOf(name);
      const [cx, cy] = this.px(x, y);
      const pr = this.d.priors?.[name];
      if (pr && this.o.showPriors) {
        const [px, py] = this.px(pr.p[0], pr.p[1]);
        ctx.strokeStyle = col; ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(cx, cy); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (!unconfirmed) {
        const el = ellipse(vx, cxy, vy);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(this.ang(el.ang));
        ctx.beginPath();
        ctx.ellipse(0, 0, Math.max(el.rx * this.s, 1.5), Math.max(el.ry * this.s, 1.5), 0, 0, TAU);
        ctx.fillStyle = col + '30'; ctx.fill();
        ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.restore();
      }
      ctx.beginPath(); ctx.arc(cx, cy, 3.6, 0, TAU);
      ctx.fillStyle = unconfirmed ? '#f3f7f7' : col; ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.stroke();
      ctx.font = '650 12px Archivo Variable, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(243,247,247,0.9)';
      const label = PROPS[name].label;
      ctx.strokeText(label, cx + 8, cy - 7);
      ctx.fillStyle = '#0f2633'; ctx.fillText(label, cx + 8, cy - 7);
    }
  }

  detections() {
    const { ctx } = this;
    const dets = this.d.detections || [];
    const t = this.t, fade = this.o.detFade;
    // detections are time sorted: walk back from t
    let lo = 0, hi = dets.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (dets[m].t <= t) lo = m + 1; else hi = m; }
    for (let i = lo - 1; i >= 0 && dets[i].t > t - fade; i--) {
      const d = dets[i];
      if (!d.p || d.f !== 'map') continue;
      const a = 1 - (t - d.t) / fade;
      const [cx, cy] = this.px(d.p[0], d.p[1]);
      ctx.globalAlpha = 0.25 + 0.6 * a;
      ctx.fillStyle = colorOf(d.c);
      ctx.beginPath(); ctx.arc(cx, cy, 2.2, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  robot() {
    const { ctx } = this;
    const path = this.d.truth_path || [];
    const t = this.t;
    const r = at(path, t);
    if (!r) return;
    // trail
    ctx.strokeStyle = 'rgba(15,38,51,0.55)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let first = true;
    for (const q of path) {
      if (q[0] < t - this.o.trail) continue;
      if (q[0] > t) break;
      const p = this.px(q[1], q[2]);
      if (first) { ctx.moveTo(...p); first = false; } else ctx.lineTo(...p);
    }
    ctx.stroke();
    const [, x, y, , yaw] = r;
    const [cx, cy] = this.px(x, y);
    // camera field of view, forward
    const half = (this.o.fov / 2) * (Math.PI / 180);
    const R = this.o.fovRange;
    const a = this.px(x + R * Math.cos(yaw + half), y + R * Math.sin(yaw + half));
    const b = this.px(x + R * Math.cos(yaw - half), y + R * Math.sin(yaw - half));
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * this.s);
    g.addColorStop(0, 'rgba(217,72,15,0.20)');
    g.addColorStop(1, 'rgba(217,72,15,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(...a); ctx.lineTo(...b); ctx.closePath(); ctx.fill();
    // body: 0.35 m long, 0.83 m wide
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.ang(yaw));
    const L = Math.max(0.35 * this.s, 7), W = Math.max(0.83 * this.s, 14);
    ctx.fillStyle = '#0f2633';
    ctx.beginPath();
    ctx.roundRect(-L / 2, -W / 2, L, W, 3);
    ctx.fill();
    ctx.fillStyle = '#d9480f';
    ctx.beginPath(); ctx.moveTo(L / 2 + 5, 0); ctx.lineTo(L / 2 - 1, -4); ctx.lineTo(L / 2 - 1, 4); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
}
