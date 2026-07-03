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

function resolveArg(a, el, event) {
  if (a === '@this')  return el;
  if (a === '@event') return event;
  if (a === '@value') return el.value;
  return a;
}

function dispatch(attr, event) {
  const el = event.target.closest(`[${attr}]`);
  if (!el) return;
  const name = el.getAttribute(attr);
  const fn = window[name];
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
  fn(...args.map(a => resolveArg(a, el, event)));
}

export function initDispatch() {
  for (const [evName, attr] of Object.entries(EVENT_ATTR)) {
    // blur/focus don't bubble — listen in the capture phase.
    const capture = evName === 'blur' || evName === 'focus';
    document.addEventListener(evName, e => dispatch(attr, e), capture);
  }
}

// ── Attribute builders for use inside template-literal render code ────────
// Usage:  `<button ${onClick('doLogout')}>`  /  `<select ${onChange('setUserRole', id, '@value')}>`
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function build(attr, name, args) {
  const base = `${attr}="${name}"`;
  return args.length ? `${base} ${attr}-args="${escAttr(JSON.stringify(args))}"` : base;
}

export const onClick   = (name, ...a) => build('data-act', name, a);
export const onChange  = (name, ...a) => build('data-change', name, a);
export const onInput   = (name, ...a) => build('data-input', name, a);
export const onKeydown = (name, ...a) => build('data-keydown', name, a);
export const onBlur    = (name, ...a) => build('data-blur', name, a);
export const onFocus   = (name, ...a) => build('data-focus', name, a);

// Small reusable handlers for former inline expressions.
export function registerBuiltins() {
  window.clickEl   = id => document.getElementById(id)?.click();
  window.selectAll = el => el.select?.();
  window.enterBlur = (event, el) => {
    if (event.key === 'Enter') { event.preventDefault(); el.blur(); }
  };
}
