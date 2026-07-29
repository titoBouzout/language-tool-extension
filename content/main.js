// Orchestration. No page-wide scanning and no standing MutationObserver: an
// element is attached the first time it receives focus or dispatches an input
// event — both observed once each, at the document, in the capture phase.
// Checks are debounced off those input events, and only the handful of
// most-recently edited elements keep live state. (One observer does get
// attached, scoped to a single editable and for a few hundred ms at a time,
// while waiting for a controlled editor to commit an edit — see
// watchForSplice.)
const LT = (globalThis.LT ??= {});

// See background.js: Firefox's promise-based namespace is `browser`.
const ext = globalThis.browser ?? globalThis.chrome;

// Settings decide whether we may attach at all (global switch, per-site and
// per-field opt-outs) and which server to ask, so nothing happens until the
// first read resolves. boot.js keeps collecting candidates in the meantime.
await LT.settingsReady;

(() => {
  if (LT.started) return;
  LT.started = true;

  const FIELD_TYPES = new Set(['', 'text', 'search']);
  const DEBOUNCE_MS = 500;   // still inside a word: wait for it to be finished
  const BOUNDARY_MS = 150;   // the edit completed a word (space, punctuation, paste)
  const FIRST_CHECK_MS = 100; // nothing on screen yet for this element
  const SETTLE_MS = 900;     // typing stopped: the word at the caret is fair game
  const FOCUS_CHECK_MS = 250;
  const MAX_LIVE = 8;     // most-recently-used elements that keep highlights
  const MAX_TEXT = 20000; // check the tail of longer texts (where typing happens)
  const BOUNDARY_SCAN = 500;  // how far past the cut to look for a clean break
  const FRAGMENT_GUARD = 200; // matches dropped when no clean break was found
  const REANCHOR_MS = 800;    // how long to wait for an editor to commit our edit

  const states = new Map(); // el -> state, in LRU order
  let contextDead = false;

  // --- eligibility ---

  // Fields that structurally hold codes and secrets rather than prose.
  // Checking them is useless and would ship the value to the server.
  const SENSITIVE_AUTOCOMPLETE = /^(?:one-time-code|current-password|new-password|cc-(?:number|csc|exp|exp-month|exp-year|name|type)|username|email|tel|tel-.+|impp|url)$/;
  const SENSITIVE_HINT = /(?:^|[^a-z])(?:pass(?:word|wd|phrase)?|pwd|otp|totp|mfa|2fa|token|secret|api[-_ ]?key|cvv|cvc|csc|iban|swift|ssn|pin|routing|verification|security[-_ ]?code|card[-_ ]?number|credit[-_ ]?card|account[-_ ]?number)(?:$|[^a-z])/i;
  const NUMERIC_MODES = new Set(['numeric', 'tel', 'decimal']);

  function sensitiveField(el) {
    const ac = el.getAttribute('autocomplete');
    if (ac && ac.toLowerCase().split(/\s+/).some(t => SENSITIVE_AUTOCOMPLETE.test(t))) return true;
    if (NUMERIC_MODES.has((el.getAttribute('inputmode') || '').toLowerCase())) return true;
    // A field capped this short holds a code, a PIN or a postcode — never
    // something a grammar checker has an opinion about.
    if (el.maxLength > 0 && el.maxLength <= 8) return true;
    const hint = [el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label')]
      .filter(Boolean).join(' ');
    return !!hint && SENSITIVE_HINT.test(hint);
  }

  // Identifies one field on one site well enough for "Disable here" to stick
  // across reloads. Generated ids (React's ":r3:", hashes, long digit runs)
  // change on every mount, so those fall through to the structural path.
  const GENERATED_ID = /^:r|\d{4,}|[0-9a-f]{8}/i;

  LT.fieldKey = function (el) {
    const id = el.getAttribute('id');
    if (id && !GENERATED_ID.test(id)) return el.localName + '#' + id;
    const name = el.getAttribute('name');
    if (name) return el.localName + '[name=' + name + ']';
    const label = el.getAttribute('aria-label');
    if (label) return el.localName + '[aria=' + label.slice(0, 40) + ']';
    const path = [];
    for (let n = el; n && n.nodeType === Node.ELEMENT_NODE && path.length < 5; n = n.parentElement) {
      let i = 1;
      for (let p = n.previousElementSibling; p; p = p.previousElementSibling) {
        if (p.localName === n.localName) i++;
      }
      path.unshift(n.localName + ':' + i);
    }
    return path.join('>');
  };

  function fieldDisabled(el) {
    const keys = LT.settings.disabledFields[LT.siteHost];
    // fieldKey walks the DOM, so only pay for it on sites that have opt-outs.
    return !!keys?.length && keys.includes(LT.fieldKey(el));
  }

  function editableRoot(t) {
    if (contextDead || LT.siteDisabled()) return null;
    if (!(t instanceof Element) || t.closest('#lt-ext-root')) return null;
    if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) {
      if (t instanceof HTMLInputElement &&
          !FIELD_TYPES.has((t.getAttribute('type') || '').toLowerCase())) return null;
      // spellcheck="false" is deliberately ignored. It is an inherited
      // attribute, so the single `<body spellcheck=false>` that pages use to
      // suppress the browser's native squiggles would silence LanguageTool
      // across the whole site. The popup's "Disable here" is the opt-out.
      if (t.readOnly || t.disabled || sensitiveField(t)) return null;
      return fieldDisabled(t) ? null : t;
    }
    if (t.isContentEditable || t.getAttribute?.('contenteditable') === 'plaintext-only') {
      let el = t;
      while (el.parentElement?.isContentEditable) el = el.parentElement;
      return fieldDisabled(el) ? null : el;
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
      seq: 0, timer: 0, retryMs: 0, lastChecked: null,
      raf: 0, ro: null,
      typing: false, settle: 0, // see caretWord: hide errors in the word being typed
      splice: null,   // edit we are about to make ourselves (see reanchor)
      recheck: false, // ask the server even though lastChecked matches
      mo: null, moTimer: 0, // waiting for a controlled editor to apply that edit
      clipboard: 0,   // paste/cut/drop that may never fire an input event
    };

    if (kind === 'field') {
      LT.fieldOverlay.create(s);
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
    clearTimeout(s.clipboard);
    clearTimeout(s.settle);
    s.seq++; // invalidate in-flight checks
    s.ro?.disconnect();
    stopWatching(s);
    if (s.raf) cancelAnimationFrame(s.raf);
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
    if (contextDead) return;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => runCheck(s), delay);
  }

  // How long to wait before asking the server, decided from the edit itself
  // rather than from a single fixed debounce. A keystroke that ends inside a
  // word means the word isn't finished, so waiting is what avoids flagging a
  // half-typed one; anything that closes a word (space, punctuation, newline,
  // paste, a suggestion we applied) is checkable straight away, and the very
  // first check on an element is as fast as we can make it because until it
  // lands the field shows nothing at all.
  const WORD_CHAR = /[\p{L}\p{N}'’]/u;

  function typingDelay(s, e) {
    if (s.lastChecked == null) return FIRST_CHECK_MS;
    if (!e) return BOUNDARY_MS; // programmatic edit, not someone mid-word
    if (e.inputType?.startsWith('delete')) return DEBOUNCE_MS;
    const d = e.data;
    if (d == null) return BOUNDARY_MS; // paste, newline, drop, autocomplete
    return WORD_CHAR.test(d[d.length - 1]) ? DEBOUNCE_MS : BOUNDARY_MS;
  }

  // Offset of a collapsed caret in the text we check, or -1. A selection isn't
  // a caret and doesn't mark a word as in progress.
  function caretOffset(s) {
    if (s.kind === 'field') {
      if (s.el.selectionStart == null || s.el.selectionStart !== s.el.selectionEnd) return -1;
      return s.el.selectionStart;
    }
    const rootNode = s.el.getRootNode();
    const sel = rootNode instanceof ShadowRoot && rootNode.getSelection
      ? rootNode.getSelection()
      : window.getSelection();
    if (!sel?.isCollapsed || !sel.anchorNode || !s.el.contains(sel.anchorNode)) return -1;
    return LT.cePos(s.map || LT.ceBuildMap(s.el), sel.anchorNode, sel.anchorOffset);
  }

  // The word the caret sits in or against, while typing is still going on.
  // Debouncing alone can't fix "it corrects words I haven't finished": however
  // long the wait, the check can always land on a word one keystroke short of
  // complete, and short waits are exactly what makes the rest of the text
  // feel responsive. So keep the checks quick and drop the matches that touch
  // this word instead; the settle timer in onInput brings them back a beat
  // after the typing stops.
  function caretWord(s, text) {
    const pos = caretOffset(s);
    if (pos < 0 || pos > text.length) return null;
    let a = pos, b = pos;
    while (a > 0 && WORD_CHAR.test(text[a - 1])) a--;
    while (b < text.length && WORD_CHAR.test(text[b])) b++;
    return a === b ? null : [a, b];
  }

  // Applying a suggestion is the one edit whose effect on the text we know
  // up front: `value` spliced over [start, end). Shifting the matches that
  // survive it keeps every other underline on screen — and drops the
  // corrected one at once — instead of blanking the field and painting the
  // same marks again a round-trip later. False when the live text isn't what
  // we predicted (the page rewrote it, or applied the edit asynchronously);
  // the caller then falls back to clearing.
  function reanchor(s, { start, end, value }) {
    if (s.lastChecked == null) return false;
    const next = s.lastChecked.slice(0, start) + value + s.lastChecked.slice(end);
    if (s.kind === 'ce') LT.ceInvalidateMap();
    const { text, map } = textOf(s);
    if (text !== next) return false;
    const delta = value.length - (end - start);
    s.lastChecked = next;
    s.map = map;
    s.raw = s.raw.flatMap(m =>
      m.offset + m.length <= start ? [m] :
      m.offset >= end ? [{ ...m, offset: m.offset + delta }] :
      []); // touches the replaced span: whatever it flagged is gone
    // These offsets are guesswork until the server has seen the new text, and
    // lastChecked now equals it — force the pending check through anyway.
    s.recheck = true;
    applyMatches(s);
    return true;
  }

  function stopWatching(s) {
    s.mo?.disconnect();
    s.mo = null;
    clearTimeout(s.moTimer);
    s.moTimer = 0;
  }

  // A controlled editor (Slate — Discord, Lexical, Draft) doesn't apply the
  // edit when we announce it: it takes it into its own model and re-renders
  // from there, in React's case a tick or two later. So the re-anchor above
  // ran against the pre-edit DOM and failed — and once that render lands it
  // replaces the very text nodes the highlight ranges point at, which is what
  // makes every mark in the field disappear until the recheck comes back.
  // Wait for the text we predicted to show up instead. MutationObserver
  // callbacks run as microtasks, so re-anchoring here happens in the same
  // frame as the editor's own render and nothing blinks.
  function watchForSplice(s, splice) {
    stopWatching(s);
    const from = s.lastChecked;
    const attempt = () => {
      // A real check landing first supersedes what we predicted.
      if (s.lastChecked !== from || !s.el.isConnected || reanchor(s, splice)) stopWatching(s);
    };
    s.mo = new MutationObserver(attempt);
    s.mo.observe(s.el, { subtree: true, childList: true, characterData: true });
    // Editor did something else with the edit: give up and let the recheck
    // repaint from the server.
    s.moTimer = setTimeout(() => stopWatching(s), REANCHOR_MS);
  }

  function onInput(s, e) {
    LT.closePopup();
    // The input event a paste normally fires got here first: the pending
    // clipboard fallback below has nothing left to do.
    clearTimeout(s.clipboard);
    s.clipboard = 0;
    const splice = s.splice;
    s.splice = null;
    let kept = false;
    if (splice) {
      kept = reanchor(s, splice);
      if (!kept && s.kind === 'ce') watchForSplice(s, splice);
    }
    // Field underlines are positioned against the text they were measured
    // against — hide them until the next check once it changes. CE ranges are
    // live and track simple edits, keep them.
    if (!kept && s.kind === 'field' && s.el.value !== s.lastChecked) {
      LT.fieldOverlay.clear(s);
    }
    // Mid-IME-composition text is half-typed by definition; wait for the
    // committing input event (isComposing: false) before checking.
    if (e?.isComposing) {
      clearTimeout(s.timer);
      return;
    }
    // Typing is in progress until it has been quiet for a beat; while it is,
    // whatever word the caret is in stays unflagged.
    s.typing = true;
    clearTimeout(s.settle);
    s.settle = setTimeout(() => {
      s.settle = 0;
      s.typing = false;
      if (s.lastChecked != null) applyMatches(s);
    }, SETTLE_MS);
    scheduleCheck(s, typingDelay(s, e));
  }

  // Only the tail of a very long text is checked — that is where typing
  // happens. Cutting at a fixed offset lands mid-word and makes LanguageTool
  // report errors on the fragment it now starts with, so prefer a paragraph,
  // then a line, then a sentence boundary. When only a word boundary is
  // available, distrust the matches in what is left of the first sentence.
  function tailWindow(text) {
    if (text.length <= MAX_TEXT) return { slice: text, shift: 0, guard: 0 };
    const cut = text.length - MAX_TEXT;
    const probe = text.slice(cut, cut + BOUNDARY_SCAN);

    let rel = -1;
    const para = probe.indexOf('\n\n');
    const line = probe.indexOf('\n');
    if (para >= 0) rel = para + 2;
    else if (line >= 0) rel = line + 1;
    else {
      const sentence = /[.!?]["'”’)\]]?\s+/.exec(probe);
      if (sentence) rel = sentence.index + sentence[0].length;
    }
    if (rel >= 0) return { slice: text.slice(cut + rel), shift: cut + rel, guard: 0 };

    const ws = /\s/.exec(probe);
    const at = cut + (ws ? ws.index + 1 : 0);
    return { slice: text.slice(at), shift: at, guard: FRAGMENT_GUARD };
  }

  // Reloading or updating the extension orphans every already-injected frame:
  // chrome.runtime is gone and every later message rejects identically. Left
  // alone, the backoff below would keep firing in every frame of every open
  // tab for as long as they stay open.
  function orphaned(err) {
    let alive = false;
    try { alive = !!ext.runtime?.id; } catch { /* invalidated */ }
    if (alive && !/context invalidated/i.test(err?.message || '')) return false;
    contextDead = true;
    LT.closePopup();
    for (const s of [...states.values()]) dispose(s);
    return true;
  }

  async function runCheck(s) {
    if (contextDead) return;
    if (!s.el.isConnected) { dispose(s); return; }
    const { text, map } = textOf(s);
    if (text === s.lastChecked && !s.recheck) {
      // The events that led here may net out to no text change (undo, a
      // framework re-render with identical text) — but they already hid the
      // field overlay (onInput clears it) or replaced the CE text nodes the
      // highlight ranges point at. Repaint instead of bailing.
      s.map = map;
      applyMatches(s);
      return;
    }
    s.recheck = false;

    const seq = ++s.seq;
    if (!text.trim()) {
      s.lastChecked = text;
      s.map = map;
      s.raw = [];
      applyMatches(s);
      return;
    }

    const win = tailWindow(text);
    let resp;
    try {
      resp = await LT.checkText(win.slice);
    } catch (err) {
      if (seq !== s.seq) return;
      if (orphaned(err)) return;
      // Server unreachable: clear stale marks and retry with backoff, so
      // highlights come back without requiring another keystroke.
      s.lastChecked = null;
      s.raw = [];
      applyMatches(s);
      s.retryMs = Math.min((s.retryMs || 1000) * 2, 16000);
      // Nobody is watching a hidden tab, and retrying there just keeps every
      // background tab polling a server that is down. visibilitychange resumes.
      if (!document.hidden) scheduleCheck(s, s.retryMs);
      return;
    }
    if (seq !== s.seq) return;
    s.retryMs = 0;

    s.lastChecked = text;
    s.map = map;
    s.raw = (resp.matches || [])
      .filter(m => m.offset >= win.guard)
      .map(m => (win.shift ? { ...m, offset: m.offset + win.shift } : m));
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
    const word = s.typing ? caretWord(s, text) : null;
    if (word) {
      s.matches = s.matches.filter(m => m.offset >= word[1] || m.offset + m.length <= word[0]);
    }
    render(s);
  }

  function render(s) {
    if (s.kind === 'field') {
      LT.fieldOverlay.render(s, s.lastChecked ?? '');
    } else {
      // s.map was built before the server round-trip; a framework re-render
      // during the await (Slate/Discord re-parse) leaves its nodes detached
      // and the highlights invisible. Re-anchor against the live DOM — the
      // await drained the microtask queue, so this is a genuine rebuild.
      const map = LT.ceBuildMap(s.el);
      if (s.lastChecked != null && map.text !== s.lastChecked) {
        // Text changed under us with no input event — the matches don't
        // apply anymore; get a fresh check instead of painting garbage.
        scheduleCheck(s, DEBOUNCE_MS);
        return;
      }
      s.map = map;
      const items = [];
      for (const m of s.matches) {
        const range = LT.ceRangeFor(map, m.offset, m.offset + m.length);
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

  let repositionRaf = 0;
  function repositionAll() {
    if (repositionRaf) return;
    repositionRaf = requestAnimationFrame(() => {
      repositionRaf = 0;
      const dead = [];
      for (const s of states.values()) {
        if (!s.el.isConnected) { dead.push(s); continue; }
        if (s.kind === 'field') {
          LT.fieldOverlay.position(s);
          // The document-level scroll listener also fires for the field's own
          // scrollbar, so the inner layer is re-synced from here too.
          LT.fieldOverlay.syncScroll(s);
        }
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
            LT.showPopup(s, s.matches[i], { x: e.clientX, y: e.clientY });
            return;
          }
        }
      }
      return;
    }

    const map = LT.ceBuildMap(s.el);
    if (map.text !== s.lastChecked) {
      // Stale, and if the change came from a silent framework re-render no
      // input event ever scheduled the recheck — do it here.
      scheduleCheck(s, FOCUS_CHECK_MS);
      return;
    }
    const pos = LT.cePosFromPoint(s.el, map, e.clientX, e.clientY);
    if (pos < 0) return;
    const m = s.matches.find(mm => pos >= mm.offset && pos <= mm.offset + mm.length);
    if (!m) return;
    LT.showPopup(s, m, { x: e.clientX, y: e.clientY });
  }

  // --- global wiring ---

  const pathTarget = (e) => (e.composedPath ? e.composedPath()[0] : e.target);

  function considerTarget(t) {
    const el = editableRoot(t);
    if (!el) return;
    const s = attach(el);
    // runCheck no-ops if unchanged; focusing something never checked before
    // is the one case where the wait is visible, so keep it short.
    if (s) scheduleCheck(s, s.lastChecked == null ? FIRST_CHECK_MS : FOCUS_CHECK_MS);
  }

  // One document-level listener per event type, rather than three per attached
  // element. Fewer registrations, and — because these run in the capture phase
  // above anything the page installs on an ancestor — they still fire on pages
  // that stop input/click events before they reach the field.
  document.addEventListener('focusin', (e) => considerTarget(pathTarget(e)), true);

  // Input is a discovery signal too: mirror/autofill patterns edit fields that
  // never get focus, and an element focused before injection never produced a
  // focusin we could see. This also LRU-bumps the element being edited so
  // active fields aren't evicted while in use.
  document.addEventListener('input', (e) => {
    const el = editableRoot(pathTarget(e));
    if (!el) return;
    const s = attach(el);
    if (s) onInput(s, e);
  }, true);

  document.addEventListener('scroll', () => {
    if (states.size) repositionAll();
  }, { capture: true, passive: true });

  // --- text that changes with no input event to debounce off ---

  // Compare the live text against what we last checked and treat any
  // difference as input.
  function revalidate(s) {
    if (s.lastChecked == null || !s.el.isConnected) return;
    const now = s.kind === 'field' ? s.el.value : LT.ceBuildMap(s.el).text;
    if (now !== s.lastChecked) onInput(s);
  }

  // A click can be a Send button clearing the field programmatically — after a
  // beat, revalidate everything live, so stale marks go away.
  let revalidateTimer = 0;
  function revalidateSoon() {
    clearTimeout(revalidateTimer);
    revalidateTimer = setTimeout(() => {
      for (const s of states.values()) revalidate(s);
    }, FOCUS_CHECK_MS);
  }

  // A paste is only sometimes an input event. Editors that own their content
  // (Slate, ProseMirror, Lexical, Quill) and fields whose framework handles
  // onPaste cancel the event and insert the clipboard through their own model
  // instead, and the DOM they then render carries no input event at all — the
  // same way a cut or a drop they handle themselves doesn't. This listener
  // runs before the page's own, so all it can do is arm a fallback and look
  // again once that model has rendered. A native paste does fire input, and
  // onInput disarms the fallback on the way through, so the common path keeps
  // its usual debounce and nothing is scheduled twice.
  function onClipboardEdit(e) {
    const el = editableRoot(pathTarget(e));
    if (!el) return;
    const s = attach(el);
    if (!s || s.clipboard) return;
    s.clipboard = setTimeout(() => {
      s.clipboard = 0;
      // Nothing checked yet means the first check is still in flight and will
      // land with the pre-paste text — queue another one behind it.
      if (s.lastChecked == null) scheduleCheck(s, DEBOUNCE_MS);
      else revalidate(s);
    }, FOCUS_CHECK_MS);
  }

  for (const type of ['paste', 'cut', 'drop']) {
    document.addEventListener(type, onClipboardEdit, true);
  }

  // Capture, like the others, so a page that stops click propagation on an
  // ancestor can't make underlines unclickable. Our own popup is excluded by
  // editableRoot's #lt-ext-root check rather than by phase. Clicks that toggle
  // layout (accordions, tabs) move fields without producing a scroll event —
  // repositionAll is rAF-batched, so it still lands after the page's own
  // handlers have run and changed the layout.
  document.addEventListener('click', (e) => {
    if (!states.size) return;
    repositionAll();
    revalidateSoon();
    const el = editableRoot(pathTarget(e));
    const s = el && states.get(el);
    if (s) onClick(s, e);
  }, true);

  // Chat apps consume Enter to send, then clear the input programmatically —
  // again no input event. Revalidate the element shortly after; if Enter
  // just typed a newline, the resulting input event re-debounces normally.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !states.size) return;
    const el = editableRoot(pathTarget(e));
    const s = el && states.get(el);
    if (s) scheduleCheck(s, FOCUS_CHECK_MS);
  }, true);

  window.addEventListener('resize', () => {
    LT.closePopup();
    for (const s of states.values()) {
      if (s.kind === 'field') refreshFieldSoon(s);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    for (const s of states.values()) if (s.retryMs) scheduleCheck(s, 100);
  });

  // Called by replace.js after applying a suggestion, because a framework
  // that consumes the synthetic beforeinput produces no native input event.
  // Redundant with the input listener on the other paths — the shared timer
  // dedupes.
  LT.afterEdit = (s) => onInput(s);

  const RECHECK_KEYS = new Set(['serverUrl', 'language', 'preferredVariants', 'motherTongue', 'level']);

  LT.onSettingsChanged.push((keys) => {
    // An element that just became ineligible (extension switched off, site or
    // field disabled) has to lose its state and its marks right away.
    if (keys.some(k => k === 'enabled' || k === 'disabledSites' || k === 'disabledFields')) {
      LT.closePopup();
      for (const s of [...states.values()]) {
        if (editableRoot(s.el) !== s.el) dispose(s);
      }
    }
    if (keys.some(k => RECHECK_KEYS.has(k))) {
      for (const s of states.values()) {
        s.lastChecked = null;
        scheduleCheck(s, 100);
      }
    } else {
      for (const s of states.values()) applyMatches(s);
    }
  });

  // Anything boot.js saw while the modules were loading.
  for (const t of LT.pending || []) considerTarget(t);
  LT.pending = null;
  LT.bootDone?.();
})();
