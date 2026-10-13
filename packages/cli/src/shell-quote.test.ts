import { expect, test } from 'vitest';
import { shellQuote } from './shell-quote.js';

test('safe values stay bare; anything else is single-quoted', () => {
  expect(shellQuote('before-op-color')).toBe('before-op-color');
  expect(shellQuote('http://127.0.0.1:4777/p/a.html')).toBe(
    'http://127.0.0.1:4777/p/a.html',
  );
  expect(shellQuote('a b')).toBe("'a b'");
  expect(shellQuote("x'y")).toBe("'x'\\''y'");
});
