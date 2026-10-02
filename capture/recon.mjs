// Recon pass 3: get past the draw and learn screener / terminal / orders / results DOM.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = 'https://nse-time-capsule.vercel.app';
const OUT = path.resolve('captures/recon3');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const stamp = Date.now().toString(36);
const A = { email: `mmfilm.${stamp}.a@gmail.com`, pass: 'Capture@2021x', name: 'Ananya' };
const B = { email: `mmfilm.${stamp}.b@gmail.com`, pass: 'Capture@2021x', name: 'Rohit' };
const log = [];
const L = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s); log.push(s); };
const save = () => fs.writeFileSync(path.join(OUT, 'report.md'), '# recon3\n\n' + JSON.stringify({ A, B }) + '\n\n```\n' + log.join('\n') + '\n```\n');

let n = 0;
async function shot(page, label, full = false) {
  const id = String(++n).padStart(2, '0');
  try { await page.screenshot({ path: path.join(OUT, `${id}-${label}.jpg`), quality: 62, type: 'jpeg', fullPage: full }); } catch (e) { L('shot fail', label, e.message); }
  const text = await page.evaluate(() => {
    const t = document.body.innerText;
    // drop the ticker tape noise at the top
    const i = t.indexOf('MarketMind');
    return (i > 0 ? t.slice(i) : t).replace(/\n{3,}/g, '\n\n').slice(0, 3500);
  }).catch(() => '');
  const ctl = await page.evaluate(() => [...document.querySelectorAll('button,a[href],[role=tab],input,select,summary')].slice(0, 120)
    .map(e => `${e.tagName}${e.getAttribute('href') ? '[' + e.getAttribute('href') + ']' : ''}${e.id ? '#' + e.id : ''}${e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').slice(0, 2).join('.') : ''}: ${(e.innerText || e.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 44)}`)).catch(() => []);
  L(`\n===== [${id}] ${label} :: ${page.url()}\n--TEXT--\n${text}\n--CTL--\n${ctl.join(' | ')}`);
  save();
}
async function html(page, label) { try { fs.writeFileSync(path.join(OUT, `html-${label}.html`), (await page.content()).slice(0, 600000)); } catch (e) {} }

async function signup(ctx, acc, mode, teamNameOrCode) {
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
    await page.waitForTimeout(600);
    const ids = await page.evaluate(() => [...document.querySelectorAll('form input:not([type=hidden])')].map(i => i.id + '|' + i.name + '|' + i.placeholder));
    L('join inputs', ids);
    const target = page.locator('form input:not([type=hidden]):not([type=checkbox])').last();
    await target.fill(teamNameOrCode);
  } else {
    await page.fill('#teamName', teamNameOrCode);
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

  // ---------- THE DRAW ----------
  await pA.goto(BASE + '/game/draw', { waitUntil: 'networkidle', timeout: 60000 });
  await pA.waitForTimeout(1500);
  await shot(pA, 'draw-before');
  await html(pA, 'draw-before');
  await pA.getByRole('button', { name: /draw our client/i }).first().click({ timeout: 8000 }).catch(e => L('draw click fail', e.message));
  for (const t of [600, 1200, 1800, 2500, 4000]) { await pA.waitForTimeout(t === 600 ? 600 : 700); await shot(pA, `draw-t${t}`); }
  await pA.waitForTimeout(3000);
  await shot(pA, 'draw-result', true);
  await html(pA, 'draw-result');

  // continue past the draw if there is a confirm button
  const after = await pA.evaluate(() => [...document.querySelectorAll('button,a')].map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 30));
  L('post-draw controls', after);
  for (const label of ['Start researching', 'Open the screener', 'Continue', 'To the screener', 'Accept']) {
    const el = pA.getByRole('button', { name: new RegExp(label, 'i') }).first();
    if (await el.count()) { await el.click().catch(() => {}); await pA.waitForTimeout(2500); await shot(pA, 'post-draw-' + label.replace(/\s+/g, '-')); break; }
  }

  // ---------- SCREENER ----------
  await pA.goto(BASE + '/game/screener', { waitUntil: 'networkidle', timeout: 60000 });
  await pA.waitForTimeout(2500);
  await shot(pA, 'screener-top');
  await html(pA, 'screener');
  for (const f of [0.25, 0.55, 0.9]) {
    await pA.evaluate(y => window.scrollTo({ top: document.body.scrollHeight * y }), f);
    await pA.waitForTimeout(1200);
    await shot(pA, `screener-scroll-${Math.round(f * 100)}`);
  }
  const screenerCtl = await pA.evaluate(() => [...document.querySelectorAll('button,select,input,th,[role=tab]')].map(e => `${e.tagName}:${(e.innerText || e.placeholder || '').trim().slice(0, 30)}`).slice(0, 80));
  L('SCREENER CONTROLS', screenerCtl);
  const rowLinks = await pA.evaluate(() => [...document.querySelectorAll('a[href*="terminal"],a[href*="stock"],tr a')].slice(0, 20).map(a => a.getAttribute('href') + '::' + (a.innerText || '').trim().slice(0, 30)));
  L('SCREENER ROW LINKS', rowLinks);

  // ---------- TERMINAL ----------
  await pA.goto(BASE + '/game/terminal', { waitUntil: 'networkidle', timeout: 60000 });
  await pA.waitForTimeout(3000);
  await shot(pA, 'terminal-default', true);
  await html(pA, 'terminal');
  const termCtl = await pA.evaluate(() => [...document.querySelectorAll('button,[role=tab],select,input')].map(e => `${e.tagName}|${e.id}|${(e.innerText || e.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 34)}`).slice(0, 90));
  L('TERMINAL CONTROLS', termCtl);
  // try tabs
  for (const t of ['Chart', 'Financials', 'Ratios', 'Accounts', 'Price', 'Fundamentals', 'Profile', 'About']) {
    const el = pA.getByRole('button', { name: new RegExp('^' + t + '$', 'i') }).first();
    if (await el.count()) { await el.click().catch(() => {}); await pA.waitForTimeout(1800); await shot(pA, 'terminal-' + t.toLowerCase(), true); }
  }
  // try searching a ticker
  const search = pA.locator('input[type=search],input[placeholder*="earch" i],input[placeholder*="icker" i]').first();
  if (await search.count()) {
    await search.fill('TATAMOTORS');
    await pA.waitForTimeout(1500);
    await shot(pA, 'terminal-search');
    await pA.keyboard.press('Enter');
    await pA.waitForTimeout(2500);
    await shot(pA, 'terminal-tatamotors', true);
  } else L('no search input on terminal');

  // ---------- ORDERS ----------
  await pA.goto(BASE + '/game/orders', { waitUntil: 'networkidle', timeout: 60000 });
  await pA.waitForTimeout(2500);
  await shot(pA, 'orders-empty', true);
  await html(pA, 'orders');
  const orderCtl = await pA.evaluate(() => [...document.querySelectorAll('button,input,select')].map(e => `${e.tagName}|${e.id}|${e.name}|${(e.innerText || e.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 34)}`).slice(0, 90));
  L('ORDER CONTROLS', orderCtl);
  const teamCode = await pA.evaluate(() => {
    const m = document.body.innerText.match(/code[^A-Z]{0,12}([A-Z]{6})/i);
    return m ? m[1] : null;
  });
  L('TEAM CODE', teamCode);

  // try to place an order
  const buyBtn = pA.getByRole('button', { name: /buy|add|place|order/i }).first();
  if (await buyBtn.count()) {
    await buyBtn.click().catch(() => {});
    await pA.waitForTimeout(2000);
    await shot(pA, 'order-dialog', true);
    await html(pA, 'order-dialog');
  }
  await shot(pA, 'orders-after', true);

  // ---------- second player ----------
  if (teamCode) {
    const ctxB = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const pB = await signup(ctxB, B, 'join', teamCode);
    await pB.goto(BASE + '/game/orders', { waitUntil: 'networkidle', timeout: 60000 });
    await pB.waitForTimeout(2500);
    await shot(pB, 'B-orders', true);
    await pA.reload({ waitUntil: 'networkidle' });
    await pA.waitForTimeout(2500);
    await shot(pA, 'A-orders-with-teammate', true);
  }
} catch (e) {
  L('FATAL', e.message, (e.stack || '').slice(0, 1500));
} finally {
  save();
  await browser.close();
}
