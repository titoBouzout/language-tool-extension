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
};
