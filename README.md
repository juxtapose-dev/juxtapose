# juxtapose

Check the UI your code actually renders. Juxtapose compares screenshots and
records DOM changes so people and coding agents can investigate differences
before merging. It works with pages by URL, Storybook and Ladle.

```text
style-only (color): button[name="Save"] color #ffffff→#fef08a. Structure explains the changed region.

  button[name="Save"] color #ffffff → #fef08a
```

## Why use it

- **Give your agent visual feedback.** Start with a bounded change summary, then
  inspect recorded properties and images where needed.
- **Choose exact or visual comparison.** Exact SHA-256 comparison is the default.
  An opt-in [Pixelmatch policy](docs/configuration.md#visual-equivalence) can filter
  small color and antialias differences, with every tolerance-based pass reported
  explicitly. Approved baselines stay unchanged.
- **Find unexpected changes.** Grouped property and geometry observations help
  focus review on the differences that need investigation.
- **Reduce repeated work.** After capture, matching image hashes skip detailed
  pixel diffing. Affected-story analysis can limit captures, with a full-run
  fallback when uncertain; a reusable browser avoids some launches.
- **Local baselines live in your repo.** Local approval updates the manifest and
  structure files without an account or hosted service. Hosted review decisions
  are separate.
- **No Playwright to install.** jux drives a pinned Chrome for Testing build
  directly over the DevTools protocol, and one command downloads it and
  verifies its checksum.

## Get started with an agent

The local MCP server exposes this loop as agent tools. It provides snap, diff
and review steps and can reuse a browser across captures.

1. Install the CLI and the browser:

   ```bash
   pnpm add -D @juxtapose/cli
   npx -p @juxtapose/cli jux browser install   # once, ~100 MB
   ```

2. Add the server to your agent. For Claude Code:

   ```bash
   claude mcp add jux -- npx -y -p @juxtapose/cli jux mcp
   ```

   For Cursor and other MCP clients, see [MCP server](docs/mcp.md).

3. Ask the agent to change something that renders. It snaps the page before and
   after the edit, then reads the verdict.

| Tool      | What the agent uses it for                                           |
| --------- | -------------------------------------------------------------------- |
| `snap`    | Capture a page by URL: pixels and structure                          |
| `diff`    | Compare two snaps and get the verdict; `crops: true` adds the pixels |
| `run`     | Capture and compare the stories in a Storybook or Ladle build        |
| `check`   | Report whether anything still needs review                           |
| `handoff` | Get the verdict and a fix prompt for one failing story               |
| `explain` | Which layer set each capture setting of a story or variant           |
| `approve` | Approve stories by id; there is no approve-all                       |

### Without MCP

Any agent with a shell can run the same loop with the CLI:

```bash
jux snap http://localhost:5173/settings --as before
# …edit code…
jux snap http://localhost:5173/settings --as after
jux diff before after          # exit 0 identical, 1 different, 2 usage, 3 environment
```

For Claude Code, the `visual-check` skill in `plugins/claude-code/` teaches this
loop. See [Agents](docs/agents.md) for the verdict format and every option.

## Get started with Storybook or Ladle

```bash
pnpm add -D @juxtapose/cli
npx storybook build --quiet --disable-telemetry --loglevel error  # or: npx ladle build
npx -p @juxtapose/cli jux browser install   # once, ~100 MB
npx -p @juxtapose/cli jux init              # writes the config, captures, approves
git add juxtapose.config.json juxtapose.manifest.json juxtapose.structures/ .gitignore
```

To focus on specific examples, use `jux list` to find IDs, then
`jux run 'components-button--*'`. Add `--dry-run` to preview the selected captures.
See [example selection](docs/cli.md#select-specific-examples) for variants and JSON.

After that, run `jux run` whenever you change a component. It captures the
stories your change can affect and compares them with their baselines. When it
can't be sure what a change reaches, it captures everything. Approve an
intended change with `jux approve --story <id>`.

To review diffs inside Storybook as you work, add the addon:

```bash
pnpm add -D @juxtapose/storybook   # then add it to .storybook/main.js addons
```

The addon shows each diff in a panel, marks changed stories in the sidebar, and
recaptures a component when you edit it. See [Watch mode](docs/watch-mode.md).

The `jux` command comes from `@juxtapose/cli`. Without it installed, run it as
`npx -p @juxtapose/cli jux …`: the unscoped `jux` package on npm is unrelated.

## In CI

Use Node.js 22.2 or later and install the project dependencies first. Linux
runners also need the [browser system libraries](docs/browser.md).

```yaml
- run: npx -p @juxtapose/cli jux browser install
- run: npx storybook build --quiet --disable-telemetry --loglevel error
- run: npx -p @juxtapose/cli jux run --comment --html
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The Storybook flags keep the build output short and turn off telemetry. Errors still print, so a failing build shows its cause.

`jux run` fails the job when a story changed, is new, or has a stale baseline,
and `--comment` posts the results on the pull request. See [CI](docs/ci.md).

## Documentation

Start with the [documentation index](docs/README.md).

- [MCP server](docs/mcp.md): setup for each client, and every tool
- [Agents](docs/agents.md): the CLI loop, the verdict, crops, groups and cause
- [Commands](docs/cli.md): every `jux` command
- [Configuration](docs/configuration.md): config file, masks, dynamic content
- [Browser](docs/browser.md): install, your own Chromium, the warm browser
- [CI](docs/ci.md): pull request comments and the HTML report
- [Hosted uploads](docs/hosted-uploads.md): opt-in hosted review and upload retries
- [Watch mode](docs/watch-mode.md): the Storybook addon
- [Packages](docs/packages.md): what each package is for

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and
[ARCHITECTURE.md](ARCHITECTURE.md) for the design and the reasoning behind it.
Contributor measurement guides cover [field tests](docs/field-tests.md) and
[profiling](docs/profiling.md); historical measurements are scoped evidence, not
current product performance guarantees.

## License

MIT © Magic Factory LLC. See [LICENSE](LICENSE).

For hosted PR approval, see [GitHub PR review](docs/github-pr-review.md): canonical CI rendering, inline evidence, and a required GitHub App check.
