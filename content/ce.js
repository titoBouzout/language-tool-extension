// contenteditable support built on the CSS Custom Highlight API: errors are
// painted via ::highlight() pseudo-elements from Range objects, so the
// page's DOM is never touched — framework-safe (React/Vue/editors keep
// their own tree) and the caret never moves.
'use strict';

(() => {
  LT.ceSupported = typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && !!CSS.highlights;

  const BLOCKY = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
    'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3',
    'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
    'SECTION', 'TABLE', 'TD', 'TH', 'TR', 'UL',
  ]);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

  // Linearizes an editable tree into checkable text. Unlike textContent, it
  // inserts "\n" at block boundaries and <br>, so LanguageTool doesn't see
  // adjacent paragraphs glued into one word. `entries` maps text nodes to
  // their start offset in `text`; the synthetic newlines map to no node.
  LT.ceBuildMap = function (root) {
    const entries = [];
    let text = '';
    const pushBreak = () => {
      if (text && !text.endsWith('\n')) text += '\n';
    };
    const isBlockyEl = (n) => !!n && n.nodeType === Node.ELEMENT_NODE && BLOCKY.has(n.tagName);
    (function walk(node) {
      const parentIsBoundary = node === root || BLOCKY.has(node.tagName);
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === Node.TEXT_NODE) {
          // Whitespace-only nodes between block boundaries are HTML source
          // formatting, never rendered — including them makes LanguageTool
          // flag invisible "extra spaces". Whitespace next to inline content
          // is real and kept.
          if (/^\s+$/.test(c.data)) {
            const prevB = c.previousSibling ? isBlockyEl(c.previousSibling) : parentIsBoundary;
            const nextB = c.nextSibling ? isBlockyEl(c.nextSibling) : parentIsBoundary;
            if (prevB && nextB) continue;
          }
          entries.push({ node: c, start: text.length, len: c.data.length });
          text += c.data;
        } else if (c.nodeType === Node.ELEMENT_NODE) {
          if (SKIP.has(c.tagName)) continue;
          if (c.tagName === 'BR') { text += '\n'; continue; }
          const blocky = BLOCKY.has(c.tagName);
          if (blocky) pushBreak();
          walk(c);
          if (blocky) pushBreak();
        }
      }
    })(root);
    return { text, entries };
  };

  function posToNodeOffset(map, pos) {
    for (const e of map.entries) {
      if (pos >= e.start && pos <= e.start + e.len) return { node: e.node, offset: pos - e.start };
    }
    // pos falls on a synthetic newline: clamp to the next node's start.
    for (const e of map.entries) {
      if (e.start > pos) return { node: e.node, offset: 0 };
    }
    const last = map.entries[map.entries.length - 1];
    return last ? { node: last.node, offset: last.len } : null;
  }

  LT.ceRangeFor = function (map, start, end) {
    const a = posToNodeOffset(map, start);
    const b = posToNodeOffset(map, end);
    if (!a || !b) return null;
    const r = document.createRange();
    try {
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
    } catch {
      return null;
    }
    return r;
  };

  // (node, offset in node) -> offset in map.text. -1 when unknown.
  LT.cePos = function (map, node, offset) {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const e of map.entries) {
        if (e.node === node) return e.start + Math.min(offset, e.len);
      }
      return -1;
    }
    const child = node.childNodes[offset];
    if (child) {
      for (const e of map.entries) {
        const cmp = child.compareDocumentPosition(e.node);
        if (child === e.node ||
            (cmp & Node.DOCUMENT_POSITION_CONTAINED_BY) ||
            (cmp & Node.DOCUMENT_POSITION_FOLLOWING)) {
          return e.start;
        }
      }
    }
    return map.text.length;
  };

  LT.cePosFromPoint = function (root, map, x, y) {
    let node = null, offset = 0;
    if (document.caretPositionFromPoint) {
      const shadow = root.getRootNode();
      const opts = shadow instanceof ShadowRoot ? { shadowRoots: [shadow] } : undefined;
      const p = document.caretPositionFromPoint(x, y, opts);
      if (p) { node = p.offsetNode; offset = p.offset; }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    if (!node || !root.contains(node)) return -1;
    return LT.cePos(map, node, offset);
  };

  // --- highlight registries, one per severity ---

  const NAMES = { spell: 'lt-ext-spell', grammar: 'lt-ext-grammar', style: 'lt-ext-style' };
  const registries = {};

  function registry(sev) {
    const name = NAMES[sev] || NAMES.grammar;
    if (!registries[name]) {
      registries[name] = new Highlight();
      CSS.highlights.set(name, registries[name]);
    }
    return registries[name];
  }

  // items: [{ range, sev }]
  LT.ceApply = function (s, items) {
    LT.ceClear(s);
    s.ceRanges = items;
    for (const it of items) registry(it.sev).add(it.range);
  };

  LT.ceClear = function (s) {
    for (const it of s.ceRanges || []) registry(it.sev).delete(it.range);
    s.ceRanges = [];
  };

  // ::highlight() rules don't cascade into shadow trees, so when an editable
  // lives inside one, adopt a copy of the highlight styles there. Values
  // mirror content/styles.css.
  const HIGHLIGHT_CSS = `
    ::highlight(lt-ext-spell) { text-decoration: underline wavy #ff6259 1.5px; text-decoration-skip-ink: none; background-color: rgba(255, 98, 89, 0.10); }
    ::highlight(lt-ext-grammar) { text-decoration: underline wavy #fbbc04 1.5px; text-decoration-skip-ink: none; background-color: rgba(251, 188, 4, 0.10); }
    ::highlight(lt-ext-style) { text-decoration: underline wavy #6aa9ff 1.5px; text-decoration-skip-ink: none; background-color: rgba(106, 169, 255, 0.10); }
  `;
  const adopted = new WeakSet();
  let sharedSheet = null;

  LT.adoptHighlightStyles = function (rootNode) {
    if (!(rootNode instanceof ShadowRoot) || adopted.has(rootNode)) return;
    try {
      if (!sharedSheet) {
        sharedSheet = new CSSStyleSheet();
        sharedSheet.replaceSync(HIGHLIGHT_CSS);
      }
      rootNode.adoptedStyleSheets = [...rootNode.adoptedStyleSheets, sharedSheet];
      adopted.add(rootNode);
    } catch { /* closed/immutable shadow roots: highlights just won't paint */ }
  };
})();
