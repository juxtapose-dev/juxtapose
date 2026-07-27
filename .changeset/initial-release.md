---
'@juxtapose/core': minor
'@juxtapose/adapter-storybook': minor
'@juxtapose/adapter-ladle': minor
'@juxtapose/cli': minor
---

Initial release.

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
