// Registers juxtapose as a Storybook test provider, so it appears in the
// built-in "Run tests" panel and participates in "run all tests".
//
// Storybook 10 only, verified rather than assumed: 8.6's manager-api exports
// nothing test-related at all, while 10.5 exports
// `experimental_getTestProviderStore`, `onRunAll` and `TestProviderStore`.
// The addon supports ^8 || ^9 || ^10, so this degrades to a silent no-op on
// the older majors — there is no test panel to appear in, which is an expected
// state rather than an error.
//
// The decisions live in test-provider-state.ts, which has no Storybook
// imports and is therefore testable without a DOM.

import React, { useCallback, useEffect, useState } from 'react';
import { addons, types, styled } from './storybook.js';
import { fetchBundle, fetchProgress, startRun, type Bundle } from './api.js';
import {
  getTestProviderStore,
  stateAfterRun,
  TEST_PROVIDER_ID,
  TEST_PROVIDER_STATE,
  type ProviderStore,
} from './test-provider-state.js';

const POLL_MS = 2000;

const Row = styled.div({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
});

const Muted = styled.span(({ theme }) => ({
  color: theme.textMutedColor,
}));

/**
 * Register the provider, if this Storybook has test providers at all.
 *
 * Returns whether it registered, so callers can stay quiet on versions where
 * absence is expected.
 */
export function registerTestProvider(api: unknown): boolean {
  const store = getTestProviderStore(api);
  if (!store) return false;

  // Storybook 8's declared type for a TEST_PROVIDER addon predates the shape
  // 10 accepts, so the compile-time and run-time contracts genuinely differ.
  // We only get here when the 10-era store probe succeeded, so the runtime is
  // the newer one. Narrowing the *parameter* rather than casting the whole
  // object keeps the render function and type field checked.
  const add = addons.add as (id: string, addon: TestProviderAddon) => void;
  add(TEST_PROVIDER_ID, {
    type: types.experimental_TEST_PROVIDER,
    render: () => <TestProviderRow store={store} />,
  });

  return true;
}

/** What Storybook 10 accepts for a test provider. */
interface TestProviderAddon {
  type: unknown;
  render: () => React.ReactElement;
}

const TestProviderRow: React.FC<{ store: ProviderStore }> = ({ store }) => {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [running, setRunning] = useState(false);

  const refresh = useCallback(async () => {
    const next = await fetchBundle().catch(() => null);
    if (next) setBundle(next);
    return next;
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    store.setState(TEST_PROVIDER_STATE.running);
    try {
      await startRun();
    } catch {
      // Failing to *start* is a genuine crash — nothing will follow it.
      store.setState(TEST_PROVIDER_STATE.crashed);
      setRunning(false);
    }
  }, [store]);

  // Storybook's "run all tests" should run us too. This is the whole reason to
  // be a provider rather than just another panel.
  useEffect(() => {
    if (!store.onRunAll) return;
    return store.onRunAll(() => void run());
  }, [store, run]);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      const progress = await fetchProgress().catch(() => null);
      if (!progress) return;

      if (progress.running) {
        setRunning(true);
        return;
      }

      if (running) {
        setRunning(false);
        const next = await refresh();
        store.setState(stateAfterRun(Boolean(next?.report)));
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [running, refresh, store]);

  useEffect(() => {
    void refresh();
    store.setState(TEST_PROVIDER_STATE.pending);
  }, [refresh, store]);

  const s = bundle?.report?.summary;
  const duration = bundle?.report?.durationMs;

  return (
    <Row>
      <strong>Visual</strong>
      {running ? (
        <Muted>running…</Muted>
      ) : s ? (
        <Muted>
          {s.pass} pass
          {s.fail > 0 ? ` · ${s.fail} fail` : ''}
          {s.new > 0 ? ` · ${s.new} new` : ''}
          {s.stale > 0 ? ` · ${s.stale} stale` : ''}
          {duration ? ` · ${(duration / 1000).toFixed(1)}s` : ''}
        </Muted>
      ) : (
        <Muted>not run</Muted>
      )}
    </Row>
  );
};
