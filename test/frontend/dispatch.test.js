import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { initDispatch, onClick, onChange, onKeydown } from '../../src/ui/dispatch.js';

// initDispatch attaches document-level listeners once for the whole file.
beforeAll(() => initDispatch());
afterEach(() => { document.body.innerHTML = ''; });

function fire(el, type) {
  const bubbles = !(type === 'blur' || type === 'focus');
  el.dispatchEvent(new Event(type, { bubbles }));
}

describe('attribute builders', () => {
  it('emits just the handler name when there are no args', () => {
    expect(onClick('doLogout')).toBe('data-act="doLogout"');
  });
  it('emits JSON args with HTML-escaped quotes', () => {
    expect(onChange('setUserRole', 3, '@value'))
      .toBe('data-change="setUserRole" data-change-args="[3,&quot;@value&quot;]"');
  });
  it('escapes string args', () => {
    expect(onClick('f', 'a&b'))
      .toBe('data-act="f" data-act-args="[&quot;a&amp;b&quot;]"');
  });
});

describe('dispatch', () => {
  it('calls the named window handler with parsed literal args', () => {
    const spy = vi.fn();
    window.__t_open = spy;
    document.body.innerHTML = `<button ${onClick('__t_open', 410000, 'rev', 'revenue', -1)}>x</button>`;
    fire(document.querySelector('button'), 'click');
    expect(spy).toHaveBeenCalledWith(410000, 'rev', 'revenue', -1);
  });

  it('resolves @this and @value sentinels against the element', () => {
    const spy = vi.fn();
    window.__t_role = spy;
    document.body.innerHTML = `<select ${onChange('__t_role', 7, '@value')}><option value="admin" selected>a</option></select>`;
    const sel = document.querySelector('select');
    fire(sel, 'change');
    expect(spy).toHaveBeenCalledWith(7, 'admin');
  });

  it('resolves @event and @this for keydown', () => {
    const spy = vi.fn();
    window.__t_key = spy;
    document.body.innerHTML = `<input ${onKeydown('__t_key', '@event', '@this')}>`;
    const inp = document.querySelector('input');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const [evt, el] = spy.mock.calls[0];
    expect(evt).toBeInstanceOf(Event);
    expect(el).toBe(inp);
  });

  it('fires the handler when a child of the data-act element is clicked', () => {
    const spy = vi.fn();
    window.__t_nested = spy;
    document.body.innerHTML = `<div ${onClick('__t_nested')}><span>inner</span></div>`;
    fire(document.querySelector('span'), 'click');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('does nothing (no throw) for an unknown handler', () => {
    document.body.innerHTML = `<button ${onClick('__t_missing_handler')}>x</button>`;
    expect(() => fire(document.querySelector('button'), 'click')).not.toThrow();
  });
});
