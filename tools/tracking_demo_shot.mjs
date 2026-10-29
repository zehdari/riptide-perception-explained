import { chromium } from 'playwright';
const [url, out, w, h, wait, clicks] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome' });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(url, { waitUntil: 'networkidle' });
await p.locator('.trk-panel').scrollIntoViewIfNeeded();
for (const step of (clicks || '').split(',').filter(Boolean)) {
  const [name, ms] = step.split(':');
  if (name !== 'wait') await p.getByRole('button', { name, exact: true }).click();
  await p.waitForTimeout(+ms || 500);
}
await p.waitForTimeout(+wait);
await p.locator('.trk-panel').screenshot({ path: out });
console.log(errs.join('\n') || 'ok');
await b.close();
