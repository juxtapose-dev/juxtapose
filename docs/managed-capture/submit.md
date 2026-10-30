# Submit a compiled Storybook build (experimental)

This preview uploads a build without installing Chromium or taking local
screenshots. Hosted execution is still gated: **an uploaded build is not a passed
visual test**. Continue using `jux run --upload --review-in-github` for production
PR checks until the managed runner is available.

```sh
npm run build-storybook
JUXTAPOSE_TOKEN=... jux submit --build-dir storybook-static --experimental
```

Use a project token with `ingest` permission. The service must explicitly enable
managed build intake. A disabled service returns an actionable error; the command
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

Retry the same command after transient failures. Its request identity is retained
for 23 hours in `.juxtapose/managed-builds/`; no token is stored. Changes to the
source, branch, PR number, service origin or archive create a new identity. Keep
`.juxtapose/` ignored as with other local jux artifacts. `--json` emits the service
receipt, including `captureStatus: "not_started"`; automation must not interpret
an upload-only exit code as visual approval.
