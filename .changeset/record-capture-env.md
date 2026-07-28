---
'@juxtapose/core': minor
'@juxtapose/cli': minor
'@juxtapose/server': minor
---

Record what captured each baseline

Baselines now carry a `CaptureEnv` — browser version, OS/arch, and the libvips
that encoded the WebP. Under a byte-exact hash a toolchain bump and a real
regression look identical, so an all-red suite could not be explained. This is
the fact that explains it.

The encoder is a separate field because it moves bytes far more readily than the
browser does. Measured on the examples: a libvips bump changed all 17 baseline
hashes with zero changed pixels, while Chromium 149 to 151 left 16 of 18 stories
byte-identical.

Existing baselines have no fingerprint and are left alone; an unknown
environment is treated as unknown rather than as current, so nothing is
silently assumed to match. Approvals made from the CLI, from `init`, and from
the addon panel all record it.
