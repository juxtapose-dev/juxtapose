// Shared demo components, consumed by both the Storybook and Ladle examples.
//
// Deliberately plain JSX with inline styles: no CSS framework, no build step
// beyond the workbench's own. The point is to exercise juxtapose's capture
// pipeline, not to demonstrate a design system.
//
// Several of these exist specifically to stress a part of the pipeline that is
// easy to get wrong — see the notes on each.

import { useState, useEffect } from 'react';

export const Button = ({ label = 'Button', variant = 'primary', size = 'md' }) => {
  const palette = {
    primary: { bg: '#2563eb', fg: '#ffffff' },
    secondary: { bg: '#64748b', fg: '#ffffff' },
    danger: { bg: '#dc2626', fg: '#ffffff' },
    ghost: { bg: 'transparent', fg: '#2563eb' },
  }[variant];

  const sizing = {
    sm: { padding: '6px 12px', fontSize: 14 },
    md: { padding: '10px 20px', fontSize: 16 },
    lg: { padding: '14px 28px', fontSize: 18 },
  }[size];

  return (
    <button
      style={{
        ...sizing,
        fontFamily: 'system-ui, sans-serif',
        border: variant === 'ghost' ? '1px solid #2563eb' : 'none',
        borderRadius: 6,
        color: palette.fg,
        background: palette.bg,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
};

export const Card = ({ title = 'Card', body = 'Some body copy.', badge }) => (
  <div
    style={{
      width: 280,
      padding: 20,
      fontFamily: 'system-ui, sans-serif',
      border: '1px solid #e2e8f0',
      borderRadius: 10,
      background: '#ffffff',
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 17, color: '#0f172a' }}>{title}</h3>
      {badge && (
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 999,
            background: '#dbeafe',
            color: '#1d4ed8',
          }}
        >
          {badge}
        </span>
      )}
    </div>
    <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.5, color: '#475569' }}>
      {body}
    </p>
  </div>
);

/**
 * A continuously animating spinner.
 *
 * This is the canary for animation freezing. Without the injected freeze CSS
 * the rotation lands at a random angle every capture, so the story diffs
 * against itself on every run — and because pass/fail is a byte-exact hash,
 * that is a permanently red build rather than a small percentage.
 *
 * If this story ever goes flaky, the freeze step regressed.
 */
export const Spinner = ({ size = 32 }) => (
  <>
    <style>{`@keyframes jux-spin { to { transform: rotate(360deg) } }`}</style>
    <div
      style={{
        width: size,
        height: size,
        border: '3px solid #e2e8f0',
        borderTopColor: '#2563eb',
        borderRadius: '50%',
        animation: 'jux-spin 0.7s linear infinite',
      }}
    />
  </>
);

/**
 * Text that fades and slides in on mount.
 *
 * Stresses the same freeze path as Spinner but via a transition rather than a
 * keyframe animation, and additionally checks that we do not screenshot
 * mid-flight — a capture taken before the transition settles would differ
 * from one taken after.
 */
export const FadeIn = ({ text = 'Faded in.' }) => (
  <>
    <style>{`
      @keyframes jux-fade {
        from { opacity: 0; transform: translateY(8px) }
        to   { opacity: 1; transform: translateY(0) }
      }
    `}</style>
    <p
      style={{
        margin: 0,
        fontFamily: 'system-ui, sans-serif',
        fontSize: 18,
        color: '#0f172a',
        animation: 'jux-fade 600ms ease-out',
      }}
    >
      {text}
    </p>
  </>
);

/**
 * Renders only after a fetch resolves.
 *
 * Exercises the network-quiescence half of the settle pipeline: the observer
 * counts in-flight fetches, so a capture must not fire during the gap between
 * mount and response. Without that, this story would intermittently capture
 * its loading state.
 */
export const AsyncContent = () => {
  const [state, setState] = useState('loading');

  useEffect(() => {
    let alive = true;
    // A real fetch, because that is what juxtapose can actually observe: the
    // settle script counts in-flight requests, so capture waits for this to
    // resolve rather than screenshotting the loading state.
    //
    // Note there is deliberately no setTimeout here. A bare timer after the
    // fetch resolves would be invisible to settling — nothing observes it —
    // and the story would race the quiescence window. That is a real
    // limitation worth knowing about: if your content appears on a timer
    // rather than in response to work juxtapose can see, reach for
    // `waitForSelector`.
    fetch('data:text/plain,loaded')
      .then((r) => r.text())
      .then(() => alive && setState('ready'))
      .catch(() => alive && setState('ready'));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div
      style={{
        width: 240,
        padding: 16,
        fontFamily: 'system-ui, sans-serif',
        fontSize: 15,
        borderRadius: 8,
        border: '1px dashed #cbd5e1',
        color: state === 'ready' ? '#0f172a' : '#94a3b8',
      }}
    >
      {state === 'ready' ? 'Loaded content.' : 'Loading…'}
    </div>
  );
};

/**
 * A dense type specimen.
 *
 * Antialiased text at several weights and sizes is the most sensitive thing a
 * pixel differ sees. If webfont waiting or device scale factor regresses, this
 * story fails first and loudest.
 */
export const TextSpecimen = () => (
  <div style={{ width: 420, fontFamily: 'system-ui, sans-serif', color: '#0f172a' }}>
    <h2 style={{ margin: '0 0 4px', fontSize: 24, fontWeight: 700 }}>Heading</h2>
    <p style={{ margin: '0 0 12px', fontSize: 13, color: '#64748b' }}>
      Subheading in a lighter tone
    </p>
    <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
      The quick brown fox jumps over the lazy dog. Antialiased glyph edges are the most
      sensitive input a pixel differ receives.
    </p>
    <code
      style={{
        display: 'block',
        marginTop: 12,
        padding: 10,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        background: '#f1f5f9',
        borderRadius: 6,
      }}
    >
      sha256(webp) === manifest[storyId].hash
    </code>
  </div>
);
