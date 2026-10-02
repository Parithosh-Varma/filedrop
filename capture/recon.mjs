// Recon pass 4: company research page, team join, order placement, and the 2026 reveal.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = 'https://nse-time-capsule.vercel.app';
const OUT = path.resolve('captures/recon4');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const stamp = Date.now().toString(36);
const A = { email: `mmfilm.${stamp}.a@gmail.com`, pass: 'Capture@2021x', name: 'Ananya' };
const B = { email: `mmfilm.${stamp}.b@gmail.com`, pass: 'Capture@2021x', name: 'Rohit' };
const log = [];
const L = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s); log.push(s); };
const save = () => fs.writeFileSync(path.join(OUT, 'report.md'), '# recon4\n\n' + JSON.stringify({ A, B }) + '\n\n```\n' + log.join('\n') + '\n```\n');

let n = 0;
async function shot(page, label, full = false) {
  const id = String(++n).padStart(2, '0');
  try { await page.screenshot({ path: path.join(OUT, `${id}-${label}.jpg`), quality: 60, type: 'jpeg', fullPage: full }); } catch (e) { L('shot fail', label, e.message); }
  const text = await page.evaluate(() => { const t = document.body.innerText; const i = t.indexOf('MarketMind'); return (i > 0 ? t.slice(i) : t).replace(/\n{3,}/g, '\n\n').slice(0, 4000); }).catch(() => '');
  L(`\n===== [${id}] ${label} :: ${page.url()}\n--TEXT--\n${text}`);
  save();
}
async function html(page, label) { try { fs.writeFileSync(path.join(OUT, `html-${label}.html`), (await page.content()).slice(0, 700000)); } catch (e) {} }

async function signup(ctx, acc, mode, val) {
  const page = await ctx.newPage();
  await page.goto(BASE + '/game', { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(1000);
  await page.locator('button[aria-label="Switch to dark theme"]').first().click({ timeout: 5000 }).catch(() => L('no dark toggle'));
  await page.waitForTimeout(600);
  await page.fill('#email', acc.email);
  await page.fill('#password', acc.pass);
  await page.fill('#name', acc.name);
  if (mode === 'join') {
    await page.getByRole('button', { name: /join a team/i }).first().click().catch(e => L('join tab fail', e.message));
    await page.waitForTimeout(700);
    const ids = await page.evaluate(() => [...document.querySelectorAll('form input:not([type=hidden])')].map(i => `${i.id}|${i.name}|${i.placeholder}`));
    L('JOIN INPUTS', ids);
    await page.locator('form input:not([type=hidden]):not([type=checkbox])').last().fill(val);
  } else {
    await page.fill('#teamName', val);
  }
  await page.locator('button[type=submit]').first().click();
  await page.waitForTimeout(8000);
  await shot(page, `signed-in-${acc.name}`);
  return page;
}

const browser = await chromium.launch();
try {
  const ctxA = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const pA = await signup(ctxA, A, 'create', 'Desk Nine');

  // draw + sign
  await pA.goto(BASE + '/game/draw', { waitUntil: 'networkidle', timeout: 60000 });
  await pA.waitForTimeout(1200);
  await pA.getByRole('button', { name: /draw our client/i }).first().click({ timeout: 8000 }).catch(e => L('draw fail', e.message));
  await pA.waitForTimeout(6000);
  await shot(pA, 'agreement', true);
  const sign = pA.getByRole('button', { name: /sign the agreement/i }).first();
  if (await sign.count()) { await sign.click(); await pA.waitForTimeout(4000); await shot(pA, 'after-sign', true); }
  await html(pA, 'after-sign');

  // team page -> code
  await pA.goto(BASE + '/game', { waitUntil: 'networkidle', timeout: 60000 });
  await pA.waitForTimeout(2500);
  await shot(pA, 'team-page', true);
  await html(pA, 'team-page');
  const code = await pA.evaluate(() => {
    const txt = document.body.innerText;
    const m = txt.match(/\b([A-Z]{6})\b(?![^]*NSE CLOSE)/g) || [];
    const known = new Set(['SCREENER', 'TERMINAL', 'ORDERS']);
    return (txt.match(/code[\s\S]{0,40}?\b([A-Z]{6})\b/i) || [])[1] || m.filter(x => !known.has(x))[0] || null;
  });
  L('TEAM CODE', code);

  // ---------- company research page ----------
  for (const tk of ['TATAMOTORS', 'INFY']) {
    await pA.goto(`${BASE}/game/screener/${tk}`, { waitUntil: 'networkidle', timeout: 60000 });
    await pA.waitForTimeout(3000);
    await shot(pA, `co-${tk}-full`, true);
    await html(pA, `co-${tk}`);
    const h = await pA.evaluate(() => ({
      height: document.body.scrollHeight,
      sections: [...document.querySelectorAll('section,h2,h3,table,svg,canvas')].slice(0, 60).map(e => `${e.tagName}:${(e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60)}`),
      ctl: [...document.querySelectorAll('button,[role=tab],select')].slice(0, 40).map(e => (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 30)),
    }));
    L('COMPANY STRUCTURE', tk, JSON.stringify(h).slice(0, 2500));
    for (const f of [0.2, 0.42, 0.62, 0.82]) {
      await pA.evaluate(y => window.scrollTo({ top: document.body.scrollHeight * y }), f);
      await pA.waitForTimeout(1100);
      await shot(pA, `co-${tk}-${Math.round(f * 100)}`);
    }
  }

  // ---------- orders ----------
  await pA.goto(BASE + '/game/orders', { waitUntil: 'networkidle', timeout: 60000 });
  await pA.waitForTimeout(2500);
  const buys = pA.locator('button', { hasText: /^BUY$/ });
  const count = await buys.count();
  L('buy buttons', count);
  for (const i of [3, 7, 12, 20]) {
    if (i < count) {
      await buys.nth(i).click().catch(e => L('buy click fail', e.message));
      await pA.waitForTimeout(1200);
    }
  }
  await shot(pA, 'orders-with-slip', true);
  await html(pA, 'orders-with-slip');
  // bump a quantity with MAX / +
  const maxBtn = pA.getByRole('button', { name: /^MAX$/ }).first();
  if (await maxBtn.count()) { await maxBtn.click(); await pA.waitForTimeout(1500); await shot(pA, 'orders-max'); }
  const plus = pA.getByRole('button', { name: '+' }).first();
  for (let i = 0; i < 4 && await plus.count(); i++) { await plus.click(); await pA.waitForTimeout(400); }
  await shot(pA, 'orders-qty', true);
  const slipText = await pA.evaluate(() => document.body.innerText.slice(0, 2500));
  L('SLIP', slipText.slice(0, 1500));

  // ---------- teammate ----------
  if (code) {
    const ctxB = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const pB = await signup(ctxB, B, 'join', code);
    await pB.goto(BASE + '/game', { waitUntil: 'networkidle', timeout: 60000 });
    await pB.waitForTimeout(2000);
    await shot(pB, 'B-team', true);
    await pB.goto(BASE + '/game/orders', { waitUntil: 'networkidle', timeout: 60000 });
    await pB.waitForTimeout(2500);
    const bBuys = pB.locator('button', { hasText: /^BUY$/ });
    if (await bBuys.count() > 30) { await bBuys.nth(30).click().catch(() => {}); await pB.waitForTimeout(1500); }
    await shot(pB, 'B-orders', true);
    await pA.reload({ waitUntil: 'networkidle' });
    await pA.waitForTimeout(3000);
    await shot(pA, 'A-orders-shared', true);
    await html(pA, 'orders-shared');
  }

  // ---------- the reveal ----------
  const reveal = pA.getByRole('button', { name: /see what happened/i }).first();
  const revealLink = pA.getByRole('link', { name: /next: the reveal/i }).first();
  if (await reveal.count()) { await reveal.click(); }
  else if (await revealLink.count()) { await revealLink.click(); }
  else L('no reveal control');
  for (let i = 0; i < 8; i++) { await pA.waitForTimeout(1500); await shot(pA, `reveal-${i}`); }
  await pA.waitForTimeout(3000);
  await shot(pA, 'reveal-full', true);
  await html(pA, 'reveal');
  L('REVEAL URL', pA.url());
} catch (e) {
  L('FATAL', e.message, (e.stack || '').slice(0, 1500));
} finally {
  save();
  await browser.close();
}
