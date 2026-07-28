// Writes a Firefox-loadable copy of the extension to dist/firefox.
//
//   npm run build:firefox
//
// The sources are cross-browser as they stand (see the `browser ?? chrome`
// line at the top of every file that touches the extension APIs); only the
// manifest needs translating, and Firefox insists the file be named
// manifest.json, so it cannot just sit next to the Chrome one.
//
// Load the result with about:debugging#/runtime/this-firefox → "Load Temporary
// Add-on" → pick dist/firefox/manifest.json. Temporary add-ons are dropped
// when Firefox exits.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist/firefox');

// Everything the manifest can reach. Keep in sync when a new top-level file or
// directory becomes part of the extension proper.
const PAYLOAD = ['background.js', 'content', 'pages', 'icons'];

// storage.sync needs a stable add-on ID in Firefox, and AMO requires one to
// publish. 128 is the floor for content_scripts.match_origin_as_fallback,
// which the manifest uses; the Custom Highlight API that contenteditable
// support wants landed later still, but that path is feature-detected
// (LT.ceSupported) and degrades to no highlights rather than breaking.
const GECKO = {
  id: 'langtool-spellcheck@tito.bouzout',
  strict_min_version: '128.0',
};

function firefoxManifest(chromeManifest) {
  const m = structuredClone(chromeManifest);

  // Firefox has no extension service workers (bug 1573659); MV3 background
  // code runs in an event page instead. background.js is a classic script and
  // uses no service-worker-only API, so the same file works verbatim.
  m.background = { scripts: [m.background.service_worker] };

  delete m.minimum_chrome_version; // Gecko warns about unknown keys
  m.browser_specific_settings = { gecko: GECKO };
  return m;
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const entry of PAYLOAD) {
  const from = path.join(ROOT, entry);
  if (!fs.existsSync(from)) throw new Error(`missing payload entry: ${entry}`);
  fs.cpSync(from, path.join(OUT, entry), { recursive: true });
}

fs.writeFileSync(
  path.join(OUT, 'manifest.json'),
  JSON.stringify(firefoxManifest(manifest), null, 2) + '\n',
);

console.log(`built ${path.relative(process.cwd(), OUT)} (v${manifest.version})`);
console.log('load it: about:debugging#/runtime/this-firefox → Load Temporary Add-on → dist/firefox/manifest.json');
