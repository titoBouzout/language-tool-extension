// Service worker: proxies requests from content scripts / the preferences
// popup to the LanguageTool server, so pages never talk to it directly.
'use strict';

// Firefox puts the promise-based API on `browser`; its `chrome` alias is
// callback-only, so awaiting a `chrome.*` call there yields undefined. Same
// line in every file that touches the extension APIs. It cannot be named
// `chrome`: a top-level lexical declaration collides with the non-configurable
// global of that name, and the classic scripts (this one, pages/popup.js)
// would fail to parse.
const ext = globalThis.browser ?? globalThis.chrome;

const DEFAULT_SERVER = 'http://localhost:8010';

// Accepts whatever the user typed ("http://localhost:8010/",
// ".../v2/check", ...) and reduces it to the server base URL.
function serverBase(url) {
  let u = String(url || DEFAULT_SERVER).trim();
  u = u.replace(/\/+$/, '').replace(/\/v2(\/check|\/languages)?$/, '');
  return u || DEFAULT_SERVER;
}

async function fetchJson(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: ctrl.signal });
    if (!r.ok) return { error: 'Server responded ' + r.status };
    return { data: await r.json() };
  } catch (err) {
    return { error: (err && err.message) || 'Request failed' };
  } finally {
    clearTimeout(timer);
  }
}

// Identical requests are common: refocusing a field, a settings change that
// re-checks every live element, the retry backoff after the server comes back,
// and several frames of one page holding the same draft. `cache` skips the
// round-trip entirely; `inflight` collapses concurrent duplicates into one.
// Both are keyed on the exact request body, so any parameter change misses.
const CACHE_MAX = 30;
const CACHE_MAX_TEXT = 10000; // don't hold megabytes of drafts in the worker
const cache = new Map();      // key -> { matches, language }, in LRU order
const inflight = new Map();   // key -> Promise

async function handleCheck(req) {
  const base = serverBase(req.serverUrl);
  const text = String(req.text ?? '');
  const params = new URLSearchParams({ language: req.language || 'auto', text });
  if (req.language === 'auto' && Array.isArray(req.preferredVariants) && req.preferredVariants.length) {
    params.set('preferredVariants', req.preferredVariants.join(','));
  }
  if (req.motherTongue) params.set('motherTongue', req.motherTongue);
  if (req.level === 'picky') params.set('level', 'picky');
  if (Array.isArray(req.disabledRules) && req.disabledRules.length) {
    params.set('disabledRules', req.disabledRules.join(','));
  }
  const body = params.toString();
  const key = base + '\n' + body;

  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // LRU bump
    cache.set(key, hit);
    return hit;
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const res = await fetchJson(base + '/v2/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }, 15000);
    if (res.error) return { error: res.error };
    const out = { matches: res.data.matches || [], language: res.data.language || null };
    if (text.length <= CACHE_MAX_TEXT) {
      cache.set(key, out);
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return out;
  })();

  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

async function handleLanguages(req) {
  const res = await fetchJson(serverBase(req.serverUrl) + '/v2/languages', { method: 'GET' }, 8000);
  if (res.error) return { error: res.error };
  return { languages: Array.isArray(res.data) ? res.data : [] };
}

// A stale cache would keep serving matches for rules the user just re-enabled
// only if the key were unchanged — it isn't, since disabledRules is part of
// the body. Ignored words are filtered in the content script, so they never
// reach the server. Server URL changes are keyed too. Nothing to invalidate.

ext.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type === 'checkText') {
    handleCheck(request).then(sendResponse);
    return true;
  }
  if (request?.type === 'getLanguages') {
    handleLanguages(request).then(sendResponse);
    return true;
  }
  return false;
});
