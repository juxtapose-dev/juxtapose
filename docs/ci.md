# In CI

`jux run --comment` posts a summary to the pull request, updating the same
comment on every push rather than adding a new one:

```yaml
- run: npx storybook build
- run: npx -p @juxtapose/cli jux run --comment --html
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: juxtapose-report
    path: .juxtapose/runs/*/report.html
```

The job needs `permissions: pull-requests: write`.

`--html` writes a self-contained `report.html` into the run directory: every
image is inlined, so it works opened straight from disk. Uploading it is what
lets the PR comment link somewhere useful — the comment adds that link only
when a report was actually written, so a run without `--html` gets no link
rather than one pointing at an empty artifacts list.

Outside a pull request — locally, or on a push — `--comment` is a no-op and
never changes the exit code: a reporting problem should not fail a build that
otherwise passed.

## Cache the baseline images

Projects commit hashes and structure, not images, so pass/fail needs no image:
a story passes when its hash matches the manifest. CI still tells you what
changed without images, because the structure sidecars are committed. To also
get pixel diffs, crops and the report's overlay for a failing story, give the
run the approved image by saving and restoring the cache directory.

A run on the main branch saves the cache (a passing run keeps its capture, and
images are named by hash, so a restored cache can only add files). A pull
request restores from its merge-base, falling back to the latest main cache:

```yaml
jobs:
  visual:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the merge-base lookup below needs history
      - run: npx storybook build

      - id: base
        if: github.event_name == 'pull_request'
        run: echo "sha=$(git merge-base origin/${{ github.base_ref }} HEAD)" >> "$GITHUB_OUTPUT"

      # Pull request: exact merge-base cache first, then the newest main cache.
      - uses: actions/cache/restore@v4
        if: github.event_name == 'pull_request'
        with:
          path: .juxtapose/cache
          key: juxtapose-cache-none # never matches; only restore-keys apply
          restore-keys: |
            juxtapose-cache-${{ steps.base.outputs.sha }}
            juxtapose-cache-

      # Main: restore the previous cache, so the new one only grows.
      - uses: actions/cache/restore@v4
        if: github.ref == 'refs/heads/main'
        with:
          path: .juxtapose/cache
          key: juxtapose-cache-none
          restore-keys: juxtapose-cache-

      - run: npx -p @juxtapose/cli jux run --comment --html
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - uses: actions/cache/save@v4
        if: github.ref == 'refs/heads/main'
        with:
          path: .juxtapose/cache
          key: juxtapose-cache-${{ github.sha }}
```

Without the cache, a failing story is still reported, by hash and structure,
with "baseline image not available (not in cache); structure diff only". Add a
step that fails the job if an image is ever committed:

```yaml
- run: npx -p @juxtapose/cli jux doctor
```
