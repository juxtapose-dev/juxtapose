---
'@juxtapose/core': minor
'@juxtapose/cli': minor
'@juxtapose/storybook': minor
---

Projects no longer commit snapshot images. The default storage is now `{ "kind": "cache" }`: baseline images live in a git-ignored, hash-keyed cache (`.juxtapose/cache/baselines/<sha256>.webp`), and the repo carries only `juxtapose.manifest.json` (the hashes that decide pass/fail) and structure sidecars in `.juxtapose/structure/<id>.structure.json` (plain JSON, one element per line, so an approval diff shows what moved). A failing story whose image is not in the cache is reported by hash and structure ("baseline image not available (not in cache); structure diff only") instead of erroring, in run output, the PR comment, the handoff, the HTML report and the panel. A passing run keeps its capture in the cache. `jux init` writes the `.gitignore` entries, and the new `jux doctor` lists tracked images and prints the migration. `docs/ci.md` has a GitHub Actions snippet that saves and restores the cache.

Migration. Projects with `storage.kind: "git"` (or `"fs"`) set explicitly are unchanged. Projects with no `storage` key and images committed under `.juxtapose/baselines/` keep working: jux still reads those images (when they match the manifest hash) and writes new ones to the cache. To move over, run `jux doctor`, then `git rm --cached -- '.juxtapose/baselines/*.webp'` and add `.juxtapose/cache/` and `.juxtapose/runs/` to `.gitignore` (`jux init` does this for new projects). Structure sidecars may stay where they are; new approvals write them to `.juxtapose/structure/`. To keep committing images, set `"storage": { "kind": "git" }`.
