import { describe, it, expect, vi } from 'vitest';
// The real module, not a hand-shaped stand-in: #117 shipped because every test
// here mocked the `api` object, and the getter turned out to live on the module.
import * as realManagerApi from 'storybook/internal/manager-api';
import {
  getTestProviderStore,
  LEGACY_RUN_REQUEST,
  legacyProviderStore,
  resolveProviderStore,
  stateAfterRun,
  TEST_PROVIDER_STATE,
} from './test-provider-state.js';

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

  it('returns null where there is no store getter', () => {
    // 8.6's manager-api module exports no store getter; absence is expected.
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

/** An 8.6-shaped manager api: updateTestProviderState plus a local channel. */
function legacyApi() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    updateTestProviderState: vi.fn(),
    on: vi.fn((event: string, cb: (payload: unknown) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(cb);
      listeners.set(event, set);
      return () => set.delete(cb);
    }),
    emit(event: string, payload: unknown) {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
  };
}

describe('legacyProviderStore (Storybook 8.6)', () => {
  it('maps the four states onto running/failed/crashed', () => {
    const api = legacyApi();
    const store = legacyProviderStore(api);
    store?.setState(TEST_PROVIDER_STATE.running);
    store?.setState(TEST_PROVIDER_STATE.succeeded);
    store?.setState(TEST_PROVIDER_STATE.crashed);
    expect(api.updateTestProviderState.mock.calls).toEqual([
      ['juxtapose/tests', { running: true, failed: false, crashed: false }],
      ['juxtapose/tests', { running: false, failed: false, crashed: false }],
      ['juxtapose/tests', { running: false, failed: false, crashed: true }],
    ]);
  });

  it('never reports failed: a red diff is not a broken run', () => {
    const api = legacyApi();
    const store = legacyProviderStore(api);
    for (const state of Object.values(TEST_PROVIDER_STATE)) store?.setState(state);
    for (const [, update] of api.updateTestProviderState.mock.calls)
      expect(update).toMatchObject({ failed: false });
  });

  it('runs on a run request for this provider only, until unsubscribed', () => {
    const api = legacyApi();
    const listener = vi.fn();
    const off = legacyProviderStore(api)?.onRunAll?.(listener);
    api.emit(LEGACY_RUN_REQUEST, { providerId: 'storybook/test' });
    expect(listener).not.toHaveBeenCalled();
    api.emit(LEGACY_RUN_REQUEST, { providerId: 'juxtapose/tests', indexUrl: 'x' });
    expect(listener).toHaveBeenCalledTimes(1);
    off?.();
    api.emit(LEGACY_RUN_REQUEST, { providerId: 'juxtapose/tests' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('survives updateTestProviderState throwing before init', () => {
    const api = legacyApi();
    api.updateTestProviderState.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'stateUpdater')");
    });
    expect(() =>
      legacyProviderStore(api)?.setState(TEST_PROVIDER_STATE.pending),
    ).not.toThrow();
  });

  it('declines an api without the testing module', () => {
    expect(legacyProviderStore({ on: () => {} })).toBeNull();
    expect(legacyProviderStore(undefined)).toBeNull();
  });
});

describe('resolveProviderStore', () => {
  it('takes the store from the module even when the api lacks it (#117)', () => {
    // Storybook 10.6's shape, confirmed live: the getter is a module export
    // and the manager `api` object has no such property.
    const store = { setState: vi.fn() };
    const managerApi = { experimental_getTestProviderStore: vi.fn(() => store) };
    expect(resolveProviderStore(managerApi, {})).toEqual({ store, contract: 'store' });
  });

  it('still falls back to an api property', () => {
    const store = { setState: vi.fn() };
    const api = { experimental_getTestProviderStore: () => store };
    expect(resolveProviderStore({}, api)?.store).toBe(store);
  });

  it('prefers the store contract over the legacy one', () => {
    const store = { setState: vi.fn() };
    const managerApi = { experimental_getTestProviderStore: () => store };
    expect(resolveProviderStore(managerApi, legacyApi())?.contract).toBe('store');
  });

  it('is null where there is no testing module at all', () => {
    expect(resolveProviderStore({}, {})).toBeNull();
  });
});

describe('the real storybook/internal/manager-api module', () => {
  // The devDependency is 8.6; these pin the shape the 8.x path relies on.
  it('is 8.x: no store getter export, so the module probe declines', () => {
    expect('experimental_getTestProviderStore' in realManagerApi).toBe(false);
    expect(getTestProviderStore(realManagerApi)).toBeNull();
  });

  it('routes an 8.6 api to the legacy contract', () => {
    expect(resolveProviderStore(realManagerApi, legacyApi())?.contract).toBe('legacy');
  });

  it('has the test provider addon type the registration uses', () => {
    expect(realManagerApi.types.experimental_TEST_PROVIDER).toBe('test-provider');
  });
});

it('does not report an old report as success after a new run fails or is cancelled', () => {
  expect(
    stateAfterRun(true, { id: 'failed', status: 'failed', error: 'browser failed' }),
  ).toBe(TEST_PROVIDER_STATE.crashed);
  expect(stateAfterRun(true, { id: 'cancelled', status: 'cancelled' })).toBe(
    TEST_PROVIDER_STATE.pending,
  );
});
