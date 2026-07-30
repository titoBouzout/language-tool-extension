# Marketplace assets

Everything the three extension stores ask for, ready to paste and upload.

| File | What it is |
| --- | --- |
| `listing-copy.md` | The listing text itself — name, summary, description, category, search terms, links. Single source; the store files point at it. |
| `privacy-policy.md` | The privacy policy. Chrome and Edge want it at a public URL, AMO wants the text. |
| `chrome-web-store.md` | Chrome: every form field, the permission justifications, the data-usage answers, how to build the ZIP. |
| `edge-add-ons.md` | Edge: same package as Chrome, the fields that differ, certification notes. |
| `firefox-amo.md` | Firefox: the Gecko build, the listing fields, and the reviewer notes AMO's code review needs. |
| `screenshots/` | Six 1280×800 PNGs — the size Chrome and Edge require, and fine for AMO. |
| `popup.png` | The popup alone, cropped tight and taken at 2x — not a store asset, it is the image the project README shows. |
| `promo/` | Chrome small tile (440×280) and marquee (1400×560), Edge store logo (300×300). |
| `demo.html`, `promo.html` | The staged pages the generator drives. Not part of the extension. |
| `shots.mjs` | The generator. |

The store icon in every listing is the extension's own `icons/icon128.png`.

## The screenshots

| File | Shows |
| --- | --- |
| `01-underlines-in-place.png` | A mail composer: a misspelling and an agreement error underlined while typing. |
| `02-suggestion-popup.png` | The popup on "allmost" — explanation, rule, two replacements, the three actions. |
| `03-auto-correction.png` | The same popup with the wand half of the top suggestion under the pointer. |
| `04-rich-editor.png` | A contenteditable article draft with all three underline colours at once (picky mode). |
| `05-actions.png` | A grammar match in a comment box, popup open. |
| `06-preferences.png` | The toolbar preferences over the mail page, with lists filled in. |

They are real: `shots.mjs` loads the unpacked extension into headless Chrome for
Testing, types into a staged page, waits for the actual check to come back from
a real LanguageTool server, and clicks the actual underlines. Nothing is mocked
up, so a change to the popup or the underline colours shows up the next time the
script is run.

## Regenerating

```bash
# once: the browser the harness drives
npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer
# a LanguageTool server the checks can go to
docker run -d --name languagetool -p 8010:8010 erikvl87/languagetool

node marketplace/shots.mjs
```

It prints what each scene matched (segment counts, the suggestions it found) and
then the files it wrote. If a scene stops finding its match — a LanguageTool
upgrade changes what a rule suggests now and then — the strings to adjust are
`MAIL`, `DOC` and the `openPopupFor(...)` argument in `shots.mjs`.

Every output is written at its exact required size with `deviceScaleFactor: 1`
and no alpha channel, which is what Chrome and Edge validate on upload.

## Before submitting, check

- [ ] `manifest.json` version bumped, and the version in the three store files
      matches it.
- [ ] Privacy policy published somewhere public; its URL pasted into the Chrome
      and Edge forms, its text into AMO's.
- [ ] Screenshots regenerated if the UI changed since the last release.
- [ ] The Chromium ZIP contains `manifest.json`, `background.js`, `content/`,
      `pages/`, `icons/` and `LICENSE` — and nothing from `node_modules/`,
      `.claude/`, `marketplace/`, `tools/` or `dist/`. The Firefox ZIP is
      whatever `npm run build:firefox` wrote, zipped from inside
      `dist/firefox` so `manifest.json` sits at the root.
- [ ] Reviewer notes mention how to get a LanguageTool server; without one the
      extension looks like it does nothing.
- [ ] The trademark caveat in `listing-copy.md` has been read at least once.
