# LanguageTool Spellcheck

A Chrome extension that spell- and grammar-checks what you type on any page,
using **your own LanguageTool server** — by default one running on
`http://localhost:8010`. Nothing is sent to a cloud service, no account, no
telemetry.

Errors are underlined in place; clicking one opens a popup with LanguageTool's
message, its suggested replacements, and the rule behind it.

Underlines are colour-coded: red for spelling, amber for grammar, blue for
style and register.

## Requirements

- Chrome 119 or newer (the contenteditable support needs the CSS Custom
  Highlight API).
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
Requests are made by the extension's service worker, which holds the host
permission, so the server does not need CORS flags.

## Installing the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** → pick this directory.

## Using it

Type in any text field, textarea or rich editor. Checks are debounced ~500 ms
after you stop typing.

Click an underline to open the suggestion popup:

- pick a replacement to apply it — the edit goes through the browser's editing
  pipeline, so undo still works and frameworks see it as a normal change;
- **Ignore ‘word’** — never flag that word again (stored in your profile);
- **Disable rule** — turn off that LanguageTool rule everywhere;
- **Disable here** — stop checking this one field on this one site.

The toolbar icon opens preferences: the global on/off switch, "Disable on
*site*", server URL, language (or auto-detect), preferred variants, native
language for false-friend detection, picky mode, and the lists of ignored
words, disabled rules and disabled fields — each removable.

Preferences live in `chrome.storage.sync` and follow your Chrome profile. The
per-field disable list is keyed by hostname and can grow without bound, so it
lives in `chrome.storage.local` instead.

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
- The service worker keeps a small in-memory cache (30 entries, texts up to
  10 000 characters) so refocusing a field or a settings change doesn't re-ask
  the server. It is gone when the worker is.

`spellcheck="false"` is deliberately **not** honoured: it is inherited, so a
single `<body spellcheck="false">` would silence a whole site. Use "Disable
here" or "Disable on *site*" instead.

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
| `background.js` | Service worker; the only thing that talks to the LanguageTool server. Collapses duplicate requests and caches results. |
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

There are no build steps: load the directory unpacked and reload the extension
after an edit.

An end-to-end smoke test drives the real extension in headless Chrome for
Testing against a running LanguageTool server, and asserts the whole
check → underline → popup → replace flow:

```bash
npm install
npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer  # once
npm run verify
```

It prints one PASS/FAIL line per step and writes screenshots. Branded Google
Chrome cannot load unpacked extensions since v137, so this needs Chrome for
Testing. See `.claude/skills/verify/SKILL.md` for the rest of the gotchas.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
