// Suggestion popup (dark only). Shows the full LanguageTool payload for a
// match: message, replacements (with whitespace-only values made visible),
// rule category/description, "about this rule" link, detected language, and
// ignore/disable actions.
const LT = (globalThis.LT ??= {});

(() => {
  let active = null; // { root, cleanup: fn[] }

  LT.closePopup = function () {
    if (!active) return;
    for (const fn of active.cleanup) fn();
    active.root.remove();
    active = null;
  };

  function div(className, text) {
    const d = document.createElement('div');
    d.className = className;
    if (text != null) d.textContent = text;
    return d;
  }

  function button(className, label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  const WS_NAMES = {
    ' ': 'Single space',
    '  ': 'Two spaces',
    '\n': 'Line break',
    '\t': 'Tab',
    '\u00a0': 'Non-breaking space',
  };

  // "Turn two spaces into one" style replacements are whitespace-only and
  // would render as blank buttons — give them a readable label instead.
  function describeReplacement(value) {
    if (value === '') return { label: 'Remove', ws: true };
    if (!/\S/.test(value)) {
      if (WS_NAMES[value]) return { label: WS_NAMES[value], ws: true };
      const viz = value.replace(/ /g, '·').replace(/\t/g, '⇥').replace(/\n/g, '¶');
      return { label: viz + ' (whitespace)', ws: true };
    }
    return { label: value, ws: false };
  }

  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // anchor: viewport-coordinate rect of the underlined text.
  LT.showPopup = function (s, match, anchor) {
    LT.closePopup();

    const root = div('lt-ext-popup');

    if (match.shortMessage && match.shortMessage !== match.message) {
      root.appendChild(div('lt-ext-pop-short', match.shortMessage));
    }
    root.appendChild(div('lt-ext-pop-msg', match.message || 'Possible issue'));

    const meta = div('lt-ext-pop-rule');
    meta.appendChild(div('lt-ext-dot lt-sev-' + LT.severity(match)));
    const cat = match.rule?.category?.name || '';
    const desc = match.rule?.description || '';
    const metaText = div('lt-ext-pop-rule-text', cat && desc ? cat + ' · ' + desc : (desc || cat || 'Unknown rule'));
    if (match.rule?.id) {
      metaText.title = match.rule.id + (match.rule.subId ? '[' + match.rule.subId + ']' : '');
    }
    meta.appendChild(metaText);
    const url = match.rule?.urls?.[0]?.value;
    if (url && /^https?:/i.test(url)) {
      const a = document.createElement('a');
      a.className = 'lt-ext-pop-link';
      a.textContent = '↗';
      a.title = 'About this rule';
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      meta.appendChild(a);
    }
    root.appendChild(meta);

    if (LT.settings.language === 'auto' && s.detectedLanguage?.name) {
      root.appendChild(div('lt-ext-pop-lang', 'Detected language: ' + s.detectedLanguage.name));
    }

    // chrome.storage writes fail on quota (sync caps items at 8KB) and on the
    // write-rate limit. Keep the popup open and say so, rather than closing as
    // if the word had been saved.
    async function persist(area, items) {
      if (await LT.save(area, items)) { LT.closePopup(); return; }
      if (active?.root !== root) return;
      let note = root.querySelector('.lt-ext-pop-error');
      if (!note) {
        note = div('lt-ext-pop-error');
        root.appendChild(note);
      }
      note.textContent = LT.saveError || 'Could not save';
    }

    const actions = div('lt-ext-pop-actions');
    const ruleId = match.rule?.id;
    if (ruleId) {
      if (LT.settings.disabledRules.includes(ruleId)) {
        actions.appendChild(div('lt-ext-pop-note', 'Rule disabled'));
      } else {
        const b = button('lt-ext-pop-act', 'Disable rule', () => {
          persist('sync', { disabledRules: [...LT.settings.disabledRules, ruleId] });
        });
        b.title = ruleId;
        actions.appendChild(b);
      }
    }
    const word = (s.lastChecked || '').slice(match.offset, match.offset + match.length);
    if (word.trim()) {
      const lc = word.toLowerCase();
      if (LT.settings.ignoredWords.some(w => w.toLowerCase() === lc)) {
        actions.appendChild(div('lt-ext-pop-note', 'Word ignored'));
      } else {
        actions.appendChild(button('lt-ext-pop-act', 'Ignore ‘' + trunc(word, 24) + '’', () => {
          persist('sync', { ignoredWords: [...LT.settings.ignoredWords, word] });
        }));
      }
    }
    // Per-field opt-out. This replaces honouring the page's spellcheck="false"
    // (which is inherited, so a single attribute on <body> used to silence the
    // extension across a whole site) with a decision the user makes.
    const off = button('lt-ext-pop-act', 'Disable here', () => {
      const host = LT.siteHost;
      const fields = LT.settings.disabledFields;
      const key = LT.fieldKey(s.el);
      const list = fields[host] || [];
      if (list.includes(key)) { LT.closePopup(); return; }
      persist('local', { disabledFields: { ...fields, [host]: [...list, key] } });
    });
    off.title = 'Stop checking this field on ' + LT.siteHost;
    actions.appendChild(off);
    if (actions.childNodes.length) root.appendChild(actions);

    // Only the two best replacements, as buttons. A long list meant scanning
    // and scrolling; in practice the top suggestion is nearly always the
    // wanted one. Placed last so the corrections sit closest to the text.
    if (match.replacements?.length) {
      const list = div('lt-ext-pop-sug');
      for (const rep of match.replacements.slice(0, 2)) {
        const value = rep.value ?? '';
        const d = describeReplacement(value);
        const b = button('lt-ext-pop-item' + (d.ws ? ' lt-ext-ws' : ''), d.label, () => {
          LT.closePopup();
          LT.applyReplacement(s, match, value);
        });
        b.title = rep.shortDescription || d.label;
        list.appendChild(b);
      }
      root.appendChild(list);
    }

    // Keep focus (and the caret) in the field while interacting with the
    // popup; clicks still fire on the buttons.
    root.addEventListener('pointerdown', (e) => e.preventDefault());

    root.style.visibility = 'hidden';
    LT.root().appendChild(root);
    const pw = root.offsetWidth;
    const ph = root.offsetHeight;
    let top = anchor.top + anchor.height + 6;
    if (top + ph > window.innerHeight - 8) top = anchor.top - ph - 6;
    top = Math.max(8, top);
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - pw - 8));
    root.style.top = top + 'px';
    root.style.left = left + 'px';
    root.style.visibility = '';

    const onPointer = (e) => { if (!root.contains(e.target)) LT.closePopup(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); LT.closePopup(); }
    };
    const onScroll = (e) => { if (!root.contains(e.target)) LT.closePopup(); };
    const onFocus = (e) => { if (!root.contains(e.target) && e.target !== s.el) LT.closePopup(); };

    active = {
      root,
      cleanup: [() => {
        document.removeEventListener('pointerdown', onPointer, true);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('scroll', onScroll, { capture: true });
        document.removeEventListener('focusin', onFocus, true);
      }],
    };

    // Deferred so the click that opened the popup doesn't instantly close it.
    setTimeout(() => {
      if (active?.root !== root) return;
      document.addEventListener('pointerdown', onPointer, true);
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('scroll', onScroll, { capture: true, passive: true });
      document.addEventListener('focusin', onFocus, true);
    }, 0);
  };
})();
