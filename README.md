# LanguageTool Spellcheck

A Chrome and Firefox extension that spell- and grammar-checks what you type on
any page, using **your own LanguageTool server** — by default one running on
`http://localhost:8010`. Nothing is sent to a cloud service, no account, no
telemetry.

Errors are underlined in place; clicking one opens a popup with LanguageTool's
message, its suggested replacements, and the rule behind it.

Underlines are colour-coded: red for spelling, amber for grammar, blue for
style and register.

## Requirements

- Chrome 119 or newer, or Firefox 128 or newer. contenteditable support needs
  the CSS Custom Highlight API, which Firefox only shipped in 140; below that
  everything else still works, rich editors just aren't underlined.
- A LanguageTool server you can reach over HTTP.

## Setting up the server

Download the standalone package from
[languagetool.org/download](https://languagetool.org/download/) and run:

```bash
java -cp languagetool-server.jar org.languagetool.server.HTTPServer --port 8010
```

Or with the community Docker image:

```bash
docker run -d --name languagetool -p 8010:8010 -e Java_Xms=512m -e Java_Xmx=2g erikvl87/languagetool
```

Confirm it answers:

```bash
curl -sf localhost:8010/v2/languages | head -c 200
```

Any port works — set it under **Server URL** in the extension's preferences.
Requests are made by the extension's background worker, which holds the host
permission, so the server does not need CORS flags.

## Installing the extension

In Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** → pick this directory.

In Firefox, build the Gecko-flavoured copy first — Firefox has no extension
service workers and needs its own `manifest.json`, which is the only difference
between the two:

```bash
npm run build:firefox
```

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on** → pick `dist/firefox/manifest.json`.

Temporary add-ons are dropped when Firefox exits; re-run the build and load it
again after changing the sources.

## Using it

Type in any text field, textarea or rich editor. Checks are debounced ~500 ms
after you stop typing.

Click an underline to open the suggestion popup:

- pick one of the two suggested replacements to apply it — the edit goes through
  the browser's editing pipeline, so undo still works and frameworks see it as a
  normal change;
- **Ignore** — never flag that word again (stored in your profile);
- **Disable Rule** — turn off that LanguageTool rule everywhere;
- **Disable Here** — stop checking this one field on this one site.

The toolbar icon opens preferences: the global on/off switch, "Disable on
*site*", server URL, language (or auto-detect), preferred variants, native
language for false-friend detection, picky mode, and the lists of ignored
words, disabled rules and disabled fields — each removable.

Preferences live in `storage.sync` and follow your browser profile. The
per-field disable list is keyed by hostname and can grow without bound, so it
lives in `storage.local` instead.

## Privacy

The text of a field is sent to the server URL you configured, and nowhere
else. Beyond that:

- Fields that structurally hold secrets are never read or sent: anything with
  a sensitive `autocomplete` (passwords, one-time codes, card fields),
  `inputmode` numeric/tel/decimal, a `maxlength` of 8 or less, or a name / id /
  placeholder / aria-label that looks like a password, OTP, token, card number,
  IBAN, SSN, PIN and so on.
- Ignored words are filtered inside the page — they never reach the server.
- Very long texts are only checked from a boundary near the last 20 000
  characters, which is where editing happens.
- The background worker keeps a small in-memory cache (30 entries, texts up to
  10 000 characters) so refocusing a field or a settings change doesn't re-ask
  the server. It is gone when the worker is.

`spellcheck="false"` is deliberately **not** honoured: it is inherited, so a
single `<body spellcheck="false">` would silence a whole site. Use "Disable
Here" or "Disable on *site*" instead.

## How it works

The manifest injects one small file, `content/boot.js`, into every frame. It
watches for the first sign of an editable element and only then dynamically
imports the rest — so the ad, tracker and player frames that make up most of a
page cost nothing but that file and the stylesheet.

There is no page-wide scanning and no standing MutationObserver. An element is
attached the first time it is focused or dispatches an input event, and only
the eight most-recently-edited elements keep live state.

| File | Role |
| --- | --- |
| `background.js` | Service worker in Chrome, event page in Firefox; the only thing that talks to the LanguageTool server. Collapses duplicate requests and caches results. |
| `content/boot.js` | The injected entry point. Notices editables, imports the rest. |
| `content/index.js` | Module entry point; imports the modules below in dependency order. |
| `content/settings.js` | Shared `LT` namespace and storage-backed settings. |
| `content/api.js` | Talks to the worker; buckets matches into the three severities. |
| `content/main.js` | Orchestration: eligibility, state lifecycle, debouncing, event wiring. |
| `content/mirror.js` | Measures where matches land in a `<textarea>`/`<input>` by laying the text out in a hidden mirror. |
| `content/overlay.js` | The single `#lt-ext-root` container everything is drawn into, and the event trap that keeps extension UI events out of the page. |
| `content/ce.js` | contenteditable support via the CSS Custom Highlight API. |
| `content/replace.js` | Applies a suggestion in the least destructive way available. |
| `content/popup.js` | The suggestion popup. |
| `pages/` | The toolbar preferences page. |

Two things it goes out of its way to do:

- **The page's own DOM is never touched.** Field underlines are drawn in an
  overlay inside the extension's own container; contenteditable errors are
  painted with `::highlight()` from `Range` objects. Editors keep their tree
  and the caret never moves.
- **Controlled editors work.** Slate (Discord), Lexical, ProseMirror and
  friends own their content and ignore DOM edits they didn't make, so a
  correction is announced with a `beforeinput` carrying the exact target range
  and the resulting re-render is waited for. Text that arrives with no input
  event at all — a paste or drop such an editor applies itself, a chat app
  clearing the draft on Enter — is picked up by a revalidation pass.

## Development

The sources are the Chrome extension as it ships — no build step there, just
load the directory unpacked and reload after an edit. `npm run build:firefox`
copies them to `dist/firefox` with a translated manifest (event page instead of
a service worker, a Gecko add-on id, no `minimum_chrome_version`); nothing in
`content/`, `pages/` or `background.js` is rewritten. The one thing the code
does for Firefox is take the extension API from `browser` when it exists, since
Firefox only returns promises from that namespace and the `chrome` alias is
callback-only.

An end-to-end smoke test drives the real extension in headless Chrome for
Testing against a running LanguageTool server, and asserts the whole
check → underline → popup → replace flow:

```bash
npm install
npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer  # once
npm run verify
```

A shorter suite runs the same flows in real Firefox — the parts that differ
there: the promise namespace, the event page, the dynamic import of a
`moz-extension:` module, and the prefs page.

```bash
npm run verify:firefox   # builds dist/firefox first; needs firefox on PATH
```

Both print one PASS/FAIL line per step and write screenshots. Branded Google
Chrome cannot load unpacked extensions since v137, so the Chrome run needs
Chrome for Testing. See `.claude/skills/verify/SKILL.md` for the rest of the
gotchas.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
