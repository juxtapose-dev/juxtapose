// Typed `parameters.juxtapose` (issue #180). The type is @juxtapose/core's,
// derived from the same schema as the runtime checks, and the augmentation
// makes CSF's `Parameters` know the key, so a typo in a story file is a type
// error rather than a story captured with the default.
//
// `storybook/internal/csf` is the path Storybook 8 to 10 all export `Parameters`
// through; its own index signature (`[name: string]: any`) keeps every other
// addon's key working.

import type { JuxtaposeParameters } from '@juxtapose/core';
import type { Parameters } from 'storybook/internal/csf';

export type { JuxtaposeParameters };

declare module 'storybook/internal/csf' {
  interface Parameters {
    /** juxtapose capture options for this story; see docs/configuration.md. */
    juxtapose?: JuxtaposeParameters;
  }
}

// The smallest check that the augmentation reaches CSF: tsc fails the build if
// a known option stops type-checking or an unknown one starts to.
const _typed: Parameters = { juxtapose: { delay: 100, settle: { timeout: 3000 } } };
// @ts-expect-error -- 'dely' is not an option
const _typo: Parameters = { juxtapose: { dely: 100 } };
