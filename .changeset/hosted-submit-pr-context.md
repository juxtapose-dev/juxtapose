---
'@juxtapose/cli': patch
---

Carry pull request identity in experimental managed build submissions. Detect GitHub Actions PR refs automatically or use `jux submit --pr <number>`. Keep retry identities separate across PRs and verify branch/PR identity in build receipts. The actual Git checkout SHA remains authoritative; check out the PR head rather than GitHub's synthetic merge commit. Submission remains upload-only while hosted execution is gated.
