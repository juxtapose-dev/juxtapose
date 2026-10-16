// The comparison surface: four ways of looking at the same pair of images.
//
// Each mode answers a different question, which is why one isn't enough:
//   side-by-side  what changed, with the diff highlighted
//   slider        did this element move, or did the whole layout shift
//   onion         subtle colour and weight changes a diff overlay hides
//   flicker       small movement, which the eye catches instantly in motion

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { styled, Button } from './storybook.js';
import { mutedColor } from './theme.js';
import { Loupe } from './Loupe.js';

export type ViewMode = 'sxs' | 'slider' | 'onion' | 'flicker';

export interface CompareProps {
  baselineUrl: string | null;
  currentUrl: string;
  diffUrl: string | null;
  mode: ViewMode;
  showDiff: boolean;
  /** Desaturate the unchanged parts so the eye goes to what moved. */
  unfocus: boolean;
  /** Magnify pixels under the cursor. Orthogonal to `mode`: a 1px shift is
   *  unreadable at 1:1 whichever way the pair is being shown. */
  loupe?: boolean;
}

// A single-image mode uses one side-by-side column's scale so changing modes
// doesn't enlarge a capture beyond the panel. On narrow panels it needs the
// whole width to remain readable; query the panel, not the browser viewport.
const Surface = styled.div<{ paired: boolean; comparing: boolean }>(
  ({ paired, comparing }) => ({
    width: comparing && !paired ? 'calc((100% - 12px) / 2)' : '100%',
    maxWidth: paired ? 1600 : comparing ? 794 : 800,
    margin: '0 auto',
    '@container (max-width: 700px)': { width: '100%' },
  }),
);

const Frame = styled.div({
  position: 'relative',
  overflow: 'hidden',
  background:
    'repeating-conic-gradient(rgba(0,0,0,.04) 0% 25%, transparent 0% 50%) 50% / 16px 16px',
  borderRadius: 6,
  boxShadow: '0 0 0 1px rgba(128,128,128,.18)',
  lineHeight: 0,
});

const Img = styled.img({
  display: 'block',
  width: '100%',
  height: 'auto',
});

const Layer = styled.img<{ opacity?: number }>(({ opacity }) => ({
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: 'auto',
  opacity: opacity ?? 1,
  pointerEvents: 'none',
}));

const Pair = styled.div({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
  gap: 12,
  alignItems: 'start',
});

const Caption = styled.div(({ theme }) => ({
  font: `500 11px/1.4 ${theme.typography.fonts.base}`,
  color: mutedColor(theme),
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  marginBottom: 6,
}));

const Handle = styled.div(({ theme }) => ({
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: 2,
  background: theme.color.secondary,
  cursor: 'ew-resize',
  '&::after': {
    content: '""',
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: 22,
    height: 22,
    transform: 'translate(-50%, -50%)',
    borderRadius: '50%',
    background: theme.color.secondary,
  },
}));

const UNFOCUS = 'saturate(0.15) brightness(0.6)';

/**
 * Controls sit above their image, never below.
 *
 * A capture is often taller than the panel, so anything rendered after it is
 * off-screen — which meant the slider you need to drive Onion and Flicker was
 * the one thing you could not reach without scrolling past the image.
 */
const Controls = styled.label({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 8,
  minHeight: 28,
  fontSize: 12,
});

export const Compare: React.FC<CompareProps> = (props) => {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  if (failed)
    return (
      <div role="alert">
        A capture image could not be loaded. Capture the story again, or{' '}
        <Button
          size="small"
          onClick={() => {
            setAttempt((n) => n + 1);
            setFailed(false);
          }}
        >
          Retry images
        </Button>
      </div>
    );
  const retryUrl = (url: string | null) => url && `${url}&retry=${attempt}`;
  return (
    <div
      style={{ containerType: 'inline-size' }}
      onErrorCapture={(event) => {
        if (event.target instanceof HTMLImageElement) setFailed(true);
      }}
    >
      <Surface
        paired={props.mode === 'sxs' && !!props.baselineUrl}
        comparing={!!props.baselineUrl}
      >
        <ComparisonImages
          {...props}
          baselineUrl={retryUrl(props.baselineUrl)}
          currentUrl={retryUrl(props.currentUrl)!}
          diffUrl={retryUrl(props.diffUrl)}
        />
      </Surface>
    </div>
  );
};

const ComparisonImages: React.FC<CompareProps> = ({
  baselineUrl,
  currentUrl,
  diffUrl,
  mode,
  showDiff,
  unfocus,
  loupe = false,
}) => {
  // The lens magnifies the capture under review. Baseline is what the story
  // used to look like; `current` is what the reviewer is deciding about.
  const magnify = (node: React.ReactNode) =>
    loupe ? <Loupe src={currentUrl}>{node}</Loupe> : <>{node}</>;
  // No baseline means a new story: there is nothing to compare against, so
  // show the capture rather than an empty split view.
  if (!baselineUrl) {
    return magnify(
      <Frame>
        <Img src={currentUrl} alt="current capture" />
      </Frame>,
    );
  }

  if (mode === 'slider')
    return magnify(<Slider baselineUrl={baselineUrl} currentUrl={currentUrl} />);
  if (mode === 'onion')
    return magnify(<Onion baselineUrl={baselineUrl} currentUrl={currentUrl} />);
  if (mode === 'flicker')
    return magnify(<Flicker baselineUrl={baselineUrl} currentUrl={currentUrl} />);

  return (
    <Pair>
      <div>
        <Caption>Baseline</Caption>
        {loupe ? (
          <Loupe src={baselineUrl}>
            <Frame>
              <Img src={baselineUrl} alt="baseline" />
            </Frame>
          </Loupe>
        ) : (
          <Frame>
            <Img src={baselineUrl} alt="baseline" />
          </Frame>
        )}
      </div>
      <div>
        <Caption>Current</Caption>
        {magnify(
          <Frame>
            <Img
              src={currentUrl}
              alt="current"
              style={unfocus && diffUrl ? { filter: UNFOCUS } : undefined}
            />
            {/*
              Multiplied at 0.4, not stacked. pixelmatch writes the whole frame
              into its output (unchanged pixels as a faded copy of the
              baseline), so at full opacity the overlay replaced Current and
              the reviewer only ever saw a red silhouette. Compared on the
              example Button at 1, 0.6 and 0.4: below about 0.5 the current
              label stays readable and the changed edges still read as red.
            */}
            {showDiff && diffUrl && (
              <Layer
                src={diffUrl}
                alt=""
                opacity={0.4}
                style={{ mixBlendMode: 'multiply' }}
              />
            )}
          </Frame>,
        )}
      </div>
    </Pair>
  );
};

/** Draggable wipe. Best for "did this move or did everything shift". */
const Slider: React.FC<{ baselineUrl: string; currentUrl: string }> = ({
  baselineUrl,
  currentUrl,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pct, setPct] = useState(50);
  const dragging = useRef(false);

  const positionFrom = useCallback((clientX: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    setPct(Math.min(100, Math.max(0, ((clientX - box.left) / box.width) * 100)));
  }, []);

  return (
    <Frame
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label="Comparison wipe position"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 10 : 1;
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? 100
              : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
                ? pct - step
                : event.key === 'ArrowRight' || event.key === 'ArrowUp'
                  ? pct + step
                  : null;
        if (next === null) return;
        event.preventDefault();
        setPct(Math.max(0, Math.min(100, next)));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true;
        positionFrom(event.clientX);
      }}
      onPointerMove={(event) => {
        if (dragging.current) positionFrom(event.clientX);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onLostPointerCapture={() => {
        dragging.current = false;
      }}
      style={{ cursor: 'ew-resize', userSelect: 'none', touchAction: 'none' }}
    >
      <Img src={baselineUrl} alt="baseline" draggable={false} />
      <Layer
        src={currentUrl}
        alt="current"
        style={{ clipPath: `inset(0 0 0 ${pct}%)` }}
        draggable={false}
      />
      <Handle style={{ left: `${pct}%` }} />
    </Frame>
  );
};

/** Opacity crossfade. Surfaces subtle colour and weight changes. */
const Onion: React.FC<{ baselineUrl: string; currentUrl: string }> = ({
  baselineUrl,
  currentUrl,
}) => {
  const [mix, setMix] = useState(0.5);
  return (
    <div>
      <Controls>
        <span style={{ whiteSpace: 'nowrap' }}>Baseline</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={mix}
          aria-label="Blend between baseline and current"
          onChange={(e) => setMix(Number(e.target.value))}
          style={{ flex: 1 }}
        />
        <span style={{ whiteSpace: 'nowrap' }}>Current · {Math.round(mix * 100)}%</span>
      </Controls>
      <Frame>
        <Img src={baselineUrl} alt="baseline" />
        <Layer src={currentUrl} alt="current" opacity={mix} />
      </Frame>
    </div>
  );
};

/** Alternate the two images. Movement is obvious in motion, invisible still. */
const Flicker: React.FC<{ baselineUrl: string; currentUrl: string }> = ({
  baselineUrl,
  currentUrl,
}) => {
  const [hz, setHz] = useState(4);
  const [showCurrent, setShowCurrent] = useState(false);
  const [playing, setPlaying] = useState(
    () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const visibility = () => setHidden(document.hidden);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const preference = () => {
      if (reduced.matches) setPlaying(false);
    };
    document.addEventListener('visibilitychange', visibility);
    reduced.addEventListener('change', preference);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      reduced.removeEventListener('change', preference);
    };
  }, []);

  useEffect(() => {
    if (!playing || hidden) return;
    const id = setInterval(() => setShowCurrent((v) => !v), 1000 / hz / 2);
    return () => clearInterval(id);
  }, [hz, playing, hidden]);

  return (
    <div>
      <Controls as="div">
        <Button size="small" onClick={() => setPlaying((value) => !value)}>
          {playing ? 'Pause flicker' : 'Play flicker'}
        </Button>
        <span style={{ whiteSpace: 'nowrap' }}>{hz} Hz</span>
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={hz}
          aria-label="Flicker rate"
          onChange={(e) => setHz(Number(e.target.value))}
          style={{ flex: 1 }}
        />
      </Controls>
      <Frame>
        <Img src={baselineUrl} alt="baseline" />
        <Layer src={currentUrl} alt="current" opacity={showCurrent ? 1 : 0} />
      </Frame>
    </div>
  );
};
