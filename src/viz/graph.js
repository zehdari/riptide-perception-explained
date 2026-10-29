// Node-and-edge diagrams (SVG). Nodes: {id, x, y, label, sub, shape: 'rect'|'circle'|'square', w, h, info}.
// Edges: {from, to, label, bend, dash, width, color}. Hover or tap a node to light its neighbourhood.
import { el } from './chart.js';

const measure = document.createElement('canvas').getContext('2d');
function textWidth(text, weight, size) {
  measure.font = `${weight} ${size}px 'Archivo Variable', Archivo, system-ui, sans-serif`;
  return measure.measureText(text).width;
}

export class Graph {
  constructor(container, { width = 900, height = 360, nodes = [], edges = [], onSelect, arrows = true, info } = {}) {
    this.W = width; this.H = height;
    this.svg = el('svg', { class: 'graph', viewBox: `0 0 ${width} ${height}`, role: 'img' }, container);
    const defs = el('defs', {}, this.svg);
    for (const [id, color] of [['arrow', 'var(--ink-2)'], ['arrow-hot', 'var(--accent)']]) {
      const mk = el('marker', { id: id + this.uid(), viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
      el('path', { d: 'M0,1 L9,5 L0,9 z', fill: color }, mk);
    }
    this.arrows = arrows;
    this.onSelect = onSelect;
    this.info = info;
    this.gEdges = el('g', {}, this.svg);
    this.gPulses = el('g', {}, this.svg);
    this.gNodes = el('g', {}, this.svg);
    this.gLabels = el('g', {}, this.svg); // edge labels sit above nodes and edges
    this.nodes = new Map();
    this.edges = [];
    nodes.forEach((n) => this.addNode(n));
    edges.forEach((e) => this.addEdge(e));
    // A touch "leaves" as soon as the finger lifts: only a mouse clears the highlight by leaving,
    // so a tapped node stays selected until another is tapped.
    this.svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this.highlight(null); });
    // Touch: tapping empty space in the graph, or anywhere outside it, deselects.
    this.svg.addEventListener('pointerdown', (e) => { if (!e.target.closest('.node')) this.highlight(null); });
    document.addEventListener('pointerdown', (e) => { if (this.selected && !this.svg.contains(e.target)) this.highlight(null); });
  }
  uid() {
    if (!this._uid) this._uid = '-' + Math.random().toString(36).slice(2, 8);
    return this._uid;
  }
  addNode(n) {
    const g = el('g', { class: 'node', tabindex: 0, transform: `translate(${n.x},${n.y})` }, this.gNodes);
    // Boxes grow to fit their text, so a label is never cut off by its own box.
    const fit = Math.max(textWidth(n.label || '', n.bold ? 650 : 400, 12.5), textWidth(n.sub || '', 400, 11.5)) + 24;
    const w = Math.max(n.w || 0, fit, n.label || n.sub ? 0 : 110), h = n.h || (n.sub ? 46 : 34);
    if (n.shape === 'circle') el('circle', { r: n.r || 20 }, g);
    else if (n.shape === 'square') el('rect', { x: -(n.r || 8), y: -(n.r || 8), width: 2 * (n.r || 8), height: 2 * (n.r || 8), rx: 2 }, g);
    else el('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: n.rx ?? 7 }, g);
    if (n.fill) g.firstChild.style.fill = n.fill;
    if (n.stroke) g.firstChild.style.stroke = n.stroke;
    if (n.label) {
      const t = el('text', { y: n.sub ? -7 : 0 }, g);
      if (n.labelY !== undefined) t.setAttribute('y', n.labelY);
      t.textContent = n.label;
      if (n.bold) t.style.fontWeight = 650;
    }
    if (n.sub) {
      const t = el('text', { class: 'sub', y: 10 }, g);
      t.textContent = n.sub;
    }
    g.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') this.highlight(n.id); });
    // A tap selects; tapping the selected node again deselects it.
    g.addEventListener('pointerdown', (e) => this.highlight(e.pointerType !== 'mouse' && this.selected === n.id ? null : n.id));
    g.addEventListener('focus', () => { if (this.selected !== n.id) this.highlight(n.id); });
    this.nodes.set(n.id, { ...n, g, w, h });
  }
  anchor(n, toward) {
    // Point on the node boundary in the direction of `toward`.
    const dx = toward.x - n.x, dy = toward.y - n.y;
    if (n.shape === 'circle') {
      const d = Math.hypot(dx, dy) || 1, r = (n.r || 20) + 2;
      return { x: n.x + (dx / d) * r, y: n.y + (dy / d) * r };
    }
    const hw = (n.shape === 'square' ? n.r || 8 : n.w / 2) + 2, hh = (n.shape === 'square' ? n.r || 8 : n.h / 2) + 2;
    const s = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
    return { x: n.x + dx * s, y: n.y + dy * s };
  }
  addEdge(e) {
    const a = this.nodes.get(e.from), b = this.nodes.get(e.to);
    const bend = e.bend || 0;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const nx = -(b.y - a.y), ny = b.x - a.x, nl = Math.hypot(nx, ny) || 1;
    const c = { x: mx + (nx / nl) * bend, y: my + (ny / nl) * bend };
    const p0 = this.anchor(a, bend ? c : b), p1 = this.anchor(b, bend ? c : a);
    const d = bend ? `M${p0.x},${p0.y} Q${c.x},${c.y} ${p1.x},${p1.y}` : `M${p0.x},${p0.y} L${p1.x},${p1.y}`;
    const path = el('path', { class: 'edge', d }, this.gEdges);
    if (this.arrows && e.arrow !== false) path.setAttribute('marker-end', `url(#arrow${this.uid()})`);
    if (e.dash) path.setAttribute('stroke-dasharray', '4 4');
    if (e.width) path.style.strokeWidth = e.width;
    if (e.color) path.style.stroke = e.color;
    if (e.opacity !== undefined) path.style.opacity = e.opacity;
    let label = null;
    if (e.label) {
      // On a curved edge, sit on the curve's midpoint (p0 + 2c + p1) / 4, not on its control point.
      const lx = bend ? (p0.x + 2 * c.x + p1.x) / 4 : mx, ly = bend ? (p0.y + 2 * c.y + p1.y) / 4 : my;
      label = el('text', { class: 'elabel', x: lx, y: ly - 5 }, this.gLabels);
      label.textContent = e.label;
    }
    const edge = { ...e, path, label };
    this.edges.push(edge);
    return edge;
  }
  highlight(id) {
    this.selected = id;
    const near = new Set([id]);
    if (id) this.edges.forEach((e) => { if (e.from === id) near.add(e.to); if (e.to === id) near.add(e.from); });
    this.nodes.forEach((n, k) => {
      n.g.classList.toggle('dim', !!id && !near.has(k));
      n.g.classList.toggle('hot', k === id);
    });
    this.edges.forEach((e) => {
      const on = id && (e.from === id || e.to === id);
      e.path.classList.toggle('hot', !!on);
      e.path.classList.toggle('dim', !!id && !on);
      if (this.arrows && e.arrow !== false) e.path.setAttribute('marker-end', `url(#arrow${on ? '-hot' : ''}${this.uid()})`);
      if (e.label) e.label.style.opacity = id && !on ? 0.2 : 1;
    });
    if (this.info) this.info(id ? this.nodes.get(id) : null);
    if (this.onSelect) this.onSelect(id);
  }
  // Dots that travel along edges, `period` seconds per lap; respects reduced motion.
  pulse(edgeFilter = () => true, period = 1.6) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const dots = this.edges.filter(edgeFilter).map((e) => ({ e, dot: el('circle', { class: 'pulse', r: 3.2 }, this.gPulses), len: e.path.getTotalLength() }));
    const t0 = performance.now();
    let visible = true;
    new IntersectionObserver(([en]) => (visible = en.isIntersecting)).observe(this.svg);
    const loop = (now) => {
      if (visible) {
        const u = (((now - t0) / 1000) % period) / period;
        dots.forEach(({ e, dot, len }) => {
          const p = e.path.getPointAtLength(((u + (e.phase || 0)) % 1) * len);
          dot.setAttribute('cx', p.x);
          dot.setAttribute('cy', p.y);
        });
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}
