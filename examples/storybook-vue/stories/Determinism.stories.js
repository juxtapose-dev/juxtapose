// The Vue counterpart of the React determinism stories.
//
// The settle pipeline is renderer-agnostic — it observes the DOM, not React —
// so these should behave identically. This example is how we would find out if
// that stopped being true.

const Spinner = {
  template: `
    <div>
      <style>@keyframes jux-spin { to { transform: rotate(360deg) } }</style>
      <div :style="style" />
    </div>
  `,
  computed: {
    style() {
      return {
        width: '32px',
        height: '32px',
        border: '3px solid #e2e8f0',
        borderTopColor: '#2563eb',
        borderRadius: '50%',
        animation: 'jux-spin 0.7s linear infinite',
      };
    },
  },
};

const TextSpecimen = {
  template: `
    <div style="width: 420px; font-family: system-ui, sans-serif; color: #0f172a">
      <h2 style="margin: 0 0 4px; font-size: 24px; font-weight: 700">Heading</h2>
      <p style="margin: 0 0 12px; font-size: 13px; color: #64748b">
        Subheading in a lighter tone
      </p>
      <p style="margin: 0; font-size: 15px; line-height: 1.6">
        The quick brown fox jumps over the lazy dog. Antialiased glyph edges are
        the most sensitive input a pixel differ receives.
      </p>
    </div>
  `,
};

export default { title: 'Determinism' };

/** Animations are frozen, so a spinner cannot land on a random frame. */
export const InfiniteSpinner = {
  render: () => ({ components: { Spinner }, template: '<Spinner />' }),
};

/** Text rendering, the most diff-sensitive thing on a page. */
export const Typography = {
  render: () => ({ components: { TextSpecimen }, template: '<TextSpecimen />' }),
};

/** Per-story viewport override, read from the live preview. */
export const NarrowViewport = {
  render: () => ({ components: { TextSpecimen }, template: '<TextSpecimen />' }),
  parameters: { juxtapose: { viewport: { width: 480, height: 400 } } },
};

/** Excluded from capture. Still renders in Storybook. */
export const NeverCaptured = {
  render: () => ({ template: '<p style="font-family: system-ui">Never captured.</p>' }),
  parameters: { juxtapose: { skip: true } },
};
