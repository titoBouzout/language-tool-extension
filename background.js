// Service worker: proxies requests from content scripts / the preferences
// popup to the LanguageTool server, so pages never talk to it directly.
'use strict';

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

async function handleCheck(req) {
  const params = new URLSearchParams({
    language: req.language || 'auto',
    text: String(req.text ?? ''),
  });
  if (Array.isArray(req.disabledRules) && req.disabledRules.length) {
    params.set('disabledRules', req.disabledRules.join(','));
  }
  const res = await fetchJson(serverBase(req.serverUrl) + '/v2/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  }, 15000);
  if (res.error) return { error: res.error };
  return { matches: res.data.matches || [], language: res.data.language || null };
}

async function handleLanguages(req) {
  const res = await fetchJson(serverBase(req.serverUrl) + '/v2/languages', { method: 'GET' }, 8000);
  if (res.error) return { error: res.error };
  return { languages: Array.isArray(res.data) ? res.data : [] };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
