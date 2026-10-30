# Hosted capture in CI

Use a CLI release whose `jux submit --help` lists `--wait`. The service must enable
managed validation, execution, comparison and publication for the project.
Configure a project token with **ingest and read** permissions as `JUXTAPOSE_TOKEN`.
`JUXTAPOSE_API_URL` defaults to `https://api.juxtapose.dev`.

Build Storybook normally, then submit its compiled output:

```sh
pnpm exec jux submit --experimental --build-dir storybook-static --wait --json
```

The CLI uploads a deterministic archive, starts no local browser, requests hosted
capture and waits for publication. Without `--wait`, it preserves the upload-only
receipt and does not claim a visual result. JSON waiting output adds `workflow`
with exact build/source identity, progress, bounded reason/recovery, and a ready
review URL. It stops when review is ready; it does not wait for a human approval.

On GitHub Actions, check out the PR's **head SHA**, not the synthetic merge commit:

```yaml
- uses: actions/checkout@v4
  with:
    ref: ${{ github.event.pull_request.head.sha || github.sha }}
- run: pnpm install --frozen-lockfile
- run: pnpm build-storybook
- run: pnpm exec jux submit --experimental --build-dir storybook-static --wait --json
  env:
    JUXTAPOSE_TOKEN: ${{ secrets.JUXTAPOSE_TOKEN }}
```

PR identity is inferred from GitHub Actions PR refs. Other CI systems can pass
`--branch feature/name --pr 123`; the checked-out commit remains authoritative.
The default wait is 30 minutes. Set `--wait-timeout <milliseconds>` (1 second to
3 hours) and `--poll-interval <milliseconds>` (250 to 30000) when needed. Timeout
or Ctrl-C stops local waiting; durable service work continues. Retry the same
command to reuse the existing build identity.

For an existing build, including while intake is paused, use its printed ID:

```sh
pnpm exec jux submit --experimental --resume <buildId> --json
```

Resume is read-only: it needs no checkout or archive, performs no build creation,
upload or capture request, and follows the server's immutable source SHA rather
than the current local Git HEAD. It waits for already-started work or returns an
explicit paused/terminal diagnostic. An upload-only build with no capture request
requires retrying the original compiled submission with `--wait`. A pause between
upload and capture trigger also falls back to the exact scoped status endpoint;
other trigger errors are retained.

| Exit | Meaning                                                                                |
| ---- | -------------------------------------------------------------------------------------- |
| 0    | Ready unchanged/approved review, or explicitly completed default-branch reference      |
| 1    | Published changes need review, rejected changes, or terminal missing-baseline recovery |
| 2    | Invalid CLI arguments/configuration                                                    |
| 3    | Operational failure, unavailable service, timeout, interruption or superseded source   |

A completed reference is **not** a passing PR review. Capture the default branch
before branching to establish a usable reference. Existing PRs may need to rebase
onto a captured default-branch commit. A missing exact ancestor baseline is never
replaced by the latest branch tip or automatically approved.
