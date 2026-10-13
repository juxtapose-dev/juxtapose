// The review panel.
//
// Built from Storybook's own components and theme on purpose: this is an addon,
// and it should look like part of Storybook rather than a guest application
// with its own opinions about type and colour.
//
// It is also deliberately not a story browser. Storybook's sidebar already does
// that job; the panel shows the selected story and gets out of the way.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { styled, Badge, Button, EmptyTabContent, Loader } from './storybook.js';
// Deep import on purpose: '@juxtapose/core' reaches sharp and playwright
// through the capture modules, and this file is bundled for the browser.
import { formatPercent } from '@juxtapose/core/format';
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
  type Bundle,
} from './api.js';
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

const Body = styled.div({ padding: 12, overflow: 'auto', flex: 1 });

const Spacer = styled.div({ flex: 1 });

const Muted = styled.span(({ theme }) => ({
  color: theme.textMutedColor,
  fontSize: 12,
}));

const Stat = styled.span(({ theme }) => ({
  font: `600 12px/1 ${theme.typography.fonts.base}`,
  color: theme.textMutedColor,
}));

const ModeGroup = styled.div({ display: 'flex', gap: 2 });

const Note = styled.span(({ theme }) => ({
  color: theme.textMutedColor,
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
  const [mode, setMode] = useState<ViewMode>('sxs');
  const [showDiff, setShowDiff] = useState(true);
  const [unfocus, setUnfocus] = useState(false);
  const [loupe, setLoupe] = useState(false);
  const [version, setVersion] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchBundle();
      setBundle(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Poll only while the panel is visible. A background tab has no business
  // hitting the server every two seconds.
  useEffect(() => {
    if (!active) return;
    void refresh();
    const id = setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [active, refresh]);

  // A faster poll while capturing, so the progress readout feels live.
  useEffect(() => {
    if (!progress.running && !bundle?.running) return;
    const id = setInterval(async () => {
      const p = await fetchProgress().catch(() => null);
      if (!p) return;
      setProgress({ done: p.done, total: p.total, running: p.running });
      if (!p.running) {
        // Bump the cache-buster so freshly captured images actually load.
        setVersion((v) => v + 1);
        void refresh();
      }
    }, PROGRESS_POLL_MS);
    return () => clearInterval(id);
  }, [progress.running, bundle?.running, refresh]);

  const report = bundle?.report ?? null;
  const approved = useMemo(() => bundle?.approved ?? [], [bundle]);
  const pending = useMemo(() => needsReview(report, approved), [report, approved]);

  const result: DiffResult | undefined = useMemo(
    () => report?.results.find((r) => r.storyId === storyId),
    [report, storyId],
  );
  const isApproved = storyId !== null && approved.includes(storyId);

  // Only a failing story has two meaningfully different images. `pass` means
  // they are byte-identical and `new` has no baseline at all, so in both cases
  // the comparison modes would be comparing something against nothing.
  const hasComparison = result?.status === 'fail';

  const subThreshold = isSubThreshold(result);

  // Approving is only meaningful when there is something to accept: a changed
  // capture, a first baseline, or a re-anchor after a stale one. For a passing
  // story it would write back bytes already on disk.
  const canApprove =
    result?.status === 'fail' || result?.status === 'new' || result?.status === 'stale';

  const run = useCallback(async (ids?: string[]) => {
    setBusy(true);
    try {
      await startRun(ids);
      setProgress({ done: 0, total: ids?.length ?? 0, running: true });
    } finally {
      setBusy(false);
    }
  }, []);

  const approve = useCallback(async () => {
    if (!storyId) return;
    setBusy(true);
    try {
      await approveStory(storyId);
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [storyId, refresh]);

  const approveAll = useCallback(async () => {
    setBusy(true);
    try {
      // Sequential on purpose. The server serializes these anyway, and firing
      // them in parallel just makes a failure harder to attribute.
      for (const item of pending) await approveStory(item.storyId).catch(() => {});
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [pending, refresh]);

  const copyHandoff = useCallback(async () => {
    if (!storyId) return;
    const text = await fetchHandoff(storyId).catch(() => null);
    if (!text) return;
    await navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [storyId]);

  const jump = useCallback(
    (direction: 'next' | 'prev') => {
      const target = adjacentStory(report, approved, storyId, direction);
      if (target) onSelectStory(target);
    },
    [report, approved, storyId, onSelectStory],
  );

  useKeyboardShortcuts(active, {
    j: () => jump('next'),
    k: () => jump('prev'),
    // Gated the same as the button: pressing `a` on a passing story should do
    // nothing rather than silently rewrite an identical baseline.
    a: () => {
      if (canApprove) void approve();
    },
    d: () => setShowDiff((v) => !v),
    u: () => setUnfocus((v) => !v),
    z: () => setLoupe((v) => !v),
    ...Object.fromEntries(MODES.map((m) => [m.key, () => setMode(m.id)])),
  });

  if (!report) {
    return (
      <EmptyTabContent
        title="No run yet"
        description={
          error
            ? `Could not reach juxtapose: ${error}`
            : 'Capture this story to compare it against its baseline.'
        }
        footer={
          <Button size="small" onClick={() => void run()} disabled={busy}>
            Run all stories
          </Button>
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
          disabled={busy}
        >
          Capture story
        </Button>
        <Button size="small" onClick={() => void run()} disabled={busy}>
          Run all
        </Button>
        {progress.running && (
          <>
            <Muted>
              {progress.done}/{progress.total}
            </Muted>
            <Button size="small" onClick={() => void cancelRun()}>
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

      {progress.running && <Loader />}

      <Body>
        {error && <Muted role="alert">{error}</Muted>}

        {!result ? (
          <EmptyTabContent
            title="Not captured"
            description="This story wasn't part of the last run."
            footer={
              <Button size="small" onClick={() => storyId && void run([storyId])}>
                Capture it
              </Button>
            }
          />
        ) : (
          <>
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
                  <ModeGroup>
                    {MODES.map((m) => (
                      <Button
                        key={m.id}
                        size="small"
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
                        variant={showDiff ? 'solid' : 'ghost'}
                        onClick={() => setShowDiff((v) => !v)}
                        title="Toggle diff overlay (d)"
                      >
                        Diff
                      </Button>
                      <Button
                        size="small"
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
                    variant={loupe ? 'solid' : 'ghost'}
                    onClick={() => setLoupe((v) => !v)}
                    title="Magnify pixels under the cursor (z)"
                  >
                    Loupe
                  </Button>
                </>
              ) : (
                <StatusNote status={result.status} />
              )}

              <Spacer />

              {result.status === 'fail' &&
                (subThreshold ? (
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
                  <Button size="small" onClick={() => void approve()} disabled={busy}>
                    Approve (a)
                  </Button>
                ))}

              {/*
                The agent prompt describes what changed and asks for a verdict.
                With nothing changed there is no verdict to reach, so offering
                it would hand someone a prompt about a diff that does not exist.
              */}
              {hasComparison && (
                <Button size="small" variant="ghost" onClick={() => void copyHandoff()}>
                  {copied ? 'Copied' : 'Copy agent prompt'}
                </Button>
              )}
            </Toolbar>

            {result.error && <Muted role="alert">{result.error}</Muted>}

            <Compare
              baselineUrl={
                result.status === 'new'
                  ? null
                  : imageUrl('baseline', result.storyId, version)
              }
              currentUrl={imageUrl('current', result.storyId, version)}
              diffUrl={
                result.status === 'fail' && !subThreshold
                  ? imageUrl('diff', result.storyId, version)
                  : null
              }
              mode={mode}
              showDiff={showDiff}
              unfocus={unfocus}
              loupe={loupe}
            />

            {pending.length > 0 && (
              <Toolbar as="div" style={{ borderBottom: 'none', paddingLeft: 0 }}>
                <Muted>
                  {pending.length} {pending.length === 1 ? 'story needs' : 'stories need'}{' '}
                  review
                </Muted>
                <Button size="small" variant="ghost" onClick={() => jump('next')}>
                  Next (j)
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => void approveAll()}
                  disabled={busy}
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
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
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
