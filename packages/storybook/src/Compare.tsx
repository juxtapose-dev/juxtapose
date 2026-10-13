// The comparison surface: four ways of looking at the same pair of images.
//
// Each mode answers a different question, which is why one isn't enough:
//   side-by-side  what changed, with the diff highlighted
//   slider        did this element move, or did the whole layout shift
//   onion         subtle colour and weight changes a diff overlay hides
//   flicker       small movement, which the eye catches instantly in motion

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { styled } from './storybook.js';
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

const Frame = styled.div({
  position: 'relative',
  overflow: 'hidden',
  background:
    'repeating-conic-gradient(rgba(0,0,0,.04) 0% 25%, transparent 0% 50%) 50% / 16px 16px',
  borderRadius: 4,
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
  gridTemplateColumns: '1fr 1fr',
  gap: 12,
  alignItems: 'start',
});

const Caption = styled.div(({ theme }) => ({
  font: `500 11px/1.4 ${theme.typography.fonts.base}`,
  color: theme.textMutedColor,
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
  fontSize: 12,
});

export const Compare: React.FC<CompareProps> = ({
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

  useEffect(() => {
    // Listeners go on the window so a fast drag that leaves the frame still
    // tracks, and still releases.
    const move = (e: MouseEvent) => {
      if (dragging.current) positionFrom(e.clientX);
    };
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [positionFrom]);

  return (
    <Frame
      ref={ref}
      onMouseDown={(e) => {
        dragging.current = true;
        positionFrom(e.clientX);
      }}
      style={{ cursor: 'ew-resize', userSelect: 'none' }}
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
        <span style={{ whiteSpace: 'nowrap' }}>Current</span>
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

  useEffect(() => {
    const id = setInterval(() => setShowCurrent((v) => !v), 1000 / hz / 2);
    return () => clearInterval(id);
  }, [hz]);

  return (
    <div>
      <Controls>
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
