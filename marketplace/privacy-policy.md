# Privacy policy — LanguageTool Spellcheck

_Last updated: 2026-07-29._

All three stores want a privacy policy at a public URL. Publish this file
somewhere stable — the simplest is to keep it in the repository and link the
raw rendered page, e.g.
`https://github.com/titoBouzout/language-tool-extension/blob/master/marketplace/privacy-policy.md`
— and paste that URL into the Chrome, Edge and AMO listing forms.

---

## Who processes your data

Nobody but you. The extension has no backend, no analytics, no accounts and no
third-party services. The only network requests it ever makes go to the
LanguageTool server URL you enter in its preferences (default
`http://localhost:8010`), which is a server **you** choose and operate.

## What is sent, and where

When you type in a text field, the text of that field is sent to your
configured server URL so that it can be checked. That is the whole of it. It is
sent by the extension's own background worker over HTTP(S) to that URL and
nowhere else.

If you point the extension at a third-party server (for example the public
LanguageTool API instead of your own instance), your text is then handled by
whoever operates that server, under their policy. The extension does not
suggest or default to any such service.

## What is deliberately never sent

- Fields that structurally hold secrets are never read at all: sensitive
  `autocomplete` values (passwords, one-time codes, credit-card fields),
  `inputmode` of numeric, tel or decimal, a `maxlength` of 8 or less, and any
  field whose name, id, placeholder or accessible label looks like a password,
  OTP, token, card number, IBAN, SSN or PIN.
- Words on your ignore list are filtered out inside the page, before any
  request is made.
- Fields and sites you have disabled are never read.
- Very long texts are only checked from a boundary near their last 20 000
  characters, which is where editing happens.

## What is stored, and where

Your preferences — server URL, language and variants, native language, picky
mode, the global and per-site switches, your ignored words, pinned
auto-corrections and disabled rules — are stored in your browser's extension
storage (`storage.sync`), which means they follow your browser profile if you
have browser sync turned on. The list of individually disabled fields is kept
in local extension storage (`storage.local`) because it is keyed by hostname
and can grow.

The background worker keeps a small in-memory cache of recent check results (up
to 30 entries) so that refocusing a field does not re-ask your server. It is
never written to disk and disappears when the worker stops.

Nothing else is stored. Nothing is transmitted to the developer.

## What is not done

- No data is sold or shared with third parties.
- No advertising, profiling, tracking, fingerprinting or analytics.
- No creditworthiness or lending assessment.
- No remote code is loaded or executed; all code ships in the package.
- No use of your text for any purpose other than returning the check result to
  you.

## Permissions and why they exist

- **`storage`** — to save the preferences described above.
- **Host access to all sites (`*://*/*`)** — two reasons. Editable fields exist
  on any site, so the checking code has to be able to run anywhere (you can
  switch it off globally, per site, or per field). And the server URL is yours
  to choose, so the extension cannot know in advance which host it must be
  allowed to contact.

## Your control

Turn checking off globally or for a site from the toolbar popup; turn it off
for a single field from the suggestion popup's "Disable Here". Clearing the
lists in the preferences page removes that stored data, and uninstalling the
extension removes all of it.

## Contact

Issues and questions:
<https://github.com/titoBouzout/language-tool-extension/issues>
