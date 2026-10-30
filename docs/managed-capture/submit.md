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
unverified until its GitHub association is independently checked.

Archive bytes are stable across file timestamps and ownership. Symlinks, special
files, credential files and incomplete Storybook output are refused. Limits are
16 MiB compressed, 512 MiB expanded, 64 MiB per file and 10,000 entries.

Retry the same command after transient failures. Its request identity is retained
for 23 hours in `.juxtapose/managed-builds/`; no token is stored. Changes to the
source, branch, service origin or archive create a new identity. Keep
`.juxtapose/` ignored as with other local jux artifacts. `--json` emits the service
receipt, including `captureStatus: "not_started"`; automation must not interpret
an upload-only exit code as visual approval.
