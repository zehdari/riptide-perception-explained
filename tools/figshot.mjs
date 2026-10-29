// node figshot.mjs url selector out.png [width]
import { chromium } from 'playwright';
const [url, sel, out, w = 1400] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: +w, height: 900 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(url, { waitUntil: 'networkidle' });
const el = await p.$(sel); await el.scrollIntoViewIfNeeded(); await p.waitForTimeout(2500);
await el.screenshot({ path: out });
console.log(errs.join('\n') || 'ok'); await b.close();
