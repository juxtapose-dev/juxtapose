// A magnifier for the compare surface.
//
// Every other mode answers "did something move". None of them answer "is this
// one pixel or two", which is the question that actually blocks a review: a
// 1px border shift and an antialiasing change look identical at 1:1, and the
// diff overlay marks both. Zooming is the only way to tell them apart.
//
// Drawn on a canvas rather than with CSS transforms because `image-rendering:
// pixelated` is what makes a magnified pixel readable as a pixel, and canvas
// gives that with `imageSmoothingEnabled = false` on every browser worth
// supporting.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { styled } from './storybook.js';
import { loupeGeometry, SIZE } from './loupe-geometry.js';

const Host = styled.div({
  position: 'relative',
  cursor: 'crosshair',
});

const Lens = styled.canvas({
  position: 'absolute',
  width: SIZE,
  height: SIZE,
  borderRadius: '50%',
  border: '2px solid rgba(0,0,0,.4)',
  boxShadow: '0 4px 16px rgba(0,0,0,.3)',
  pointerEvents: 'none',
  zIndex: 2,
  background: '#fff',
});

export interface LoupeProps {
  /** The image the lens magnifies. Whatever the active mode is showing. */
  src: string;
  children: React.ReactNode;
}

export const Loupe: React.FC<LoupeProps> = ({ src, children }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [active, setActive] = useState(false);

  // Decode once per src rather than per pointer move. An <img> the browser has
  // already fetched for the frame below is served from cache, so this is a
  // decode, not a download.
  useEffect(() => {
    const img = new Image();
    img.src = src;
    img.onload = () => {
      imageRef.current = img;
    };
    return () => {
      imageRef.current = null;
    };
  }, [src]);

  const draw = useCallback((clientX: number, clientY: number) => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!host || !canvas || !img) return;

    const rect = host.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const g = loupeGeometry({
      x,
      y,
      width: rect.width,
      height: rect.height,
      naturalWidth: img.naturalWidth,
    });

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(img, g.sx, g.sy, g.sw, g.sw, 0, 0, SIZE, SIZE);

    canvas.style.left = `${g.left}px`;
    canvas.style.top = `${g.top}px`;
  }, []);

  return (
    <Host
      ref={hostRef}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
      onMouseMove={(e) => draw(e.clientX, e.clientY)}
    >
      {children}
      <Lens
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        style={{ display: active ? 'block' : 'none' }}
      />
    </Host>
  );
};
