// Orchestration. No MutationObserver, no page-wide scanning: an element is
// attached the first time it receives focus (document-level focusin), checks
// are debounced off its own input events, and only the handful of
// most-recently-edited elements keep live state.
'use strict';

(() => {
  if (LT.started) return;
  LT.started = true;

  const FIELD_TYPES = new Set(['', 'text', 'search']);
  const DEBOUNCE_MS = 500;
  const FOCUS_CHECK_MS = 250;
  const MAX_LIVE = 8;   // most-recently-used elements that keep highlights
  const MAX_TEXT = 20000; // check the tail of longer texts (where typing happens)

  const states = new Map(); // el -> state, in LRU order

  // --- element discovery ---

  function editableRoot(t) {
    if (!(t instanceof Element) || t.closest('#lt-ext-root')) return null;
    if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) {
      if (t instanceof HTMLInputElement &&
          !FIELD_TYPES.has((t.getAttribute('type') || '').toLowerCase())) return null;
      // spellcheck=false is the page opting out (also how code editors like
      // Monaco/CodeMirror mark their hidden inputs) — respect it.
      if (t.readOnly || t.disabled || t.spellcheck === false) return null;
      return t;
    }
    if (t.isContentEditable || t.getAttribute?.('contenteditable') === 'plaintext-only') {
      let el = t;
      while (el.parentElement?.isContentEditable) el = el.parentElement;
      if (el.spellcheck === false) return null;
      return el;
    }
    return null;
  }

  // --- state lifecycle ---

  function attach(el) {
    let s = states.get(el);
    if (s) {
      states.delete(el); // LRU bump
      states.set(el, s);
      return s;
    }
    const kind = (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) ? 'field' : 'ce';
    if (kind === 'ce' && !LT.ceSupported) return null;

    s = {
      el, kind,
      raw: [],        // matches as returned by the server
      matches: [],    // after local ignore/disable filtering
      rects: [],      // field: per-match content-coordinate rects
      ceRanges: [],   // ce: [{range, sev}] currently registered
      map: null,      // ce: text/node map the matches refer to
      seq: 0, timer: 0, lastChecked: null, detectedLanguage: null,
      raf: 0, scrollRaf: 0, ro: null,
    };
    s.onInput = (e) => onInput(s, e);
    s.onClick = (e) => onClick(s, e);
    el.addEventListener('input', s.onInput);
    el.addEventListener('click', s.onClick);

    if (kind === 'field') {
      LT.fieldOverlay.create(s);
      s.onScroll = () => syncScrollSoon(s);
      el.addEventListener('scroll', s.onScroll, { passive: true });
      s.ro = new ResizeObserver(() => refreshFieldSoon(s));
      s.ro.observe(el);
    } else {
      LT.adoptHighlightStyles(el.getRootNode());
    }

    states.set(el, s);
    while (states.size > MAX_LIVE) dispose(states.values().next().value);
    return s;
  }

  function dispose(s) {
    states.delete(s.el);
    clearTimeout(s.timer);
    s.seq++; // invalidate in-flight checks
    s.el.removeEventListener('input', s.onInput);
    s.el.removeEventListener('click', s.onClick);
    if (s.onScroll) s.el.removeEventListener('scroll', s.onScroll);
    s.ro?.disconnect();
    if (s.raf) cancelAnimationFrame(s.raf);
    if (s.scrollRaf) cancelAnimationFrame(s.scrollRaf);
    LT.fieldOverlay.remove(s);
    LT.ceClear(s);
  }

  // --- checking ---

  function textOf(s) {
    if (s.kind === 'field') return { text: s.el.value, map: null };
    const map = LT.ceBuildMap(s.el);
    return { text: map.text, map };
  }

  function scheduleCheck(s, delay) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => runCheck(s), delay);
  }

  function onInput(s, e) {
    LT.closePopup();
    // Field underlines are positioned against the old text — hide them until
    // the next check. CE ranges are live and track simple edits, keep them.
    if (s.kind === 'field') LT.fieldOverlay.clear(s);
    // Mid-IME-composition text is half-typed by definition; wait for the
    // committing input event (isComposing: false) before checking.
    if (e?.isComposing) {
      clearTimeout(s.timer);
      return;
    }
    scheduleCheck(s, DEBOUNCE_MS);
  }

  async function runCheck(s) {
    if (!s.el.isConnected) { dispose(s); return; }
    const { text, map } = textOf(s);
    if (text === s.lastChecked) return;

    const seq = ++s.seq;
    if (!text.trim()) {
      s.lastChecked = text;
      s.map = map;
      s.raw = [];
      s.detectedLanguage = null;
      applyMatches(s);
      return;
    }

    const clipped = text.length > MAX_TEXT;
    let resp;
    try {
      resp = await LT.checkText(clipped ? text.slice(-MAX_TEXT) : text);
    } catch {
      if (seq !== s.seq) return;
      // Server unreachable: clear stale marks, retry on the next input.
      s.lastChecked = null;
      s.raw = [];
      applyMatches(s);
      return;
    }
    if (seq !== s.seq) return;

    const shift = clipped ? text.length - MAX_TEXT : 0;
    s.lastChecked = text;
    s.map = map;
    s.detectedLanguage = resp.language?.detectedLanguage || null;
    s.raw = (resp.matches || []).map(m => (shift ? { ...m, offset: m.offset + shift } : m));
    applyMatches(s);
  }

  // Local filtering is instant (no server round-trip) when the user ignores
  // a word or disables a rule; the next real check also applies
  // disabledRules server-side.
  function applyMatches(s) {
    const text = s.lastChecked ?? '';
    const disabled = new Set(LT.settings.disabledRules);
    const ignored = new Set(LT.settings.ignoredWords.map(w => w.toLowerCase()));
    s.matches = s.raw.filter(m => {
      if (m.offset < 0 || m.offset + m.length > text.length) return false;
      if (m.rule && disabled.has(m.rule.id)) return false;
      return !ignored.has(text.slice(m.offset, m.offset + m.length).toLowerCase());
    });
    render(s);
  }

  function render(s) {
    if (s.kind === 'field') {
      LT.fieldOverlay.render(s, s.lastChecked ?? '');
    } else {
      const items = [];
      for (const m of s.matches) {
        const range = s.map && LT.ceRangeFor(s.map, m.offset, m.offset + m.length);
        if (range) items.push({ range, sev: LT.severity(m) });
      }
      LT.ceApply(s, items);
    }
  }

  // --- rAF-batched geometry updates ---

  function refreshFieldSoon(s) {
    if (s.raf) return;
    s.raf = requestAnimationFrame(() => {
      s.raf = 0;
      if (!s.el.isConnected) { dispose(s); return; }
      LT.fieldOverlay.render(s, s.lastChecked ?? '');
    });
  }

  function syncScrollSoon(s) {
    if (s.scrollRaf) return;
    s.scrollRaf = requestAnimationFrame(() => {
      s.scrollRaf = 0;
      LT.fieldOverlay.syncScroll(s);
    });
  }

  let repositionRaf = 0;
  function repositionAll() {
    if (repositionRaf) return;
    repositionRaf = requestAnimationFrame(() => {
      repositionRaf = 0;
      const dead = [];
      for (const s of states.values()) {
        if (!s.el.isConnected) { dead.push(s); continue; }
        if (s.kind === 'field') LT.fieldOverlay.position(s);
      }
      dead.forEach(dispose);
    });
  }

  // --- popup opening ---

  function onClick(s, e) {
    if (s.lastChecked == null || !s.matches.length) return;

    if (s.kind === 'field') {
      const el = s.el;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left - el.clientLeft + el.scrollLeft;
      const y = e.clientY - r.top - el.clientTop + el.scrollTop;
      for (let i = 0; i < s.matches.length; i++) {
        for (const seg of s.rects[i] || []) {
          if (x >= seg.left - 2 && x <= seg.left + seg.width + 2 &&
              y >= seg.top - 2 && y <= seg.top + seg.height + 2) {
            LT.showPopup(s, s.matches[i], {
              left: r.left + el.clientLeft + seg.left - el.scrollLeft,
              top: r.top + el.clientTop + seg.top - el.scrollTop,
              width: seg.width,
              height: seg.height,
            });
            return;
          }
        }
      }
      return;
    }

    const map = LT.ceBuildMap(s.el);
    if (map.text !== s.lastChecked) return; // stale — recheck is pending
    const pos = LT.cePosFromPoint(s.el, map, e.clientX, e.clientY);
    if (pos < 0) return;
    const m = s.matches.find(mm => pos >= mm.offset && pos <= mm.offset + mm.length);
    if (!m) return;
    const range = LT.ceRangeFor(map, m.offset, m.offset + m.length);
    const rect = range?.getBoundingClientRect();
    if (rect) LT.showPopup(s, m, rect);
  }

  // --- global wiring ---

  function considerTarget(t) {
    const el = editableRoot(t);
    if (!el) return;
    const s = attach(el);
    if (s) scheduleCheck(s, FOCUS_CHECK_MS); // runCheck no-ops if unchanged
  }

  document.addEventListener('focusin', (e) => {
    considerTarget(e.composedPath ? e.composedPath()[0] : e.target);
  }, true);

  if (document.activeElement && document.activeElement !== document.body) {
    considerTarget(document.activeElement);
  }

  document.addEventListener('scroll', () => {
    if (states.size) repositionAll();
  }, { capture: true, passive: true });

  // Clicks that toggle layout (accordions, tabs) move fields without any
  // scroll event; bubble phase runs after the page's own handlers.
  document.addEventListener('click', () => {
    if (states.size) repositionAll();
  });

  window.addEventListener('resize', () => {
    LT.closePopup();
    for (const s of states.values()) {
      if (s.kind === 'field') refreshFieldSoon(s);
    }
  });

  // Called by replace.js after applying a suggestion, because a framework
  // that consumes the synthetic beforeinput produces no native input event.
  // Redundant with the input listener on the other paths — the shared timer
  // dedupes.
  LT.afterEdit = (s) => onInput(s);

  LT.onSettingsChanged.push((keys) => {
    if (keys.includes('serverUrl') || keys.includes('language')) {
      for (const s of states.values()) {
        s.lastChecked = null;
        scheduleCheck(s, 100);
      }
    } else {
      for (const s of states.values()) applyMatches(s);
    }
  });
})();
