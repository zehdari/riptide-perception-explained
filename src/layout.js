import './style.css';
import katex from 'katex';

export const chapters = [
  { href: 'index.html', title: 'Overview' },
  { href: 'calibration.html', title: 'Cameras and calibration', part: 'Vision' },
  { href: 'training.html', title: 'Training the detector' },
  { href: 'detector.html', title: 'The detector, frame by frame' },
  { href: 'pose.html', title: 'From a mask to a pose' },
  { href: 'composites.html', title: 'Props made of several pieces' },
  { href: 'noise.html', title: 'How far to trust a detection', part: 'Mapping' },
  { href: 'tracking.html', title: 'Tracking one object' },
  { href: 'map.html', title: 'The course map' },
  { href: 'frames.html', title: 'Frames, targets and the mission tree' },
  { href: 'mission.html', title: 'One mission in Nereus' },
  { href: 'workflow.html', title: 'Working on it yourself', part: 'Your turn' },
  { href: 'math.html', title: 'The math in one place', appendix: 'A' },
];

// Chapter sections whose equations are collected in the appendix, and where.
const APPENDIX = {
  'calibration.html': { pinhole: 'calibration', distortion: 'calibration', stereo: 'calibration' },
  'pose.html': { backproject: 'pose', gate: 'pose', plane: 'pose' },
  'composites.html': { torpedo: 'composites' },
  'noise.html': { model: 'noise', inflation: 'noise' },
  'tracking.html': { update: 'tracking', gating: 'tracking', agreement: 'tracking' },
  'map.html': { model: 'map', solve: 'map', robust: 'map' },
};

// A quiet link under a section's first displayed equation, to the same block on the appendix page.
function appendixLinks() {
  const here = location.pathname.split('/').pop() || 'index.html';
  const map = APPENDIX[here];
  if (!map) return;
  document.querySelectorAll('main h2[id]').forEach((h) => {
    const target = map[h.id];
    if (!target) return;
    for (let el = h.nextElementSibling; el && el.tagName !== 'H2'; el = el.nextElementSibling) {
      const eq = el.matches('.M') ? el : el.querySelector('.M');
      if (!eq) continue;
      const a = document.createElement('a');
      a.className = 'eqlink';
      a.href = `math.html#${target}`;
      a.textContent = 'All the math on one page →';
      eq.after(a);
      return;
    }
  });
}

export const REPO = 'https://github.com/osu-uwrt/riptide_perception/tree/mapping-estimator';
export const SRC = 'https://github.com/osu-uwrt/riptide_perception/blob/mapping-estimator';

function renderMath(root = document) {
  root.querySelectorAll('.m, .M').forEach((el) => {
    if (el.dataset.done) return;
    const tex = el.textContent;
    const display = el.classList.contains('M');
    katex.render(tex, el, { displayMode: display, throwOnError: false, trust: true, macros: MACROS });
    el.dataset.done = '1';
    if (display) { el.dataset.tex = tex; fitMath(el); }
  });
}

// Splits TeX at its top-level \qquad gaps (outside braces and environments).
function topLevelParts(tex) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (tex.startsWith('\\begin{', i)) depth++;
    else if (tex.startsWith('\\end{', i)) depth--;
    else if (depth === 0 && tex.startsWith('\\qquad', i) && !/[a-zA-Z]/.test(tex[i + 6] || '')) {
      parts.push(tex.slice(start, i));
      start = i + 6;
    }
  }
  parts.push(tex.slice(start));
  const out = parts.map((p) => p.trim().replace(/,$/, '').trim()).filter(Boolean);
  // A lone connective ("s.t.") belongs on the line it introduces.
  for (let i = out.length - 2; i >= 0; i--) if (/^\\text\{[^}]{1,6}\}$/.test(out[i])) out.splice(i, 2, `${out[i]}\\quad ${out[i + 1]}`);
  return out;
}

// A displayed equation too wide for the column (a phone) is stacked at its \qquad gaps,
// then, only if still too wide, scaled down a little. Wide screens keep the one-line form.
function fitMath(el) {
  const box = () => el.querySelector('.katex-display');
  const over = () => { const b = box(); return b && b.scrollWidth > b.clientWidth + 1; };
  el.style.fontSize = '';
  if (el.dataset.stacked) {
    katex.render(el.dataset.tex, el, { displayMode: true, throwOnError: false, trust: true, macros: MACROS });
    delete el.dataset.stacked;
  }
  if (!over()) return;
  const parts = topLevelParts(el.dataset.narrow || el.dataset.tex);
  const narrow = parts.length > 1 ? `\\begin{gathered}${parts.join(' \\\\[6pt] ')}\\end{gathered}` : el.dataset.narrow;
  if (narrow) {
    katex.render(narrow, el, { displayMode: true, throwOnError: false, trust: true, macros: MACROS });
    el.dataset.stacked = '1';
  }
  for (let i = 0, scale = 1; i < 4 && over(); i++) {
    const b = box();
    scale = Math.max(0.72, scale * (b.clientWidth / b.scrollWidth) - 0.01);
    el.style.fontSize = `${scale.toFixed(3)}em`;
  }
}

let fitWidth = 0;
function refitMath() {
  const w = document.documentElement.clientWidth;
  if (w === fitWidth) return;
  fitWidth = w;
  document.querySelectorAll('.M[data-tex]').forEach(fitMath);
}

export const MACROS = {
  '\\R': '\\mathbb{R}',
  '\\bx': '\\mathbf{x}',
  '\\bz': '\\mathbf{z}',
  '\\bp': '\\mathbf{p}',
  '\\bo': '\\mathbf{o}',
  '\\bd': '\\mathbf{d}',
  '\\bn': '\\mathbf{n}',
  '\\P': '\\mathbf{P}',
  '\\Rm': '\\mathbf{R}',
  '\\Q': '\\mathbf{Q}',
  '\\K': '\\mathbf{K}',
};

function buildRail() {
  const here = location.pathname.split('/').pop() || 'index.html';
  const rail = document.createElement('nav');
  rail.className = 'rail';
  rail.setAttribute('aria-label', 'Chapters');
  rail.innerHTML = `
    <a class="brand" href="index.html">How Talos sees<small>Perception and mapping for an AUV, explained</small></a>
    <ol>${chapters
      .map((c) => `${c.part ? `<li class="part" aria-hidden="true">${c.part}</li>` : ''}<li${c.appendix ? ` class="appendix"` : ''}><a href="${c.href}"${c.href === here ? ' aria-current="page"' : ''}>${c.title}</a>${c.href === here ? '<ul class="toc"></ul>' : ''}</li>`)
      .join('')}</ol>
    <div class="foot">Code: <a href="${REPO}">riptide_perception</a><br>Companion: <a href="https://zehdari.github.io/riptide-mpc-explained/">How Talos flies</a><br>Simulator: <a href="https://github.com/osu-uwrt/nereus">Nereus</a><br>Underwater Robotics Team, Ohio State</div>`;
  const toc = rail.querySelector('.toc');
  if (toc) {
    document.querySelectorAll('main h2[id]').forEach((h) => {
      const li = document.createElement('li');
      li.innerHTML = `<a href="#${h.id}">${h.dataset.short || h.textContent}</a>`;
      toc.appendChild(li);
    });
    const links = [...toc.querySelectorAll('a')];
    const heads = links.map((a) => document.getElementById(a.getAttribute('href').slice(1)));
    const spy = () => {
      let on = 0;
      heads.forEach((h, i) => { if (h.getBoundingClientRect().top < 140) on = i; });
      links.forEach((a, i) => a.classList.toggle('on', i === on && window.scrollY > 200));
    };
    addEventListener('scroll', spy, { passive: true });
    spy();
  }
  const btn = document.createElement('button');
  btn.className = 'btn menu-btn';
  btn.textContent = 'Chapters';
  btn.setAttribute('aria-expanded', 'false');
  btn.onclick = (e) => {
    e.stopPropagation();
    const open = rail.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
  };
  document.addEventListener('click', (e) => { if (!rail.contains(e.target)) rail.classList.remove('open'); });
  return { rail, btn };
}

function nextPrev() {
  const here = location.pathname.split('/').pop() || 'index.html';
  const i = chapters.findIndex((c) => c.href === here);
  const slot = document.querySelector('.next');
  if (!slot || i < 0) return;
  const prev = chapters[i - 1], next = chapters[i + 1];
  slot.innerHTML = `${prev ? `<a href="${prev.href}"><small>Previous</small><strong>${prev.title}</strong></a>` : '<span></span>'}${next ? `<a href="${next.href}" style="text-align:right"><small>Next</small><strong>${next.title}</strong></a>` : ''}`;
}

// Wraps tables so a wide one scrolls inside the text column on phones.
export function wrapTables(root = document) {
  root.querySelectorAll('table.params').forEach((t) => {
    if (t.parentElement.classList.contains('table-scroll')) return;
    const w = document.createElement('div');
    w.className = 'table-scroll';
    t.replaceWith(w);
    w.appendChild(t);
    // Let long names break after _ and / rather than mid-word.
    t.querySelectorAll('code').forEach((c) => {
      if (!c.children.length) c.innerHTML = c.textContent.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m]).replace(/([_/])/g, '$1<wbr>');
    });
  });
}

export function setup() {
  const main = document.querySelector('main');
  wrapTables();
  new MutationObserver(() => wrapTables()).observe(main, { childList: true, subtree: true });
  const shell = document.createElement('div');
  shell.className = 'shell';
  main.parentNode.insertBefore(shell, main);
  const { rail, btn } = buildRail();
  shell.appendChild(rail);
  shell.appendChild(main);
  document.body.appendChild(btn);
  renderMath();
  fitWidth = document.documentElement.clientWidth;
  document.fonts?.ready.then(() => { fitWidth = 0; refitMath(); }); // widths change once KaTeX's fonts arrive
  let t = 0;
  addEventListener('resize', () => { clearTimeout(t); t = setTimeout(refitMath, 150); });
  appendixLinks();
  nextPrev();
}

export { renderMath };
