// Recon pass 2: full flow with correct selectors, dark theme, two accounts (team mode).
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = 'https://nse-time-capsule.vercel.app';
const OUT = path.resolve('captures/recon2');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const stamp = Date.now().toString(36);
const A = { email: `mmfilm.${stamp}.a@gmail.com`, pass: 'Capture@2021x', name: 'Ananya' };
const B = { email: `mmfilm.${stamp}.b@gmail.com`, pass: 'Capture@2021x', name: 'Rohit' };
const log = [];
const L = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s); log.push(s); };
const save = () => fs.writeFileSync(path.join(OUT, 'report.md'), '# recon2\n\n' + JSON.stringify({ A, B }) + '\n\n```\n' + log.join('\n') + '\n```\n');

let n = 0;
async function shot(page, label, full = false) {
  const id = String(++n).padStart(2, '0');
  try { await page.screenshot({ path: path.join(OUT, `${id}-${label}.jpg`), quality: 68, type: 'jpeg', fullPage: full }); } catch (e) { L('shot fail', label, e.message); }
  const text = await page.evaluate(() => document.body.innerText.replace(/\n{3,}/g, '\n\n').slice(0, 3000)).catch(() => '');
  const ctl = await page.evaluate(() => [...document.querySelectorAll('button,a[href],[role=tab],input,select')].slice(0, 90)
    .map(e => `${e.tagName}${e.getAttribute('href') ? '[' + e.getAttribute('href') + ']' : ''}${e.id ? '#' + e.id : ''}: ${(e.innerText || e.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 50)}`)).catch(() => []);
  L(`\n===== [${id}] ${label} :: ${page.url()}\n--TEXT--\n${text}\n--CTL--\n${ctl.join(' | ')}`);
  save();
}
async function html(page, label) { try { fs.writeFileSync(path.join(OUT, `html-${label}.html`), (await page.content()).slice(0, 500000)); } catch (e) {} }
async function dark(page) { await page.locator('button[aria-label="Switch to dark theme"]').first().click({ timeout: 4000 }).catch(() => L('no dark toggle')); await page.waitForTimeout(700); }

async function signup(ctx, acc, mode, teamNameOrCode) {
  const page = await ctx.newPage();
  await page.goto(BASE + '/game', { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(1200);
  await dark(page);
  await page.fill('#email', acc.email);
  await page.fill('#password', acc.pass);
  await page.fill('#name', acc.name);
  if (mode === 'join') { await page.getByRole('button', { name: /join a team/i }).first().click().catch(e => L('join tab fail', e.message)); await page.waitForTimeout(500); }
  const field = mode === 'join' ? '#teamCode' : '#teamName';
  const has = await page.locator(field).count();
  L('field', field, 'count', has);
  if (has) await page.fill(field, teamNameOrCode);
  else { const last = page.locator('form input:not([type=hidden]):not([type=checkbox])').last(); await last.fill(teamNameOrCode); }
  await shot(page, `signup-${acc.name}`);
  await page.locator('button[type=submit]').first().click();
  await page.waitForTimeout(7000);
  await shot(page, `after-signup-${acc.name}`);
  await html(page, `after-signup-${acc.name}`);
  return page;
}

const browser = await chromium.launch();
try {
  const ctxA = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const pA = await signup(ctxA, A, 'create', 'Desk Nine');

  // discover routes/nav
  const nav = await pA.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href') + ' :: ' + (a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40)));
  L('NAV', nav.join(' | '));

  // team code (if shown)
  const codeTxt = await pA.evaluate(() => document.body.innerText.match(/\b[A-Z]{6}\b/g)?.slice(0, 6) || []);
  L('possible team codes', codeTxt);

  // walk every in-app link
  const links = [...new Set(await pA.evaluate(() => [...document.querySelectorAll('a[href^="/"]')].map(a => a.getAttribute('href'))))];
  L('LINKS', links);
  for (const href of links.slice(0, 12)) {
    try {
      await pA.goto(BASE + href, { waitUntil: 'networkidle', timeout: 60000 });
      await pA.waitForTimeout(2200);
      await shot(pA, 'nav' + href.replace(/\//g, '_'));
      await html(pA, 'nav' + href.replace(/\//g, '_'));
    } catch (e) { L('nav fail', href, e.message); }
  }

  // ---- market / research ----
  for (const r of ['/game/market', '/game/research', '/game/stocks', '/game/companies']) {
    try {
      const resp = await pA.goto(BASE + r, { waitUntil: 'networkidle', timeout: 45000 });
      L('route', r, resp && resp.status());
      await pA.waitForTimeout(1800);
      await shot(pA, 'try' + r.replace(/\//g, '_'));
    } catch (e) { L('route fail', r, e.message); }
  }

  // from the main app screen, click the first company-ish link
  await pA.goto(BASE + '/game', { waitUntil: 'networkidle', timeout: 60000 });
  await pA.waitForTimeout(2500);
  await shot(pA, 'app-home-full', true);
  const stockLinks = [...new Set(await pA.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => h && /stock|company|ticker|\/game\//.test(h))))];
  L('STOCKLINKS', stockLinks.slice(0, 40));
  for (const href of stockLinks.slice(0, 4)) {
    try {
      await pA.goto(BASE + href, { waitUntil: 'networkidle', timeout: 60000 });
      await pA.waitForTimeout(2500);
      await shot(pA, 'co' + href.replace(/\//g, '_'), true);
      await html(pA, 'co' + href.replace(/\//g, '_'));
      // tabs inside company page
      const tabs = await pA.evaluate(() => [...document.querySelectorAll('[role=tab],button')].map(b => (b.innerText || '').trim()).filter(t => t && t.length < 28).slice(0, 20));
      L('TABS', href, tabs);
      for (const t of tabs.slice(0, 8)) {
        try {
          const el = pA.getByRole('button', { name: t, exact: true }).first();
          if (!(await el.count())) continue;
          await el.click({ timeout: 4000 });
          await pA.waitForTimeout(1400);
          await shot(pA, 'cotab-' + t.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20));
        } catch (e) { L('tab fail', t, e.message); }
      }
    } catch (e) { L('company fail', href, e.message); }
  }

  // ---- second player joins ----
  const code = (codeTxt && codeTxt[0]) || null;
  if (code) {
    const ctxB = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const pB = await signup(ctxB, B, 'join', code);
    await shot(pB, 'player-b');
    await pA.goto(BASE + '/game', { waitUntil: 'networkidle', timeout: 60000 });
    await pA.waitForTimeout(3000);
    await shot(pA, 'team-after-join');
  } else L('no team code found — skipping player B');
} catch (e) {
  L('FATAL', e.message, (e.stack || '').slice(0, 1500));
} finally {
  save();
  await browser.close();
}
