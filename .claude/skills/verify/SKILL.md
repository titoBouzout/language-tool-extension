---
name: verify
description: Drive the extension end-to-end in headless Chrome for Testing (and, for the Gecko-specific parts, real Firefox) against the local LanguageTool server and assert the check → underline → popup → replace flows.
---

# Verify the extension

```bash
node .claude/skills/verify/smoke.mjs [screenshot-dir]          # Chrome, full suite
npm run verify:firefox                                          # Firefox, Gecko-specific parts
```

Exit 0 = all steps passed; prints one PASS/FAIL line per step plus collected
page console errors, and writes screenshots (underlines, popups, prefs page).

## Prerequisites

- LanguageTool server running on `http://localhost:8010`
  (`curl -sf localhost:8010/v2/languages` to confirm).
- Chrome for Testing in puppeteer's cache. One-time:
  `npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer`
- `npm install` (puppeteer-core is a devDependency).
- For the Firefox run: a `firefox` on PATH (or `FIREFOX_BIN=…`). It drives
  `dist/firefox`, so `npm run build:firefox` must have run — the npm script
  does it.

## Gotchas learned the hard way

- **Branded Google Chrome cannot load unpacked extensions since v137** —
  `--load-extension` is silently ignored and CDP `installExtension()` returns
  an ID but the extension never runs (`ERR_BLOCKED_BY_CLIENT` on its own
  pages, content scripts never inject). Only Chrome for Testing works.
- Content scripts don't run on `file://` by default — the harness serves
  `test.html` over a loopback HTTP server.
- Underline segments are `pointer-events: none` by design; to open the
  suggestion popup, click at the segment's screen coordinates so the event
  lands on the field beneath.
- Each run uses a fresh temp profile, so `chrome.storage` starts empty.
- Pick test sentences with exactly the matches you assert on: LanguageTool
  also flags things like lowercase sentence starts, which shifts segment
  indexes (that once made an "ignore word" assertion grab the wrong match).
- **Only `content/boot.js` is injected by the manifest.** The rest is
  dynamically imported the first time a frame sees an editable, so nothing
  exists until something is focused — wait for that before asserting on
  `#lt-ext-root`, `.lt-ext-seg` or `CSS.highlights`.
- **`use_dynamic_url` must stay off** for `content/*.js` in
  `web_accessible_resources`. A dynamic URL applies only to the entry point;
  the relative imports inside it resolve back to the static paths, which are
  then blocked ("Resources must be listed in the web_accessible_resources
  manifest key") and the extension silently does nothing.
- `spellcheck="false"` is deliberately **not** honoured (it is inherited, so
  one attribute on `<body>` used to silence the whole site). The per-field
  opt-out is the popup's "Disable here", stored in `chrome.storage.local`
  under `disabledFields`.
- Rows toggled with the `hidden` attribute need `[hidden] { display: none }`
  in popup.css — they carry `display: flex`, which beats the UA stylesheet.
- Server-option steps (preferredVariants, picky) drive `chrome.storage` from
  the prefs page and rely on the content script's own re-check on change;
  allow ~2.5s to settle.

## Firefox-specific gotchas

- **The extension API binding cannot be called `chrome`.** Every file takes it
  as `const ext = globalThis.browser ?? globalThis.chrome` — Firefox only
  returns promises from `browser`, its `chrome` alias is callback-only. Naming
  the binding `chrome` looks tidier and breaks Chrome outright: a top-level
  lexical declaration collides with the non-configurable global, so the
  service worker and the prefs page fail to parse and *every* step fails at
  once with no console error to show for it.
- **WebDriver BiDi refuses to navigate a tab to `moz-extension:`**
  ("unsupported operation"), and web content may not link to one either
  (`Location.href setter: Access … denied`) — extension pages are not
  web-accessible. The prefs page can only be opened from inside the extension,
  so the harness installs a throwaway copy of `dist/firefox` with one appended
  `ext.tabs.create(…)` line in `background.js`.
- Puppeteer reports an extension tab's URL as `about:blank`; find it by
  evaluating `location.href` in each page.
- `browser.installExtension()` takes the built directory, and Firefox 127+
  grants the manifest's host permissions on install, so no permission prompt
  has to be dismissed.
- Each run is a fresh temp profile, so `storage.sync` starts empty — the same
  assumption the Chrome suite makes.
