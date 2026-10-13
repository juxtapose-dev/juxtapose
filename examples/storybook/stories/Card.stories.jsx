import { Card } from 'example-components';

export default { title: 'Card', component: Card };

/**
 * Captured three more ways besides its default: at a phone viewport, in a
 * dark color scheme, and both. Declared on the story, where only the live
 * preview carries it — juxtapose reads it before capture, so each variant
 * gets its own baseline (`card--default__mobile`, `__dark`, `__mobile-dark`).
 */
export const Default = {
  args: { title: 'Hello', body: 'A card with some body copy in it.' },
  parameters: {
    juxtapose: {
      variants: {
        mobile: { viewport: { width: 375, height: 812 } },
        dark: { colorScheme: 'dark' },
        'mobile-dark': { extends: 'mobile', colorScheme: 'dark' },
      },
    },
  },
};

export const WithBadge = {
  args: { title: 'Release', body: 'Shipped to production.', badge: 'new' },
};

export const LongBody = {
  args: {
    title: 'Wrapping',
    body: 'A longer body that wraps across several lines, so the story exercises text layout and line breaking rather than a single short run of glyphs.',
  },
};
