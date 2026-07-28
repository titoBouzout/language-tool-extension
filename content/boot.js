// The only file the manifest injects. Everything else is imported on demand
// the first time this frame sees an editable element, so the frames that make
// up most of a page (ads, trackers, pixels, players — none of which ever take
// text input) pay for this file and the stylesheet, nothing more.
'use strict';

(() => {
  // See background.js: Firefox's promise-based namespace is `browser`.
  const ext = globalThis.browser ?? globalThis.chrome;
  const LT = (globalThis.LT ??= {});
  if (LT.booted) return;
  LT.booted = true;

  // Elements noticed before the modules finished loading; main.js drains this
  // on startup. Deliberately coarse — main.js re-applies the real eligibility
  // rules (input types, sensitive fields, per-site and per-field disables).
  const pending = (LT.pending = new Set());

  const maybeEditable = (t) =>
    t instanceof Element &&
    (t instanceof HTMLTextAreaElement ||
      t instanceof HTMLInputElement ||
      t.isContentEditable ||
      t.getAttribute('contenteditable') === 'plaintext-only');

  let loading = false;
  function note(t) {
    if (!maybeEditable(t) || t.closest('#lt-ext-root')) return;
    pending.add(t);
    if (loading) return;
    loading = true;
    try {
      import(ext.runtime.getURL('content/index.js')).catch(giveUpOrRetry);
    } catch {
      giveUpOrRetry();
    }
  }

  // A transient load failure is worth retrying on the next event. An
  // invalidated context — the extension was reloaded or updated, orphaning
  // this frame — never recovers, so detach instead of retrying forever.
  function giveUpOrRetry() {
    let alive = false;
    try { alive = !!ext.runtime?.id; } catch { /* invalidated */ }
    if (alive) loading = false; else LT.bootDone();
  }

  const onEvent = (e) => note(e.composedPath ? e.composedPath()[0] : e.target);

  LT.bootDone = () => {
    document.removeEventListener('focusin', onEvent, true);
    document.removeEventListener('input', onEvent, true);
  };

  document.addEventListener('focusin', onEvent, true);
  document.addEventListener('input', onEvent, true);

  // A field can already be focused when we inject (run_at is document_end, and
  // pages restore focus on load). activeElement stops at a shadow host.
  let ae = document.activeElement;
  while (ae?.shadowRoot?.activeElement) ae = ae.shadowRoot.activeElement;
  if (ae && ae !== document.body) note(ae);
})();
