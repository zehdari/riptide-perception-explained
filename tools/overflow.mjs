// Reports elements wider than the viewport on a phone-sized screen, per page.
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://127.0.0.1:5199/riptide-perception-explained/';
const pages = ['index.html','calibration.html','training.html','detector.html','pose.html','composites.html','noise.html','tracking.html','map.html','frames.html','mission.html','workflow.html','math.html'];
const browser = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
for (const pg of pages) {
  await p.goto(base + pg, { waitUntil: 'load' });
  await p.waitForTimeout(1500);
  const r = await p.evaluate(() => {
    const W = document.documentElement.clientWidth, out = [];
    for (const el of document.querySelectorAll('main *')) {
      const b = el.getBoundingClientRect();
      if (b.width && b.right > W + 1) {
        let a = el.parentElement, scrolls = false;
        while (a) { const s = getComputedStyle(a); if (['auto', 'scroll'].includes(s.overflowX) || s.overflow === 'hidden') { scrolls = true; break; } a = a.parentElement; }
        if (!scrolls) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} right=${Math.round(b.right)}`);
      }
    }
    return { page: document.documentElement.scrollWidth, W, out: [...new Set(out)].slice(0, 6) };
  });
  console.log(pg, 'scrollWidth', r.page, 'of', r.W, r.out.join(' | '));
}
await browser.close();
