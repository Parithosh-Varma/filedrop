// Recon pass: learn the real MarketMind UI from a CI runner (sandbox has no route to the site).
// Creates a throwaway account, walks the flow, dumps text + screenshots + static assets.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = 'https://nse-time-capsule.vercel.app';
const OUT = path.resolve('captures/recon');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });

const stamp = Date.now().toString(36);
const ACC = {
  a: { email: `mmfilm.${stamp}.a@example.com`, pass: 'Capture@2021x', name: 'Ananya' },
  b: { email: `mmfilm.${stamp}.b@example.com`, pass: 'Capture@2021x', name: 'Rohit' },
};
const log = [];
const L = (...a) => { console.log(...a); log.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x, null, 1)).join(' ')); };

let n = 0;
async function shot(page, label) {
  const id = String(++n).padStart(2, '0');
  const file = path.join(OUT, `${id}-${label}.jpg`);
  await page.screenshot({ path: file, quality: 70, type: 'jpeg' });
  const text = await page.evaluate(() => document.body.innerText.replace(/\n{3,}/g, '\n\n').slice(0, 3500));
  const ctl = await page.evaluate(() => [...document.querySelectorAll('button,a[href],input,select,[role=button],[role=tab]')]
    .slice(0, 120).map(e => `${e.tagName}${e.getAttribute('href') ? '['+e.getAttribute('href')+']' : ''}${e.getAttribute('type') ? '('+e.getAttribute('type')+')' : ''}${e.name ? '{'+e.name+'}' : ''}: ${(e.innerText || e.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 60)}`));
  L(`\n===== [${id}] ${label} :: ${page.url()}\n--- TEXT ---\n${text}\n--- CONTROLS ---\n${ctl.join('\n')}`);
  return file;
}

async function dumpHtml(page, label) {
  const html = await page.content();
  fs.writeFileSync(path.join(OUT, `html-${label}.html`), html.slice(0, 400000));
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') L('[console error]', m.text().slice(0, 200)); });

try {
  // ---------- 1. landing page + static assets ----------
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(2500);
  await shot(page, 'landing-hero');
  await dumpHtml(page, 'landing');

  const assetUrls = await page.evaluate(() => {
    const out = new Set();
    document.querySelectorAll('link[rel=stylesheet],link[as=style]').forEach(l => out.add(l.href));
    document.querySelectorAll('link[as=font],link[rel=preload][href*=".woff"]').forEach(l => out.add(l.href));
    document.querySelectorAll('img,svg image').forEach(i => { if (i.src) out.add(i.src); });
    return [...out];
  });
  L('ASSETS', assetUrls);
  // also grab fonts actually used
  const fontFaces = await page.evaluate(() => {
    const srcs = [];
    for (const ss of document.styleSheets) {
      try { for (const r of ss.cssRules) if (r.constructor.name === 'CSSFontFaceRule') srcs.push(r.cssText.slice(0, 400)); } catch (e) {}
    }
    const used = new Set();
    document.querySelectorAll('h1,h2,h3,p,span,button,div').forEach(e => used.add(getComputedStyle(e).fontFamily));
    return { fontFaces: srcs.slice(0, 40), families: [...used].slice(0, 20), bodyBg: getComputedStyle(document.body).backgroundColor, bodyColor: getComputedStyle(document.body).color };
  });
  L('FONTS', fontFaces);

  for (const u of assetUrls.slice(0, 40)) {
    try {
      const r = await ctx.request.get(u);
      if (!r.ok()) continue;
      const name = u.split('/').pop().split('?')[0];
      fs.writeFileSync(path.join(OUT, 'assets', name), await r.body());
      // pull woff2 referenced inside css
      if (name.endsWith('.css')) {
        const css = (await r.text());
        const refs = [...css.matchAll(/url\(([^)]+)\)/g)].map(m => m[1].replace(/['"]/g, ''));
        for (const ref of refs.slice(0, 20)) {
          const full = new URL(ref, u).href;
          if (!/\.(woff2?|ttf|otf|png|svg|jpg)$/.test(full)) continue;
          try { const rr = await ctx.request.get(full); if (rr.ok()) fs.writeFileSync(path.join(OUT, 'assets', full.split('/').pop().split('?')[0]), await rr.body()); } catch (e) {}
        }
      }
    } catch (e) { L('asset fail', u, e.message); }
  }

  // scroll through the landing page
  const marks = [0.18, 0.33, 0.5, 0.66, 0.8, 0.95];
  for (const m of marks) {
    await page.evaluate(f => window.scrollTo({ top: document.body.scrollHeight * f, behavior: 'instant' }), m);
    await page.waitForTimeout(1600);
    await shot(page, `landing-${Math.round(m * 100)}`);
  }

  // ---------- 2. sign up ----------
  await page.goto(BASE + '/game', { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(1500);
  await shot(page, 'auth');
  await dumpHtml(page, 'auth');

  const fill = async (sel, val) => { const el = page.locator(sel).first(); if (await el.count()) { await el.fill(val); return true; } return false; };
  await page.getByText('New here', { exact: false }).first().click().catch(() => {});
  await page.waitForTimeout(400);
  await fill('input[type=email]', ACC.a.email);
  await fill('input[type=password]', ACC.a.pass);
  const textInputs = page.locator('input[type=text]');
  const tcount = await textInputs.count();
  L('text inputs', tcount);
  if (tcount >= 1) await textInputs.nth(0).fill(ACC.a.name);
  await page.getByText('Start a team', { exact: false }).first().click().catch(() => {});
  await page.waitForTimeout(300);
  if (tcount >= 2) await textInputs.nth(1).fill('Desk Nine');
  await shot(page, 'auth-filled');
  await page.getByRole('button', { name: /create account|sign up|→/i }).first().click().catch(e => L('submit click fail', e.message));
  await page.waitForTimeout(6000);
  await shot(page, 'after-signup');
  await dumpHtml(page, 'after-signup');

  // ---------- 3. walk whatever the app shows ----------
  const navTexts = await page.evaluate(() => [...document.querySelectorAll('a[href],button,[role=tab]')]
    .map(e => ({ t: (e.innerText || '').trim(), h: e.getAttribute('href') || '' }))
    .filter(x => x.t && x.t.length < 40));
  L('NAV', navTexts);

  const routes = ['/game', '/game/market', '/market', '/game/client', '/game/team', '/game/portfolio', '/game/results'];
  for (const r of routes) {
    try {
      await page.goto(BASE + r, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(2000);
      await shot(page, 'route' + r.replace(/\//g, '_'));
    } catch (e) { L('route fail', r, e.message); }
  }

  // back to the app shell and click the first few primary actions
  await page.goto(BASE + '/game', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2500);
  await shot(page, 'shell');
  await dumpHtml(page, 'shell');

  const clickable = await page.evaluate(() => [...document.querySelectorAll('button,a[href^="/"]')]
    .map(e => (e.innerText || '').trim()).filter(t => t && t.length < 40).slice(0, 25));
  L('CLICKABLE', clickable);

  for (const label of clickable.slice(0, 12)) {
    try {
      await page.goto(BASE + '/game', { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(1800);
      const el = page.getByRole('button', { name: label, exact: true }).first();
      const el2 = (await el.count()) ? el : page.getByText(label, { exact: true }).first();
      if (!(await el2.count())) continue;
      await el2.click({ timeout: 5000 });
      await page.waitForTimeout(2500);
      await shot(page, 'click-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24));
    } catch (e) { L('click fail', label, e.message); }
  }
} catch (e) {
  L('FATAL', e.message, e.stack?.slice(0, 1200));
} finally {
  fs.writeFileSync(path.join(OUT, 'report.md'), '# MarketMind recon\n\naccounts: ' + JSON.stringify(ACC) + '\n\n```\n' + log.join('\n') + '\n```\n');
  await browser.close();
}
