# In CI

The step excerpt below assumes checkout, Node.js 22.2 or later, project dependencies
and the pinned browser plus Linux system libraries are installed. The complete
job below includes that setup.

`jux run --comment` posts a summary to the pull request, updating the same
comment on every push rather than adding a new one:

```yaml
- run: npx storybook build --quiet --disable-telemetry --loglevel error
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

The Storybook flags keep the build output short and turn off telemetry. Errors still print, so a failing build shows its cause.

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

A run on the main branch saves the cache. A passing run keeps its capture, and
images are named by hash, so a restored cache can only add files. A pull
request restores the newest main cache. Its `restore-keys` try the merge-base
commit first, but on a `pull_request` event `HEAD` is a test merge commit and
the base branch may have moved, so in practice this finds the most recent main
cache, which is usually the one you want.

This job assumes a pnpm project with `@juxtapose/cli` pinned in devDependencies
and its lockfile. Adapt the build command and paths for your project.

```yaml
jobs:
  visual:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the merge-base lookup below needs history
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Install Chrome and Linux system libraries
        shell: bash
        run: |
          set -euo pipefail
          pnpm exec jux browser install
          chrome_dir=$(dirname "$(pnpm exec jux browser path)")
          sudo apt-get update
          sudo apt-get satisfy -y --no-install-recommends "$(paste -sd, "$chrome_dir/deb.deps")"
      - run: npx storybook build --quiet --disable-telemetry --loglevel error

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

      - run: pnpm exec jux run --comment --html
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      # Not `if: success()`: a failing main run still has cached the images of
      # every story that passed, and those are the ones later runs need.
      - uses: actions/cache/save@v4
        if: ${{ !cancelled() && github.ref == 'refs/heads/main' }}
        with:
          path: .juxtapose/cache
          key: juxtapose-cache-${{ github.sha }}
```

Things to know before you rely on it:

- `path: .juxtapose/cache` assumes the default cache directory and a project at
  the repository root. For a monorepo package, use `packages/web/.juxtapose/cache`
  (the package's own path); if you set `storage.dir`, use that directory
  instead.
- Baselines must be approved on the platform that runs CI. Pixels can differ
  between macOS and Linux, so a laptop-approved baseline may not match the CI
  runner. Approve in CI, or on the same OS in a container. Until the hashes
  match there is nothing to pass, so the main run keeps no images and the cache
  stays empty.
- The cache is not pruned. Every approved image stays, named by hash, and
  GitHub evicts caches by age on its own schedule, so a cache grows with the
  number of distinct approved renders. Cleaning up what no manifest references
  is part of
  [#114](https://github.com/juxtapose-dev/juxtapose/issues/114).

Without the cache, a failing story is still reported, by hash and structure,
with "baseline image not available (not in cache); structure diff only". Add a
step that fails the job if an image is ever committed:

```yaml
- run: npx -p @juxtapose/cli jux doctor
```
