// Climax capture: fill the portfolio, then trigger the 2021 -> 2026 reveal and the scorecard.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = 'https://nse-time-capsule.vercel.app';
const OUT = path.resolve('captures/film2');
const STILL = path.join(OUT, 'stills');
const CLIP = path.join(OUT, 'clips');
fs.rmSync(OUT, { recursive: true, force: true });
[OUT, STILL, CLIP].forEach(d => fs.mkdirSync(d, { recursive: true }));
const STATE_A = path.resolve('captures/film/state-A.json');
const STATE_B = path.resolve('captures/film/state-B.json');

const log = [];
const L = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s); log.push(s); };
const save = () => fs.writeFileSync(path.join(OUT, 'report.md'), '# film2\n\n```\n' + log.join('\n') + '\n```\n');

const W = 1920, H = 1080;
const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });

const CURSOR_JS = `(() => { if (window.__cur) return; const d=document.createElement('div'); d.style.cssText='position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;pointer-events:none;background:rgba(255,90,31,.22);border:1.5px solid rgba(255,255,255,.85);box-shadow:0 0 18px rgba(255,90,31,.45);transition:transform .12s ease;left:-100px;top:-100px'; document.documentElement.appendChild(d); window.__cur=d; addEventListener('mousemove',e=>{d.style.left=e.clientX+'px';d.style.top=e.clientY+'px';},true); addEventListener('mousedown',()=>{d.style.transform='scale(.7)';},true); addEventListener('mouseup',()=>{d.style.transform='scale(1)';},true); })();`;

async function newCtx({ video, dpr = 2, state = STATE_A } = {}) {
  return browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: video ? 1 : dpr,
    storageState: state && fs.existsSync(state) ? state : undefined,
    recordVideo: video ? { dir: path.join(CLIP, '_raw_' + video), size: { width: W, height: H } } : undefined,
  });
}
async function finishClip(ctx, name) {
  const dir = path.join(CLIP, '_raw_' + name);
  await ctx.close();
  try { const f = fs.readdirSync(dir)[0]; fs.renameSync(path.join(dir, f), path.join(CLIP, name + '.webm')); fs.rmSync(dir, { recursive: true, force: true }); L('clip saved', name); }
  catch (e) { L('clip save fail', name, e.message); }
}
async function prep(page, cursor = false) {
  await page.addStyleTag({ content: `*{scrollbar-width:none}::-webkit-scrollbar{display:none}` }).catch(() => {});
  if (cursor) await page.evaluate(CURSOR_JS).catch(() => {});
}
async function still(page, name, clip) {
  try { await page.screenshot({ path: path.join(STILL, name + '.jpg'), type: 'jpeg', quality: 92, clip }); L('still', name); }
  catch (e) { L('still fail', name, e.message); }
}
async function smoothScrollTo(page, y, ms = 2400) {
  await page.evaluate(([target, dur]) => new Promise(res => {
    const start = window.scrollY, delta = target - start, t0 = performance.now();
    const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    (function step(now) { const t = Math.min(1, (now - t0) / dur); window.scrollTo(0, start + delta * ease(t)); t < 1 ? requestAnimationFrame(step) : res(); })(performance.now());
  }), [y, ms]);
}
async function glide(page, x, y, steps = 26) { await page.mouse.move(x, y, { steps }); }
async function gotoDark(page, url, wait = 2500) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
  const t = page.locator('button[aria-label="Switch to dark theme"]');
  if (await t.count()) { await t.first().click().catch(() => {}); await page.waitForTimeout(500); }
  await page.waitForTimeout(wait);
}
async function clickVisible(page, locator, { settle = 1200, cursor = true } = {}) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(350);
  const bb = await locator.boundingBox();
  if (!bb) { L('no bbox'); return false; }
  if (cursor) { await glide(page, bb.x + bb.width / 2, bb.y + bb.height / 2); await page.waitForTimeout(260); }
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.waitForTimeout(settle);
  return true;
}

// ---------- 1. fill the portfolio (clip) ----------
await (async () => {
  const name = 'orders-fill';
  const ctx = await newCtx({ video: name });
  const page = await ctx.newPage();
  try {
    await gotoDark(page, BASE + '/game/orders', 3000);
    await prep(page, true);
    // buy a handful more companies
    const buys = page.locator('button', { hasText: /^buy$/i });
    L('buy count', await buys.count());
    for (const i of [0, 3, 10]) {
      const b = buys.nth(i);
      if (!(await b.count())) continue;
      await clickVisible(page, b, { settle: 1300 });
    }
    // push quantities up: MAX on the first row, then + on another
    await smoothScrollTo(page, 0, 1200);
    await page.waitForTimeout(800);
    const maxes = page.getByRole('button', { name: /^MAX$/ });
    if (await maxes.count()) { await clickVisible(page, maxes.nth(1), { settle: 2000 }); }
    const plus = page.getByRole('button', { name: '+' });
    if (await plus.count()) {
      const b = plus.nth(2);
      await b.scrollIntoViewIfNeeded().catch(() => {});
      const bb = await b.boundingBox();
      if (bb) { await glide(page, bb.x + bb.width / 2, bb.y + bb.height / 2); for (let i = 0; i < 8; i++) { await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.waitForTimeout(430); } }
    }
    await page.waitForTimeout(1500);
    await smoothScrollTo(page, 0, 1500);
    await page.waitForTimeout(2500);
  } catch (e) { L('fill fail', e.message); }
  await finishClip(ctx, name);
})();
save();

// ---------- 2. stills of the full slip ----------
await (async () => {
  const ctx = await newCtx({});
  const page = await ctx.newPage();
  await gotoDark(page, BASE + '/game/orders', 3000);
  await prep(page);
  await still(page, 'orders-full-top');
  const txt = await page.evaluate(() => document.body.innerText);
  const i = txt.indexOf('Spend');
  L('ORDERS TEXT', txt.slice(i, i + 1800).replace(/\n{2,}/g, '\n'));
  await page.evaluate(() => window.scrollTo(0, 480)); await page.waitForTimeout(1200);
  await still(page, 'orders-full-mid');
  await page.evaluate(() => window.scrollTo(0, 900)); await page.waitForTimeout(1200);
  await still(page, 'orders-full-bottom');
  await ctx.close();
})();
save();

// ---------- 3. the reveal ----------
await (async () => {
  const name = 'reveal';
  const ctx = await newCtx({ video: name });
  const page = await ctx.newPage();
  try {
    await gotoDark(page, BASE + '/game/orders', 3000);
    await prep(page, true);
    const go = page.getByRole('button', { name: /see what happened/i }).first();
    if (await go.count()) {
      L('reveal button found');
      await clickVisible(page, go, { settle: 2500 });
    } else {
      const link = page.getByRole('link', { name: /next: the reveal/i }).first();
      if (await link.count()) await clickVisible(page, link, { settle: 2500 });
      else L('NO reveal control');
    }
    // confirmation?
    const confirm = page.getByRole('button', { name: /confirm|yes|hand in|submit|open the/i }).first();
    if (await confirm.count()) { L('confirm button:', (await confirm.innerText()).slice(0, 40)); await clickVisible(page, confirm, { settle: 2000 }); }
    L('url after reveal click', page.url());
    await page.waitForTimeout(36000);
    L('url after wait', page.url());
    L('REVEAL TEXT', (await page.evaluate(() => document.body.innerText)).slice(0, 2500));
  } catch (e) { L('reveal fail', e.message); }
  await finishClip(ctx, name);
})();
save();

// ---------- 4. result stills ----------
await (async () => {
  const ctx = await newCtx({});
  const page = await ctx.newPage();
  await gotoDark(page, BASE + '/game/orders', 4000);
  await prep(page);
  L('result url', page.url());
  const txt = await page.evaluate(() => document.body.innerText);
  const i = Math.max(0, txt.indexOf('MarketMind'));
  L('RESULT PAGE TEXT', txt.slice(i, i + 3500));
  fs.writeFileSync(path.join(OUT, 'result.html'), (await page.content()).slice(0, 800000));
  const h = await page.evaluate(() => document.body.scrollHeight);
  L('height', h);
  await still(page, 'res-0');
  for (let y = 600; y < Math.min(h, 8000); y += 600) {
    await page.evaluate(v => window.scrollTo(0, v), y);
    await page.waitForTimeout(1500);
    await still(page, 'res-' + y);
  }
  // a slow scroll clip over the results
  await ctx.close();
  const ctx2 = await newCtx({ video: 'results-scroll' });
  const p2 = await ctx2.newPage();
  await gotoDark(p2, BASE + '/game/orders', 3500);
  await prep(p2);
  await p2.waitForTimeout(2000);
  await smoothScrollTo(p2, 700, 3200); await p2.waitForTimeout(2200);
  await smoothScrollTo(p2, 1500, 3200); await p2.waitForTimeout(2200);
  await smoothScrollTo(p2, 2400, 3200); await p2.waitForTimeout(2500);
  await finishClip(ctx2, 'results-scroll');
})();
save();

// ---------- 5. team page after everything ----------
await (async () => {
  const ctx = await newCtx({});
  const page = await ctx.newPage();
  await gotoDark(page, BASE + '/game', 2500);
  await prep(page);
  await still(page, 'team-final');
  L('TEAM TEXT', (await page.evaluate(() => document.body.innerText)).slice(-1200));
  await ctx.close();
})();

await browser.close();
L('DONE');
save();
