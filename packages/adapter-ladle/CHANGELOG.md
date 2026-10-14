# @juxtapose/adapter-ladle

## 0.3.16

### Patch Changes

- Updated dependencies [6dac140]
  - @juxtapose/core@0.18.2

## 0.3.15

### Patch Changes

- Updated dependencies [62fb1ec]
  - @juxtapose/core@0.18.1

## 0.3.14

### Patch Changes

- Updated dependencies [f5c1b67]
  - @juxtapose/core@0.18.0

## 0.3.13

### Patch Changes

- Updated dependencies [d7558ed]
  - @juxtapose/core@0.17.0

## 0.3.12

### Patch Changes

- Updated dependencies [34f879d]
  - @juxtapose/core@0.16.1

## 0.3.11

### Patch Changes

- Updated dependencies [7a53ce1]
- Updated dependencies [6ec8d81]
  - @juxtapose/core@0.16.0

## 0.3.10

### Patch Changes

- Updated dependencies [e3608de]
  - @juxtapose/core@0.15.0

## 0.3.9

### Patch Changes

- Updated dependencies [4638d64]
- Updated dependencies [b40e080]
- Updated dependencies [535c676]
- Updated dependencies [48258e9]
  - @juxtapose/core@0.14.0

## 0.3.8

### Patch Changes

- Updated dependencies [e2d1770]
- Updated dependencies [3668e0e]
- Updated dependencies [a7e5e61]
  - @juxtapose/core@0.13.0

## 0.3.7

### Patch Changes

- Updated dependencies [c602676]
- Updated dependencies [981f6b9]
- Updated dependencies [f251aa8]
- Updated dependencies [0807b4f]
- Updated dependencies [a646af0]
  - @juxtapose/core@0.12.0

## 0.3.6

### Patch Changes

- Updated dependencies [16d7ed3]
- Updated dependencies [8f38247]
- Updated dependencies [dc60343]
- Updated dependencies [c7f9ffb]
- Updated dependencies [255fc28]
  - @juxtapose/core@0.11.0

## 0.3.5

### Patch Changes

- Updated dependencies [746d075]
  - @juxtapose/core@0.10.0

## 0.3.4

### Patch Changes

- Updated dependencies [9830e0d]
- Updated dependencies [8b80785]
  - @juxtapose/core@0.9.0

## 0.3.3

### Patch Changes

- Updated dependencies [6b98571]
  - @juxtapose/core@0.8.0

## 0.3.2

### Patch Changes

- Updated dependencies [dfb006b]
  - @juxtapose/core@0.7.0

## 0.3.1

### Patch Changes

- Updated dependencies [8ea2e71]
- Updated dependencies [a4593ae]
  - @juxtapose/core@0.6.0

## 0.3.0

### Minor Changes

- 31bc685: Capture through juxtapose's own CDP driver instead of Playwright. Captures stay byte-identical (verified on both example workbenches), so existing baselines remain valid and nothing needs re-approving.

  Playwright is no longer a dependency or peer dependency. The browser is a pinned `chrome-headless-shell` 151.0.7922.34, installed once with `npx -p @juxtapose/cli jux browser install` (also `jux browser status` and `jux browser path`). An existing `ms-playwright` cache of the same build is reused and nothing is downloaded. New: `JUX_CHROME=<path>` or `--chrome <path>` uses your own Chromium, and `JUX_CACHE_DIR` moves the cache.

  **Breaking:**

  - Mask and `--wait-for` selectors must be CSS. Playwright-only syntax (`text=`, `>>`, `:has-text()`, `:visible`, `nth=`) now fails the story with `jux: selector '…' is not a CSS selector` instead of silently matching nothing.
  - Node >= 22.2.0 is required (it was 20).
  - Adapters receive `@juxtapose/core`'s `Page`, not Playwright's. Third-party adapters that used Playwright-only `Page` methods need to move to the `Page` interface core exports.

### Patch Changes

- Updated dependencies [373ff1b]
- Updated dependencies [31bc685]
- Updated dependencies [e65f1bd]
- Updated dependencies [68c7ceb]
- Updated dependencies [966f6e7]
  - @juxtapose/core@0.5.0

## 0.2.2

### Patch Changes

- 474a0db: Add npm keywords and a homepage link to each package

  Nothing installed changes; this is what the registry listing shows and how the
  packages are found in search.

- Updated dependencies [474a0db]
- Updated dependencies [04615a6]
- Updated dependencies [f40f5cf]
  - @juxtapose/core@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [c28a95a]
- Updated dependencies [b6dd903]
- Updated dependencies [c10ec5c]
- Updated dependencies [81fc005]
- Updated dependencies [77fac97]
- Updated dependencies [d47ddc4]
  - @juxtapose/core@0.3.0

## 0.2.0

### Minor Changes

- 97b4994: Initial release.

  Visual regression testing for component workbenches, with Storybook and Ladle
  adapters behind a shared platform seam.

  - Pass/fail is a byte-exact hash against a committed manifest; the pixel diff is
    a cold path that only runs to explain a failure.
  - Baselines live in the repo by default, so approving a change is a reviewable
    diff in the pull request that caused it. S3/R2 is available behind the same
    interface.
  - Affected-story analysis walks the Vite build manifest and escalates to a full
    run on any uncertainty.
  - `jux handoff` emits an agent-ready prompt carrying exact mismatch figures and
    changed-region coordinates rather than screenshots.

### Patch Changes

- Updated dependencies [97b4994]
  - @juxtapose/core@0.2.0
