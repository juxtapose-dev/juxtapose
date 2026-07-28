---
'@juxtapose/core': minor
'@juxtapose/storybook': patch
---

Update sharp to ^0.35.3 for four libvips CVEs.

CVE-2026-33327, -33328, -35590 and -35591 affect sharp below 0.35.0. This was
the only advisory reaching published packages — the others `pnpm audit` reports
are devDependencies (vitest, vite) or example-only.

**This invalidates existing baselines.** The new libvips encodes identical
pixels to different WebP bytes, so the first run after upgrading reports
changes with `0.000%` mismatch and no changed regions — the images are
pixel-for-pixel the same, only the encoding differs. Run `jux approve --all`
once to re-anchor. Verified: two example stories failed at exactly 0 mismatched
pixels, and `check:determinism` passes at 14/14 byte-identical across 3 runs
on the new version, so encoding remains deterministic within it.

Also declares `@emotion/react` as a devDependency of the addon. It was imported
by `emotion.d.ts` and resolvable from nowhere; `skipLibCheck` hid it, which
meant the `Theme` augmentation silently did not apply.
