# Firefox Add-ons (AMO) submission

Dashboard: <https://addons.mozilla.org/developers/> (free). Package version:
**3.0.0**.

Firefox needs its own package: no extension service workers, an event page
instead, plus the Gecko add-on id and `strict_min_version`. That is the only
difference — `tools/build-firefox.mjs` writes it and rewrites nothing else.

## Package

```bash
cd /mnt/Data/www/chrome-extension/langtool-spellcheck
npm run build:firefox
rm -f /tmp/langtool-spellcheck-firefox-3.0.0.zip
cd dist/firefox && zip -r /tmp/langtool-spellcheck-firefox-3.0.0.zip . -x '*/.*' && cd -
unzip -l /tmp/langtool-spellcheck-firefox-3.0.0.zip   # check before uploading
```

The ZIP must have `manifest.json` at its root, not inside a directory — hence
zipping from inside `dist/firefox`.

Facts the form will ask about, all already in the built manifest:

| Field | Value |
| --- | --- |
| Add-on ID | `langtool-spellcheck@tito.bouzout` |
| `strict_min_version` | `128.0` |
| Applications | Firefox (desktop). Android is untested — leave it unchecked. |
| License | GPL-3.0-or-later (pick "GNU General Public License v3.0" from the list) |

Keep the add-on ID stable: `storage.sync` is keyed by it, and changing it
orphans every existing user's preferences.

## Listing

| Field | Value | Limit |
| --- | --- | --- |
| Name | `LanguageTool Spellcheck` | 50 |
| Summary | short description from `listing-copy.md` | 250 |
| Description | detailed description from `listing-copy.md`, with the Firefox requirement line (see below) | 15 000, limited HTML allowed |
| Categories | Language Support (primary), Privacy & Security (secondary) | 2 |
| Tags | `spellcheck`, `grammar`, `languagetool`, `self-hosted`, `privacy` | 10 |
| Homepage | `https://github.com/titoBouzout/language-tool-extension` | — |
| Support site | `https://github.com/titoBouzout/language-tool-extension/issues` | — |
| Privacy policy | paste the text of `privacy-policy.md` (**≠** AMO takes the text itself, not a URL) | — |
| Experimental | No | — |
| Requires payment | No | — |

Firefox requirement line for the description:

```
• Firefox 128 or newer. Underlines inside rich editors need the CSS Custom
  Highlight API, which Firefox shipped in 140; below that everything else still
  works and rich editors simply are not underlined.
```

AMO's description field accepts a little HTML but no headings; the plain-text
block with its `•` bullets renders fine as-is. Blank lines become paragraph
breaks.

### Images

AMO does not enforce screenshot dimensions, and it lists them at up to 1280
wide, so the same 1280×800 files are used unchanged:

| Slot | File |
| --- | --- |
| Add-on icon | `../icons/icon128.png` (128×128) |
| Screenshots (up to 10, with captions) | `screenshots/*.png` |

Order and captions:

1. `01-underlines-in-place.png` — "Mistakes are underlined as you type, in any field on any site."
2. `02-suggestion-popup.png` — "Click an underline for the explanation, the rule and the fixes."
3. `03-auto-correction.png` — "The wand pins a correction: that mistake is fixed silently from then on."
4. `04-rich-editor.png` — "Rich editors too — red for spelling, amber for grammar, blue for style."
5. `05-actions.png` — "Ignore a word, disable a rule, or stop checking one field."
6. `06-preferences.png` — "Your server, your language, your lists. No cloud, no account."

The promo tiles in `promo/` are not used by AMO; they exist for the Chromium
stores.

## Notes to the reviewer

AMO reviews read the code, so these notes matter more here than on the other
two stores. Paste:

```
Source: https://github.com/titoBouzout/language-tool-extension
(GPL-3.0-or-later). Nothing is minified, obfuscated, transpiled or bundled —
the files in this ZIP are the sources as written.

How the ZIP was produced, from a clean checkout at version 3.0.0:

    npm run build:firefox        # node tools/build-firefox.mjs
    cd dist/firefox && zip -r ../../langtool-spellcheck-firefox-3.0.0.zip .

That script copies background.js, content/, pages/ and icons/ verbatim and
translates only the manifest: the MV3 service worker becomes an event page
(background.scripts), minimum_chrome_version is dropped, and
browser_specific_settings.gecko adds the add-on id and strict_min_version 128.
Diffing dist/firefox against the repository root shows manifest.json as the
only difference.

TESTING. The extension deliberately has no cloud service, so it needs a
LanguageTool server. Either:

  • open the toolbar popup and set Server URL to https://api.languagetool.org
    (the public LanguageTool API; the extension normalises the URL and appends
    /v2/check itself), or
  • run: docker run -d -p 8010:8010 erikvl87/languagetool
    and leave the default http://localhost:8010.

Then type "I think its allmost ready" into any text field. After ~500 ms the
mistakes are underlined; click an underline for the suggestion popup. Note that
nothing is underlined until a field is focused or typed into — an element is
attached the first time it is focused or fires an input event, so a
freshly-loaded page shows nothing. The toolbar icon opens the preferences page.

WHAT THE PERMISSIONS ARE FOR

  • storage — the user's own preferences (server URL, language, ignored words,
    pinned auto-corrections, disabled rules) in storage.sync; the per-field
    disable list in storage.local because it is keyed by hostname and unbounded.
  • host_permissions *://*/* — the background page fetches the user-configured
    server URL, which may be any host (localhost by default), so it cannot be
    narrowed; and editable fields exist on any site, so the content script must
    be able to run there. No request is made to any host other than the
    configured server.

CODE NOTES A REVIEWER USUALLY ASKS ABOUT

  • No remote code, no eval, no new Function, no injected <script>. The
    dynamic import in content/boot.js loads a module from the extension's own
    moz-extension: origin (listed in web_accessible_resources), which is why
    only that one small file is injected per frame: the rest loads only if a
    frame actually holds an editable element.
  • The extension API binding is taken as `globalThis.browser ?? globalThis
    .chrome` in every file, because only `browser` returns promises in Firefox.
  • The page's own DOM is never modified. Plain fields are underlined in the
    extension's own overlay container; contenteditable is underlined with the
    CSS Custom Highlight API from Range objects (feature-detected, so nothing
    breaks below Firefox 140). Applying a suggestion goes through beforeinput /
    execCommand so undo and framework editors keep working.
  • Fields that structurally hold secrets are never read or sent: sensitive
    autocomplete values (passwords, one-time codes, card fields), inputmode
    numeric/tel/decimal, maxlength ≤ 8, and password/OTP/token/card/IBAN/SSN/PIN
    -looking names, ids, placeholders and labels.
  • spellcheck="false" is intentionally not honoured, because the attribute is
    inherited and one attribute on <body> would silence a whole site. The
    per-field opt-out is the popup's "Disable Here".
```

## Regenerating the assets

```bash
node marketplace/shots.mjs      # needs a LanguageTool server on :8010
```

The screenshots are taken in Chrome for Testing, because that is what the
harness drives; the UI is identical in Firefox apart from font rendering. If you
would rather ship Gecko-rendered screenshots, `npm run verify:firefox` writes
its own set (different framing, not store-sized).
