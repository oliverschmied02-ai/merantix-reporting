// @ts-check
// ── Event delegation ──────────────────────────────────────────────────
// Replaces inline on*= attributes so a strict Content-Security-Policy (no
// 'unsafe-inline' for scripts) can be enabled. Elements declare handlers via
// data-<event> attributes naming a function on `window`; arguments are carried
// in a JSON data-<event>-args attribute. Sentinel strings are resolved at
// dispatch time against the triggering element/event:
//   "@this"  -> the element carrying the data-<event> attribute
//   "@event" -> the DOM event object
//   "@value" -> element.value
//
// Kept deliberately tiny and framework-free to match the existing codebase.

// event name -> the attribute that names the handler for that event
const EVENT_ATTR = {
  click:   'data-act',
  change:  'data-change',
  input:   'data-input',
  keydown: 'data-keydown',
  blur:    'data-blur',
  focus:   'data-focus',
};

/**
 * @param {any} a - literal arg or a sentinel ("@this"/"@event"/"@value")
 * @param {Element} el
 * @param {Event} event
 */
function resolveArg(a, el, event) {
  if (a === '@this')  return el;
  if (a === '@event') return event;
  if (a === '@value') return /** @type {HTMLInputElement} */ (el).value;
  return a;
}

/**
 * @param {string} attr - the data attribute naming the handler (e.g. 'data-act')
 * @param {Event} event
 */
function dispatch(attr, event) {
  const target = /** @type {Element|null} */ (event.target);
  const el = target && target.closest(`[${attr}]`);
  if (!el) return;
  const name = el.getAttribute(attr);
  const fn = name && /** @type {any} */ (window)[name];
  if (typeof fn !== 'function') {
    console.warn('[dispatch] no handler for', attr, '=', name);
    return;
  }
  let args = [];
  const raw = el.getAttribute(`${attr}-args`);
  if (raw) {
    try { args = JSON.parse(raw); }
    catch (e) { console.error('[dispatch] invalid args', raw, e); }
  }
  fn(...args.map((/** @type {any} */ a) => resolveArg(a, el, event)));
}

// Non-native controls carrying data-act (e.g. a clickable <td>) aren't
// keyboard-activatable by default. Treat Enter/Space as a click for any
// focusable data-act element that isn't already a native button/link/field.
const NATIVE_ACTIVATABLE = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']);
/** @param {KeyboardEvent} event */
function keyActivate(event) {
  if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
  const target = /** @type {Element|null} */ (event.target);
  const el = target && target.closest('[data-act]');
  if (!el || NATIVE_ACTIVATABLE.has(el.tagName)) return;
  event.preventDefault();
  dispatch('data-act', event);
}

export function initDispatch() {
  for (const [evName, attr] of Object.entries(EVENT_ATTR)) {
    // blur/focus don't bubble — listen in the capture phase.
    const capture = evName === 'blur' || evName === 'focus';
    document.addEventListener(evName, e => dispatch(attr, e), capture);
  }
  document.addEventListener('keydown', keyActivate);
}

// ── Attribute builders for use inside template-literal render code ────────
// Usage:  `<button ${onClick('doLogout')}>`  /  `<select ${onChange('setUserRole', id, '@value')}>`
/** @param {unknown} s */
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * @param {string} attr
 * @param {string} name
 * @param {any[]} args
 * @returns {string}
 */
function build(attr, name, args) {
  const base = `${attr}="${name}"`;
  return args.length ? `${base} ${attr}-args="${escAttr(JSON.stringify(args))}"` : base;
}

/** @typedef {(name: string, ...a: any[]) => string} AttrBuilder */
/** @type {AttrBuilder} */ export const onClick   = (name, ...a) => build('data-act', name, a);
/** @type {AttrBuilder} */ export const onChange  = (name, ...a) => build('data-change', name, a);
/** @type {AttrBuilder} */ export const onInput   = (name, ...a) => build('data-input', name, a);
/** @type {AttrBuilder} */ export const onKeydown = (name, ...a) => build('data-keydown', name, a);
/** @type {AttrBuilder} */ export const onBlur    = (name, ...a) => build('data-blur', name, a);
/** @type {AttrBuilder} */ export const onFocus   = (name, ...a) => build('data-focus', name, a);

// Small reusable handlers for former inline expressions.
export function registerBuiltins() {
  const w = /** @type {any} */ (window);
  w.clickEl   = (/** @type {string} */ id) => document.getElementById(id)?.click();
  w.selectAll = (/** @type {HTMLInputElement} */ el) => el.select?.();
  w.enterBlur = (/** @type {KeyboardEvent} */ event, /** @type {HTMLElement} */ el) => {
    if (event.key === 'Enter') { event.preventDefault(); el.blur(); }
  };
}
