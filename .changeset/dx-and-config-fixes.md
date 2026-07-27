---
'@juxtapose/cli': patch
'@juxtapose/core': patch
---

Fix three things that failed silently.

`jux run --story <id>` parsed the flag and then ignored it, capturing every
story instead of the one you named — the exact flag you reach for when a single
story is flaking. It now captures only the named stories, errors on an unknown
id, and reports `explicit` as the selection reason.

A `juxtapose.config.json` that exists but does not parse was swallowed by a
bare `catch`, discarding every setting and continuing against defaults with no
message. It now fails with the filename and the parse error.

`previewUrl` and `storyFileGlobs` were required on the `Platform` interface but
read by nothing, taxing every third-party adapter for capabilities the core
never exercises. Both are optional now — a change that would be breaking after
1.0, so it lands before.
