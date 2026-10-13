// packages/storybook/src/theme.ts

/**
 * The muted text color. The `Theme` Storybook 8's styled passes does not
 * declare textMutedColor, so `theme.textMutedColor` reads as `any` there (our
 * emotion.d.ts augments @emotion/react, which Storybook's bundled theming does
 * not use). Narrowed here instead, once.
 */
export const mutedColor = (theme: object): string | undefined =>
  'textMutedColor' in theme && typeof theme.textMutedColor === 'string'
    ? theme.textMutedColor
    : undefined;
