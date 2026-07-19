// Applies a suggestion to the element in the least destructive way available:
// execCommand('insertText') first — it goes through the browser's editing
// pipeline, so it preserves the undo stack and fires the same trusted-looking
// input events frameworks listen for.
'use strict';

LT.applyReplacement = function (s, match, value) {
  const el = s.el;
  const start = match.offset;
  const end = match.offset + match.length;

  if (s.kind === 'field') {
    el.focus();
    el.setSelectionRange(start, end);
    let ok = false;
    try {
      ok = document.execCommand(value === '' ? 'delete' : 'insertText', false, value);
    } catch { /* fall through */ }
    if (!ok) {
      // Native value setter + InputEvent: the pattern React et al. accept for
      // programmatic edits of controlled inputs (loses undo, hence fallback).
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const next = el.value.slice(0, start) + value + el.value.slice(end);
      if (setter) setter.call(el, next); else el.value = next;
      el.setSelectionRange(start + value.length, start + value.length);
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, composed: true, inputType: 'insertText', data: value,
      }));
    }
    return;
  }

  // contenteditable
  const map = LT.ceBuildMap(el);
  const range = LT.ceRangeFor(map, start, end);
  if (!range) return;
  const rootNode = el.getRootNode();
  const sel = rootNode instanceof ShadowRoot && rootNode.getSelection
    ? rootNode.getSelection()
    : window.getSelection();
  if (!sel) return;
  el.focus();
  sel.removeAllRanges();
  sel.addRange(range);
  // Selection-tracking frameworks sync their model selection on
  // selectionchange; the browser's own event fires too late (async).
  document.dispatchEvent(new Event('selectionchange'));

  // Controlled editors (Slate — Discord, Lexical, Draft) keep their own
  // model and re-render the DOM from it: an edit they never heard about is
  // reverted on the next keystroke. execCommand does NOT fire beforeinput —
  // the one event those editors accept changes through — so announce the
  // edit first with a synthetic beforeinput carrying the exact target
  // range. A framework that owns the field preventDefaults it and applies
  // the change to its model itself; then there is nothing left for us to do.
  const staticRange = new StaticRange({
    startContainer: range.startContainer,
    startOffset: range.startOffset,
    endContainer: range.endContainer,
    endOffset: range.endOffset,
  });
  const announce = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    composed: true,
    inputType: value === '' ? 'deleteContentBackward' : 'insertText',
    data: value === '' ? null : value,
  });
  Object.defineProperty(announce, 'getTargetRanges', { value: () => [staticRange] });
  if (!el.dispatchEvent(announce)) {
    // Canceled: the page's editor consumed the edit. No native input event
    // will fire, so tell the checker directly.
    LT.afterEdit?.(s);
    return;
  }

  let ok = false;
  try {
    ok = document.execCommand(value === '' ? 'delete' : 'insertText', false, value);
  } catch { /* fall through */ }
  if (!ok) {
    // Last resort: edit the range directly and tell the page about it.
    range.deleteContents();
    if (value) range.insertNode(document.createTextNode(value));
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType: 'insertText', data: value,
    }));
  }
  LT.afterEdit?.(s);
};
