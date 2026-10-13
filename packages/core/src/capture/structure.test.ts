import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  decodeStructure,
  effectiveStyle,
  encodeStructure,
  MAX_ELEMENTS,
  normalizeStructure,
  type CdpSnapshot,
} from './structure.js';

// Real Chromium output — regenerate with scripts/capture-structure-fixture.mjs.
const fixture = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, '__fixtures__/structure-basic.cdp.json'),
    'utf8',
  ),
) as { viewport: { width: number; height: number }; raw: CdpSnapshot };
const snap = () => normalizeStructure(fixture.raw, fixture.viewport);
const find = (pred: (e: ReturnType<typeof snap>['elements'][number]) => boolean) =>
  snap().elements.find(pred);

test('keeps visible elements with identity, role and name', () => {
  const save = find((e) => e.testId === 'save');
  expect(save).toMatchObject({
    tag: 'button',
    role: 'button',
    name: 'Save',
    text: 'Save',
  });
  expect(save!.classes).toEqual(['btn', 'primary']);
  expect(save!.path).toBe(
    'html:nth-of-type(1)>body:nth-of-type(1)>main:nth-of-type(1)>button[data-testid="save"]',
  );
  expect(find((e) => e.id === 'title')).toMatchObject({
    tag: 'h1',
    role: 'heading',
    text: 'Settings',
  });
  expect(find((e) => e.tag === 'a')).toMatchObject({ role: 'link', name: 'Help' });
  expect(find((e) => e.tag === 'img')).toMatchObject({
    role: 'img',
    name: 'Logo',
    src: 'logo.png',
  });
  expect(find((e) => e.name === 'Close')).toBeDefined();
});

test('own text excludes child element text', () => {
  const p = find((e) => e.tag === 'p' && (e.text ?? '').startsWith('Hello'));
  expect(p!.text).toBe('Hello world');
  expect(find((e) => e.tag === 'b')!.text).toBe('there');
});

test('drops display:none, visibility:hidden, offscreen, zero-area, html, body', () => {
  const texts = snap().elements.map((e) => e.text);
  expect(texts).not.toContain('gone');
  expect(texts).not.toContain('invisible');
  expect(texts).not.toContain('offscreen');
  expect(snap().elements.some((e) => e.tag === 'html' || e.tag === 'body')).toBe(false);
  expect(snap().elements.some((e) => e.tag === 'span' && e.rect.w === 0)).toBe(false);
});

test('a masked subtree becomes one opaque element', () => {
  const masked = snap().elements.filter((e) => e.tag === 'masked');
  // #masked-area, and the visibility:hidden mask below
  expect(masked).toHaveLength(2);
  expect(snap().elements.map((e) => e.text)).not.toContain('secret');
  expect(snap().elements.map((e) => e.text)).not.toContain('more');
});

test('a hidden mask target never leaks a visible descendant', () => {
  // visibility:hidden on the mask target, visibility:visible on its child: the
  // screenshot mask covers the parent's box, so the child must not be read.
  expect(JSON.stringify(snap())).not.toContain('SECRET-A');
  const masked = snap().elements.filter((e) => e.tag === 'masked');
  expect(masked[1].path).toMatch(/div:nth-of-type\(\d+\)$/);
});

test('iframe is one element; open shadow content is included', () => {
  expect(find((e) => e.tag === 'iframe')).toMatchObject({ role: 'document' });
  expect(snap().elements.map((e) => e.text)).not.toContain('inside');
  expect(find((e) => e.text === 'in shadow')).toBeDefined();
});

test('styles are compact but effectiveStyle reconstructs them', () => {
  const s = snap();
  const i = s.elements.findIndex((e) => e.testId === 'save');
  const save = s.elements[i];
  expect(save.styles['background-color']).toBe('rgb(37, 99, 235)');
  expect(save.styles['padding-top']).toBe('8px');
  expect(save.styles['margin-top']).toBeUndefined(); // initial value, not stored
  expect(effectiveStyle(s, i, 'margin-top')).toBe('0px');
  // inherited: body color is set on body, which is not kept; main stores it
  const main = s.elements.findIndex((e) => e.tag === 'main');
  expect(effectiveStyle(s, main, 'color')).toBe('rgb(17, 24, 39)');
  const p = s.elements.findIndex((e) => e.text === 'One');
  expect(s.elements[p].styles.color).toBeUndefined(); // same as ancestor
  expect(effectiveStyle(s, p, 'color')).toBe('rgb(17, 24, 39)');
});

test('a pseudo-element is an element whose text is its CSS content', () => {
  const before = find((e) => e.tag === '::before');
  expect(before).toMatchObject({ text: '★' });
  expect(before!.styles.color).toBe('rgb(220, 38, 38)');
  expect(before!.styles.content).toBe('"★"');
  // `content` is never stored on a normal element
  expect(
    snap().elements.filter((e) => !e.tag.startsWith('::') && e.styles.content),
  ).toEqual([]);
});

test('SVG paint is captured, inherited-compact like color', () => {
  const s = snap();
  const i = s.elements.findIndex((e) => e.tag === 'circle');
  expect(s.elements[i].styles.fill).toBe('rgb(255, 0, 0)');
  expect(effectiveStyle(s, i, 'stroke')).toBe('none');
});

test("an input's typed value is its text", () => {
  expect(find((e) => e.tag === 'input')).toMatchObject({
    text: 'typed text',
    role: 'textbox',
  });
});

test('a password input is kept but its value is never recorded', () => {
  const pw = find((e) => e.tag === 'input' && e.text === undefined);
  expect(pw).toMatchObject({ role: 'textbox' });
  expect(JSON.stringify(snap())).not.toContain('hunter2');
  // HTML type values are case-insensitive
  expect(JSON.stringify(snap())).not.toContain('hunter3');
});

test('rects are rounded to 0.01px', () => {
  for (const e of snap().elements) {
    for (const v of Object.values(e.rect)) expect(Math.round(v * 100) / 100).toBe(v);
  }
});

test('hash is stable and changes with content', () => {
  expect(snap().structureHash).toBe(snap().structureHash);
  const raw = structuredClone(fixture.raw);
  const i = raw.strings.indexOf('Settings');
  raw.strings[i] = 'Preferences';
  expect(normalizeStructure(raw, fixture.viewport).structureHash).not.toBe(
    snap().structureHash,
  );
});

test('url() in a style records the filename only', () => {
  expect(find((e) => e.id === 'bg')!.styles['background-image']).toBe('url("bg.png")');
});

test('hash does not depend on the origin a url() was served from', () => {
  // `jux run` serves on port 0, so every run has a different origin.
  const raw = structuredClone(fixture.raw);
  const i = raw.strings.indexOf('url("http://127.0.0.1:9/assets/bg.png?v=3#frag")');
  expect(i).toBeGreaterThanOrEqual(0);
  raw.strings[i] = 'url("http://localhost:51234/other/path/bg.png?v=9")';
  expect(normalizeStructure(raw, fixture.viewport).structureHash).toBe(
    snap().structureHash,
  );
});

test('records the document content height, taller than the viewport', () => {
  expect(snap().contentHeight).toBe(fixture.raw.documents[0].contentHeight);
  expect(snap().contentHeight).toBeGreaterThan(fixture.viewport.height);
  // below-fold content is dropped even though the page extends to it
  expect(snap().elements.map((e) => e.text)).not.toContain('below fold');
});

test('gzip round-trips', () => {
  const s = snap();
  expect(decodeStructure(encodeStructure(s))).toEqual(s);
});

test('caps at MAX_ELEMENTS and records the truncation', () => {
  const raw = structuredClone(fixture.raw);
  const doc = raw.documents[0];
  const mainNode = doc.nodes.nodeName.findIndex((n) => raw.strings[n] === 'MAIN');
  const mainRow = doc.layout.nodeIndex.indexOf(mainNode);
  const divName = raw.strings.indexOf('DIV');
  for (let k = 0; k < MAX_ELEMENTS + 10; k++) {
    const idx = doc.nodes.nodeType.length;
    doc.nodes.parentIndex.push(mainNode);
    doc.nodes.nodeType.push(1);
    doc.nodes.nodeName.push(divName);
    doc.nodes.nodeValue.push(-1);
    doc.nodes.attributes.push([]);
    doc.layout.nodeIndex.push(idx);
    doc.layout.styles.push([...doc.layout.styles[mainRow]]);
    doc.layout.bounds.push([10, 10, 5, 5]);
    doc.layout.paintOrders?.push(1);
  }
  const s = normalizeStructure(raw, fixture.viewport);
  expect(s.elements).toHaveLength(MAX_ELEMENTS);
  expect(s.truncated!.kept).toBe(MAX_ELEMENTS);
  expect(s.truncated!.total).toBeGreaterThan(MAX_ELEMENTS);
});
