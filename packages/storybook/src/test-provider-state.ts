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

/** Shapes Storybook has exposed the store getter under. */
interface StoreHost {
  experimental_getTestProviderStore?: (id: string) => unknown;
  getTestProviderStore?: (id: string) => unknown;
}

export const TEST_PROVIDER_ID = 'juxtapose/tests';

/**
 * Probe for the provider store.
 *
 * Storybook 10 exposes `experimental_getTestProviderStore`; the prefix is an
 * explicit warning it will move again. Returning null is the expected outcome
 * on 8 and 9, which have no test panel at all — verified against the published
 * packages, where 8.6's manager-api exports nothing test-related. So a miss is
 * silent rather than a warning.
 */
export function getTestProviderStore(api: unknown): ProviderStore | null {
  const host = api as StoreHost | undefined;
  const get = host?.experimental_getTestProviderStore ?? host?.getTestProviderStore;
  if (typeof get !== 'function') return null;

  try {
    const store = get.call(host, TEST_PROVIDER_ID);
    return isProviderStore(store) ? store : null;
  } catch {
    return null;
  }
}

/** A narrowing type guard, so callers get a real ProviderStore rather than a
 *  cast through `unknown`. */
function isProviderStore(value: unknown): value is ProviderStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ProviderStore).setState === 'function'
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
export function stateAfterRun(hasReport: boolean): TestProviderStateValue {
  return hasReport ? TEST_PROVIDER_STATE.succeeded : TEST_PROVIDER_STATE.crashed;
}
