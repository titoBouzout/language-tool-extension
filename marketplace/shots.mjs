// Generates the store screenshots and promo tiles under marketplace/.
//
//   node marketplace/shots.mjs
//
// Drives the real extension in headless Chrome for Testing against a running
// LanguageTool server (localhost:8010) over marketplace/demo.html, so every
// underline and popup in the output is the actual product, not a mockup.
//
// Prerequisites are the same as the verify skill:
//   npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer
//   a LanguageTool server on http://localhost:8010
//
// Output (all exact-sized, PNG):
//   screenshots/*.png   1280x800 — Chrome Web Store, Edge Add-ons, AMO
//   promo/small-tile-440x280.png       Chrome Web Store small promo tile
//   promo/marquee-1400x560.png         Chrome Web Store marquee
//   promo/logo-300x300.png             Edge Add-ons store logo
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const SHOTS = path.join(here, 'screenshots');
const PROMO = path.join(here, 'promo');
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(PROMO, { recursive: true });

const W = 1280, H = 800;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const done = [];

// --- serve marketplace/ over http (content scripts don't run on file://) ---
const server = http.createServer((req, res) => {
  const name = (req.url.split('?')[0] || '/').replace(/^\/+/, '') || 'demo.html';
  const file = path.join(here, path.basename(name));
  if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('no'); }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const cftDir = path.join(os.homedir(), '.cache/puppeteer/chrome');
const cft = fs.readdirSync(cftDir).sort().at(-1);
const browser = await puppeteer.launch({
  executablePath: path.join(cftDir, cft, 'chrome-linux64/chrome'),
  headless: true,
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lt-shots-profile-')),
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${W},${H}`,
  ],
});

const target = await browser.waitForTarget(
  t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
  { timeout: 15000 });
const EXT_ID = new URL(target.url()).host;

const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

async function save(name, buf) {
  fs.writeFileSync(path.join(SHOTS, name + '.png'), buf);
  done.push(`screenshots/${name}.png`);
}
const capture = () => page.screenshot({ captureBeyondViewport: false });

// Open a scene and get the field checked: pre-fill everything but the last
// character, focus, then type it — the extension attaches on focus or on the
// first input event, and a real keystroke also exercises the debounce.
async function stageScene(scene, text, { html = false } = {}) {
  await page.goto(`${ORIGIN}/demo.html?scene=${scene}`);
  await page.waitForSelector('#field');
  if (html) {
    await page.evaluate(h => { document.getElementById('field').innerHTML = h; }, text);
    await page.click('#field');
    await page.evaluate(() => {
      const el = document.getElementById('field');
      const r = document.createRange();
      const last = el.querySelector('p:last-of-type') || el;
      r.selectNodeContents(last);
      r.collapse(false);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
    });
  } else {
    await page.evaluate(h => { document.getElementById('field').value = h; }, text);
    await page.click('#field');
    await page.evaluate(() => {
      const el = document.getElementById('field');
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }
  // A space and a backspace: two real keystrokes that leave the text as it
  // was, so the field is checked without a stray character in the shot.
  await page.keyboard.type(' ');
  await page.keyboard.press('Backspace');
  await page.waitForFunction(
    () => document.querySelectorAll('.lt-ext-seg').length > 0 ||
          (CSS.highlights && CSS.highlights.get('lt-ext-spell')?.size > 0) ||
          (CSS.highlights && CSS.highlights.get('lt-ext-grammar')?.size > 0),
    { timeout: 15000 });
  await sleep(1200); // let the rest of the matches land
}

// Underline segments are pointer-events:none by design, so a click has to land
// on the field beneath them. There is no way to ask a segment which word it
// sits over, so this walks them until the popup that opens offers `want` as
// its top suggestion.
async function openPopupFor(want) {
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.lt-ext-seg')]
    .map(s => s.getBoundingClientRect())
    .filter(r => r.width > 0)
    .map(r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })));
  for (const pt of boxes) {
    await page.mouse.click(pt.x, pt.y);
    const open = await page.waitForSelector('.lt-ext-popup', { timeout: 4000 }).catch(() => null);
    if (!open) continue;
    await sleep(200);
    const labels = await page.$$eval('.lt-ext-pop-item', els => els.map(e => e.textContent));
    if (labels[0] === want) return labels;
    await page.keyboard.press('Escape');
    await sleep(100);
  }
  throw new Error(`no underline offered "${want}" as its top suggestion`);
}

const setPrefs = async (prefs) => {
  const p = await browser.newPage();
  await p.goto(`chrome-extension://${EXT_ID}/pages/popup.html`);
  await p.evaluate(v => chrome.storage.sync.set(v), prefs);
  await p.close();
  await sleep(1200);
};

const log = (...a) => console.log(...a);

// ---------------------------------------------------------------- 01 + 02 + 03

const MAIL = `Hi Dana,

Thanks for sending the draft over — I read it on the train this morning and I think it is allmost ready to go out.

The screenshots in section two are still the old ones, and I recieved a note from legal about the trademark line. There is two other changes I want to make before we publish.`;

await stageScene('mail', MAIL);
log('01 segments:', await page.$$eval('.lt-ext-seg', e => e.length));
await save('01-underlines-in-place', await capture());

// The popup on a misspelling, with its suggestions, the rule behind it and the
// three actions.
{
  const labels = await openPopupFor('almost');
  log('02 suggestions:', labels.join(' | '));
  await save('02-suggestion-popup', await capture());

  // Same popup, wand half hovered so its tooltip-worthy affordance reads.
  const wand = await page.$('.lt-ext-pop-auto');
  if (wand) {
    const r = await wand.boundingBox();
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await sleep(200);
    await save('03-auto-correction', await capture());
  }
  await page.keyboard.press('Escape');
}

// ------------------------------------------------------------------------- 04
// Picky mode on, so spelling (red), grammar (amber) and style (blue) are all
// on screen at once, in a contenteditable editor — the highlight-API path.

await setPrefs({ level: 'picky' });

const DOC = `<p>We shifted the release to Tuesday, and I want to be upfront about the reason: the asset pipeline was'nt ready.</p>
<h2>What happened</h2>
<p>On friday the build began to hang on the compression step. The runners had been swapping for days, and nobody noticed becuase the job still reported green.</p>
<p>There is two changes we made. First, the runner image now pins its compiler version. Second, a very unique alert fires when any step runs long.</p>
<h2>What it means for the release</h2>
<p>Nothing in the release itself changed — the same build that went to staging on Wednesday is the one shipping, with the asset step rerun on a pinned runner. The changelog is unchanged and the migration notes still apply.</p>
<p>If you are on a self-hosted install, there is nothing to do. The next nightly picks up the new runner image on its own, and the alert is on by default.</p>
<p>Thanks to everyone who dug through the logs on Friday evening. The postmortem is linked from the runbook and comments are open until the end of the week.</p>`;

await stageScene('doc', DOC, { html: true });
log('04 highlights:', await page.evaluate(() =>
  ['spell', 'grammar', 'style'].map(k => `${k}=${CSS.highlights.get('lt-ext-' + k)?.size ?? 0}`).join(' ')));
await save('04-rich-editor', await capture());

// ------------------------------------------------------------------------- 05
// A short reply box, with the popup on a grammar match so the rule row and the
// three actions read on their own.

await setPrefs({ level: 'default' });
await stageScene('comment', `Same here — it started right after we bumped the runner image. The runners was swapping for hours, and the compresion step is the one that hangs. I attached a log from the nightly run.`);
log('05 segments:', await page.$$eval('.lt-ext-seg', e => e.length));
{
  const labels = await openPopupFor('were');
  log('05 suggestions:', labels.join(' | '));
  await save('05-actions', await capture());
  await page.keyboard.press('Escape');
}

// ------------------------------------------------------------------------- 06
// The preferences page. It is a 320px browser popup, so it is composited over
// the demo page where the toolbar button would drop it.

{
  const prefs = await browser.newPage();
  await prefs.setViewport({ width: 320, height: 600, deviceScaleFactor: 1 });
  await prefs.goto(`chrome-extension://${EXT_ID}/pages/popup.html`);
  await prefs.evaluate(() => chrome.storage.sync.set({
    language: 'auto',
    preferredVariants: ['en-GB', 'de-DE'],
    ignoredWords: ['Kubernetes', 'Nandakumar', 'langtool'],
    disabledRules: ['OXFORD_SPELLING_Z_NOT_S'],
    autoCorrections: [{ rule: 'MORFOLOGIK_RULE_EN_US', sub: '', from: 'allmost', to: 'almost' }],
  }));
  await prefs.reload();
  await prefs.waitForFunction(() => document.querySelectorAll('#language option').length > 1,
    { timeout: 15000 });
  await sleep(400);
  const png = (await prefs.screenshot({ fullPage: true })).toString('base64');
  const size = await prefs.evaluate(() => ({
    w: document.documentElement.scrollWidth,
    h: document.documentElement.scrollHeight,
  }));
  await prefs.close();

  // Clean draft, and the field is deliberately left unfocused: the overlay
  // sits at the top of the stacking order by design, so a live underline would
  // paint over the preferences panel composited below.
  await page.goto(`${ORIGIN}/demo.html?scene=mail`);
  await page.waitForSelector('#field');
  await page.evaluate(t => { document.getElementById('field').value = t; },
    MAIL.replace('allmost', 'almost').replace('recieved', 'received')
      .replace('There is two', 'There are two'));

  await page.evaluate((b64, size) => {
    const frame = document.createElement('div');
    frame.style.cssText = `position:fixed;top:10px;right:18px;width:${size.w}px;
      border-radius:12px;overflow:hidden;background:#202124;
      box-shadow:0 10px 40px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.25);z-index:9`;
    const img = document.createElement('img');
    img.src = 'data:image/png;base64,' + b64;
    img.style.cssText = 'display:block;width:100%';
    frame.appendChild(img);
    document.body.appendChild(frame);
  }, png, size);
  await page.evaluate(() => new Promise(r => {
    const img = document.querySelector('img[src^="data:image/png"]');
    img.complete ? r() : img.addEventListener('load', r);
  }));
  await sleep(200);
  await save('06-preferences', await capture());
}

// ------------------------------------------------------------- promo graphics

for (const [name, w, h, variant] of [
  ['small-tile-440x280', 440, 280, 'tile'],
  ['marquee-1400x560', 1400, 560, 'marquee'],
  ['logo-300x300', 300, 300, 'logo'],
]) {
  const p = await browser.newPage();
  await p.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await p.goto(`${ORIGIN}/promo.html?variant=${variant}`);
  await p.evaluate(() => document.fonts.ready);
  await sleep(150);
  fs.writeFileSync(path.join(PROMO, name + '.png'), await p.screenshot());
  done.push(`promo/${name}.png`);
  await p.close();
}

await browser.close();
server.close();

for (const f of done) {
  const s = fs.statSync(path.join(here, f));
  console.log(`wrote ${f} (${(s.size / 1024).toFixed(0)} KB)`);
}
