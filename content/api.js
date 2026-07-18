// LanguageTool semantics: talking to the background worker and interpreting
// match objects.
'use strict';

// Resolves to { matches, language } or throws.
LT.checkText = async function (text) {
  const s = LT.settings;
  const resp = await chrome.runtime.sendMessage({
    type: 'checkText',
    text,
    serverUrl: s.serverUrl,
    language: s.language || 'auto',
    disabledRules: s.disabledRules.length ? s.disabledRules : undefined,
  });
  if (!resp || resp.error) throw new Error(resp?.error || 'No response from background');
  return resp;
};

// Buckets a match into one of three underline severities.
LT.severity = function (match) {
  const t = match.rule?.issueType;
  if (t === 'misspelling' || t === 'typographical' || match.rule?.category?.id === 'TYPOS') return 'spell';
  if (t === 'style' || t === 'register' || t === 'locale-violation') return 'style';
  return 'grammar';
};
