// @ts-check
// Tiny safe DOM builder. Unlike innerHTML template strings, text children are
// inserted as text nodes and never parsed as HTML, so interpolated data can't
// inject markup — the structural fix for the "did I remember esc()?" footgun.

/**
 * @typedef {string|number|boolean|null|undefined|Node} Child
 */

/**
 * Create a DOM element.
 * @param {string} tag
 * @param {Record<string, any>} [attrs] - attributes; special keys:
 *   `class` -> className, `dataset` -> element.dataset, `on<Event>` (function)
 *   -> addEventListener. `true` renders a boolean attribute; `false`/`null` skip.
 * @param {...(Child|Child[])} children - strings become text nodes (escaped);
 *   Nodes are appended as-is; nullish/false are skipped.
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  appendChildren(el, children);
  return el;
}

/**
 * @param {HTMLElement} el
 * @param {(Child|Child[])[]} children
 */
function appendChildren(el, children) {
  for (const c of children) {
    if (Array.isArray(c)) { appendChildren(el, c); continue; }
    if (c == null || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/**
 * Escape a string for safe interpolation into an HTML template string.
 * Prefer h() where practical; use this when building a string is unavoidable.
 * Escapes the single quote too (utils.esc does not), making it safe inside
 * single-quoted attribute values.
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  /** @type {Record<string, string>} */
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s ?? '').replace(/[&<>"']/g, c => map[c] ?? c);
}
