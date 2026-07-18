// Shared namespace + storage-backed settings for all content modules.
// Content scripts in the manifest share one isolated world, so `LT` declared
// here is visible to every later file.
'use strict';

var LT = globalThis.LT ?? (globalThis.LT = {});

if (!LT.settingsInit) {
  LT.settingsInit = true;

  const DEFAULTS = {
    serverUrl: 'http://localhost:8010',
    language: 'auto',
    disabledRules: [],
    ignoredWords: [],
  };

  LT.settings = { ...DEFAULTS };
  LT.onSettingsChanged = [];

  LT.emitSettings = (keys) => {
    for (const fn of LT.onSettingsChanged) {
      try { fn(keys); } catch { /* one bad listener must not stop the rest */ }
    }
  };

  chrome.storage.sync.get(DEFAULTS, (items) => {
    Object.assign(LT.settings, items);
    LT.emitSettings(Object.keys(DEFAULTS));
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const keys = [];
    for (const k of Object.keys(DEFAULTS)) {
      if (k in changes) {
        LT.settings[k] = changes[k].newValue ?? DEFAULTS[k];
        keys.push(k);
      }
    }
    if (keys.length) LT.emitSettings(keys);
  });
}
