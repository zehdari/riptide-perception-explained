// Usage: node tools/figs.mjs <page> <selector>... : scrolls each figure into view and screenshots it.
import { chromium } from 'playwright';
const [page, ...sels] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await browser.newPage({ viewport: { width: +(process.env.W || 1400), height: +(process.env.H || 900) } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await p.goto(`http://127.0.0.1:5199/riptide-mpc-explained/${page}`, { waitUntil: 'networkidle' });
let i = 0;
for (const s of sels) {
  const el = p.locator(s).first();
  await el.scrollIntoViewIfNeeded();
  await p.waitForTimeout(+(process.env.WAIT || 2500));
  await el.screenshot({ path: `/tmp/fig_${page.replace('.html', '')}_${i++}.png` });
}
console.log(errs.join('\n') || 'ok');
await browser.close();
