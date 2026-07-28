// Firefox counterpart of smoke.mjs — not a second copy of the whole suite,
// just the parts whose Firefox behaviour differs from Chrome's: the promise
// namespace (`browser` vs `chrome`), the event page standing in for the
// service worker, the dynamic import of a moz-extension: module from a
// content script, and the extension pages. Everything else is engine-neutral
// and already covered by the Chrome run.
//
//   npm run verify:firefox     (builds dist/firefox first)
//
// Needs a LanguageTool server on localhost:8010 and a real Firefox; set
// FIREFOX_BIN to point at one other than the first on PATH.
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');
const BUILD = path.join(ROOT, 'dist/firefox');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'lt-ff-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });

if (!fs.existsSync(path.join(BUILD, 'manifest.json'))) {
  throw new Error('dist/firefox is missing — run `npm run build:firefox` first');
}

// WebDriver BiDi refuses to navigate a tab to a moz-extension: URL, and web
// content may not link to one either, so the prefs page can only be opened
// from inside the extension. Install a throwaway copy of the build with a
// one-line hook that opens it at startup; everything else is the real build.
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-ff-ext-'));
fs.cpSync(BUILD, EXT, { recursive: true });
fs.appendFileSync(path.join(EXT, 'background.js'),
  "\next.tabs.create({ url: ext.runtime.getURL('pages/popup.html') });\n");

const FIREFOX = process.env.FIREFOX_BIN ||
  execSync('command -v firefox', { shell: '/bin/bash' }).toString().trim();

const results = [];
let failed = false;
async function step(name, fn) {
  try {
    const note = await fn();
    results.push(`PASS ${name}${note ? ' — ' + note : ''}`);
  } catch (err) {
    failed = true;
    results.push(`FAIL ${name} — ${err.message}`);
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const html = fs.readFileSync(path.join(here, 'test.html'));
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(html);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: FIREFOX,
  headless: true,
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lt-ff-profile-')),
});
await browser.installExtension(EXT);

const consoleErrors = [];
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 900 });
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
await page.goto(PAGE);

const shot = (name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });
const segsOver = (id) => page.evaluate((fid) => {
  const el = document.getElementById(fid);
  const r = el.getBoundingClientRect();
  return [...document.querySelectorAll('.lt-ext-seg')].filter(s => {
    const b = s.getBoundingClientRect();
    return b.width > 0 && b.top >= r.top - 2 && b.bottom <= r.bottom + 2;
  }).length;
}, id);

async function clickSeg(id, index) {
  const pt = await page.evaluate((t) => {
    const el = document.getElementById(t.id);
    const r = el.getBoundingClientRect();
    const s = [...document.querySelectorAll('.lt-ext-seg')].filter(seg => {
      const b = seg.getBoundingClientRect();
      return b.width > 0 && b.top >= r.top - 2 && b.bottom <= r.bottom + 2;
    })[t.index];
    if (!s) return null;
    const b = s.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, { id, index });
  if (!pt) throw new Error('segment not found');
  await page.mouse.click(pt.x, pt.y);
}

// The whole pipeline in one assertion: boot.js sees the focus, dynamic-imports
// content/index.js over moz-extension:, settings.js reads storage.sync,
// api.js awaits a runtime.sendMessage the event page answers from the
// LanguageTool server, and overlay.js paints the result.
await step('textarea: boot → dynamic import → event page → underlines', async () => {
  await page.click('#ta');
  await page.type('#ta', 'This is a testt with  two spaces.');
  await page.waitForSelector('.lt-ext-seg', { timeout: 15000 });
  await sleep(300);
  const n = await segsOver('ta');
  if (n < 2) throw new Error(`expected >=2 segments, got ${n}`);
  await shot('ff-01-underlines');
  return `${n} segments`;
});

await step('textarea: click underline opens popup with suggestions', async () => {
  await clickSeg('ta', 0);
  await page.waitForSelector('.lt-ext-popup', { timeout: 5000 });
  const labels = await page.$$eval('.lt-ext-pop-item', els => els.map(e => e.textContent));
  if (!labels.includes('test')) throw new Error(`no "test" suggestion in ${JSON.stringify(labels)}`);
  await shot('ff-02-popup');
  return labels.slice(0, 3).join(', ');
});

await step('textarea: applying a suggestion edits the value', async () => {
  const ok = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.lt-ext-pop-item')].find(b => b.textContent === 'test');
    if (!b) return false;
    b.click();
    return true;
  });
  if (!ok) throw new Error('suggestion button vanished');
  await sleep(300);
  const v = await page.$eval('#ta', el => el.value);
  if (!v.startsWith('This is a test ')) throw new Error(`value is ${JSON.stringify(v)}`);
});

// Firefox only shipped the Custom Highlight API in 140; ce.js feature-detects
// it, so this asserts the supported path is the one actually taken here.
await step('contenteditable: highlights via CSS.highlights, DOM untouched', async () => {
  await page.click('#ce');
  await page.keyboard.press('End');
  await page.type('#ce', ' Secnd paragraf here.');
  await page.waitForFunction(() =>
    ['lt-ext-spell', 'lt-ext-grammar', 'lt-ext-style']
      .reduce((n, k) => n + (CSS.highlights.get(k)?.size || 0), 0) > 0, { timeout: 15000 });
  const clean = await page.evaluate(() =>
    document.getElementById('ce').querySelectorAll('span, [class*=lt-]').length === 0);
  if (!clean) throw new Error('extension inserted nodes into the contenteditable');
  await shot('ff-03-ce-highlights');
  return 'ranges registered, zero injected nodes';
});

// Ignoring a word writes to storage.sync from the content script and the page
// popup reads it back — the promise-namespace round trip in both directions.
await step('input: ignoring a word writes storage.sync and clears the underline', async () => {
  await page.click('#inp');
  await page.type('#inp', 'Word mispeled here.');
  await page.waitForFunction(() => document.querySelector('.lt-ext-seg'), { timeout: 15000 });
  await sleep(500);
  await clickSeg('inp', 0);
  await page.waitForSelector('.lt-ext-popup', { timeout: 5000 });
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.lt-ext-pop-act')]
      .find(b => b.textContent.startsWith('Ignore'));
    if (!b) return false;
    b.click();
    return true;
  });
  if (!clicked) throw new Error('no Ignore button');
  await sleep(700);
  if (await segsOver('inp') !== 0) throw new Error('segments remain after ignore');
});

await step('prefs page: loads over moz-extension:, languages come from the server', async () => {
  // Puppeteer reports an extension tab's url as about:blank, so identify it
  // from the inside.
  let prefs = null;
  for (let i = 0; i < 40 && !prefs; i++) {
    for (const p of await browser.pages()) {
      const url = await p.evaluate(() => location.href).catch(() => '');
      if (url.includes('/pages/popup.html')) { prefs = p; break; }
    }
    if (!prefs) await sleep(250);
  }
  if (!prefs) throw new Error('the extension never opened its prefs page');
  prefs.on('pageerror', (e) => consoleErrors.push('prefs pageerror: ' + e.message));
  await prefs.waitForFunction(
    () => document.querySelectorAll('#language option').length > 5, { timeout: 15000 });
  const info = await prefs.evaluate(() => ({
    langs: document.querySelectorAll('#language option').length,
    status: document.getElementById('status').className,
    chips: [...document.querySelectorAll('.chip')].map(c => c.textContent.replace('×', '').trim()),
    server: document.getElementById('server').value,
    enabled: document.getElementById('enabled').checked,
  }));
  if (!info.status.includes('ok')) throw new Error(`server status: ${info.status}`);
  if (!info.chips.includes('mispeled')) throw new Error(`chips: ${JSON.stringify(info.chips)}`);
  if (!info.enabled) throw new Error('extension reported as globally off');
  await prefs.screenshot({ path: path.join(SHOTS, 'ff-04-prefs.png') });
  return `${info.langs} languages, server=${info.server}, ignored word round-tripped`;
});

await browser.close();
server.close();

console.log('\n=== RESULTS (firefox) ===');
for (const r of results) console.log(r);
console.log('\nconsole errors:', consoleErrors.length ? consoleErrors : 'none');
console.log('screenshots in', SHOTS);
process.exit(failed ? 1 : 0);
