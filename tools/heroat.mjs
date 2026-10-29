import { chromium } from 'playwright';
const [url, out, t, w = 1400, h = 900] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome' });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(url, { waitUntil: 'load' }); await p.waitForTimeout(2500);
await p.click('#play'); await p.evaluate((t) => { const s = document.getElementById('scrub'); s.value = t; s.dispatchEvent(new Event('input')); }, t);
await p.waitForTimeout(1200); await p.screenshot({ path: out }); console.log(errs.join('\n') || 'ok'); await b.close();
