# Hosted review uploads

Hosted review is opt-in. Local `jux approve` and `jux check` use local manifests;
hosted review decisions and the required GitHub App check are separate. Uploading
never approves snapshots or changes your local comparison settings.

Create a project-scoped token in the hosted dashboard and provide it through the
`JUXTAPOSE_TOKEN` environment variable (for CI, use a secret). Never commit tokens
or put them in command arguments.

From a committed project with a built workbench:

```sh
jux run --upload
```

To upload an existing run or retry after a service/network failure:

```sh
jux upload --run .juxtapose/runs/<run-id>
```

`jux run --upload --json` keeps the existing run-report JSON on stdout and prints
the hosted review URL on stderr. `jux upload --run <directory> --json` prints
`{ "runId": "…", "reportUrl": "…" }`. Projects without a linked GitHub repository
return `reportUrl: null`; link the repository in the dashboard to enable review. A failed upload exits nonzero and retains
all local artifacts. The upload-only command reports transfer success; it does
not replace `jux check` or the original run's visual verdict.

The default API is `https://api.juxtapose.dev`. `JUXTAPOSE_API_URL` overrides the
origin for self-hosting or staging; HTTPS is required except loopback development.
Redirects are rejected to keep tokens from reaching another server. Requests have
a 30-second timeout; transient network errors and HTTP 502/503/504 responses are retried at most
twice using stable run identity. Authentication, quota, and conflict errors are not retried. Re-running the upload uses a stable external run identifier.

When the API advertises direct snapshot uploads, the CLI sends image bytes to
private, short-lived R2 upload URLs and sends metadata and acceptance requests
to the API. Shared artifacts reuse the same in-flight transfer, with at most
four image loads and PUTs running at once. The API must verify and accept each
snapshot before the run is finalized. An interrupted response retries the same
control request; a missing cached artifact is uploaded before acceptance is
retried. Older services continue to receive API uploads. An invalid direct
advertisement or a failed direct upload exits nonzero and retains local artifacts.
When another upload owns an uncached current image, the CLI waits for its verified
result before retrying that snapshot's admission. This preserves existing usage
accounting for shared images. The wait is bounded to five minutes plus the API's
finalization retry budget (about 6.5 minutes); exhaustion retains local artifacts
for a later retry.

Direct upload URLs stay in memory and are omitted from command output and saved
receipts. External PUTs omit the project token and cookies and reject redirects.
Service-side direct upload enablement is required; upgrading the CLI alone does
not activate it.

To inspect a stuck direct attempt without uploading, using its original local
run directory:

```sh
jux upload --run .juxtapose/runs/<run-id> --recover-direct
```

This resolves only an existing hosted run and prints opaque story/attempt IDs.
It works without local image files and while new direct upload signing is
disabled. It does not issue upload URLs or change reservations. Unknown runs
return an error without creating a hosted run. Both recovery commands require
the original project token with ingest permission and a service supporting this
recovery protocol.

To permanently abandon one inspected attempt, explicitly copy its identifiers:

```sh
jux upload --run .juxtapose/runs/<run-id> --abandon-direct <storyIdSafe>:<attemptId>
```

Abandonment is never automatic after a transfer or service failure. This command
cancels only the entered attempt and performs no upload or run finalization.
The story cannot resume in that hosted run. To submit again, capture a new run
with `jux run --upload`; these commands do not reuse the old capture as a new run.
The cancellation receipt's `cleanupPending: true` means physical cleanup may
still be pending, including waiting for an active internal writer to settle.
`--recover-direct` and `--abandon-direct` are mutually exclusive. `--json` returns
only the scoped run/story/attempt identities and cancellation receipt, without
upload URLs.

On GitHub pull request jobs, `GITHUB_EVENT_PATH` supplies the PR number when its
head/merge commit matches the captured commit. Detached `HEAD` uses the PR branch
name; the actual captured commit stays unchanged, including merge checkouts.
Retrying an older run in an unrelated job does not attach it to that job’s PR. Captures,
including variant keys, are uploaded as separate snapshots. The original report
is preserved alongside the service summary, including pixel hashes, instability,
visual-equivalence evidence, and structural change explanations.

When capturing with `--upload`, available approved baseline images are verified
against the manifest and saved with the run for consistent review and retries.
Older run directories without these pinned images show no baseline; the uploader
does not substitute a newer baseline.

Current limits: at least one result, at most 50,000 captures, capture IDs up to
200 characters, and each WebP image up to 1 MiB. Capture errors must be fixed and
recaptured before upload. Viewport-size changes with valid image evidence upload as failures.
Empty affected runs do not create hosted runs.

DOM inspection is available for new hosted captures when both the current and
approved baseline structures are available and match their captured image hashes.
The CLI carries those verified sidecars with the run, including passing snapshots;
retrying an upload never substitutes a newer baseline. Older run directories and
new stories without an approved baseline show DOM evidence as unavailable.

Hosted trees are a sanitized projection of the original hashed structures, not
React component metadata. Masked subtrees, typed form values and URL-bearing
metadata are omitted. Trees preserve parent relationships and include explicit
truncation metadata: at most 100 nodes per side and 64 KiB per snapshot, fairly
shared within the complete report's 5 MiB limit. Missing, corrupt or over-budget
optional DOM never changes a pixel verdict or blocks an otherwise valid upload.
