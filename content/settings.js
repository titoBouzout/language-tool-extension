// Shared namespace + storage-backed settings for all content modules.
//
// Preferences live in chrome.storage.sync so they follow the profile. The
// per-field disable list is the exception: it is keyed by hostname and grows
// without bound, which would blow sync's 8KB-per-item quota, so it lives in
// chrome.storage.local.
const LT = (globalThis.LT ??= {});

const SYNC_DEFAULTS = {
  serverUrl: 'http://localhost:8010',
  language: 'auto',
  preferredVariants: [], // only meaningful when language is 'auto'
  motherTongue: '',
  level: 'default',      // 'default' | 'picky'
  enabled: true,
  disabledSites: [],     // hostnames
  disabledRules: [],
  ignoredWords: [],
};

const LOCAL_DEFAULTS = {
  disabledFields: {},    // { [hostname]: [fieldKey, ...] }
};

LT.SYNC_DEFAULTS = SYNC_DEFAULTS;
LT.LOCAL_DEFAULTS = LOCAL_DEFAULTS;
LT.settings = { ...SYNC_DEFAULTS, ...LOCAL_DEFAULTS };
LT.onSettingsChanged = [];

LT.emitSettings = (keys) => {
  for (const fn of LT.onSettingsChanged) {
    try { fn(keys); } catch { /* one bad listener must not stop the rest */ }
  }
};

// Writes can fail — sync caps each item at 8KB and allows 120 writes/minute,
// and both lists here grow by user action. Surface the failure instead of
// dropping it, so the UI can say the word/rule was not actually saved.
LT.saveError = null;
LT.save = async function (area, items) {
  try {
    await chrome.storage[area].set(items);
    LT.saveError = null;
    return true;
  } catch (err) {
    LT.saveError = (err && err.message) || 'Could not save (storage quota?)';
    return false;
  }
};

// The hostname a "disable on this site" decision is keyed by. Same-origin
// frames (and about:blank/srcdoc frames, which inherit their parent's origin)
// resolve to the top document so a disabled site stays disabled inside its own
// iframes; cross-origin frames key by their own host.
LT.siteHost = (() => {
  let host = location.hostname;
  if (window.top !== window) {
    try { host = window.top.location.hostname || host; } catch { /* cross-origin */ }
  }
  return host;
})();

LT.siteDisabled = () =>
  !LT.settings.enabled || LT.settings.disabledSites.includes(LT.siteHost);

// main.js awaits this before attaching to anything, so the first check already
// knows the configured server, language and disable lists.
LT.settingsReady = (async () => {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(SYNC_DEFAULTS),
    chrome.storage.local.get(LOCAL_DEFAULTS),
  ]);
  Object.assign(LT.settings, sync, local);
})().catch(() => { /* orphaned context: fall back to defaults */ });

chrome.storage.onChanged.addListener((changes, area) => {
  const defaults = area === 'sync' ? SYNC_DEFAULTS : area === 'local' ? LOCAL_DEFAULTS : null;
  if (!defaults) return;
  const keys = [];
  for (const k of Object.keys(defaults)) {
    if (k in changes) {
      LT.settings[k] = changes[k].newValue ?? defaults[k];
      keys.push(k);
    }
  }
  if (keys.length) LT.emitSettings(keys);
});
