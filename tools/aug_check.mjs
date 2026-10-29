// Drive the training playground: pick a sample, set sliders/mode, screenshot the canvas.
import { chromium } from 'playwright';
const [url, out, sample, mode, zoom = '1', sat = '1', val = '1'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome' });
const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(url, { waitUntil: 'load' }); await p.waitForTimeout(2500);
const set = async (label, v) => p.evaluate(([label, v]) => {
  for (const l of document.querySelectorAll('label')) if (l.textContent.trim().startsWith(label)) { const i = l.querySelector('input[type=range]'); if (i) { i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); return true; } }
  return false;
}, [label, v]);
await p.evaluate(([s, m]) => { for (const bt of document.querySelectorAll('button')) { if (bt.textContent.trim() === s || bt.textContent.trim() === m) bt.click(); } }, [sample, mode]);
await p.waitForTimeout(500);
await set('Zoom', zoom); await set('Saturation', sat); await set('Brightness', val);
await p.waitForTimeout(1200);
const c = await p.$('canvas#aug-canvas') || (await p.$$('canvas')).at(-1);
await c.scrollIntoViewIfNeeded(); await c.screenshot({ path: out });
console.log(errs.join('\n') || 'ok'); await b.close();
