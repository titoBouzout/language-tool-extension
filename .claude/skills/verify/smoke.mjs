// End-to-end smoke test: loads the extension into headless Chrome, drives a
// local test page, and exercises check → underline → popup → replace flows
// against the real LanguageTool server (localhost:8010 must be running).
//
//   node .claude/skills/verify/smoke.mjs [screenshot-dir]
//
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '../../..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'lt-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });

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

// --- serve the test page over http (content scripts don't run on file:// by default) ---
const html = fs.readFileSync(path.join(here, 'test.html'));
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(html);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${server.address().port}/`;

// Branded Chrome refuses unpacked extensions since v137 (both
// --load-extension and CDP loadUnpacked silently no-op), so this needs
// Chrome for Testing: npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer
const cftDir = path.join(os.homedir(), '.cache/puppeteer/chrome');
const cft = fs.readdirSync(cftDir).sort().at(-1);
const browser = await puppeteer.launch({
  executablePath: path.join(cftDir, cft, 'chrome-linux64/chrome'),
  headless: true,
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lt-profile-')),
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,900',
  ],
});

const consoleErrors = [];
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 900 });
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
await page.goto(PAGE);

// Simulate a page with global listeners: count every event that reaches the
// document while targeting extension UI. The trap in overlay.js must keep
// this at zero through all popup interactions below.
await page.evaluate(() => {
  window.__leaks = [];
  for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'mousemove',
    'mouseover', 'click', 'dblclick', 'contextmenu', 'wheel', 'focusin']) {
    document.addEventListener(t, (e) => {
      if (e.target instanceof Element && e.target.closest('#lt-ext-root')) {
        window.__leaks.push(t);
      }
    });
  }
});

const shot = (name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });
const segCount = () => page.$$eval('.lt-ext-seg', els => els.length);
const boxCount = () => page.$$eval('.lt-ext-box', els => els.length);

// helper: click at the center of the Nth underline segment (segments are
// pointer-events:none, so the click lands on the field underneath)
async function clickSeg(matchText) {
  const pt = await page.evaluate((t) => {
    for (const seg of document.querySelectorAll('.lt-ext-seg')) {
      const r = seg.getBoundingClientRect();
      if (r.width > 0) {
        // pick by horizontal position when multiple; caller filters by order
      }
    }
    const segs = [...document.querySelectorAll('.lt-ext-seg')];
    const ta = document.getElementById(t.id);
    const tr = ta.getBoundingClientRect();
    const inside = segs.filter(s => {
      const r = s.getBoundingClientRect();
      return r.top >= tr.top - 2 && r.bottom <= tr.bottom + 2;
    });
    const s = inside[t.index];
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, matchText);
  if (!pt) throw new Error('segment not found');
  await page.mouse.click(pt.x, pt.y);
}

async function clickSuggestion(label) {
  const ok = await page.evaluate((l) => {
    const btn = [...document.querySelectorAll('.lt-ext-pop-item')]
      .find(b => b.textContent === l);
    if (!btn) return false;
    btn.click();
    return true;
  }, label);
  if (!ok) throw new Error(`no suggestion button "${label}"`);
}

// --- textarea flow ---

await step('textarea: typing produces underlines', async () => {
  await page.click('#ta');
  await page.type('#ta', 'This is a testt with  two spaces.');
  await page.waitForSelector('.lt-ext-seg', { timeout: 8000 });
  await sleep(300);
  const n = await segCount();
  if (n < 2) throw new Error(`expected >=2 segments, got ${n}`);
  await shot('01-textarea-underlines');
  return `${n} segments`;
});

await step('textarea: click underline opens popup with suggestions', async () => {
  await clickSeg({ id: 'ta', index: 0 });
  await page.waitForSelector('.lt-ext-popup', { timeout: 3000 });
  const labels = await page.$$eval('.lt-ext-pop-item', els => els.map(e => e.textContent));
  if (!labels.includes('test')) throw new Error(`no "test" suggestion in ${JSON.stringify(labels)}`);
  await shot('02-popup-spelling');
  return labels.slice(0, 3).join(', ');
});

await step('textarea: applying suggestion edits the value', async () => {
  await clickSuggestion('test');
  await sleep(200);
  const v = await page.$eval('#ta', el => el.value);
  if (!v.startsWith('This is a test ')) throw new Error(`value is ${JSON.stringify(v)}`);
});

await step('textarea: double-space match shows readable "Single space"', async () => {
  await page.waitForSelector('.lt-ext-seg', { timeout: 8000 }); // recheck after edit
  await sleep(300);
  await clickSeg({ id: 'ta', index: 0 });
  await page.waitForSelector('.lt-ext-popup', { timeout: 3000 });
  const labels = await page.$$eval('.lt-ext-pop-item', els => els.map(e => e.textContent));
  if (!labels.includes('Single space')) throw new Error(`labels: ${JSON.stringify(labels)}`);
  await shot('03-popup-single-space');
});

await step('textarea: applying "Single space" collapses the spaces', async () => {
  await clickSuggestion('Single space');
  await sleep(200);
  const v = await page.$eval('#ta', el => el.value);
  if (v !== 'This is a test with two spaces.') throw new Error(JSON.stringify(v));
});

await step('popup: Escape closes it', async () => {
  await sleep(900);
  await clickSeg({ id: 'ta', index: 0 }).catch(() => {}); // may be clean now
  const open = await page.$('.lt-ext-popup');
  if (open) {
    await page.keyboard.press('Escape');
    await sleep(100);
    if (await page.$('.lt-ext-popup')) throw new Error('popup still open');
    return 'closed an open popup';
  }
  return 'text already clean, no popup to close';
});

// --- input flow + ignore word ---

await step('input: underline + ignore word removes it', async () => {
  await page.click('#inp');
  await page.type('#inp', 'Word mispeled here.');
  await sleep(1500);
  await clickSeg({ id: 'inp', index: 0 });
  await page.waitForSelector('.lt-ext-popup', { timeout: 3000 });
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.lt-ext-pop-act')]
      .find(b => b.textContent.startsWith('Ignore'));
    if (!b) return false;
    b.click();
    return true;
  });
  if (!clicked) throw new Error('no Ignore button');
  await sleep(500);
  const left = await page.evaluate(() => {
    const inp = document.getElementById('inp');
    const r = inp.getBoundingClientRect();
    return [...document.querySelectorAll('.lt-ext-seg')].filter(s => {
      const b = s.getBoundingClientRect();
      return b.top >= r.top - 2 && b.bottom <= r.bottom + 2;
    }).length;
  });
  if (left !== 0) throw new Error(`${left} segments remain after ignore`);
});

// --- contenteditable flow ---

await step('contenteditable: highlights via CSS.highlights, DOM untouched', async () => {
  await page.click('#ce');
  await page.keyboard.press('End');
  await page.type('#ce', ' Secnd paragraf here.');
  await sleep(1500);
  const hl = await page.evaluate(() =>
    ['lt-ext-spell', 'lt-ext-grammar', 'lt-ext-style']
      .reduce((n, k) => n + (CSS.highlights.get(k)?.size || 0), 0));
  if (hl < 1) throw new Error('no highlight ranges registered');
  const clean = await page.evaluate(() => {
    const ce = document.getElementById('ce');
    return ce.querySelectorAll('span, .lt-error, [class*=lt-]').length === 0;
  });
  if (!clean) throw new Error('extension inserted nodes into the contenteditable');
  await shot('04-ce-highlights');
  return `${hl} ranges, zero injected nodes`;
});

await step('contenteditable: click word → popup → replacement keeps structure', async () => {
  const pt = await page.evaluate(() => {
    const ce = document.getElementById('ce');
    const w = document.createTreeWalker(ce, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const i = n.data.indexOf('Secnd');
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + 5);
        const b = r.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
    }
    return null;
  });
  if (!pt) throw new Error('word not found');
  await page.mouse.click(pt.x, pt.y);
  await page.waitForSelector('.lt-ext-popup', { timeout: 3000 });
  await shot('05-ce-popup');
  const labels = await page.$$eval('.lt-ext-pop-item', els => els.map(e => e.textContent));
  const pick = labels.find(l => /^Second$/i.test(l)) || labels[0];
  await clickSuggestion(pick);
  await sleep(300);
  const state = await page.evaluate(() => {
    const ce = document.getElementById('ce');
    return { text: ce.textContent, ps: ce.querySelectorAll('p').length };
  });
  if (state.text.includes('Secnd')) throw new Error('replacement not applied: ' + state.text);
  if (state.ps !== 1) throw new Error(`paragraph count changed: ${state.ps}`);
  return `text now: ${JSON.stringify(state.text.trim())}`;
});

await step('contenteditable: pre-filled text checked on focus, source whitespace not flagged', async () => {
  await page.click('#ce2');
  await page.waitForFunction(() => {
    let n = 0;
    for (const k of ['lt-ext-spell', 'lt-ext-grammar', 'lt-ext-style']) {
      for (const r of CSS.highlights.get(k) || []) {
        if (document.getElementById('ce2').contains(r.startContainer)) n++;
      }
    }
    return n > 0;
  }, { timeout: 8000 });
  const ranges = await page.evaluate(() => {
    const out = [];
    for (const k of ['lt-ext-spell', 'lt-ext-grammar', 'lt-ext-style']) {
      for (const r of CSS.highlights.get(k) || []) {
        if (document.getElementById('ce2').contains(r.startContainer)) out.push(r.toString());
      }
    }
    return out;
  });
  if (!ranges.some(t => t.includes('Twoo'))) throw new Error(`no Twoo highlight: ${JSON.stringify(ranges)}`);
  const ws = ranges.filter(t => !/\S/.test(t));
  if (ws.length) throw new Error(`whitespace-only highlights: ${JSON.stringify(ws)}`);
  return `ranges: ${JSON.stringify(ranges)}`;
});

// --- probes ---

await step('probe: spellcheck=false textarea is skipped', async () => {
  const before = await boxCount();
  await page.click('#nospell');
  await page.type('#nospell', 'definately wrong');
  await sleep(1500);
  const after = await boxCount();
  if (after !== before) throw new Error(`overlay was attached (${before} -> ${after})`);
});

await step('probe: overlay stays aligned after page scroll', async () => {
  await page.mouse.wheel({ deltaY: 300 });
  await sleep(400);
  const d = await page.evaluate(() => {
    const ta = document.getElementById('ta');
    const boxes = [...document.querySelectorAll('.lt-ext-box')];
    const tr = ta.getBoundingClientRect();
    // find the box overlapping the textarea
    const box = boxes.find(b => {
      const r = b.getBoundingClientRect();
      return Math.abs(r.top - tr.top) < tr.height && Math.abs(r.left - tr.left) < tr.width;
    });
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return Math.abs(r.top - (tr.top + ta.clientTop)) + Math.abs(r.left - (tr.left + ta.clientLeft));
  });
  if (d === null) return 'textarea clean — no box to compare (ok)';
  if (d > 2) throw new Error(`misaligned by ${d}px`);
  return `drift ${d.toFixed(1)}px`;
});

await step('probe: no extension UI events leaked to page listeners', async () => {
  const leaks = await page.evaluate(() => window.__leaks);
  if (leaks.length) throw new Error(`leaked: ${JSON.stringify(leaks)}`);
  return 'page document listeners saw 0 events from extension UI';
});

// --- preferences popup page ---

await step('prefs popup: languages load from server, ignored word listed', async () => {
  const swTarget = await browser.waitForTarget(
    t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
    { timeout: 5000 });
  const extId = new URL(swTarget.url()).host;
  const prefs = await browser.newPage();
  prefs.on('pageerror', (e) => consoleErrors.push('prefs pageerror: ' + e.message));
  await prefs.goto(`chrome-extension://${extId}/pages/popup.html`);
  await prefs.waitForFunction(
    () => document.querySelectorAll('#language option').length > 5, { timeout: 8000 });
  const info = await prefs.evaluate(() => ({
    langs: document.querySelectorAll('#language option').length,
    status: document.getElementById('status').className,
    chips: [...document.querySelectorAll('.chip')].map(c => c.textContent.replace('×', '').trim()),
    server: document.getElementById('server').value,
  }));
  if (!info.status.includes('ok')) throw new Error(`status: ${info.status}`);
  if (!info.chips.includes('mispeled')) throw new Error(`chips: ${JSON.stringify(info.chips)}`);
  await prefs.type('#add-word', 'foobarbaz');
  await prefs.keyboard.press('Enter');
  await sleep(400);
  const chips = await prefs.$$eval('.chip', els => els.map(c => c.textContent.replace('×', '').trim()));
  if (!chips.includes('foobarbaz')) throw new Error(`add failed: ${JSON.stringify(chips)}`);
  await prefs.screenshot({ path: path.join(SHOTS, '06-prefs.png') });
  return `${info.langs} languages, server=${info.server}, chips=${chips.join('/')}`;
});

await browser.close();
server.close();

console.log('\n=== RESULTS ===');
for (const r of results) console.log(r);
console.log('\nconsole errors:', consoleErrors.length ? consoleErrors : 'none');
console.log('screenshots in', SHOTS);
process.exit(failed ? 1 : 0);
