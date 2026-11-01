# Submit a compiled Storybook build (experimental)

Submit a compiled build without installing Chromium or taking local screenshots.
By default this only uploads the build: **an uploaded build is not a passed visual
test**. For projects with hosted execution enabled, use `--wait` to request capture
and wait for review publication; see [hosted capture in CI](../managed-ci.md).
Projects without that enablement can capture locally with
`jux run --upload --review-in-github`.

```sh
npm run build-storybook
npx -p @juxtapose/cli@0.29.0 jux submit --build-dir storybook-static --experimental
```

Supply `JUXTAPOSE_TOKEN` through the process environment or a CI secret. Upload-only
submission requires `ingest`; `--wait` needs `read` and `ingest`, while read-only
`--resume` needs `read`. The service
must explicitly enable managed build intake. A disabled service returns an actionable error; the command
does not silently fall back to running a browser.

The command reads the full checked-out Git SHA. For detached checkouts, pass
`--branch feature/my-change`; GitHub's `GITHUB_HEAD_REF` and GitLab's
`CI_COMMIT_REF_NAME` are also recognized. The service treats source metadata as
client-declared. Its GitHub association is checked independently before preparation;
that check does not prove the compiled bundle was built from the declared source.

For a GitHub PR, pass `--pr 42`, or let the command detect the number from
`GITHUB_REF=refs/pull/42/merge` (or `/head`) in GitHub Actions. An explicit `--pr`
takes precedence. Check out `github.event.pull_request.head.sha` before building;
the command uses the actual checkout SHA and does not relabel GitHub's synthetic
merge commit as the PR head. The initial hosted pilot accepts current
same-repository PR heads or the current default-branch head; fork PRs and other
unassociated branches are not supported. Other CI systems targeting a GitHub PR
can provide `--branch` and `--pr` explicitly. A GitLab branch environment variable
does not imply native merge-request integration.

Archive bytes are stable across file timestamps and ownership. Symlinks, special
files, credential files and incomplete Storybook output are refused. Limits are
16 MiB compressed, 512 MiB expanded, 64 MiB per file and 10,000 entries.

When the service advertises direct archive uploads, the CLI uploads the archive
to a private, short-lived R2 URL and asks the API to verify and accept the original
upload attempt. A lost PUT response or an existing-object response still requires
API acceptance. External PUTs omit the project token and cookies and refuse
redirects; signed URLs are omitted from saved identities and JSON receipts.
Services without this advertisement continue to receive archive bytes through
the API. Upgrading the CLI alone does not enable direct uploads on the service.

Retry the same command after transient failures. Its request identity is retained
for 23 hours in `.juxtapose/managed-builds/`; no token is stored. Changes to the
source, branch, PR number, service origin or archive create a new identity. Keep
`.juxtapose/` ignored as with other local jux artifacts. Without `--wait`, `--json`
emits the upload receipt, including `captureStatus: "not_started"`; automation
must not interpret an upload-only exit code as visual approval.

## Wait for a private preview

CLI 0.30.0 adds `--wait-preview`. When the service enables preview publication
and private viewing for your project, upload a compiled build and wait for its
private preview URL:

```sh
jux submit --experimental --build-dir storybook-static --wait-preview --json
```

This needs `ingest` and `read`. It never requests capture or produces a visual
verdict. To resume after an interruption, use
`jux submit --experimental --resume <buildId> --wait-preview`; that command needs
only `read` and works without a checkout or local build files. The URL requires
sign-in and project review access.

`--wait-preview` cannot be combined with `--wait` or `--review-in-github`. It
returns zero only for a published preview with a usable URL; disabled,
unrequested, expired, failed, or viewer-blocked publication returns nonzero.
An unsupported service endpoint also stops without requesting capture or
reuploading. The wait uses one 30-minute deadline (`--wait-timeout`, at most
3 hours) and respects the service's polling interval. Resuming does not renew
publication or retention. Ordinary upload remains successful without polling
preview status; preview publication depends on service enablement.
