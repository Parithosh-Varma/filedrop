// Cinematic capture pass: real MarketMind UI, choreographed camera moves.
// Produces hi-res stills (jpeg q92, dpr 2) + 1920x1080 clips for the launch film.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = 'https://nse-time-capsule.vercel.app';
const OUT = path.resolve('captures/film');
const STILL = path.join(OUT, 'stills');
const CLIP = path.join(OUT, 'clips');
fs.rmSync(OUT, { recursive: true, force: true });
[OUT, STILL, CLIP].forEach(d => fs.mkdirSync(d, { recursive: true }));

const stamp = Date.now().toString(36);
const A = { email: `mmfilm.${stamp}.a@gmail.com`, pass: 'Capture@2021x', name: 'Ananya' };
const B = { email: `mmfilm.${stamp}.b@gmail.com`, pass: 'Capture@2021x', name: 'Rohit' };
const log = [];
const L = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s); log.push(s); };
const save = () => fs.writeFileSync(path.join(OUT, 'report.md'), '# film capture\n\n' + JSON.stringify({ A, B }) + '\n\n```\n' + log.join('\n') + '\n```\n');

const W = 1920, H = 1080;
const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text'] });

// ---------- helpers ----------
const CURSOR_JS = `
(() => {
  if (window.__cur) return;
  const d = document.createElement('div');
  d.id = '__cursor';
  d.style.cssText = 'position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;pointer-events:none;background:rgba(255,90,31,.22);border:1.5px solid rgba(255,255,255,.85);box-shadow:0 0 18px rgba(255,90,31,.45);transition:transform .12s ease;left:-100px;top:-100px';
  document.documentElement.appendChild(d);
  window.__cur = d;
  addEventListener('mousemove', e => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', () => { d.style.transform = 'scale(.7)'; }, true);
  addEventListener('mouseup', () => { d.style.transform = 'scale(1)'; }, true);
})();`;

async function newCtx({ video, dpr = 2, state = 'A' } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: video ? 1 : dpr,
    storageState: fs.existsSync(path.join(OUT, `state-${state}.json`)) ? path.join(OUT, `state-${state}.json`) : undefined,
    recordVideo: video ? { dir: path.join(CLIP, '_raw_' + video), size: { width: W, height: H } } : undefined,
    reducedMotion: 'no-preference',
  });
  ctx.setDefaultTimeout(45000);
  return ctx;
}

async function finishClip(ctx, page, name) {
  const dir = path.join(CLIP, '_raw_' + name);
  await ctx.close();
  try {
    const f = fs.readdirSync(dir)[0];
    fs.renameSync(path.join(dir, f), path.join(CLIP, name + '.webm'));
    fs.rmSync(dir, { recursive: true, force: true });
    L('clip saved', name);
  } catch (e) { L('clip save fail', name, e.message); }
}

async function prep(page, { cursor = false } = {}) {
  await page.addStyleTag({ content: `*{scrollbar-width:none}::-webkit-scrollbar{display:none}` }).catch(() => {});
  if (cursor) await page.evaluate(CURSOR_JS).catch(() => {});
}

async function still(page, name, opts = {}) {
  const { clip, full = false } = opts;
  try {
    await page.screenshot({ path: path.join(STILL, name + '.jpg'), type: 'jpeg', quality: 92, clip, fullPage: full });
    L('still', name);
  } catch (e) { L('still fail', name, e.message); }
}

async function smoothScrollTo(page, y, ms = 2600) {
  await page.evaluate(([target, dur]) => new Promise(res => {
    const start = window.scrollY, delta = target - start, t0 = performance.now();
    const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    function step(now) {
      const t = Math.min(1, (now - t0) / dur);
      window.scrollTo(0, start + delta * ease(t));
      if (t < 1) requestAnimationFrame(step); else res();
    }
    requestAnimationFrame(step);
  }), [y, ms]);
}

async function glide(page, x, y, steps = 28) { await page.mouse.move(x, y, { steps }); }

async function gotoDark(page, url, wait = 2500) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
  const toggle = page.locator('button[aria-label="Switch to dark theme"]');
  if (await toggle.count()) { await toggle.first().click().catch(() => {}); await page.waitForTimeout(500); }
  await page.waitForTimeout(wait);
}

// ---------- stage 1: accounts ----------
let TEAM_CODE = null, CLIENT = null, BUDGET = null;
{
  const ctx = await newCtx({ state: 'none' });
  const page = await ctx.newPage();
  await gotoDark(page, BASE + '/game', 1200);
  await page.fill('#email', A.email); await page.fill('#password', A.pass); await page.fill('#name', A.name);
  await page.fill('#teamName', 'Desk Nine');
  await page.locator('button[type=submit]').first().click();
  await page.waitForTimeout(7000);
  // draw the client
  await page.goto(BASE + '/game/draw', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /draw our client/i }).first().click().catch(e => L('draw fail', e.message));
  await page.waitForTimeout(6500);
  await page.locator('#signer').first().fill(A.name).catch(() => {});
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /sign the agreement/i }).first().click({ timeout: 20000 }).catch(e => L('sign fail', e.message));
  await page.waitForTimeout(5000);
  await page.goto(BASE + '/game', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => document.body.innerText);
  TEAM_CODE = (info.match(/JOIN CODE\s*\n?\s*([A-Z0-9]{3}-[A-Z0-9]{3})/) || [])[1] || (info.match(/\b[A-Z0-9]{3}-[A-Z0-9]{3}\b/) || [])[0] || null;
  CLIENT = (info.match(/YOUR CLIENT\s*\n(.+)/) || [])[1] || null;
  BUDGET = (info.match(/₹[\d,]+/) || [])[0] || null;
  L('TEAM_CODE', TEAM_CODE, 'CLIENT', CLIENT, 'BUDGET', BUDGET);
  await ctx.storageState({ path: path.join(OUT, 'state-A.json') });
  await ctx.close();
}
save();

// second player joins (so the team screens are real)
if (TEAM_CODE) {
  const ctx = await newCtx({ state: 'none' });
  const page = await ctx.newPage();
  await gotoDark(page, BASE + '/game', 1200);
  await page.fill('#email', B.email); await page.fill('#password', B.pass); await page.fill('#name', B.name);
  await page.getByRole('button', { name: /join a team/i }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  await page.fill('#joinCode', TEAM_CODE);
  await page.locator('button[type=submit]').first().click();
  await page.waitForTimeout(8000);
  L('B joined?', (await page.evaluate(() => document.body.innerText)).slice(0, 300).replace(/\n/g, ' '));
  await ctx.storageState({ path: path.join(OUT, 'state-B.json') });
  await ctx.close();
}
save();

// ---------- stage 2: stills ----------
{
  const ctx = await newCtx({});
  const page = await ctx.newPage();

  // landing
  await gotoDark(page, BASE + '/', 3000);
  await prep(page);
  await still(page, 'land-hero');
  await page.evaluate(() => window.scrollTo(0, 620)); await page.waitForTimeout(1800);
  await still(page, 'land-chart');      // fig.1 — 100 companies 2011-2021
  await page.evaluate(() => window.scrollTo(0, 1500)); await page.waitForTimeout(1500);
  await still(page, 'land-rule');
  for (const [nme, y] of [['land-round', 2600], ['land-clients', 4100], ['land-clients2', 4700], ['land-scoring', 5600], ['land-stats', 6400], ['land-cta', 7100]]) {
    await page.evaluate(v => window.scrollTo(0, v), y); await page.waitForTimeout(1400);
    await still(page, nme);
  }
  const docH = await page.evaluate(() => document.body.scrollHeight);
  L('landing height', docH);

  // team page
  await gotoDark(page, BASE + '/game', 2500);
  await prep(page);
  await still(page, 'team');

  // screener
  await gotoDark(page, BASE + '/game/screener', 3000);
  await prep(page);
  await still(page, 'screener-top');
  await page.evaluate(() => window.scrollTo(0, 760)); await page.waitForTimeout(1500);
  await still(page, 'screener-tiles');
  await page.evaluate(() => window.scrollTo(0, 1500)); await page.waitForTimeout(1200);
  await still(page, 'screener-tiles2');
  // table view
  const tableBtn = page.getByRole('button', { name: /^table$/i }).first();
  if (await tableBtn.count()) {
    await page.evaluate(() => window.scrollTo(0, 400)); await page.waitForTimeout(600);
    await tableBtn.click(); await page.waitForTimeout(1800);
    await still(page, 'screener-table');
    await page.evaluate(() => window.scrollTo(0, 1200)); await page.waitForTimeout(1200);
    await still(page, 'screener-table2');
  }
  // small-cap filter
  const small = page.getByRole('button', { name: /^small$/i }).first();
  if (await small.count()) { await page.evaluate(() => window.scrollTo(0, 400)); await small.click(); await page.waitForTimeout(1800); await still(page, 'screener-small'); }

  // company research pages
  for (const tk of ['TATAMOTORS', 'INFY', 'BAJFINANCE', 'AAVAS', 'ZENSARTECH']) {
    await gotoDark(page, `${BASE}/game/screener/${tk}`, 3200);
    await prep(page);
    await still(page, `co-${tk}-head`);
    const sections = await page.evaluate(() => {
      const out = {};
      document.querySelectorAll('h2,h3,div,section').forEach(e => {
        const t = (e.innerText || '').trim().slice(0, 40);
        if (/^0?1 — PRICE|^Price since|^Profit & loss|^Cash from operations|^Peers|^At a glance/i.test(t)) {
          const r = e.getBoundingClientRect();
          const key = t.toLowerCase().split('\n')[0].replace(/[^a-z& ]/g, '').trim().replace(/\s+/g, '-').slice(0, 18);
          if (!(key in out)) out[key] = Math.round(r.top + window.scrollY);
        }
      });
      return out;
    });
    L('sections', tk, JSON.stringify(sections));
    for (const [k, y] of Object.entries(sections)) {
      await page.evaluate(v => window.scrollTo(0, Math.max(0, v - 150)), y);
      await page.waitForTimeout(1500);
      await still(page, `co-${tk}-${k}`);
    }
  }

  // terminal
  await gotoDark(page, BASE + '/game/terminal', 4000);
  await prep(page);
  await still(page, 'terminal-globe');
  await page.evaluate(() => window.scrollTo(0, 700)); await page.waitForTimeout(1500);
  await still(page, 'terminal-timeline');
  await page.evaluate(() => window.scrollTo(0, 1400)); await page.waitForTimeout(1500);
  await still(page, 'terminal-wire');

  // orders (empty)
  await gotoDark(page, BASE + '/game/orders', 3000);
  await prep(page);
  await still(page, 'orders-empty');
  await ctx.close();
}
save();

// ---------- stage 3: clips ----------
async function clip(name, fn, { state = 'A' } = {}) {
  const ctx = await newCtx({ video: name, state });
  const page = await ctx.newPage();
  try { await fn(page, ctx); } catch (e) { L('clip fail', name, e.message); }
  await finishClip(ctx, page, name);
}

// ticker tape — the frozen market, moving
await clip('ticker', async page => {
  await gotoDark(page, BASE + '/game/screener', 2500);
  await prep(page);
  await page.waitForTimeout(9000);
});

// landing: hero into the 100-company chart
await clip('landing-scroll', async page => {
  await gotoDark(page, BASE + '/', 3500);
  await prep(page);
  await page.waitForTimeout(1200);
  await smoothScrollTo(page, 700, 4200);
  await page.waitForTimeout(2500);
  await smoothScrollTo(page, 1250, 3200);
  await page.waitForTimeout(1500);
});

// screener: search a ticker, filter sectors, hover tiles
await clip('screener-work', async page => {
  await gotoDark(page, BASE + '/game/screener', 3000);
  await prep(page, { cursor: true });
  await glide(page, 300, 700);
  await page.waitForTimeout(500);
  const search = page.locator('input[placeholder*="Name or ticker" i]').first();
  if (await search.count()) {
    const box = await search.boundingBox();
    if (box) { await glide(page, box.x + 60, box.y + box.height / 2); await page.mouse.click(box.x + 60, box.y + box.height / 2); }
    await page.keyboard.type('BAJAJ', { delay: 180 });
    await page.waitForTimeout(2200);
    await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
    await page.waitForTimeout(900);
  }
  for (const sec of ['IT SERVICES', 'PHARMA/BIOTECH', 'AUTO']) {
    const b = page.getByRole('button', { name: sec, exact: true }).first();
    if (await b.count()) {
      const bb = await b.boundingBox();
      if (bb) { await glide(page, bb.x + bb.width / 2, bb.y + bb.height / 2); await page.waitForTimeout(350); await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); }
      await page.waitForTimeout(1800);
    }
  }
  const every = page.getByRole('button', { name: /every sector/i }).first();
  if (await every.count()) { await every.click(); await page.waitForTimeout(1200); }
  await smoothScrollTo(page, 900, 2600);
  await page.waitForTimeout(1500);
});

// company research: slow scroll through chart -> accounts -> ratios
for (const tk of ['TATAMOTORS', 'INFY']) {
  await clip('research-' + tk, async page => {
    await gotoDark(page, `${BASE}/game/screener/${tk}`, 3500);
    await prep(page);
    await page.waitForTimeout(1200);
    await smoothScrollTo(page, 520, 3000);
    await page.waitForTimeout(2200);
    await smoothScrollTo(page, 1180, 3000);
    await page.waitForTimeout(2200);
    await smoothScrollTo(page, 1850, 3000);
    await page.waitForTimeout(2000);
    await smoothScrollTo(page, 2500, 2600);
    await page.waitForTimeout(1800);
  });
}

// the draw + the agreement + the signature (fresh account, so the draw is live)
await clip('draw', async page => {
  const stamp2 = Date.now().toString(36);
  await gotoDark(page, BASE + '/game', 1500);
  await prep(page, { cursor: true });
  await page.fill('#email', `mmfilm.${stamp2}.c@gmail.com`);
  await page.fill('#password', 'Capture@2021x');
  await page.fill('#name', 'Ira');
  await page.fill('#teamName', 'Desk Four');
  await page.locator('button[type=submit]').first().click();
  await page.waitForTimeout(7000);
  await page.goto(BASE + '/game/draw', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const btn = page.getByRole('button', { name: /draw our client/i }).first();
  const bb = await btn.boundingBox();
  if (bb) { await glide(page, bb.x + bb.width / 2, bb.y + bb.height / 2, 30); await page.waitForTimeout(700); await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); }
  await page.waitForTimeout(9000);          // the draw animation + agreement
  const signer = page.locator('#signer').first();
  if (await signer.count()) {
    const sb = await signer.boundingBox();
    if (sb) { await glide(page, sb.x + 80, sb.y + sb.height / 2); await page.mouse.click(sb.x + 80, sb.y + sb.height / 2); }
    await page.keyboard.type('Ira', { delay: 420 });
    await page.waitForTimeout(2500);
  }
  await page.waitForTimeout(1500);
}, { state: 'none' });

// terminal globe
await clip('terminal', async page => {
  await gotoDark(page, BASE + '/game/terminal', 4500);
  await prep(page, { cursor: true });
  await page.waitForTimeout(2500);
  await glide(page, 420, 500);
  await page.mouse.down();
  for (let i = 0; i < 40; i++) { await page.mouse.move(420 + i * 6, 500 - Math.sin(i / 8) * 20); await page.waitForTimeout(40); }
  await page.mouse.up();
  await page.waitForTimeout(2500);
  await smoothScrollTo(page, 950, 3000);
  await page.waitForTimeout(2500);
});

// ---------- stage 4: build the portfolio (clip) ----------
let BUY_LABELS = [];
await clip('orders-build', async page => {
  await gotoDark(page, BASE + '/game/orders', 3000);
  await prep(page, { cursor: true });
  await page.waitForTimeout(1200);
  const buys = page.locator('button', { hasText: /^buy$/i });
  const n = await buys.count();
  L('buy buttons', n);
  for (const idx of [1, 4, 8]) {
    if (idx >= n) continue;
    const bb = await buys.nth(idx).boundingBox();
    if (!bb) continue;
    await glide(page, bb.x + bb.width / 2, bb.y + bb.height / 2, 24);
    await page.waitForTimeout(400);
    await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.waitForTimeout(1600);
  }
  // nudge a quantity up
  const plus = page.getByRole('button', { name: '+' }).first();
  if (await plus.count()) {
    const pb = await plus.boundingBox();
    if (pb) {
      await glide(page, pb.x + pb.width / 2, pb.y + pb.height / 2, 20);
      for (let i = 0; i < 6; i++) { await page.mouse.click(pb.x + pb.width / 2, pb.y + pb.height / 2); await page.waitForTimeout(520); }
    }
  }
  await page.waitForTimeout(2200);
});

// teammate buys -> it lands in the shared slip (clip on A's screen)
await clip('team-live', async page => {
  await gotoDark(page, BASE + '/game/orders', 3000);
  await prep(page);
  const ctxB = await newCtx({ state: 'B' });
  const pB = await ctxB.newPage();
  await pB.goto(BASE + '/game/orders', { waitUntil: 'networkidle' });
  await pB.waitForTimeout(2500);
  const bBuys = pB.locator('button', { hasText: /^buy$/i });
  if (await bBuys.count() > 14) { await bBuys.nth(14).click().catch(() => {}); await pB.waitForTimeout(2500); }
  if (await bBuys.count() > 22) { await bBuys.nth(22).click().catch(() => {}); await pB.waitForTimeout(2500); }
  await ctxB.close();
  await page.waitForTimeout(3000);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);
});

// stills of the loaded slip + team screen
{
  const ctx = await newCtx({});
  const page = await ctx.newPage();
  await gotoDark(page, BASE + '/game/orders', 3000);
  await prep(page);
  await still(page, 'orders-filled');
  await page.evaluate(() => window.scrollTo(0, 420)); await page.waitForTimeout(1200);
  await still(page, 'orders-filled-mid');
  const slip = await page.evaluate(() => document.body.innerText.slice(0, 2500));
  L('SLIP TEXT', slip.replace(/\n{2,}/g, '\n').slice(0, 1800));
  await gotoDark(page, BASE + '/game', 2500);
  await still(page, 'team-two');
  await ctx.close();
}
save();

// ---------- stage 5: the reveal (climax) ----------
await clip('reveal', async page => {
  await gotoDark(page, BASE + '/game/orders', 3000);
  await prep(page, { cursor: true });
  const go = page.getByRole('button', { name: /see what happened/i }).first();
  if (await go.count()) {
    const bb = await go.boundingBox();
    if (bb) { await glide(page, bb.x + bb.width / 2, bb.y + bb.height / 2, 30); await page.waitForTimeout(1200); await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); }
    else await go.click();
  } else L('no reveal button');
  await page.waitForTimeout(30000);   // the fast-forward
});

// results stills + structure
{
  const ctx = await newCtx({});
  const page = await ctx.newPage();
  await gotoDark(page, BASE + '/game/orders', 4000);
  await prep(page);
  L('post-reveal url', page.url());
  await still(page, 'result-top');
  const txt = await page.evaluate(() => document.body.innerText);
  L('RESULT TEXT', txt.slice(0, 3000));
  fs.writeFileSync(path.join(OUT, 'result.html'), (await page.content()).slice(0, 700000));
  const h = await page.evaluate(() => document.body.scrollHeight);
  L('result height', h);
  for (let y = 700; y < Math.min(h, 7000); y += 700) {
    await page.evaluate(v => window.scrollTo(0, v), y);
    await page.waitForTimeout(1400);
    await still(page, 'result-' + y);
  }
  // also try explicit routes in case the reveal lives elsewhere
  for (const r of ['/game/reveal', '/game/results', '/game/scorecard']) {
    const resp = await page.goto(BASE + r, { waitUntil: 'networkidle' }).catch(() => null);
    L('route', r, resp && resp.status());
    if (resp && resp.ok()) {
      await page.waitForTimeout(3000);
      await still(page, 'route' + r.replace(/\//g, '_'));
      L('ROUTE TEXT ' + r, (await page.evaluate(() => document.body.innerText)).slice(0, 2000));
    }
  }
  await ctx.close();
}
save();
await browser.close();
L('DONE');
save();
