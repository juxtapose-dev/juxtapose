// The review panel.
//
// Built from Storybook's own components and theme on purpose: this is an addon,
// and it should look like part of Storybook rather than a guest application
// with its own opinions about type and colour.
//
// It is also deliberately not a story browser. Storybook's sidebar already does
// that job; the panel shows the selected story and gets out of the way.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { styled, Badge, Button, EmptyTabContent, Loader } from './storybook.js';
import { mutedColor } from './theme.js';
import { useReviewState } from './review-state.js';
// Deep import on purpose: '@juxtapose/core' reaches sharp and the browser driver
// through the capture modules, and this file is bundled for the browser.
import { BASELINE_IMAGE_UNAVAILABLE, formatPercent } from '@juxtapose/core/format';
import type { DiffResult, DiffStatus } from '@juxtapose/core';
import {
  approveStory,
  cancelRun,
  fetchBundle,
  fetchHandoff,
  fetchProgress,
  imageUrl,
  isSubThreshold,
  needsReview,
  startRun,
  adjacentStory,
  approvableCaptures,
  approveAllPending,
  approveEach,
  capturesFor,
  describeFailures,
  pickCapture,
  type Bundle,
} from './api.js';
import { ChangeExplanation } from './ChangeExplanation.js';
import { Compare, type ViewMode } from './Compare.js';

const POLL_MS = 2000;
const PROGRESS_POLL_MS = 300;

export interface PanelProps {
  storyId: string | null;
  onSelectStory: (storyId: string) => void;
  active: boolean;
}

const Wrap = styled.div({ height: '100%', display: 'flex', flexDirection: 'column' });

const Toolbar = styled.div(({ theme }) => ({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  borderBottom: `1px solid ${theme.appBorderColor}`,
  flexShrink: 0,
  flexWrap: 'wrap',
}));

const Body = styled.div({ padding: 12, overflow: 'auto', flex: 1, minHeight: 0 });

const Spacer = styled.div({ flex: 1 });

const Muted = styled.span(({ theme }) => ({
  color: mutedColor(theme),
  fontSize: 12,
}));

const Stat = styled.span(({ theme }) => ({
  font: `600 12px/1 ${theme.typography.fonts.base}`,
  color: mutedColor(theme),
}));

const ModeGroup = styled.div({ display: 'flex', flexWrap: 'wrap', gap: 2 });

const Note = styled.span(({ theme }) => ({
  color: mutedColor(theme),
  fontSize: 12,
  fontStyle: 'italic',
}));

// Letters, not digits. Storybook binds bare 1, 2 and 3 to "focus sidebar",
// "focus preview" and "focus panel", and its handler runs first: pressing 2
// for Slider moved focus into the preview iframe, after which every panel
// shortcut (j, a, the other modes) went to the story instead. None of these
// letters has an unmodified Storybook binding.
const MODES: { id: ViewMode; label: string; key: string }[] = [
  { id: 'sxs', label: 'Side by side', key: 's' },
  { id: 'slider', label: 'Slider', key: 'w' },
  { id: 'onion', label: 'Onion', key: 'o' },
  { id: 'flicker', label: 'Flicker', key: 'f' },
];

export const Panel: React.FC<PanelProps> = ({ storyId, onSelectStory, active }) => {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, running: false });
  // Storybook can remount panels when its layout changes. Keep review choices
  // in the manager store, rather than resetting the mode mid-inspection.
  const [mode, setMode] = useReviewState<ViewMode>('juxtapose/review-mode', 'sxs');
  const [showDiff, setShowDiff] = useReviewState('juxtapose/review-diff', false);
  const [unfocus, setUnfocus] = useReviewState('juxtapose/review-unfocus', false);
  const [loupe, setLoupe] = useReviewState('juxtapose/review-loupe', false);
  const request = useRef(0);
  const appliedRequest = useRef(0);
  const visible = useRef(active);
  const action = useRef(false);
  const handoffRequest = useRef(0);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Which variant is shown, remembered per story: switching stories shows the
  // default capture, and a j/k jump can land on a specific variant.
  const [shown, setShown] = useState<{ story: string | null; variant: string | null }>({
    story: null,
    variant: null,
  });

  const refresh = useCallback(async () => {
    const generation = ++request.current;
    try {
      const next = await fetchBundle();
      // A newer request starting must not invalidate every slow response.
      // Only a newer response already applied can make this one stale.
      if (!visible.current || generation <= appliedRequest.current) return;
      appliedRequest.current = generation;
      setBundle(next);
      setConnectionError(null);
    } catch (err) {
      if (!visible.current || generation <= appliedRequest.current) return;
      appliedRequest.current = generation;
      setConnectionError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Poll only while the panel is visible. A background tab has no business
  // hitting the server every two seconds.
  useEffect(() => {
    visible.current = active;
    if (!active) return;
    void refresh();
    const id = setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    return () => {
      visible.current = false;
      appliedRequest.current = ++request.current;
      clearInterval(id);
    };
  }, [active, refresh]);

  // A faster poll while capturing, so the progress readout feels live.
  useEffect(() => {
    if (!active || (!progress.running && !bundle?.running)) return;
    let disposed = false;
    let polling = false;
    let finished = false;
    const tick = async () => {
      if (polling || document.hidden) return;
      polling = true;
      const p = await fetchProgress().catch(() => null);
      polling = false;
      if (!p || disposed) return;
      setProgress({ done: p.done, total: p.total, running: p.running });
      if (!p.running && !finished) {
        finished = true;
        void refresh();
      }
    };
    const id = setInterval(() => void tick(), PROGRESS_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(id);
    };
  }, [active, progress.running, bundle?.running, refresh]);

  const running = progress.running || bundle?.running === true;
  const locked = busy || running;
  const report = bundle?.report ?? null;
  const runError =
    bundle?.run?.status === 'failed'
      ? `Latest run failed: ${bundle.run.error ?? 'Unknown error'}. Capture again to retry. Displayed results are from the previous report.`
      : bundle?.run?.status === 'cancelled'
        ? 'Latest run cancelled. Displayed results may be incomplete or from an earlier run.'
        : null;
  useEffect(() => {
    handoffRequest.current++;
    setHandoff(null);
    setCopied(false);
  }, [storyId, shown, report?.runId]);
  const approved = useMemo(() => bundle?.approved ?? [], [bundle]);
  const pending = useMemo(() => needsReview(report, approved), [report, approved]);

  // Storybook selects a story; the run holds its default capture and one per
  // variant. The panel shows one capture at a time and acts on that one.
  const captures = useMemo(() => capturesFor(report, storyId), [report, storyId]);
  const variant = shown.story === storyId ? shown.variant : null;
  const result: DiffResult | undefined = useMemo(
    () => pickCapture(captures, variant),
    [captures, variant],
  );
  const captureId = result?.storyId ?? null;
  const isApproved = captureId !== null && approved.includes(captureId);
  const version = `${report?.runId ?? 'none'}:${isApproved ? 'approved' : 'pending'}`;
  const variantsToApprove = useMemo(
    () => approvableCaptures(captures, approved),
    [captures, approved],
  );

  // Only a failing story has two meaningfully different images. `pass` means
  // they are byte-identical and `new` has no baseline at all, so in both cases
  // the comparison modes would be comparing something against nothing.
  // Without the baseline image (not in the local cache) there is only the
  // current capture, so the comparison modes have nothing to compare.
  const imageUnavailable = result?.baselineImage === 'unavailable';
  const hasComparison =
    result?.status === 'fail' && !result.error && !imageUnavailable && !isApproved;

  const subThreshold = isSubThreshold(result);

  // Approving is only meaningful when there is something to accept: a changed
  // capture, a first baseline, or a re-anchor after a stale one. For a passing
  // story it would write back bytes already on disk.
  const canApprove = !!result && approvableCaptures([result], []).length > 0;

  const run = useCallback(
    async (ids?: string[]) => {
      if (action.current || running) return;
      action.current = true;
      setBusy(true);
      setError(null);
      try {
        await startRun(ids);
        setProgress({ done: 0, total: ids?.length ?? 0, running: true });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        action.current = false;
        setBusy(false);
      }
    },
    [running, refresh],
  );

  const cancel = useCallback(async () => {
    if (action.current) return;
    action.current = true;
    setBusy(true);
    try {
      await cancelRun();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      action.current = false;
      setBusy(false);
    }
  }, []);

  const approve = useCallback(async () => {
    if (!captureId || !canApprove || isApproved || running || action.current) return;
    action.current = true;
    setBusy(true);
    try {
      await approveStory(captureId);
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      action.current = false;
      setBusy(false);
    }
  }, [captureId, canApprove, isApproved, running, refresh]);

  const approveVariants = useCallback(async () => {
    if (action.current || running) return;
    action.current = true;
    setBusy(true);
    // Every capture is attempted, and the panel refreshes whatever happened:
    // stopping at the first failure left later ones unapproved and the
    // earlier ones still drawn as pending.
    const failed = await approveEach(
      variantsToApprove.map((c) => c.storyId),
      approveStory,
    );
    try {
      await refresh();
    } finally {
      action.current = false;
      setBusy(false);
    }
    setError(failed.length > 0 ? `Could not approve ${describeFailures(failed)}` : null);
  }, [variantsToApprove, running, refresh]);

  const approveAll = useCallback(async () => {
    if (action.current || running) return;
    action.current = true;
    setBusy(true);
    try {
      // Sequential on purpose. The server serializes these anyway, and firing
      // them in parallel just makes a failure harder to attribute. A refusal
      // (an unstable story) is shown, not swallowed.
      const message = await approveAllPending(
        approvableCaptures(pending, approved).map((item) => item.storyId),
        approveStory,
      );
      await refresh();
      setError(message);
    } finally {
      action.current = false;
      setBusy(false);
    }
  }, [pending, approved, running, refresh]);

  const copyHandoff = useCallback(async () => {
    if (!captureId) return;
    setCopied(false);
    const generation = ++handoffRequest.current;
    try {
      const text = await fetchHandoff(captureId);
      if (generation !== handoffRequest.current) return;
      setHandoff(text);
      if (!navigator.clipboard)
        throw new Error('Clipboard unavailable. Select and copy the prompt below.');
      await navigator.clipboard.writeText(text);
      if (generation !== handoffRequest.current) return;
      setCopied(true);
      setError(null);
    } catch (err) {
      if (generation !== handoffRequest.current) return;
      setError(
        `Could not copy prompt: ${err instanceof Error ? err.message : String(err)}. You can select the text below when available.`,
      );
    }
  }, [captureId]);

  // j/k walk captures, not stories: a story with two failing variants is two
  // stops. Landing on a variant selects its story and shows that variant.
  const jump = useCallback(
    (direction: 'next' | 'prev') => {
      const target = adjacentStory(report, approved, captureId ?? storyId, direction);
      const hit = target ? report?.results.find((r) => r.storyId === target) : undefined;
      if (!hit) return;
      const story = hit.baseStoryId ?? hit.storyId;
      setShown({ story, variant: hit.variant ?? null });
      if (story !== storyId) onSelectStory(story);
    },
    [report, approved, captureId, storyId, onSelectStory],
  );

  useKeyboardShortcuts(active, {
    j: () => jump('next'),
    k: () => jump('prev'),
    // Gated the same as the button: pressing `a` on a passing story should do
    // nothing rather than silently rewrite an identical baseline.
    a: () => {
      if (canApprove && !locked && !isApproved) void approve();
    },
    d: () => setShowDiff((v) => !v),
    u: () => setUnfocus((v) => !v),
    z: () => setLoupe((v) => !v),
    ...Object.fromEntries(MODES.map((m) => [m.key, () => setMode(m.id)])),
  });

  if (!report) {
    return (
      <EmptyTabContent
        title={
          running
            ? 'Capturing stories…'
            : !bundle && !connectionError
              ? 'Loading visual results…'
              : connectionError
                ? 'Could not reach juxtapose'
                : 'No run yet'
        }
        description={
          error || connectionError || runError
            ? (error ?? connectionError ?? runError ?? '')
            : 'Capture this story to compare it against its baseline.'
        }
        footer={
          <>
            <Button
              size="small"
              onClick={() => storyId && void run([storyId])}
              disabled={locked || !storyId}
            >
              Capture this story
            </Button>
            <Button size="small" onClick={() => void run()} disabled={locked}>
              Run all stories
            </Button>
            {running && (
              <Button size="small" onClick={() => void cancel()} disabled={busy}>
                Cancel
              </Button>
            )}
          </>
        }
      />
    );
  }

  const s = report.summary;

  return (
    <Wrap>
      <Toolbar>
        <Button
          size="small"
          onClick={() => storyId && void run([storyId])}
          disabled={locked || !storyId}
        >
          Capture story
        </Button>
        <Button size="small" onClick={() => void run()} disabled={locked}>
          Run all
        </Button>
        {running && (
          <>
            <Muted>
              {progress.done}/{progress.total}
            </Muted>
            <Button size="small" onClick={() => void cancel()} disabled={busy}>
              Cancel
            </Button>
          </>
        )}

        <Spacer />

        <Stat>{s.pass} pass</Stat>
        {s.fail > 0 && <Badge status="negative">{s.fail} fail</Badge>}
        {s.new > 0 && <Badge status="warning">{s.new} new</Badge>}
        {s.stale > 0 && <Badge status="warning">{s.stale} stale</Badge>}
      </Toolbar>

      {running && <Loader />}

      <Body>
        {error && <Muted role="alert">{error}</Muted>}
        {connectionError && (
          <p role="alert">Connection lost: {connectionError}. Retrying…</p>
        )}
        {runError && <p role="alert">{runError}</p>}

        {!result ? (
          <EmptyTabContent
            title="Not captured"
            description="This story wasn't part of the last run."
            footer={
              <Button
                size="small"
                disabled={locked || !storyId}
                onClick={() => storyId && void run([storyId])}
              >
                Capture it
              </Button>
            }
          />
        ) : (
          <>
            {captures.length > 1 && (
              <Toolbar as="div" style={{ borderBottom: 'none', paddingLeft: 0 }}>
                <ModeGroup role="group" aria-label="Variant">
                  {captures.map((c) => (
                    <Button
                      key={c.storyId}
                      size="small"
                      aria-pressed={c.storyId === captureId}
                      variant={c.storyId === captureId ? 'solid' : 'ghost'}
                      onClick={() =>
                        setShown({ story: storyId, variant: c.variant ?? null })
                      }
                      title={`${c.variant ?? 'default'}: ${approved.includes(c.storyId) ? 'approved' : c.status}`}
                    >
                      {c.variant ?? 'default'}
                      {c.status !== 'pass' &&
                      c.status !== 'skip' &&
                      !approved.includes(c.storyId)
                        ? ' •'
                        : ''}
                    </Button>
                  ))}
                </ModeGroup>
                <Spacer />
                {variantsToApprove.length > 1 && (
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => void approveVariants()}
                    disabled={locked}
                  >
                    Approve all variants ({variantsToApprove.length})
                  </Button>
                )}
              </Toolbar>
            )}

            <Toolbar as="div" style={{ borderBottom: 'none', paddingLeft: 0 }}>
              {/*
                Comparison controls only exist when there is something to
                compare. Offering Slider, Onion and Flicker for a passing story
                means inviting someone to hunt for a difference between two
                identical images — the controls appear broken rather than
                inapplicable. A story with no baseline has the same problem
                from the other direction: there is nothing to compare against.
              */}
              {hasComparison ? (
                <>
                  <ModeGroup role="group" aria-label="Comparison mode">
                    {MODES.map((m) => (
                      <Button
                        key={m.id}
                        size="small"
                        aria-pressed={mode === m.id}
                        variant={mode === m.id ? 'solid' : 'ghost'}
                        onClick={() => setMode(m.id)}
                        title={`${m.label} (${m.key})`}
                      >
                        {m.label}
                      </Button>
                    ))}
                  </ModeGroup>

                  {mode === 'sxs' && !subThreshold && (
                    <>
                      <Button
                        size="small"
                        aria-pressed={showDiff}
                        variant={showDiff ? 'solid' : 'ghost'}
                        onClick={() => setShowDiff((v) => !v)}
                        title="Toggle diff overlay (d)"
                      >
                        Diff
                      </Button>
                      <Button
                        size="small"
                        aria-pressed={unfocus}
                        variant={unfocus ? 'solid' : 'ghost'}
                        onClick={() => setUnfocus((v) => !v)}
                        title="Dim unchanged areas (u)"
                      >
                        Unfocus
                      </Button>
                    </>
                  )}

                  <Button
                    size="small"
                    aria-pressed={loupe}
                    variant={loupe ? 'solid' : 'ghost'}
                    onClick={() => setLoupe((v) => !v)}
                    title="Magnify pixels under the cursor (z)"
                  >
                    Loupe
                  </Button>
                </>
              ) : result.comparison ? (
                <Note>
                  Visually equivalent under Pixelmatch threshold{' '}
                  {result.comparison.threshold}; exact hashes differ. Approved baseline
                  unchanged.
                </Note>
              ) : (
                <StatusNote status={result.status} />
              )}

              <Spacer />

              {result.status === 'fail' &&
                !isApproved &&
                !result.error &&
                (imageUnavailable ? (
                  <Muted>{BASELINE_IMAGE_UNAVAILABLE}</Muted>
                ) : subThreshold ? (
                  <Muted title="The bytes differ from the baseline, but every pixel is within the diff's colour tolerance, so the overlay has nothing to mark.">
                    Too subtle for the diff overlay. Try Flicker (f)
                  </Muted>
                ) : (
                  <Muted>{formatPercent(result.mismatchPercent)} changed</Muted>
                ))}
              {canApprove &&
                (isApproved ? (
                  <Badge status="positive">Approved</Badge>
                ) : (
                  <Button size="small" onClick={() => void approve()} disabled={locked}>
                    Approve (a)
                  </Button>
                ))}

              {/*
                The agent prompt describes what changed and asks for a verdict.
                With nothing changed there is no verdict to reach, so offering
                it would hand someone a prompt about a diff that does not exist.
              */}
              {result.status === 'fail' && !result.error && !isApproved && (
                <Button size="small" variant="ghost" onClick={() => void copyHandoff()}>
                  {copied ? 'Copied' : 'Copy agent prompt'}
                </Button>
              )}
            </Toolbar>

            {result.error && <Muted role="alert">{result.error}</Muted>}
            {result.unrechecked && (
              <Muted role="status">
                Captured once: approval takes a fresh capture to confirm stability before
                saving a baseline.
              </Muted>
            )}
            {result.unstable && !result.unrechecked && (
              <Muted role="alert">
                {result.unstable.unconfirmed !== undefined
                  ? `Unconfirmed: recheck failed (${result.unstable.unconfirmed})`
                  : 'Unstable: two captures differed; approve refuses it'}
              </Muted>
            )}

            <ChangeExplanation result={result} />
            {handoff && (
              <details open={!copied}>
                <summary>Agent prompt {copied ? '(copied)' : '(select to copy)'}</summary>
                <textarea
                  aria-label="Agent prompt"
                  readOnly
                  value={handoff}
                  rows={8}
                  style={{ width: '100%' }}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </details>
            )}
            {copied && <p role="status">Agent prompt copied.</p>}
            {!result.error && result.status !== 'skip' && (
              <Compare
                key={`${captureId}:${version}`}
                baselineUrl={
                  hasComparison ? imageUrl('baseline', result.storyId, version) : null
                }
                currentUrl={imageUrl('current', result.storyId, version)}
                diffUrl={
                  hasComparison && !subThreshold
                    ? imageUrl('diff', result.storyId, version)
                    : null
                }
                mode={hasComparison ? mode : 'sxs'}
                showDiff={showDiff}
                unfocus={unfocus}
                loupe={hasComparison && loupe}
              />
            )}

            {pending.length > 0 && (
              <Toolbar as="div" style={{ borderBottom: 'none', paddingLeft: 0 }}>
                <Muted>
                  {pending.length}{' '}
                  {pending.some((r) => r.variant !== undefined)
                    ? pending.length === 1
                      ? 'capture needs'
                      : 'captures need'
                    : pending.length === 1
                      ? 'story needs'
                      : 'stories need'}{' '}
                  review
                </Muted>
                <Button size="small" variant="ghost" onClick={() => jump('next')}>
                  Next (j)
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => void approveAll()}
                  disabled={locked || approvableCaptures(pending, approved).length === 0}
                >
                  Approve all
                </Button>
              </Toolbar>
            )}
          </>
        )}
      </Body>
    </Wrap>
  );
};

/**
 * Single-key shortcuts, suppressed where they would be destructive.
 *
 * Typing "a" in a text field must not approve a story, and Cmd-A must still
 * select all — so anything with a modifier or an editable target is ignored.
 */
function useKeyboardShortcuts(
  active: boolean,
  handlers: Record<string, () => void>,
): void {
  useEffect(() => {
    if (!active) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;

      const target = event.target instanceof HTMLElement ? event.target : null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (target?.isContentEditable) return;

      const handler = handlers[event.key];
      if (!handler) return;
      event.preventDefault();
      handler();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, handlers]);
}

/**
 * What to say when there is nothing to compare.
 *
 * Replaces the comparison controls rather than sitting beside them, so the
 * panel states the situation instead of offering tools that would do nothing.
 */
const StatusNote: React.FC<{ status: DiffStatus }> = ({ status }) => {
  switch (status) {
    case 'pass':
      return <Note>Matches the approved baseline.</Note>;
    case 'new':
      return <Note>No baseline yet. Approve this capture to set one.</Note>;
    case 'stale':
      return (
        <Note>
          This baseline was approved on a commit that is not in your history. Re-run, then
          approve to re-anchor it.
        </Note>
      );
    case 'skip':
      return <Note>This story opts out of capture.</Note>;
    default:
      return null;
  }
};
