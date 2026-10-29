// Usage: node tools/shot.mjs <url> <out.png> [width] [height] [waitMs] [fullPage]
import { chromium } from 'playwright';
const [url, out, w = 1400, h = 900, wait = 4000, full = ''] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(+wait);
await page.screenshot({ path: out, fullPage: full === 'full' });
console.log(errors.slice(0, 10).join('\n') || 'no console errors');
await browser.close();
