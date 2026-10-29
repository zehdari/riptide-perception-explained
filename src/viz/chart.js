// Minimal SVG line chart: hairline grid, 2px lines, legend, crosshair + tooltip.
const NS = 'http://www.w3.org/2000/svg';
export const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

export function niceTicks(lo, hi, count = 5) {
  if (!(hi > lo)) return [lo];
  const span = hi - lo, step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}
const fmt = (v, d) => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'K' : v.toFixed(d));

export class LineChart {
  constructor(container, opts = {}) {
    this.o = { height: 220, xLabel: '', yLabel: '', title: '', digits: 2, xDigits: 1, unit: '', legend: true, ...opts };
    this.wrap = document.createElement('div');
    this.wrap.style.position = 'relative';
    container.appendChild(this.wrap);
    if (this.o.legend) {
      this.legend = document.createElement('div');
      this.legend.className = 'legend';
      this.wrap.appendChild(this.legend);
    }
    this.svg = el('svg', { class: 'chart', role: 'img' }, this.wrap);
    if (this.o.title) this.svg.setAttribute('aria-label', this.o.title);
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.tip.hidden = true;
    this.wrap.appendChild(this.tip);
    this.series = [];
    new ResizeObserver(() => this.draw()).observe(this.wrap);
    this.svg.style.touchAction = 'pan-y'; // a sideways drag scrubs the readout; vertical still scrolls
    this.svg.addEventListener('pointermove', (e) => this.hover(e));
    this.svg.addEventListener('pointerdown', (e) => this.hover(e));
    // A touch "leaves" when the finger lifts; keep its readout until the next tap elsewhere.
    this.svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this.unhover(); });
    tapOutside(this.svg, () => this.unhover());
  }
  set(series, opts = {}) {
    this.series = series;
    Object.assign(this.o, opts);
    if (this.legend) {
      this.legend.innerHTML = series.length > 1 || this.o.forceLegend
        ? series.filter((s) => !s.noLegend).map((s) => `<span><i class="${s.dash ? 'dash' : ''}" style="background:${s.color};color:${s.color}"></i>${s.name}</span>`).join('')
        : '';
    }
    this.draw();
  }
  domain() {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of this.series)
      for (const p of s.values) {
        if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
      }
    if (this.o.xDomain) [x0, x1] = this.o.xDomain;
    if (this.o.yDomain) [y0, y1] = this.o.yDomain;
    else {
      if (this.o.yZero) { y0 = Math.min(0, y0); y1 = Math.max(0, y1); }
      const pad = (y1 - y0) * 0.08 || Math.abs(y1) * 0.1 || 1;
      y0 -= pad; y1 += pad;
    }
    return { x0, x1, y0, y1 };
  }
  draw() {
    const W = this.wrap.clientWidth || 600, H = this.o.height;
    const svg = this.svg;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';
    if (!this.series.length) return;
    const m = { l: 46, r: 14, t: this.o.title ? 24 : this.o.yLabel ? 28 : 8, b: this.o.xLabel ? 34 : 22 }; // room between the y label and the top tick
    const { x0, x1, y0, y1 } = this.domain();
    const sx = (x) => m.l + ((x - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
    // Marker labels: one that would run off the right edge sits left of its line; one that would run into an
    // earlier label drops to the next free row. Without a title the rows go above the plot, clear of the data.
    const marks = (this.o.markers || []).map((mk) => {
      const probe = el('text', { class: 'label marker-label' }, svg);
      probe.textContent = mk.label;
      const len = probe.getComputedTextLength?.() || mk.label.length * 6.5;
      probe.remove();
      const flip = sx(mk.x) + 4 + len > W - 2;
      const l = flip ? sx(mk.x) - 4 - len : sx(mk.x) + 4;
      return { mk, flip, l, r: l + len };
    });
    const rows = [];
    for (const k of marks) {
      k.row = rows.findIndex((spans) => spans.every(([a, b]) => k.r + 6 < a || k.l > b + 6));
      if (k.row < 0) k.row = rows.push([]) - 1;
      rows[k.row].push([k.l, k.r]);
    }
    const above = rows.length && !this.o.title;
    const rowY = (row) => (above ? (this.o.yLabel ? 26 : 12) + row * 13 : m.t + 10 + row * 13);
    if (above) m.t = rowY(rows.length - 1) + 8;
    const sy = (y) => H - m.b - ((y - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
    this.map = { sx, sy, m, W, H, x0, x1 };
    if (this.o.title) el('text', { class: 'title', x: m.l, y: 13 }, svg).textContent = this.o.title;
    const grid = el('g', { class: 'grid' }, svg), axis = el('g', { class: 'axis' }, svg);
    for (const t of niceTicks(y0, y1, Math.max(3, Math.round((H - m.t - m.b) / 45)))) {
      el('line', { x1: m.l, x2: W - m.r, y1: sy(t), y2: sy(t) }, grid);
      const tx = el('text', { x: m.l - 7, y: sy(t) + 3.5, 'text-anchor': 'end' }, axis);
      tx.textContent = fmt(t, Math.max(0, -Math.floor(Math.log10(Math.abs(niceTicks(y0, y1)[1] - niceTicks(y0, y1)[0]) || 1))));
    }
    for (const t of niceTicks(x0, x1, Math.max(3, Math.round((W - m.l - m.r) / 80)))) {
      const tx = el('text', { x: sx(t), y: H - m.b + 15, 'text-anchor': 'middle' }, axis);
      tx.textContent = +t.toFixed(3);
    }
    el('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }, axis);
    if (this.o.xLabel) {
      const t = el('text', { x: W - m.r, y: H - 3, 'text-anchor': 'end' }, axis);
      t.textContent = this.o.xLabel;
    }
    if (this.o.yLabel) {
      const t = el('text', { x: m.l - 7, y: this.o.title ? m.t - 4 : 11, 'text-anchor': 'start' }, axis);
      t.textContent = this.o.yLabel;
      if (this.o.title) t.setAttribute('x', W - m.r), t.setAttribute('text-anchor', 'end');
    }
    if (this.o.bands) for (const b of this.o.bands) el('rect', { x: sx(b.x0), width: Math.max(0, sx(b.x1) - sx(b.x0)), y: m.t, height: H - m.t - m.b, fill: b.color || 'rgba(15,38,51,0.05)' }, svg);
    if (this.o.yZero && y0 < 0 && y1 > 0) el('line', { x1: m.l, x2: W - m.r, y1: sy(0), y2: sy(0), stroke: 'var(--muted)', 'stroke-width': 1 }, svg);
    const clipId = 'clip' + Math.random().toString(36).slice(2, 8);
    const cp = el('clipPath', { id: clipId }, el('defs', {}, svg));
    el('rect', { x: m.l, y: m.t - 4, width: W - m.l - m.r, height: H - m.t - m.b + 8 }, cp);
    const plot = el('g', { 'clip-path': `url(#${clipId})` }, svg);
    for (const s of this.series) {
      if (!s.values.length) continue;
      if (s.points) { // scatter: small dots, no line
        for (const p of s.values) el('circle', { cx: sx(p.x).toFixed(1), cy: sy(p.y).toFixed(1), r: s.r || 2.2, fill: s.color, opacity: s.opacity ?? 0.45 }, plot);
        continue;
      }
      const d = s.values.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
      if (s.area) el('path', { d: `${d}L${sx(s.values.at(-1).x)},${sy(Math.max(y0, 0))}L${sx(s.values[0].x)},${sy(Math.max(y0, 0))}Z`, fill: s.color, opacity: 0.1 }, plot);
      el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': s.dash ? '5 4' : '', opacity: s.opacity ?? 1 }, plot);
      if (s.endLabel) {
        const p = s.values.at(-1);
        el('circle', { cx: sx(p.x), cy: sy(p.y), r: 4, fill: s.color, stroke: 'var(--paper-2)', 'stroke-width': 2 }, svg);
        const t = el('text', { class: 'label', x: sx(p.x) - 6, y: sy(p.y) - 8, 'text-anchor': 'end' }, svg);
        t.textContent = s.endLabel;
      }
    }
    if (marks.length) {
      for (const { mk, row } of marks) el('line', { x1: sx(mk.x), x2: sx(mk.x), y1: above ? rowY(row) + 3 : m.t, y2: H - m.b, stroke: 'var(--muted)', 'stroke-dasharray': '2 3' }, svg);
      for (const { mk, row, flip } of marks) { // labels after all the lines, so no line crosses a label
        const t = el('text', { class: 'label marker-label', x: sx(mk.x) + (flip ? -4 : 4), y: rowY(row) }, svg);
        if (flip) t.setAttribute('text-anchor', 'end');
        t.textContent = mk.label;
      }
    }
    this.cross = el('line', { class: 'crosshair', y1: m.t, y2: H - m.b, visibility: 'hidden' }, svg);
    this.dots = this.series.map((s) => el('circle', { r: 4, fill: s.color, stroke: 'var(--paper-2)', 'stroke-width': 2, visibility: 'hidden' }, svg));
    el('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' }, svg);
  }
  hover(e) {
    if (!this.map || !this.series.length) return;
    const r = this.svg.getBoundingClientRect();
    const scaleX = this.map.W / r.width;
    const px = (e.clientX - r.left) * scaleX;
    const { sx, sy, m, W, x0, x1 } = this.map;
    if (px < m.l || px > W - m.r) return this.unhover();
    const x = x0 + ((px - m.l) / (W - m.l - m.r)) * (x1 - x0);
    const rows = [];
    this.series.forEach((s, i) => {
      if (!s.values.length || s.noTip) { this.dots[i].setAttribute('visibility', 'hidden'); return; }
      let lo = 0, hi = s.values.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (s.values[mid].x <= x) lo = mid; else hi = mid; }
      const p = Math.abs(s.values[hi].x - x) < Math.abs(s.values[lo].x - x) ? s.values[hi] : s.values[lo];
      this.dots[i].setAttribute('cx', sx(p.x));
      this.dots[i].setAttribute('cy', sy(p.y));
      this.dots[i].setAttribute('visibility', 'visible');
      rows.push(`<div><i style="background:${s.color}"></i>${s.name}: <b>${p.y.toFixed(this.o.digits)}</b>${this.o.unit ? ' ' + this.o.unit : ''}</div>`);
    });
    this.cross.setAttribute('x1', px);
    this.cross.setAttribute('x2', px);
    this.cross.setAttribute('visibility', 'visible');
    this.tip.innerHTML = `<div style="opacity:.75">${this.o.xLabel ? this.o.xLabel.split(' ')[0] + ' ' : ''}${x.toFixed(this.o.xDigits)}</div>${rows.join('')}`;
    this.tip.hidden = false;
    const left = (px / scaleX) + (this.legend?.offsetHeight ? 0 : 0);
    const flip = left > r.width - 170;
    this.tip.style.left = `${flip ? left - 24 : left}px`;
    this.tip.style.transform = flip ? 'translate(-100%, -50%)' : 'translate(12px, -50%)';
    this.tip.style.top = `${(e.clientY - this.wrap.getBoundingClientRect().top)}px`;
  }
  unhover() {
    this.tip.hidden = true;
    this.cross?.setAttribute('visibility', 'hidden');
    this.dots?.forEach((d) => d.setAttribute('visibility', 'hidden'));
  }
}

// Calls `off` when a touch or click lands outside `inside` (to dismiss a tapped readout).
// One document listener for all of them; charts that were redrawn away drop out.
const outside = new Set();
let listening = false;
export function tapOutside(inside, off) {
  if (!listening) {
    listening = true;
    document.addEventListener('pointerdown', (e) => {
      for (const o of outside) {
        if (!o.inside.isConnected) outside.delete(o);
        else if (!o.inside.contains(e.target)) o.off();
      }
    });
  }
  outside.add({ inside, off });
}

// Horizontal (stacked) bars: rows [{label, segments: [{value, color, name}]}]; diverging around 0 when values are signed.
export function barChart(container, rows, { width = 640, rowH = 26, unit = '', digits = 1, labelW = 92, valueW = 64, max } = {}) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  container.appendChild(wrap);
  const H = rows.length * rowH + 6;
  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${width} ${H}` }, wrap);
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  wrap.appendChild(tip);
  tapOutside(svg, () => (tip.hidden = true));
  const lo = Math.min(0, ...rows.map((r) => r.segments.reduce((s, g) => s + Math.min(0, g.value), 0)));
  const hi = Math.max(0, ...rows.map((r) => r.segments.reduce((s, g) => s + Math.max(0, g.value), 0)));
  const span = max ?? Math.max(hi - lo, 1e-9);
  const x0 = labelW, x1 = width - valueW;
  const sx = (v) => x0 + ((v - lo) / (max ? (lo < 0 ? 2 * max : max) : span)) * (x1 - x0);
  const zero = sx(0);
  rows.forEach((r, i) => {
    const y = 3 + i * rowH, h = Math.min(18, rowH - 8);
    el('text', { class: 'label', x: labelW - 10, y: y + rowH / 2 + 1, 'text-anchor': 'end', 'dominant-baseline': 'middle' }, svg).textContent = r.label;
    let pos = 0, neg = 0;
    r.segments.forEach((g, k) => {
      if (!g.value) return;
      const from = g.value >= 0 ? pos : neg, to = from + g.value;
      if (g.value >= 0) pos = to; else neg = to;
      const a = sx(Math.min(from, to)), b = sx(Math.max(from, to));
      const last = g.value >= 0 ? k === r.segments.length - 1 || r.segments.slice(k + 1).every((s) => s.value <= 0) : true;
      const w = Math.max(0, b - a - (k > 0 ? 2 : 0));
      const rect = el('rect', { x: g.value >= 0 && k > 0 ? a + 2 : a, y: y + (rowH - h) / 2, width: w, height: h, rx: last ? 3 : 0, fill: g.color, style: 'cursor:pointer' }, svg);
      const v = g.shown ?? g.value; // shown: the real value when the bar is drawn scaled
      const text = `${g.name || r.label}: <b>${v.toFixed(Math.abs(v) < 1 && v ? Math.max(digits, 2) : digits)}</b>${r.unit ?? (unit ? ' ' + unit : '')}`;
      const show = () => {
        const box = rect.getBoundingClientRect(), wb = wrap.getBoundingClientRect();
        tip.innerHTML = text;
        tip.hidden = false;
        const cx = box.left + box.width / 2 - wb.left;
        tip.style.left = `${Math.min(Math.max(cx, 60), wb.width - 60)}px`;
        tip.style.top = `${box.top - wb.top}px`;
        tip.style.transform = 'translate(-50%, -110%)';
      };
      rect.addEventListener('pointerdown', show);
      rect.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') show(); });
      rect.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') tip.hidden = true; });
    });
    const total = r.total ?? r.segments.reduce((s, g) => s + g.value, 0);
    el('text', { class: 'label', x: width - 4, y: y + rowH / 2 + 1, 'text-anchor': 'end', 'dominant-baseline': 'middle', style: 'font-variant-numeric: tabular-nums' }, svg).textContent = `${total.toFixed(digits)}${r.unit ?? (unit ? ' ' + unit : '')}`;
  });
  if (lo < 0) el('line', { x1: zero, x2: zero, y1: 0, y2: H, stroke: 'var(--muted)', 'stroke-width': 1 }, svg);
  return svg;
}
