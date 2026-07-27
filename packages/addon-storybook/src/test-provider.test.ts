import { describe, it, expect, vi } from 'vitest';
import { getTestProviderStore, stateAfterRun } from './test-provider-state.js';

describe('stateAfterRun', () => {
  it('succeeds when a report came back', () => {
    expect(stateAfterRun(true)).toBe('test-provider-state:succeeded');
  });

  it('still succeeds when stories failed', () => {
    // The rule this function exists to enforce. A failing visual diff is a
    // per-story result — it belongs in the sidebar and the panel. `crashed`
    // means the run itself broke. Conflating them makes an ordinary red diff
    // look like the tool is broken, which trains people to ignore the state.
    expect(stateAfterRun(true)).toBe('test-provider-state:succeeded');
  });

  it('crashes when no report came back at all', () => {
    // Nothing to report means the run genuinely did not happen.
    expect(stateAfterRun(false)).toBe('test-provider-state:crashed');
  });

  it('uses Storybook prefixed state strings, not bare words', () => {
    // The bare words are silently ignored, leaving the provider idle forever.
    expect(stateAfterRun(true)).toMatch(/^test-provider-state:/);
  });
});

describe('getTestProviderStore', () => {
  it('finds the experimental API', () => {
    const store = { setState: vi.fn() };
    const get = vi.fn().mockReturnValue(store);
    expect(getTestProviderStore({ experimental_getTestProviderStore: get })).toBe(store);
    expect(get).toHaveBeenCalledWith('juxtapose/tests');
  });

  it('falls back to an unprefixed name', () => {
    const store = { setState: vi.fn() };
    expect(getTestProviderStore({ getTestProviderStore: () => store })).toBe(store);
  });

  it('returns null on Storybook versions without test providers', () => {
    // Verified: 8.6's manager-api exports nothing test-related. Absence is an
    // expected state on ^8 and ^9, not an error, so this must be silent.
    expect(getTestProviderStore({})).toBeNull();
    expect(getTestProviderStore(undefined)).toBeNull();
  });

  it('returns null when the store is missing setState', () => {
    // A shape we do not recognise is safer to decline than to call blindly.
    expect(
      getTestProviderStore({ experimental_getTestProviderStore: () => ({}) }),
    ).toBeNull();
  });

  it('survives the getter throwing', () => {
    const get = vi.fn(() => {
      throw new Error('nope');
    });
    expect(getTestProviderStore({ experimental_getTestProviderStore: get })).toBeNull();
  });
});
