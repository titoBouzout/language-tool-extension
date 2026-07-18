---
name: verify
description: Drive the extension end-to-end in headless Chrome for Testing against the local LanguageTool server and assert the check → underline → popup → replace flows.
---

# Verify the extension

```bash
node .claude/skills/verify/smoke.mjs [screenshot-dir]
```

Exit 0 = all steps passed; prints one PASS/FAIL line per step plus collected
page console errors, and writes screenshots (underlines, popups, prefs page).

## Prerequisites

- LanguageTool server running on `http://localhost:8010`
  (`curl -sf localhost:8010/v2/languages` to confirm).
- Chrome for Testing in puppeteer's cache. One-time:
  `npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer`
- `npm install` (puppeteer-core is a devDependency).

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
