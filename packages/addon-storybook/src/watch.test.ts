import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CaptureBatch, RenderClassifier } from './watch.js';

describe('RenderClassifier', () => {
  it('ignores the first render, which is the page opening', () => {
    // Otherwise merely opening Storybook kicks off a capture run.
    const c = new RenderClassifier();
    expect(c.rendered()).toBe(false);
  });

  it('treats a render with no preceding navigation as an edit', () => {
    const c = new RenderClassifier();
    c.rendered(); // page load
    expect(c.rendered()).toBe(true);
  });

  it('ignores the render that follows a navigation', () => {
    // Clicking through the sidebar would otherwise recapture every story you
    // look at, which is a run triggered by reading rather than by editing.
    const c = new RenderClassifier();
    c.rendered();
    c.navigated();
    expect(c.rendered()).toBe(false);
  });

  it('treats an edit after a navigation as an edit', () => {
    // Navigate, then save: only the first render is navigation's.
    const c = new RenderClassifier();
    c.rendered();
    c.navigated();
    c.rendered();
    expect(c.rendered()).toBe(true);
  });

  it('does not accumulate navigations', () => {
    // Two navigations then two renders is still one navigation render — the
    // flag is a latch, not a counter.
    const c = new RenderClassifier();
    c.rendered();
    c.navigated();
    c.navigated();
    expect(c.rendered()).toBe(false);
    expect(c.rendered()).toBe(true);
  });
});

describe('CaptureBatch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('captures the union of a burst, once', () => {
    // Saving a shared file rerenders several stories; capturing each
    // separately would run the same work N times.
    const flush = vi.fn();
    const b = new CaptureBatch(flush, 500);
    b.add(['a']);
    b.add(['b']);
    b.add(['a']);
    vi.advanceTimersByTime(500);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0].sort()).toEqual(['a', 'b']);
  });

  it('waits for the burst to stop rather than firing on a timer', () => {
    const flush = vi.fn();
    const b = new CaptureBatch(flush, 500);
    b.add(['a']);
    vi.advanceTimersByTime(400);
    b.add(['b']); // still typing
    vi.advanceTimersByTime(400);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh batch after firing', () => {
    const flush = vi.fn();
    const b = new CaptureBatch(flush, 500);
    b.add(['a']);
    vi.advanceTimersByTime(500);
    b.add(['b']);
    vi.advanceTimersByTime(500);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush.mock.calls[1][0]).toEqual(['b']);
  });

  it('does not fire after cancel, so a timer cannot outlive the iframe', () => {
    const flush = vi.fn();
    const b = new CaptureBatch(flush, 500);
    b.add(['a']);
    b.cancel();
    vi.advanceTimersByTime(1000);
    expect(flush).not.toHaveBeenCalled();
  });
});
