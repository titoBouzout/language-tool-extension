// LanguageTool semantics: talking to the background worker and interpreting
// match objects.
const LT = (globalThis.LT ??= {});

// See background.js: Firefox's promise-based namespace is `browser`.
const ext = globalThis.browser ?? globalThis.chrome;

// Resolves to { matches, language } or throws.
LT.checkText = async function (text) {
  const s = LT.settings;
  const language = s.language || 'auto';
  const resp = await ext.runtime.sendMessage({
    type: 'checkText',
    text,
    serverUrl: s.serverUrl,
    language,
    // The detector can tell English from German but not en-GB from en-US, so
    // without this a British writer gets "colour" and "lorry" flagged as
    // misspellings. Only valid alongside language=auto.
    preferredVariants: language === 'auto' && s.preferredVariants.length
      ? s.preferredVariants : undefined,
    motherTongue: s.motherTongue || undefined,
    level: s.level === 'picky' ? 'picky' : undefined,
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
