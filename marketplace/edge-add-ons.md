# Microsoft Edge Add-ons submission

Dashboard: <https://partner.microsoft.com/dashboard/microsoftedge> (registration
is free). Package version: **3.0.0**.

Edge is Chromium, and the Chrome package works unchanged — the same ZIP built in
`chrome-web-store.md` is what you upload here. The listing form differs from
Chrome's in a handful of places, marked **≠** below.

## Package

Same ZIP as Chrome:

```bash
cd /mnt/Data/www/chrome-extension/langtool-spellcheck
rm -f /tmp/langtool-spellcheck-chrome-3.0.0.zip
zip -r /tmp/langtool-spellcheck-chrome-3.0.0.zip \
  manifest.json background.js content pages icons LICENSE \
  -x '*/.*' '.*'
```

`minimum_chrome_version: "119"` is honoured by Edge as well, so no manifest
change is needed. There is no Edge-specific build.

## Properties

| Field | Value |
| --- | --- |
| Category | Productivity |
| Privacy policy URL | published location of `privacy-policy.md` — **required** |
| "Does your extension collect user data?" | Yes — see the disclosure below |
| Website | `https://github.com/titoBouzout/language-tool-extension` |
| Support contact | `https://github.com/titoBouzout/language-tool-extension/issues` |
| Mature content | No |
| Requires an account / login | No |

**≠ Data collection disclosure.** Edge asks in prose rather than with Chrome's
checkbox matrix. Paste:

```
The extension sends the text of the field the user is typing in to a
LanguageTool server whose URL the user enters in the extension's preferences
(by default http://localhost:8010, i.e. the user's own machine). That is the
only data transmitted, it goes only to that user-chosen endpoint, and it is
used only to return the check result. The developer receives nothing: there is
no backend, no analytics and no telemetry. Preferences are kept in extension
storage. Fields that structurally hold secrets — password, one-time-code and
card autocomplete values, numeric input modes, very short maxlengths, and
password-like names or labels — are never read.
```

## Availability

- Visibility: Public.
- Markets: all markets.
- Pricing: free.

## Store listing (per language: English (United States))

| Field | Value | Limit |
| --- | --- | --- |
| Display name | `LanguageTool Spellcheck` | 50 (**≠** shorter than Chrome's 75) |
| Short description | short description from `listing-copy.md` | 200 (**≠**) |
| Description | detailed description from `listing-copy.md`, requirement line `Edge 119 or newer.` | 10 000 (**≠**) |
| Search terms | the seven terms in `listing-copy.md` | **≠** 7 terms, ≤30 chars each |
| Store logo | `promo/logo-300x300.png` | **≠** 300×300 PNG, required |
| Small promotional tile (optional) | `promo/small-tile-440x280.png` | 440×280 |
| Large promotional tile (optional) | `promo/marquee-1400x560.png` | 1400×560 |
| Screenshots (1–10, at least 1) | `screenshots/*.png` | 1280×800 or 640×400 PNG |
| YouTube video | none | — |

**≠ Screenshot captions.** Unlike Chrome, Edge lets each screenshot carry a
caption. Suggested ones, in upload order:

1. `01-underlines-in-place.png` — "Mistakes are underlined as you type, in any field on any site."
2. `02-suggestion-popup.png` — "Click an underline for the explanation, the rule and the fixes."
3. `03-auto-correction.png` — "The wand pins a correction: that mistake is fixed silently from then on."
4. `04-rich-editor.png` — "Rich editors too — red for spelling, amber for grammar, blue for style."
5. `05-actions.png` — "Ignore a word, disable a rule, or stop checking one field."
6. `06-preferences.png` — "Your server, your language, your lists. No cloud, no account."

## Notes for certification

```
Testing the extension needs a LanguageTool server, because it deliberately has
no cloud service of its own. Two ways to get one:

  • Open the toolbar popup and set Server URL to https://api.languagetool.org
    (the public LanguageTool API; the extension normalises the URL and appends
    /v2/check itself), or
  • run: docker run -d -p 8010:8010 erikvl87/languagetool
    and leave the default server URL as it is.

Then type a sentence with a mistake into any text field, e.g. "I think its
allmost ready" — after about half a second the errors are underlined; clicking
an underline opens the suggestion popup.

Note that nothing is underlined until a field is focused or typed into: the
extension attaches to an element the first time it is focused or fires an input
event, so a page that has just loaded shows no underlines.

The broad host permission is needed because the server URL is the user's own
choice (any host, typically localhost) and because editable fields exist on any
site. No request is ever made to a host other than the configured server. No
remote code is loaded; everything runs from the package.

Source code, GPL-3.0-or-later:
https://github.com/titoBouzout/language-tool-extension
```

## Regenerating the assets

```bash
node marketplace/shots.mjs      # needs a LanguageTool server on :8010
```
