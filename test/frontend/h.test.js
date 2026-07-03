import { describe, it, expect, vi } from 'vitest';
import { h, escapeHtml } from '../../src/ui/h.js';

describe('h()', () => {
  it('creates an element with text children as escaped text nodes', () => {
    const el = h('div', { class: 'box' }, 'hello');
    expect(el.tagName).toBe('DIV');
    expect(el.className).toBe('box');
    expect(el.textContent).toBe('hello');
  });

  it('never parses text children as HTML (XSS-safe)', () => {
    const el = h('div', {}, '<img src=x onerror=alert(1)>');
    // Stored verbatim as text, not as a child element:
    expect(el.children.length).toBe(0);
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(el.innerHTML).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('sets plain attributes and skips null/false', () => {
    const el = h('a', { href: '/x', title: null, hidden: false });
    expect(el.getAttribute('href')).toBe('/x');
    expect(el.hasAttribute('title')).toBe(false);
    expect(el.hasAttribute('hidden')).toBe(false);
  });

  it('renders true as a boolean attribute', () => {
    const el = h('input', { disabled: true });
    expect(el.getAttribute('disabled')).toBe('');
  });

  it('applies dataset', () => {
    const el = h('div', { dataset: { foo: 'bar', n: '1' } });
    expect(el.dataset.foo).toBe('bar');
    expect(el.dataset.n).toBe('1');
  });

  it('wires on<Event> function attrs via addEventListener', () => {
    const spy = vi.fn();
    const el = h('button', { onClick: spy });
    el.dispatchEvent(new Event('click'));
    expect(spy).toHaveBeenCalledOnce();
  });

  it('appends Node children and flattens arrays; skips nullish', () => {
    const child = h('span', {}, 'x');
    const el = h('div', {}, [child, null, false], 'y');
    expect(el.childNodes.length).toBe(2); // span + text 'y'
    expect(el.firstChild).toBe(child);
    expect(el.textContent).toBe('xy');
  });
});

describe('escapeHtml()', () => {
  it('escapes all five HTML-significant chars including the single quote', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`))
      .toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
  it('renders nullish as empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});
