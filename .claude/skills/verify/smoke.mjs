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

// Regression: applying a suggestion used to blank the whole overlay and
// repaint it only when the recheck came back, so every *other* underline in
// the field blinked out for a round-trip. Sample the segment count each frame
// while the correction settles — it must never drop below the matches that
// survive the edit (here the first of three is replaced, by a suggestion one
// character shorter, which also shifts the other two).
await step('textarea: correcting one word keeps the other underlines painted', async () => {
  await page.click('#ta');
  await page.evaluate(() => document.getElementById('ta').select());
  await page.keyboard.press('Backspace');
  await page.type('#ta', 'A testt here, a bircycle and speling too.');
  await sleep(2000);
  const before = await segCount();
  if (before !== 3) throw new Error(`expected 3 segments to start from, got ${before}`);

  await page.evaluate(() => {
    window.__samples = [];
    window.__sampling = true;
    const tick = () => {
      window.__samples.push(document.querySelectorAll('.lt-ext-seg').length);
      if (window.__sampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await clickSeg({ id: 'ta', index: 0 });
  await page.waitForSelector('.lt-ext-popup', { timeout: 3000 });
  const labels = await page.$$eval('.lt-ext-pop-item', els => els.map(e => e.textContent));
  const pick = labels.find(l => l === 'test here') || labels[0];
  await clickSuggestion(pick);
  await sleep(2500);

  const samples = await page.evaluate(() => { window.__sampling = false; return window.__samples; });
  const low = Math.min(...samples);
  if (low < 2) throw new Error(`overlay dipped to ${low} segments; samples: ${samples.join(',')}`);
  const v = await page.$eval('#ta', el => el.value);
  if (!v.startsWith('A test here,')) throw new Error(`value is ${JSON.stringify(v)}`);
  const after = await segCount();
  if (after !== 2) throw new Error(`expected 2 segments after the fix, got ${after}`);
  return `3 → 2 segments, never below ${low} across ${samples.length} frames`;
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

await step('contenteditable: highlights survive a silent re-render + net-zero edit', async () => {
  // A framework re-rendering identical text replaces the text nodes the
  // highlight ranges point at, with no input event. A following edit that
  // nets out to no text change (type + backspace) used to hit runCheck's
  // "unchanged" early-return and never repaint.
  await page.evaluate(() => {
    for (const p of document.querySelectorAll('#ce2 p')) p.textContent = p.textContent;
  });
  await page.click('#ce2');
  await page.keyboard.press('End');
  await page.type('#ce2', 'x');
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => {
    for (const k of ['lt-ext-spell', 'lt-ext-grammar', 'lt-ext-style']) {
      for (const r of CSS.highlights.get(k) || []) {
        if (r.startContainer.isConnected &&
            document.getElementById('ce2').contains(r.startContainer) &&
            r.toString().includes('Twoo')) return true;
      }
    }
    return false;
  }, { timeout: 8000 });
  return 'highlight re-anchored to live nodes';
});

await step('controlled editor (Slate-like, Discord): correction survives further edits', async () => {
  await page.click('#ce3');
  await sleep(1500); // initial check on focus
  const pt = await page.evaluate(() => {
    const t = document.querySelector('#ce3 p').firstChild;
    const i = t.data.indexOf('worng');
    if (i < 0) return null;
    const r = document.createRange();
    r.setStart(t, i); r.setEnd(t, i + 5);
    const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  if (!pt) throw new Error('word not found in editor');
  await page.mouse.click(pt.x, pt.y);
  await page.waitForSelector('.lt-ext-popup', { timeout: 3000 });
  const labels = await page.$$eval('.lt-ext-pop-item', els => els.map(e => e.textContent));
  const pick = labels.find(l => /^wrong$/i.test(l)) || labels[0];
  await clickSuggestion(pick);
  await sleep(300);
  const model = await page.evaluate(() => window.__ce3model());
  if (model.includes('worng')) throw new Error('editor model not updated: ' + model);
  // The Discord repro: keep typing after the correction — a model that never
  // heard about the edit re-renders and reverts it here.
  await page.click('#ce3');
  await page.keyboard.press('End');
  await page.type('#ce3', ' More.');
  await sleep(300);
  const final = await page.evaluate(() => ({
    model: window.__ce3model(),
    dom: document.getElementById('ce3').textContent,
  }));
  if (final.dom.includes('worng')) throw new Error('REVERTED: ' + JSON.stringify(final));
  if (!final.dom.includes('More.')) throw new Error('typing lost: ' + JSON.stringify(final));
  if (final.dom !== final.model) throw new Error('model/DOM drift: ' + JSON.stringify(final));
  return `dom: ${JSON.stringify(final.dom)}`;
});

// Same regression as the textarea one, on the timing that actually matters:
// React commits the editor's re-render on a later task, so the nodes our
// highlight ranges point at are replaced after the correction is applied.
// Count ranges that are actually painted (still attached, non-empty rect) —
// the registry keeps detached ones, which are invisible.
await step('async controlled editor: correcting one word keeps the other highlights painted', async () => {
  const painted = () => page.evaluate(() => {
    const el = document.getElementById('ce4');
    let n = 0;
    for (const k of ['lt-ext-spell', 'lt-ext-grammar', 'lt-ext-style']) {
      for (const r of CSS.highlights.get(k) || []) {
        if (!el.contains(r.startContainer)) continue;
        if (r.getBoundingClientRect().width > 0.5) n++;
      }
    }
    return n;
  });

  await page.click('#ce4');
  await sleep(2000); // check on focus
  const before = await painted();
  if (before !== 3) throw new Error(`expected 3 painted highlights, got ${before}`);

  await page.evaluate(() => {
    const el = document.getElementById('ce4');
    window.__ceSamples = [];
    window.__ceSampling = true;
    const tick = () => {
      let n = 0;
      for (const k of ['lt-ext-spell', 'lt-ext-grammar', 'lt-ext-style']) {
        for (const r of CSS.highlights.get(k) || []) {
          if (el.contains(r.startContainer) && r.getBoundingClientRect().width > 0.5) n++;
        }
      }
      window.__ceSamples.push(n);
      if (window.__ceSampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const pt = await page.evaluate(() => {
    const t = document.querySelector('#ce4 p').firstChild;
    const i = t.data.indexOf('testt');
    if (i < 0) return null;
    const r = document.createRange();
    r.setStart(t, i); r.setEnd(t, i + 5);
    const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  if (!pt) throw new Error('word not found in editor');
  await page.mouse.click(pt.x, pt.y);
  await page.waitForSelector('.lt-ext-popup', { timeout: 3000 });
  const labels = await page.$$eval('.lt-ext-pop-item', els => els.map(e => e.textContent));
  const pick = labels.find(l => l === 'test here') || labels[0];
  await clickSuggestion(pick);
  await sleep(2500);

  const samples = await page.evaluate(() => { window.__ceSampling = false; return window.__ceSamples; });
  const model = await page.evaluate(() => window.__ce4model());
  if (model.includes('testt')) throw new Error('editor model not updated: ' + model);
  const low = Math.min(...samples);
  if (low < 2) throw new Error(`highlights dipped to ${low}; samples: ${samples.join(',')}`);
  const after = await painted();
  if (after !== 2) throw new Error(`expected 2 highlights after the fix, got ${after}`);
  await shot('06-ce-async-corrected');
  return `3 → 2 highlights, never below ${low} across ${samples.length} frames`;
});

// --- probes ---

// Segments overlapping a given field, by id.
const segsOver = (id) => page.evaluate((fid) => {
  const el = document.getElementById(fid);
  const r = el.getBoundingClientRect();
  return [...document.querySelectorAll('.lt-ext-seg')].filter(s => {
    const b = s.getBoundingClientRect();
    return b.width > 0 && b.top >= r.top - 2 && b.bottom <= r.bottom + 2;
  }).length;
}, id);

// "testt" is finished and must be underlined quickly; "wor" is where the
// caret is left, so it stays clean until the settle timer fires.
await step('probe: the word being typed is not flagged until typing stops', async () => {
  await page.click('#typing');
  await page.type('#typing', 'This is a testt and wor');
  const started = Date.now();
  let sawTail = false, sawFinished = false;
  while (Date.now() - started < 800) {
    const n = await segsOver('typing');
    if (n >= 2) sawTail = true;
    if (n === 1) sawFinished = true;
    await sleep(40);
  }
  if (sawTail) throw new Error('the half-typed word was underlined while typing');
  await page.waitForFunction(() => {
    const r = document.getElementById('typing').getBoundingClientRect();
    return [...document.querySelectorAll('.lt-ext-seg')].filter(s => {
      const b = s.getBoundingClientRect();
      return b.width > 0 && b.top >= r.top - 2 && b.bottom <= r.bottom + 2;
    }).length >= 2;
  }, { timeout: 5000 });
  await shot('08-typing-settled');
  return sawFinished
    ? 'finished word underlined while typing, caret word only after the pause'
    : 'caret word underlined only after the pause (server was slower than the settle)';
});

await step('probe: spellcheck=false is ignored — the field is still checked', async () => {
  await page.click('#nospell');
  await page.type('#nospell', 'A worng word here.');
  await page.waitForFunction(() => {
    const r = document.getElementById('nospell').getBoundingClientRect();
    return [...document.querySelectorAll('.lt-ext-seg')].some(s => {
      const b = s.getBoundingClientRect();
      return b.width > 0 && b.top >= r.top - 2 && b.bottom <= r.bottom + 2;
    });
  }, { timeout: 8000 });
  return `${await segsOver('nospell')} segments despite spellcheck="false"`;
});

await step('probe: "Disable here" opts one field out, and it sticks', async () => {
  await clickSeg({ id: 'nospell', index: 0 });
  await page.waitForSelector('.lt-ext-popup', { timeout: 3000 });
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.lt-ext-pop-act')]
      .find(b => b.textContent === 'Disable Here');
    if (!b) return false;
    b.click();
    return true;
  });
  if (!clicked) throw new Error('no "Disable here" button in the popup');
  await sleep(700);
  if (await segsOver('nospell') !== 0) throw new Error('underlines remain after Disable here');
  // Re-focusing and editing must not re-attach it.
  await page.click('#nospell');
  await page.type('#nospell', ' Anothr one.');
  await sleep(1800);
  if (await segsOver('nospell') !== 0) throw new Error('field re-attached after Disable here');
  return 'field stays unchecked through refocus + edit';
});

await step('probe: sensitive fields are never checked', async () => {
  for (const [id, why] of [['otp', 'autocomplete=one-time-code'],
                           ['cardnum', 'name=credit_card_number'],
                           ['pin', 'maxlength=6']]) {
    await page.click('#' + id);
    await page.type('#' + id, 'worng');
    await sleep(1200);
    if (await segsOver(id) !== 0) throw new Error(`#${id} (${why}) was checked`);
  }
  return 'otp, card number and short-maxlength fields skipped';
});

await step('probe: field edited via synthetic input events is checked without focus', async () => {
  await page.evaluate(() => {
    const i = document.getElementById('mirror');
    i.value = 'A worng mirrored word.';
    i.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType: 'insertText', data: '.',
    }));
  });
  await page.waitForFunction(() => {
    const r = document.getElementById('mirror').getBoundingClientRect();
    return [...document.querySelectorAll('.lt-ext-seg')].some(s => {
      const b = s.getBoundingClientRect();
      return b.width > 0 && b.top >= r.top - 2 && b.bottom <= r.bottom + 2;
    });
  }, { timeout: 8000 });
  const active = await page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
  if (active === 'mirror') throw new Error('field unexpectedly gained focus');
  return `underlined while focus is on ${active}`;
});

await step('probe: chat-style send clears stale underlines (Enter and Send click)', async () => {
  const underlined = () => page.waitForFunction(() => {
    const r = document.getElementById('chat').getBoundingClientRect();
    return [...document.querySelectorAll('.lt-ext-seg')].some(s => {
      const b = s.getBoundingClientRect();
      return b.width > 0 && b.top >= r.top - 2 && b.bottom <= r.bottom + 2;
    });
  }, { timeout: 8000 });
  const clean = () => page.waitForFunction(() => {
    const chat = document.getElementById('chat');
    const r = chat.getBoundingClientRect();
    return chat.value === '' && ![...document.querySelectorAll('.lt-ext-seg')].some(s => {
      const b = s.getBoundingClientRect();
      return b.width > 0 && b.top >= r.top - 2 && b.bottom <= r.bottom + 2;
    });
  }, { timeout: 3000 });

  await page.click('#chat');
  await page.type('#chat', 'Sending a worng message.');
  await underlined();
  await page.keyboard.press('Enter'); // app consumes it, clears async
  await clean();

  await page.type('#chat', 'Anothr message.');
  await underlined();
  await page.click('#chat-send'); // app clears async, no input event
  await clean();
  return 'underlines removed after both send flows';
});

await step('probe: paste is checked even when the page cancels it', async () => {
  // Headless denies navigator.clipboard.writeText, so load the system
  // clipboard the way a user would: type it somewhere and cut it back out.
  const PASTED = 'This is a testt with a speling erorr.';
  await page.click('#clip-src');
  await page.type('#clip-src', PASTED);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.press('KeyX');
  await page.keyboard.up('Control');
  await sleep(300);

  const paste = async () => {
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyV');
    await page.keyboard.up('Control');
  };

  // Neither target fires an input event: both cancel the paste and apply the
  // clipboard themselves, the way every controlled editor does.
  await page.click('#paste-ta');
  await paste();
  await page.waitForFunction(() => {
    const r = document.getElementById('paste-ta').getBoundingClientRect();
    return [...document.querySelectorAll('.lt-ext-seg')].some(s => {
      const b = s.getBoundingClientRect();
      return b.width > 0 && b.top >= r.top - 2 && b.bottom <= r.bottom + 2;
    });
  }, { timeout: 8000 });
  const nField = await segsOver('paste-ta');
  if (await page.$eval('#paste-ta', el => el.value) !== PASTED) {
    throw new Error('paste did not reach the controlled field');
  }

  await page.click('#paste-ce');
  await paste();
  const inCe = () => page.evaluate(() => {
    const el = document.getElementById('paste-ce');
    let n = 0;
    for (const k of ['lt-ext-spell', 'lt-ext-grammar', 'lt-ext-style']) {
      for (const r of CSS.highlights.get(k) || []) {
        if (el.contains(r.startContainer)) n++;
      }
    }
    return n;
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('paste-ce');
    for (const k of ['lt-ext-spell', 'lt-ext-grammar', 'lt-ext-style']) {
      for (const r of CSS.highlights.get(k) || []) {
        if (el.contains(r.startContainer)) return true;
      }
    }
    return false;
  }, { timeout: 8000 });
  await shot('07-paste-checked');
  return `${nField} segments in the controlled field, ${await inCe()} highlights in the editor`;
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
    variants: document.querySelectorAll('#variants option').length,
    mothers: document.querySelectorAll('#mother option').length,
    status: document.getElementById('status').className,
    chips: [...document.querySelectorAll('.chip')].map(c => c.textContent.replace('×', '').trim()),
    fields: [...document.querySelectorAll('#fields li span')].map(s => s.textContent),
    server: document.getElementById('server').value,
    enabled: document.getElementById('enabled').checked,
    // [hidden] rows carry display:flex, which beats the UA display:none
    // unless the stylesheet forces it.
    siteRowShown: document.getElementById('site-row').offsetParent !== null,
    variantsRowShown: document.getElementById('variants-row').offsetParent !== null,
  }));
  // Opened as a plain tab there is no http(s) host to key a per-site
  // disable on, so that row must stay hidden.
  if (info.siteRowShown) throw new Error('site row visible with no hostname');
  if (!info.variantsRowShown) throw new Error('variants row hidden while language=auto');
  if (!info.status.includes('ok')) throw new Error(`status: ${info.status}`);
  if (!info.chips.includes('mispeled')) throw new Error(`chips: ${JSON.stringify(info.chips)}`);
  if (!info.enabled) throw new Error('extension reported as globally off');
  // Every variant option must name a dialect — preferredVariants is invalid
  // otherwise.
  if (info.variants < 2) throw new Error(`variant options: ${info.variants}`);
  // The field disabled by the popup probe above must be listed and removable.
  if (!info.fields.some(f => f.includes('textarea#nospell'))) {
    throw new Error(`disabled fields: ${JSON.stringify(info.fields)}`);
  }
  // No manual add input anymore — words are only added via the page popup's
  // Ignore action. Removing via the chip's × must still work.
  await prefs.click('.chip .remove');
  await sleep(400);
  const chips = await prefs.$$eval('.chip', els => els.map(c => c.textContent.replace('×', '').trim()));
  if (chips.includes('mispeled')) throw new Error(`remove failed: ${JSON.stringify(chips)}`);
  await prefs.screenshot({ path: path.join(SHOTS, '06-prefs.png') });
  return `${info.langs} languages, ${info.variants} variants, ${info.mothers} mother tongues, ` +
    `server=${info.server}, chip removal ok, ${info.fields.length} disabled field(s)`;
});

await step('prefs popup: global switch off disposes live overlays', async () => {
  const prefs = (await browser.pages()).at(-1);
  await prefs.click('#enabled');
  await sleep(600);
  await page.bringToFront();
  const left = await page.$$eval('.lt-ext-seg', els => els.filter(e => {
    const r = e.getBoundingClientRect();
    return r.width > 0;
  }).length);
  if (left !== 0) throw new Error(`${left} segments survived the global switch`);
  // Back on, so the profile isn't left disabled for a later run.
  await prefs.bringToFront();
  await prefs.click('#enabled');
  await sleep(300);
  return 'all overlays removed while off';
});

// --- LanguageTool request options ---
// Driven through storage from the prefs page, which is what the UI does; the
// content script re-checks every live element when these keys change.

const prefsPage = async () =>
  (await browser.pages()).find(p => p.url().includes('/pages/popup.html'));

const settle = async (id, ms = 2500) => {
  await sleep(ms);
  return segsOver(id);
};

await step('preferredVariants: auto-detect honours the chosen English variant', async () => {
  const prefs = await prefsPage();
  await prefs.evaluate(() => chrome.storage.sync.set({ language: 'auto', preferredVariants: [] }));
  await sleep(300);
  await page.bringToFront();
  await page.click('#dialect');
  await page.type('#dialect', 'I like the colour of that lorry.');
  await page.waitForFunction(() => {
    const r = document.getElementById('dialect').getBoundingClientRect();
    return [...document.querySelectorAll('.lt-ext-seg')].some(s => {
      const b = s.getBoundingClientRect();
      return b.width > 0 && b.top >= r.top - 2 && b.bottom <= r.bottom + 2;
    });
  }, { timeout: 8000 });
  const before = await segsOver('dialect');

  await prefs.evaluate(() => chrome.storage.sync.set({ preferredVariants: ['en-GB'] }));
  const after = await settle('dialect');
  if (after !== 0) throw new Error(`expected 0 segments with en-GB preferred, got ${after}`);
  return `${before} segments as en-US → 0 as en-GB`;
});

await step('level=picky surfaces extra rules', async () => {
  const prefs = await prefsPage();
  await prefs.evaluate(() => chrome.storage.sync.set({ language: 'en-US', level: 'default' }));
  await sleep(300);
  await page.bringToFront();
  await page.click('#picky-ta');
  await page.type('#picky-ta', 'He went to buy apples, oranges and bananas.');
  const before = await settle('picky-ta');

  await prefs.evaluate(() => chrome.storage.sync.set({ level: 'picky' }));
  const after = await settle('picky-ta');
  if (after <= before) throw new Error(`picky gave ${after} segments, default gave ${before}`);
  await shot('07-picky');
  return `${before} → ${after} segments`;
});

await step('long text: tail window keeps match offsets aligned', async () => {
  const prefs = await prefsPage();
  await prefs.evaluate(() => chrome.storage.sync.set({ language: 'en-US', level: 'default' }));
  await sleep(300);
  await page.bringToFront();
  // ~27k chars — well past MAX_TEXT — of clean prose with one misspelling at
  // the very end. The reported offset has to be shifted back by the size of
  // the discarded head, or the underline lands on the wrong word.
  await page.evaluate(() => {
    const ta = document.getElementById('long');
    ta.value = 'The quick brown fox jumps over the lazy dog. '.repeat(600) + 'I made a worng choice.';
    ta.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType: 'insertText', data: '.',
    }));
  });
  await page.waitForFunction(() => {
    const ta = document.getElementById('long');
    ta.scrollTop = ta.scrollHeight;
    const r = ta.getBoundingClientRect();
    return [...document.querySelectorAll('.lt-ext-seg')].some(s => {
      const b = s.getBoundingClientRect();
      return b.width > 0 && b.top >= r.top - 2 && b.bottom <= r.bottom + 2;
    });
  }, { timeout: 15000 });
  await sleep(400);
  await clickSeg({ id: 'long', index: 0 });
  await page.waitForSelector('.lt-ext-popup', { timeout: 3000 });
  const labels = await page.$$eval('.lt-ext-pop-item', els => els.map(e => e.textContent));
  if (!labels.includes('wrong')) {
    throw new Error(`underline is not on "worng" — offsets drifted; popup: ${JSON.stringify(labels)}`);
  }
  await page.keyboard.press('Escape');
  await shot('08-long-text');
  return 'offset shifted correctly across a 27k-char tail window';
});

await step('stale offsets: a silent value change cancels the replacement', async () => {
  await page.bringToFront();
  await page.click('#stale');
  await page.type('#stale', 'A worng word.');
  await page.waitForFunction(() => {
    const r = document.getElementById('stale').getBoundingClientRect();
    return [...document.querySelectorAll('.lt-ext-seg')].some(s => {
      const b = s.getBoundingClientRect();
      return b.width > 0 && b.top >= r.top - 2 && b.bottom <= r.bottom + 2;
    });
  }, { timeout: 8000 });
  await clickSeg({ id: 'stale', index: 0 });
  await page.waitForSelector('.lt-ext-popup', { timeout: 3000 });

  // The page rewrites the field with no input event (draft restore, remote
  // edit): the popup is still open and its offsets now point at other text.
  const REPLACED = 'Totally different content, quite a lot longer than before.';
  await page.evaluate((v) => { document.getElementById('stale').value = v; }, REPLACED);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.lt-ext-pop-item')][0];
    if (b) b.click();
  });
  await sleep(500);
  const v = await page.$eval('#stale', el => el.value);
  if (v !== REPLACED) throw new Error(`text was corrupted: ${JSON.stringify(v)}`);
  return 'replacement declined, text left intact';
});

await browser.close();
server.close();

console.log('\n=== RESULTS ===');
for (const r of results) console.log(r);
console.log('\nconsole errors:', consoleErrors.length ? consoleErrors : 'none');
console.log('screenshots in', SHOTS);
process.exit(failed ? 1 : 0);
