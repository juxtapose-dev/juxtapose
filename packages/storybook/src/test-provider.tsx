// Registers juxtapose as a Storybook test provider, so it appears in the
// built-in testing module and participates in "Run tests".
//
// Two contracts, verified live on 10.6 and 8.6 by
// scripts/check-test-provider.mjs (#117):
// - Storybook 9 and 10: a provider store from the `storybook/manager-api`
//   module export `experimental_getTestProviderStore`. It is NOT on the `api`
//   object `addons.register` passes, which is why reading it there left the
//   provider unregistered on 10.6. 9.0's published module exports the same.
// - Storybook 8.5-8.6: no store. The manager `api` carries
//   `updateTestProviderState`, and "Run tests" is a channel event.
// Anything else (8.4 and earlier) degrades to a silent no-op.
//
// The decisions live in test-provider-state.ts, which has no Storybook
// imports and is therefore testable without a DOM.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { addons, managerApi, types, styled } from './storybook.js';
import { mutedColor } from './theme.js';
import { fetchBundle, fetchProgress, startRun, type Bundle } from './api.js';
import {
  resolveProviderStore,
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
  color: mutedColor(theme),
}));

/**
 * Register the provider, if this Storybook has test providers at all.
 *
 * Returns whether it registered, so callers can stay quiet on versions where
 * absence is expected.
 */
export function registerTestProvider(api: unknown): boolean {
  const resolved = resolveProviderStore(managerApi, api);
  if (!resolved) return false;
  const { store, contract } = resolved;
  const render = () => <TestProviderRow store={store} />;

  // Storybook 8's declared type for a TEST_PROVIDER addon is the legacy shape
  // (`name`, `runnable`), and that is what 8.6 needs at run time: without
  // `runnable` its "Run tests" button skips the provider. 10 takes only
  // `type` and `render`. Narrowing the *parameter* rather than casting the
  // whole object keeps the render function and type field checked.
  const add = addons.add.bind(addons) as (id: string, addon: TestProviderAddon) => void;
  add(
    TEST_PROVIDER_ID,
    contract === 'legacy'
      ? { type: types.experimental_TEST_PROVIDER, name: 'Visual', runnable: true, render }
      : { type: types.experimental_TEST_PROVIDER, render },
  );

  return true;
}

/** What Storybook accepts for a test provider: 10's shape, plus 8.6's extras. */
interface TestProviderAddon {
  type: unknown;
  render: () => React.ReactElement;
  name?: string;
  runnable?: boolean;
}

const TestProviderRow: React.FC<{ store: ProviderStore }> = ({ store }) => {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const starting = useRef(false);
  const settledRun = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    const next = await fetchBundle().catch(() => null);
    if (next) setBundle(next);
    return next;
  }, []);

  const run = useCallback(async () => {
    if (starting.current || running) return;
    starting.current = true;
    setError(null);
    setRunning(true);
    store.setState(TEST_PROVIDER_STATE.running);
    try {
      await startRun();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Failing to *start* is a genuine crash — nothing will follow it.
      store.setState(TEST_PROVIDER_STATE.crashed);
      setRunning(false);
    } finally {
      starting.current = false;
    }
  }, [store, running]);

  // Storybook's "run all tests" should run us too. This is the whole reason to
  // be a provider rather than just another panel.
  useEffect(() => {
    if (!store.onRunAll) return;
    return store.onRunAll(() => void run());
  }, [store, run]);

  useEffect(() => {
    let cancelled = false;
    let polling = false;

    const tick = async () => {
      if (cancelled || polling || starting.current) return;
      polling = true;
      const progress = await fetchProgress().catch(() => null);
      if (!progress || cancelled) {
        polling = false;
        return;
      }

      if (progress.running) {
        setRunning(true);
        store.setState(TEST_PROVIDER_STATE.running);
        polling = false;
        return;
      }

      if (running || (progress.run && progress.run.id !== settledRun.current)) {
        const next = await refresh();
        if (cancelled) return;
        // Report fetching hashes approved images; do it once per terminal run,
        // not on every cheap progress poll. Retry if the bundle was unavailable.
        if (next) settledRun.current = progress.run?.id;
        setRunning(false);
        setError(
          progress.run?.status === 'failed'
            ? (progress.run.error ?? 'Latest run failed')
            : null,
        );
        store.setState(stateAfterRun(Boolean(next?.report), progress.run));
      }
      polling = false;
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
      ) : error ? (
        <Muted role="alert">{error}</Muted>
      ) : bundle?.run?.status === 'cancelled' ? (
        <Muted>cancelled</Muted>
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
