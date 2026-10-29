// A small orbit view of a detection's 3D samples in the camera frame: points coloured by fate, the fitted plane as a
// square patch, its normal, and the camera at the origin. Canvas 2D, drag to turn. No three.js needed for ~500 points.
import { inplane_basis } from '../engine/geometry.js';

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export class Cloud3D {
  constructor(host) {
    this.box = document.createElement('div');
    this.box.className = 'cloud3d';
    this.canvas = document.createElement('canvas');
    const hint = document.createElement('div');
    hint.className = 'hint3d';
    hint.textContent = 'Drag to turn';
    this.box.append(this.canvas, hint);
    host.appendChild(this.box);
    this.yaw = -0.9;
    this.pitch = 0.25;
    this.data = null;
    let drag = null;
    this.canvas.addEventListener('pointerdown', (e) => { drag = [e.clientX, e.clientY, this.yaw, this.pitch]; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.yaw = drag[2] + (e.clientX - drag[0]) * 0.01;
      this.pitch = Math.max(-1.4, Math.min(1.4, drag[3] + (e.clientY - drag[1]) * 0.01));
      this.draw();
    });
    const end = () => (drag = null);
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    new ResizeObserver(() => this.draw()).observe(this.box);
  }

  // samples: [{p, fate}], fit: {normal, centroid}, ref: an optional second normal (dashed)
  set(data) { this.data = data; this.draw(); }

  draw() {
    const d = this.data;
    const r = this.box.getBoundingClientRect();
    if (!r.width) return;
    const dpr = devicePixelRatio || 1;
    this.canvas.width = r.width * dpr;
    this.canvas.height = r.height * dpr;
    const g = this.canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    if (!d) return;
    const pts = d.samples.filter((s) => s.p);
    if (!pts.length) return;
    // Orbit about the kept points' centre; z of the camera frame points into the screen at yaw = pitch = 0
    const kept = pts.filter((s) => s.fate === 'kept');
    const base = kept.length ? kept : pts;
    const c = [0, 1, 2].map((i) => base.reduce((a, s) => a + s.p[i], 0) / base.length);
    const ext = Math.max(0.05, ...base.map((s) => Math.hypot(s.p[0] - c[0], s.p[1] - c[1], s.p[2] - c[2])));
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const view = (p) => {
      // camera optical frame (x right, y down, z forward) about the centre, then turned
      const x = p[0] - c[0], y = p[1] - c[1], z = p[2] - c[2];
      const x1 = cy * x - sy * z, z1 = sy * x + cy * z;
      const y2 = cp * y - sp * z1, z2 = sp * y + cp * z1;
      return [x1, y2, z2];
    };
    const S = (Math.min(r.width, r.height) * 0.36) / ext;
    const scr = (p) => { const v = view(p); return [r.width / 2 + v[0] * S, r.height / 2 + v[1] * S, v[2]]; };

    // plane patch
    if (d.fit) {
      const [u, v] = inplane_basis(d.fit.normal);
      const h = ext * 1.15;
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => scr([c[0] + h * (a * u[0] + b * v[0]), c[1] + h * (a * u[1] + b * v[1]), c[2] + h * (a * u[2] + b * v[2])]));
      g.beginPath();
      corners.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.fillStyle = 'rgba(27,175,122,0.13)';
      g.strokeStyle = 'rgba(27,175,122,0.7)';
      g.lineWidth = 1.2;
      g.fill();
      g.stroke();
    }
    // camera direction: a short line from the patch toward the origin
    {
      const L = Math.hypot(...c);
      const toward = c.map((x) => x - (x / L) * ext * 1.8);
      const a = scr(c), b = scr(toward);
      g.setLineDash([3, 4]);
      g.strokeStyle = css('--muted');
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      g.setLineDash([]);
      g.fillStyle = css('--muted');
      g.font = '12px Archivo Variable, sans-serif';
      g.fillText('to camera', b[0] + 4, b[1] - 4);
    }
    // points, far to near
    const col = { kept: css('--state'), gate: css('--accent'), outlier: css('--s4'), bleed: css('--s7') };
    pts.map((s) => [s, scr(s.p)]).sort((a, b) => b[1][2] - a[1][2]).forEach(([s, [x, y]]) => {
      g.fillStyle = col[s.fate] || '#999';
      g.globalAlpha = s.fate === 'kept' ? 0.85 : 1;
      g.beginPath();
      g.arc(x, y, s.fate === 'kept' ? 2.2 : 3, 0, 7);
      g.fill();
    });
    g.globalAlpha = 1;
    // normals
    const arrow = (n, color, dash) => {
      const a = d.fit.centroid ? scr(d.fit.centroid) : scr(c);
      const tip = (d.fit.centroid || c).map((x, i) => x + n[i] * ext * 1.3);
      const b = scr(tip);
      g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 2.2; g.setLineDash(dash ? [5, 4] : []);
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); g.setLineDash([]);
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      g.beginPath(); g.moveTo(b[0], b[1]);
      g.lineTo(b[0] - 9 * Math.cos(ang - 0.4), b[1] - 9 * Math.sin(ang - 0.4));
      g.lineTo(b[0] - 9 * Math.cos(ang + 0.4), b[1] - 9 * Math.sin(ang + 0.4));
      g.fill();
      if (!dash) {
        g.font = '600 12px Archivo Variable, system-ui, sans-serif';
        g.fillText('normal', b[0] + 6, b[1] - 6);
      }
    };
    if (d.fit && d.ref) arrow(d.ref, css('--muted'), true);
    if (d.fit) {
      arrow(d.fit.normal, css('--prediction'));
      const a = scr(d.fit.centroid);
      g.fillStyle = css('--ink');
      g.beginPath(); g.arc(a[0], a[1], 4.5, 0, 7); g.fill();
    }
  }
}
