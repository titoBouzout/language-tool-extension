// Preferences popup logic. Settings persist in chrome.storage.sync; content
// scripts pick changes up live via their own onChanged listener.
'use strict';

const DEFAULTS = {
  serverUrl: 'http://localhost:8010',
  language: 'auto',
  disabledRules: [],
  ignoredWords: [],
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
const settings = { ...DEFAULTS };

function normalizeServer(url) {
  let u = String(url || DEFAULTS.serverUrl).trim();
  u = u.replace(/\/+$/, '').replace(/\/v2(\/check|\/languages)?$/, '');
  return u || DEFAULTS.serverUrl;
}

function setStatus(kind, title) {
  const dot = $('status');
  dot.className = 'dot' + (kind ? ' ' + kind : '');
  dot.title = title;
}

function renderLanguages(langs) {
  const sel = $('language');
  sel.textContent = '';
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = 'Auto-detect';
  sel.appendChild(auto);
  const seen = new Set(['auto']);
  for (const l of [...langs].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!l.longCode || seen.has(l.longCode)) continue;
    seen.add(l.longCode);
    const o = document.createElement('option');
    o.value = l.longCode;
    o.textContent = l.name + ' (' + l.longCode + ')';
    sel.appendChild(o);
  }
  // Keep the saved value selectable even if the server list lacks it.
  if (!seen.has(settings.language)) {
    const o = document.createElement('option');
    o.value = settings.language;
    o.textContent = settings.language;
    sel.appendChild(o);
  }
  sel.value = settings.language;
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

function renderWords() {
  const box = $('words');
  box.textContent = '';
  for (const word of settings.ignoredWords) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.appendChild(document.createTextNode(word));
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'remove';
    rm.textContent = '×';
    rm.title = 'Stop ignoring';
    rm.addEventListener('click', () => {
      chrome.storage.sync.set({ ignoredWords: settings.ignoredWords.filter(w => w !== word) });
    });
    chip.appendChild(rm);
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
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'remove';
    rm.textContent = '×';
    rm.title = 'Re-enable rule';
    rm.addEventListener('click', () => {
      chrome.storage.sync.set({ disabledRules: settings.disabledRules.filter(r => r !== rule) });
    });
    li.appendChild(rm);
    list.appendChild(li);
  }
}

let serverTimer = 0;
function saveServer() {
  const url = normalizeServer($('server').value);
  if (url !== settings.serverUrl) chrome.storage.sync.set({ serverUrl: url });
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
  chrome.storage.sync.set({ language: $('language').value });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  let langOrServer = false;
  for (const k of Object.keys(DEFAULTS)) {
    if (k in changes) {
      settings[k] = changes[k].newValue ?? DEFAULTS[k];
      langOrServer = langOrServer || k === 'serverUrl' || k === 'language';
    }
  }
  renderWords();
  renderRules();
  if (langOrServer) {
    if (document.activeElement !== $('server')) $('server').value = settings.serverUrl;
    loadLanguages();
  }
});

chrome.storage.sync.get(DEFAULTS, (items) => {
  Object.assign(settings, items);
  $('server').value = settings.serverUrl;
  renderWords();
  renderRules();
  loadLanguages();
});
