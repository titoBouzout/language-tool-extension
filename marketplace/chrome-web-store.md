# Chrome Web Store submission

Dashboard: <https://chrome.google.com/webstore/devconsole> (one-time $5
developer registration fee). Package version: **3.0.0**.

## Store listing tab

| Field | Value | Limit |
| --- | --- | --- |
| Name | `LanguageTool Spellcheck` (taken from `manifest.json`) | 75 |
| Summary | short description from `listing-copy.md` | 132 |
| Description | detailed description from `listing-copy.md`, with the Chrome requirement line (`Chrome 119 or newer.`) | 16 000 |
| Category | Productivity → Workflow & Planning | — |
| Language | English (United States) | — |
| Homepage URL | `https://github.com/titoBouzout/language-tool-extension` | — |
| Support URL | `https://github.com/titoBouzout/language-tool-extension/issues` | — |
| Mature content | No | — |

### Graphic assets

| Slot | Required size | File |
| --- | --- | --- |
| Store icon | 128×128 PNG | `../icons/icon128.png` |
| Screenshots (1–5, at least 1) | 1280×800 or 640×400 PNG | `screenshots/*.png` |
| Small promo tile | 440×280 PNG | `promo/small-tile-440x280.png` |
| Marquee promo tile (optional) | 1400×560 PNG | `promo/marquee-1400x560.png` |

Screenshots must be exactly 1280×800 with no padding, no rounded corners and no
alpha; the generated files already are. Upload them in this order — the first
one is the listing's hero:

1. `01-underlines-in-place.png` — mistakes underlined while composing an email.
2. `02-suggestion-popup.png` — the popup: explanation, rule, suggestions, actions.
3. `03-auto-correction.png` — the wand half of the top suggestion (fix it forever).
4. `04-rich-editor.png` — a rich editor, all three underline colours at once.
5. `06-preferences.png` — the toolbar preferences.

(`05-actions.png` is a sixth candidate — a grammar match in a comment box — if
you would rather lead with that than with the rich editor. Chrome accepts five.)

## Privacy tab

**Single purpose description** — the statement in `listing-copy.md`.

**Permission justifications:**

- `storage`

  ```
  Stores the user's own preferences: the LanguageTool server URL, language and
  preferred variants, native language, picky mode, the global and per-site
  on/off switches, and the user's lists of ignored words, pinned
  auto-corrections, disabled rules and disabled fields. No other data is
  stored, and nothing is sent anywhere.
  ```

- Host permissions (`*://*/*`)

  ```
  Two things need it. (1) The text being checked is sent by the background
  worker to the LanguageTool server URL that the user enters in preferences —
  typically http://localhost:8010, but it may be any host on their LAN or their
  own instance anywhere, so the host cannot be known at build time and cannot
  be narrowed. (2) Editable fields exist on any website, so the content script
  has to be able to run there; the user controls where with the global switch,
  "Disable on this site" and per-field "Disable Here". No request is made to
  any host other than the configured server.
  ```

- Content script on `<all_urls>` (declared in the manifest)

  ```
  Spelling and grammar checking is only useful where the user types, and that
  is any site. The manifest injects one small file per frame, which loads the
  rest only if that frame actually contains an editable element.
  ```

**Remote code:** No, I am not using remote code. Everything executed ships in
the package; the server is a data endpoint (JSON over HTTP), not a code source.

**Data usage — what the extension collects:**

- ☑ **Website content** — the text of the field the user is typing in, sent to
  the user's own configured LanguageTool server so that it can be checked.
- Everything else unchecked: no personally identifiable information, no health
  information, no financial or payment information, no authentication
  information, no personal communications beyond the field text itself, no
  location, no web history, no user activity.

  Fields that structurally hold secrets (password/OTP/card `autocomplete`,
  numeric input modes, short `maxlength`, password-like names and labels) are
  never read, which is why the authentication and financial categories are not
  checked.

**Certifications (all three must be checked):**

- I do not sell or transfer user data to third parties, apart from the approved
  use cases.
- I do not use or transfer user data for purposes that are unrelated to my
  item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for
  lending purposes.

**Privacy policy URL:** the published location of `privacy-policy.md`.

## Building the upload package

Chrome takes a ZIP of the extension root. Everything the manifest can reach is
`manifest.json`, `background.js`, `content/`, `pages/` and `icons/` — the
repository's development files must not be in it:

```bash
cd /mnt/Data/www/chrome-extension/langtool-spellcheck
rm -f /tmp/langtool-spellcheck-chrome-3.0.0.zip
zip -r /tmp/langtool-spellcheck-chrome-3.0.0.zip \
  manifest.json background.js content pages icons LICENSE \
  -x '*/.*' '.*'
unzip -l /tmp/langtool-spellcheck-chrome-3.0.0.zip   # check before uploading
```

The same ZIP is what Edge takes (see `edge-add-ons.md`).

## Notes for the review

- Reviewers need a server to see it work. Either of these gets them there:
  point **Server URL** at `https://api.languagetool.org` (the public
  LanguageTool API — the extension normalises the URL and appends `/v2/check`
  itself), or run `docker run -d -p 8010:8010 erikvl87/languagetool` and leave
  the default.
- Nothing is underlined until a field is focused or typed in — the extension
  attaches to an element the first time it is focused or fires an input event,
  by design, so a freshly loaded page shows nothing.
- First review of a new extension with broad host permissions usually takes
  longer than an update. Expect days, not hours.

## Regenerating the assets

```bash
node marketplace/shots.mjs      # needs a LanguageTool server on :8010
```

See `README.md` in this directory for what that script does and its
prerequisites.
