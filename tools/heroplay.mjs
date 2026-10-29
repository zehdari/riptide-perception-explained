import { chromium } from 'playwright';
const [url, out, w = 1400, h = 900] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome' });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(url, { waitUntil: 'load' }); await p.waitForTimeout(8000);
await p.screenshot({ path: out }); console.log(errs.join('\n') || 'ok', await p.evaluate(() => { const v = document.querySelector('#cam-inset video'); return v ? [v.readyState, v.currentTime.toFixed(1), v.paused] : 'novideo'; })); await b.close();
