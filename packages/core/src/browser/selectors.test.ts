import { describe, it, expect } from 'vitest';
import {
  isCssSelector,
  assertCssSelector,
  QUERY_ALL_SOURCE,
  queryAllExpression,
} from './selectors.js';

describe('isCssSelector', () => {
  it('accepts CSS', () => {
    for (const s of [
      '[data-testid="clock"]',
      'div > span.x:nth-child(2)',
      '#id',
      'a:not(.b)',
      'x-foo::part(bar)',
    ]) {
      expect(isCssSelector(s), s).toBe(true);
    }
  });
  it('rejects Playwright-only syntax', () => {
    const bad = [
      'text=Clock',
      'div >> span',
      'css=div',
      'xpath=//a',
      'div:has-text("x")',
      'div:visible',
      'nth=1',
      'internal:role=button',
      'div:text("x")',
      'div:nth-match(x, 1)',
      ':light(.x)',
    ];
    for (const s of bad) expect(isCssSelector(s), s).toBe(false);
  });
  it('assertCssSelector names the selector', () => {
    expect(() => assertCssSelector('text=Clock')).toThrow(
      "jux: selector 'text=Clock' is not a CSS selector",
    );
  });
  it('queryAllExpression embeds the selector and the body with json-safe args', () => {
    const expr = queryAllExpression('.a"b', 'return els.length + a0.length;', 'data-x');
    expect(expr).toContain(QUERY_ALL_SOURCE);
    expect(expr).toContain(JSON.stringify('.a"b'));
    expect(expr).toContain('"data-x"');
    expect(expr).toMatch(
      /^\(function \(els, a0\) \{ return els\.length \+ a0\.length; \}\)/,
    );
  });
});

describe('isCssSelector edge cases', () => {
  it('ignores Playwright-looking text inside quoted attribute values', () => {
    for (const s of ['[title=">>"]', "[data-x='text=a']", '[aria-label="a:visible"]'])
      expect(isCssSelector(s), s).toBe(true);
  });
  it('catches underscore engines like _react= and _vue=', () => {
    for (const s of ['_react=Button', '_vue=list-item'])
      expect(isCssSelector(s), s).toBe(false);
  });
});
