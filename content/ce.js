// contenteditable support built on the CSS Custom Highlight API: errors are
// painted via ::highlight() pseudo-elements from Range objects, so the
// page's DOM is never touched — framework-safe (React/Vue/editors keep
// their own tree) and the caret never moves.
const LT = (globalThis.LT ??= {});

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
  // their start offset in `text` (sorted, non-overlapping); the synthetic
  // newlines map to no node. `byNode` is the same data keyed for lookup.
  function build(root) {
    const entries = [];
    const byNode = new Map();
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
          const e = { node: c, start: text.length, len: c.data.length };
          entries.push(e);
          byNode.set(c, e);
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
    return { text, entries, byNode };
  }

  // Walking the whole editable tree is the expensive part of a check, and a
  // single synchronous flow asks for the same map several times (check ->
  // filter -> paint). Memoize for the current task only: anything that yields
  // (an await, a later event) drains the microtask queue and forces a rebuild,
  // which is what re-anchors highlights after a framework re-render.
  let memo = null;
  LT.ceBuildMap = function (root) {
    if (memo && memo.root === root) return memo.map;
    const map = build(root);
    memo = { root, map };
    queueMicrotask(() => { memo = null; });
    return map;
  };

  // First entry that could contain `pos`. entries are sorted and
  // non-overlapping, so both `start` and `start + len` are non-decreasing.
  function posToNodeOffset(map, pos) {
    const es = map.entries;
    if (!es.length) return null;
    let lo = 0, hi = es.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (es[mid].start + es[mid].len >= pos) { idx = mid; hi = mid - 1; } else lo = mid + 1;
    }
    if (idx < 0) {
      const last = es[es.length - 1];
      return { node: last.node, offset: last.len };
    }
    const e = es[idx];
    // e.start > pos means pos landed on a synthetic newline: clamp to the
    // start of the next real node.
    return { node: e.node, offset: e.start <= pos ? pos - e.start : 0 };
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
      const e = map.byNode.get(node);
      return e ? e.start + Math.min(offset, e.len) : -1;
    }
    const child = node.childNodes[offset];
    if (child) {
      const direct = map.byNode.get(child);
      if (direct) return direct.start;
      for (const e of map.entries) {
        const cmp = child.compareDocumentPosition(e.node);
        if ((cmp & Node.DOCUMENT_POSITION_CONTAINED_BY) ||
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

  // ::highlight() rules don't cascade into shadow trees, so an editable living
  // in one needs its own copy. Keeping the rules here rather than in
  // styles.css makes this the single source of truth — the document gets the
  // same constructed sheet as any shadow root.
  const HIGHLIGHT_CSS = `
    ::highlight(lt-ext-spell) { text-decoration: underline wavy #ff6259 1.5px; text-decoration-skip-ink: none; background-color: rgba(255, 98, 89, 0.10); }
    ::highlight(lt-ext-grammar) { text-decoration: underline wavy #fbbc04 1.5px; text-decoration-skip-ink: none; background-color: rgba(251, 188, 4, 0.10); }
    ::highlight(lt-ext-style) { text-decoration: underline wavy #6aa9ff 1.5px; text-decoration-skip-ink: none; background-color: rgba(106, 169, 255, 0.10); }
  `;
  const adopted = new WeakSet();
  let sharedSheet = null;

  LT.adoptHighlightStyles = function (rootNode) {
    const target = rootNode instanceof ShadowRoot ? rootNode : document;
    if (adopted.has(target)) return;
    try {
      if (!sharedSheet) {
        sharedSheet = new CSSStyleSheet();
        sharedSheet.replaceSync(HIGHLIGHT_CSS);
      }
      target.adoptedStyleSheets = [...target.adoptedStyleSheets, sharedSheet];
      adopted.add(target);
    } catch { /* closed/immutable roots: highlights just won't paint there */ }
  };

  if (LT.ceSupported) LT.adoptHighlightStyles(document);
})();
