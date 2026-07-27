import { Card } from 'example-components';

export default { title: 'Card', component: Card };

export const Default = {
  args: { title: 'Hello', body: 'A card with some body copy in it.' },
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
