// Preferences popup logic. Settings persist in chrome.storage (sync for
// preferences, local for the per-field opt-outs, which grow without bound and
// would blow sync's per-item quota); content scripts pick changes up live via
// their own onChanged listener.
'use strict';

const SYNC_DEFAULTS = {
  serverUrl: 'http://localhost:8010',
  language: 'auto',
  preferredVariants: [],
  motherTongue: '',
  level: 'default',
  enabled: true,
  disabledSites: [],
  disabledRules: [],
  ignoredWords: [],
};

const LOCAL_DEFAULTS = {
  disabledFields: {},
};

// Shown when the server can't be reached to list its languages.
const FALLBACK_LANGS = [
  { longCode: 'en-US', name: 'English (US)' },
  { longCode: 'en-GB', name: 'English (GB)' },
  { longCode: 'es', name: 'Spanish' },
  { longCode: 'de-DE', name: 'German' },
  { longCode: 'fr', name: 'French' },
  { longCode: 'it', name: 'Italian' },
  { longCode: 'nl', name: 'Dutch' },
  { longCode: 'pt-BR', name: 'Portuguese (Brazil)' },
  { longCode: 'pt-PT', name: 'Portuguese (Portugal)' },
  { longCode: 'pl-PL', name: 'Polish' },
  { longCode: 'ru-RU', name: 'Russian' },
  { longCode: 'uk-UA', name: 'Ukrainian' },
  { longCode: 'sv', name: 'Swedish' },
  { longCode: 'ca-ES', name: 'Catalan' },
];

const $ = (id) => document.getElementById(id);
const settings = { ...SYNC_DEFAULTS, ...LOCAL_DEFAULTS };
let siteHost = '';

function normalizeServer(url) {
  let u = String(url || SYNC_DEFAULTS.serverUrl).trim();
  u = u.replace(/\/+$/, '').replace(/\/v2(\/check|\/languages)?$/, '');
  return u || SYNC_DEFAULTS.serverUrl;
}

// sync caps each item at 8KB and rate-limits writes; both lists here grow by
// user action, so a save really can fail. Say so instead of looking saved.
async function save(area, items) {
  try {
    await chrome.storage[area].set(items);
    $('error').hidden = true;
    return true;
  } catch (err) {
    $('error').textContent = (err && err.message) || 'Could not save';
    $('error').hidden = false;
    return false;
  }
}

function setStatus(kind, title) {
  const dot = $('status');
  dot.className = 'dot' + (kind ? ' ' + kind : '');
  dot.title = title;
}

function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

const byName = (a, b) => a.name.localeCompare(b.name);

function renderLanguages(langs) {
  const sorted = [...langs].filter(l => l.longCode && l.name).sort(byName);

  const sel = $('language');
  sel.textContent = '';
  sel.appendChild(option('auto', 'Auto-detect'));
  const seen = new Set(['auto']);
  for (const l of sorted) {
    if (seen.has(l.longCode)) continue;
    seen.add(l.longCode);
    sel.appendChild(option(l.longCode, l.name + ' (' + l.longCode + ')'));
  }
  // Keep the saved value selectable even if the server list lacks it.
  if (!seen.has(settings.language)) sel.appendChild(option(settings.language, settings.language));
  sel.value = settings.language;

  // Variants only: a preferredVariants entry must name a specific dialect.
  // Chosen ones float to the top — the list is ~50 long and the box shows
  // four, so otherwise the current selection is usually scrolled out of view.
  const variants = $('variants');
  variants.textContent = '';
  const seenVar = new Set();
  const dialects = sorted.filter(l => {
    if (!l.longCode.includes('-') || seenVar.has(l.longCode)) return false;
    seenVar.add(l.longCode);
    return true;
  });
  const chosen = (l) => settings.preferredVariants.includes(l.longCode);
  for (const l of [...dialects.filter(chosen), ...dialects.filter(l => !chosen(l))]) {
    const o = option(l.longCode, l.name + ' (' + l.longCode + ')');
    o.selected = chosen(l);
    variants.appendChild(o);
  }

  const mother = $('mother');
  mother.textContent = '';
  mother.appendChild(option('', 'Not set'));
  const seenMother = new Set(['']);
  for (const l of sorted) {
    if (seenMother.has(l.longCode)) continue;
    seenMother.add(l.longCode);
    mother.appendChild(option(l.longCode, l.name + ' (' + l.longCode + ')'));
  }
  if (!seenMother.has(settings.motherTongue)) {
    mother.appendChild(option(settings.motherTongue, settings.motherTongue));
  }
  mother.value = settings.motherTongue;

  syncVariantsVisibility();
}

// preferredVariants is only honoured by the server alongside language=auto.
function syncVariantsVisibility() {
  $('variants-row').hidden = settings.language !== 'auto';
}

async function loadLanguages() {
  setStatus('', 'Checking server…');
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'getLanguages', serverUrl: settings.serverUrl });
    if (!resp || resp.error) throw new Error(resp?.error || 'No response');
    renderLanguages(resp.languages);
    setStatus('ok', 'Server reachable');
  } catch (err) {
    renderLanguages(FALLBACK_LANGS);
    setStatus('error', 'Server unreachable: ' + err.message);
  }
}

function removeButton(title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'remove';
  b.textContent = '×';
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function renderWords() {
  const box = $('words');
  box.textContent = '';
  for (const word of settings.ignoredWords) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.appendChild(document.createTextNode(word));
    chip.appendChild(removeButton('Stop ignoring', () => {
      save('sync', { ignoredWords: settings.ignoredWords.filter(w => w !== word) });
    }));
    box.appendChild(chip);
  }
}

function renderRules() {
  const list = $('rules');
  list.textContent = '';
  for (const rule of settings.disabledRules) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = rule;
    li.appendChild(span);
    li.appendChild(removeButton('Re-enable rule', () => {
      save('sync', { disabledRules: settings.disabledRules.filter(r => r !== rule) });
    }));
    list.appendChild(li);
  }
}

function renderFields() {
  const list = $('fields');
  list.textContent = '';
  for (const [host, keys] of Object.entries(settings.disabledFields)) {
    for (const key of keys) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = host + ' — ' + key;
      li.appendChild(span);
      li.appendChild(removeButton('Check this field again', () => {
        const left = keys.filter(k => k !== key);
        const next = { ...settings.disabledFields };
        if (left.length) next[host] = left; else delete next[host];
        save('local', { disabledFields: next });
      }));
      list.appendChild(li);
    }
  }
}

function renderToggles() {
  $('enabled').checked = settings.enabled;
  $('picky').checked = settings.level === 'picky';
  if (siteHost) {
    $('site-row').hidden = false;
    $('site-host').textContent = siteHost;
    $('site').checked = settings.disabledSites.includes(siteHost);
  }
  document.body.classList.toggle('off', !settings.enabled);
}

// --- inputs ---

let serverTimer = 0;
function saveServer() {
  const url = normalizeServer($('server').value);
  if (url !== settings.serverUrl) save('sync', { serverUrl: url });
}
$('server').addEventListener('input', () => {
  clearTimeout(serverTimer);
  serverTimer = setTimeout(saveServer, 500);
});
// Enter/blur saves immediately so a quickly-closed popup doesn't lose the edit.
$('server').addEventListener('change', () => {
  clearTimeout(serverTimer);
  saveServer();
});

$('language').addEventListener('change', () => {
  save('sync', { language: $('language').value });
});

$('variants').addEventListener('change', () => {
  save('sync', {
    preferredVariants: [...$('variants').selectedOptions].map(o => o.value),
  });
});

$('mother').addEventListener('change', () => {
  save('sync', { motherTongue: $('mother').value });
});

$('picky').addEventListener('change', () => {
  save('sync', { level: $('picky').checked ? 'picky' : 'default' });
});

$('enabled').addEventListener('change', () => {
  save('sync', { enabled: $('enabled').checked });
});

$('site').addEventListener('change', () => {
  if (!siteHost) return;
  const on = $('site').checked;
  const list = settings.disabledSites.filter(h => h !== siteHost);
  save('sync', { disabledSites: on ? [...list, siteHost] : list });
});

chrome.storage.onChanged.addListener((changes, area) => {
  const defaults = area === 'sync' ? SYNC_DEFAULTS : area === 'local' ? LOCAL_DEFAULTS : null;
  if (!defaults) return;
  let reloadLangs = false;
  for (const k of Object.keys(defaults)) {
    if (k in changes) {
      settings[k] = changes[k].newValue ?? defaults[k];
      reloadLangs = reloadLangs || k === 'serverUrl' || k === 'language';
    }
  }
  renderWords();
  renderRules();
  renderFields();
  renderToggles();
  if (reloadLangs) {
    if (document.activeElement !== $('server')) $('server').value = settings.serverUrl;
    syncVariantsVisibility();
    loadLanguages();
  }
});

// The tab's hostname is what "disable on this site" is keyed by; host
// permissions make tab.url readable. chrome:// and extension pages have no
// meaningful host, so the row stays hidden there.
async function currentHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return '';
    const u = new URL(tab.url);
    return /^https?:$/.test(u.protocol) ? u.hostname : '';
  } catch {
    return '';
  }
}

(async () => {
  const [sync, local, host] = await Promise.all([
    chrome.storage.sync.get(SYNC_DEFAULTS),
    chrome.storage.local.get(LOCAL_DEFAULTS),
    currentHost(),
  ]);
  Object.assign(settings, sync, local);
  siteHost = host;
  $('server').value = settings.serverUrl;
  renderWords();
  renderRules();
  renderFields();
  renderToggles();
  loadLanguages();
})();
