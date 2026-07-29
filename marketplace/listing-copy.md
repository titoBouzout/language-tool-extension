# Listing copy (shared)

The text below is the single source for all three stores. The per-store files
(`chrome-web-store.md`, `firefox-amo.md`, `edge-add-ons.md`) say which field
takes which block and where the limits differ, and each one notes its own
deviations — the requirements line in particular differs per browser.

Version this copy describes: **3.0.0** (`manifest.json`).

---

## Name

Manifest name, used as the store name everywhere:

```
LanguageTool Spellcheck
```

> **Trademark caveat.** "LanguageTool" is the name of a third-party project
> (LanguageTooler GmbH). All three stores can reject or ask you to rename a
> listing whose title leads with someone else's brand, and it can also read as
> an official client. If a reviewer objects, the fallback that keeps the
> keyword without claiming the brand:
>
> ```
> Spellcheck with your own LanguageTool server
> ```
>
> Changing it means changing `name` in `manifest.json` too, since the stores
> take the name from there.

## Short description / summary (≤132 chars — Chrome's limit, the tightest)

```
Inline spelling and grammar checking on every page, using a LanguageTool server you run yourself. No cloud, no account.
```

(119 characters.)

## Detailed description

```
LanguageTool Spellcheck underlines spelling, grammar and style mistakes as you
type — in any text field, on any site, in plain inputs, textareas and rich
editors alike. It checks your text against a LanguageTool server that you run.
Nothing goes to a cloud service, there is no account, and there is no
telemetry.

By default it looks for a server on http://localhost:8010. Point it wherever
you like: a container on your laptop, a machine on your LAN, your own instance
on a VPS. If you do not run one yet, the standalone package and a community
Docker image are each a single command away — see the setup instructions in the
project README, linked below.

WHAT YOU SEE

• Mistakes are underlined in place and colour-coded: red for spelling, amber
  for grammar, blue for style and register.
• Click an underline for LanguageTool's explanation, the rule behind it, and up
  to two suggested replacements.
• Applying a suggestion goes through the browser's own editing pipeline, so
  undo still works and the page's editor sees it as an ordinary edit.

FIX IT ONCE, THEN FOREVER

The best suggestion has a wand beside it. Click the wand instead of the word
and the correction is applied now and pinned: the same rule flagging the same
text is fixed silently from then on, everywhere. Nothing else is touched, and
the list of pinned corrections is yours to edit.

ALSO IN THE POPUP

• Ignore — never flag that word again.
• Disable Rule — turn off that LanguageTool rule everywhere.
• Disable Here — stop checking this one field on this one site.

PREFERENCES, FROM THE TOOLBAR ICON

A global on/off switch, "disable on this site", the server URL, language or
auto-detect, preferred variants (so a British writer is not told "colour" is a
typo), native language for false-friend detection, picky mode for style and
typography, and editable lists of ignored words, pinned auto-corrections,
disabled rules and disabled fields.

BUILT TO STAY OUT OF THE WAY

• Your page's DOM is never modified. Plain fields are underlined in the
  extension's own overlay; rich editors are underlined with the CSS Custom
  Highlight API. Editors keep their tree and your caret never moves.
• Controlled editors work. Slate (Discord), Lexical, ProseMirror and friends
  are handed a beforeinput event carrying the exact target range, and their
  re-render is waited for.
• One small file is injected per frame, and it loads the rest only once that
  frame actually holds something editable — so the ad, tracker and player
  frames that make up most of a page cost almost nothing.
• Checks are debounced about half a second after you stop typing, duplicate
  requests are collapsed, and recent results are cached in memory.

PRIVACY

The text of the field you are typing in is sent to the server URL you
configured, and nowhere else.

• Fields that structurally hold secrets are never read or sent: sensitive
  autocomplete values (passwords, one-time codes, card fields), numeric, tel
  and decimal input modes, a maxlength of 8 or less, and names, ids,
  placeholders or labels that look like a password, OTP, token, card number,
  IBAN, SSN or PIN.
• Words you ignore are filtered inside the page and never reach the server.
• Very long texts are only checked near the end, where the editing happens.
• Preferences follow your browser profile; the per-field disable list stays on
  the machine.

REQUIREMENTS

• A LanguageTool server you can reach over HTTP. [BROWSER REQUIREMENT LINE]

Free software, GPL-3.0-or-later. Source, issues and setup instructions:
https://github.com/titoBouzout/language-tool-extension
```

`[BROWSER REQUIREMENT LINE]` is replaced per store:

- **Chrome:** `Chrome 119 or newer.`
- **Edge:** `Edge 119 or newer.`
- **Firefox:** `Firefox 128 or newer. Underlines inside rich editors need the
  CSS Custom Highlight API, which Firefox shipped in 140; below that everything
  else still works and rich editors simply are not underlined.`

## Single-purpose statement

Asked for by Chrome and Edge, useful as reviewer notes on AMO:

```
The extension has one purpose: check the text a user types into fields on web
pages for spelling, grammar and style mistakes, using a LanguageTool server
that the user configures, and offer the corrections in place.
```

## Category

| Store | Category |
| --- | --- |
| Chrome Web Store | Productivity → Workflow & Planning |
| Edge Add-ons | Productivity |
| AMO | Language Support (secondary: Privacy & Security) |

## Search terms / tags

Seven, each under 30 characters, in priority order — Edge allows 7, AMO allows
tags of its own, Chrome derives search terms from the description:

```
spellcheck
grammar checker
languagetool
self-hosted
spell checker
proofreading
privacy
```

## Support and links

| Field | Value |
| --- | --- |
| Homepage / website | `https://github.com/titoBouzout/language-tool-extension` |
| Support site | `https://github.com/titoBouzout/language-tool-extension/issues` |
| Support email | the address on the developer account |
| Privacy policy | wherever `privacy-policy.md` is published (see that file) |
| License | GPL-3.0-or-later |

## Language

English (United States) as the listing language. The UI itself is English
only; the checking languages come from whatever your server has installed.
