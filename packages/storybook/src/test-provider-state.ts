import type { ReviewRun } from '@juxtapose/server';

// The test provider's decisions, with no Storybook imports.
//
// Split from test-provider.tsx so the rules below can be tested without a DOM:
// importing Storybook's component library pulls in code that touches
// `document` at module load, which is fine in a browser and fatal in vitest.

/**
 * Storybook's provider states.
 *
 * The `test-provider-state:` prefix is required — the bare words are silently
 * ignored, leaving the provider looking idle forever. Taken from the
 * TestProviderState union in Storybook 10.5's published types.
 */
export const TEST_PROVIDER_STATE = {
  pending: 'test-provider-state:pending',
  running: 'test-provider-state:running',
  succeeded: 'test-provider-state:succeeded',
  crashed: 'test-provider-state:crashed',
} as const;

export type TestProviderStateValue =
  (typeof TEST_PROVIDER_STATE)[keyof typeof TEST_PROVIDER_STATE];

/** The subset of Storybook's provider store this addon uses. */
export interface ProviderStore {
  setState(state: TestProviderStateValue): void;
  onRunAll?(listener: () => void): () => void;
}

export const TEST_PROVIDER_ID = 'juxtapose/tests';

/**
 * Probe one object for the provider store getter.
 *
 * On Storybook 10 the getter is a *module export* of `storybook/manager-api`
 * (`experimental_getTestProviderStore`), not a property of the manager `api`
 * handed to `addons.register`. Probing only the `api` object was #117: it
 * returned null on 10.6 and the provider never registered. So callers pass the
 * module namespace first and the `api` object as a fallback; the prefix is an
 * explicit warning the getter will move again.
 */
export function getTestProviderStore(source: unknown): ProviderStore | null {
  if (typeof source !== 'object' || source === null) return null;
  const get =
    ('experimental_getTestProviderStore' in source
      ? source.experimental_getTestProviderStore
      : undefined) ??
    ('getTestProviderStore' in source ? source.getTestProviderStore : undefined);
  if (typeof get !== 'function') return null;

  try {
    const store: unknown = get.call(source, TEST_PROVIDER_ID);
    return isProviderStore(store) ? store : null;
  } catch {
    return null;
  }
}

/**
 * Storybook 8.5-8.6's run request, emitted on the manager channel when the
 * testing module's "Run tests" button runs a provider. The channel delivers a
 * manager emit to manager listeners too, so the addon hears its own UI.
 */
export const LEGACY_RUN_REQUEST = 'testingModuleRunRequest';

interface LegacyTestingApi {
  updateTestProviderState(id: string, update: LegacyStateUpdate): void;
  /** 8.6 returns the unsubscribe; `off` covers a channel that does not. */
  on(event: string, listener: (payload: unknown) => void): (() => void) | undefined;
  off?(event: string, listener: (payload: unknown) => void): void;
}

/** The fields of 8.x's Addon_TestProviderState this addon drives. */
export interface LegacyStateUpdate {
  running: boolean;
  failed: boolean;
  crashed: boolean;
}

const LEGACY_STATE: Record<TestProviderStateValue, LegacyStateUpdate> = {
  [TEST_PROVIDER_STATE.pending]: { running: false, failed: false, crashed: false },
  [TEST_PROVIDER_STATE.running]: { running: true, failed: false, crashed: false },
  [TEST_PROVIDER_STATE.succeeded]: { running: false, failed: false, crashed: false },
  [TEST_PROVIDER_STATE.crashed]: { running: false, failed: false, crashed: true },
};

function isLegacyTestingApi(api: unknown): api is LegacyTestingApi {
  return (
    typeof api === 'object' &&
    api !== null &&
    'updateTestProviderState' in api &&
    typeof api.updateTestProviderState === 'function' &&
    'on' in api &&
    typeof api.on === 'function'
  );
}

/**
 * Storybook 8.x's store-less contract, adapted to the ProviderStore the row
 * already speaks.
 *
 * 8.6 has no provider store: its manager `api` carries
 * `updateTestProviderState(id, { running, failed, crashed })`, and "Run tests"
 * arrives as a channel event naming the provider. Verified live on 8.6.18;
 * 8.5.0's published types match. 8.4 declares the addon type but has no
 * `updateTestProviderState`, so it declines here and registration is a
 * no-op. Mapping onto the same four states keeps the row identical.
 */
export function legacyProviderStore(api: unknown): ProviderStore | null {
  if (!isLegacyTestingApi(api)) return null;
  return {
    setState(state) {
      try {
        api.updateTestProviderState(TEST_PROVIDER_ID, LEGACY_STATE[state]);
      } catch {
        // 8.6 reads the provider's entry unguarded; before its testing module
        // has initialised there is none, and a state update is not worth a throw.
      }
    },
    onRunAll(listener) {
      const onRequest = (payload: unknown) => {
        if (
          typeof payload === 'object' &&
          payload !== null &&
          'providerId' in payload &&
          payload.providerId === TEST_PROVIDER_ID
        )
          listener();
      };
      const off = api.on(LEGACY_RUN_REQUEST, onRequest);
      return () => {
        if (typeof off === 'function') off();
        else api.off?.(LEGACY_RUN_REQUEST, onRequest);
      };
    },
  };
}

/** Which registration contract the running Storybook speaks. */
export type ProviderContract = 'store' | 'legacy';

/**
 * Find the provider store, newest contract first.
 *
 * `managerApi` is the `storybook/manager-api` module namespace; `api` is the
 * object `addons.register` hands over. Null means this Storybook has no test
 * providers at all, which is a silent no-op rather than an error.
 */
export function resolveProviderStore(
  managerApi: unknown,
  api: unknown,
): { store: ProviderStore; contract: ProviderContract } | null {
  const store = getTestProviderStore(managerApi) ?? getTestProviderStore(api);
  if (store) return { store, contract: 'store' };
  const legacy = legacyProviderStore(api);
  return legacy ? { store: legacy, contract: 'legacy' } : null;
}

/** A narrowing type guard, so callers get a real ProviderStore rather than a
 *  cast through `unknown`. */
function isProviderStore(value: unknown): value is ProviderStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    'setState' in value &&
    typeof value.setState === 'function'
  );
}

/**
 * The state to report once a run finishes.
 *
 * Deliberately NOT `crashed` when stories fail. A failing visual diff is a
 * per-story result — it belongs in the sidebar and the panel, not here.
 * `crashed` means the run itself broke: the browser would not launch, the
 * server is unreachable. Conflating the two makes an ordinary red diff look
 * like the tool is broken, which trains people to ignore the state entirely.
 */
export function stateAfterRun(
  hasReport: boolean,
  run?: ReviewRun,
): TestProviderStateValue {
  if (run?.status === 'failed') return TEST_PROVIDER_STATE.crashed;
  if (run?.status === 'cancelled') return TEST_PROVIDER_STATE.pending;
  return hasReport ? TEST_PROVIDER_STATE.succeeded : TEST_PROVIDER_STATE.crashed;
}
