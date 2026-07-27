// Storybook's `styled` is emotion with its theme baked in. Declaring the
// shape here means every styled callback types `theme` correctly without
// annotating each one — and keeps the surface we depend on written down in
// one place, since these are Storybook internals.

import '@emotion/react';

declare module '@emotion/react' {
  export interface Theme {
    appBorderColor: string;
    textMutedColor: string;
    color: {
      secondary: string;
      positive: string;
      negative: string;
      warning: string;
      [key: string]: string;
    };
    typography: {
      fonts: { base: string; mono: string };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }
}
