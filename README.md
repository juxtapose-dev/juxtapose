# juxtapose

<!-- [YOUR COPY] Tagline: one line on why someone would use this. -->

juxtapose tells you and your coding agent exactly what changed in a UI: which
element, which property, and the old and new values. It checks any page by URL,
and every story in Storybook or Ladle.

```text
style-only (color): button[name="Save"] color #ffffff→#fef08a. Structure explains the changed region.

  button[name="Save"] color #ffffff → #fef08a
```

## Why use it

<!-- [YOUR COPY] Optional: one or two sentences framing the list below. -->

- **Your agent can check its own UI work.** A verdict is a few hundred
  characters of JSON that names the change, so the agent acts on facts instead
  of describing a screenshot. It opens pixels only when the structure can't
  explain them.
- **Choose exact or visual comparison.** Exact SHA-256 comparison is the default.
  An opt-in [Pixelmatch policy](docs/configuration.md#visual-equivalence) can filter
  small color and antialias differences, with every tolerance-based pass reported
  explicitly. Approved baselines stay unchanged.
- **Failures explain themselves.** Each failure names the element and the
  property, groups stories that share one change, and with `--since` lists the
  changed files inside that story's imports.
- **Green runs are fast.** An exact match costs a hash comparison. `jux run`
  captures only the stories your change can reach, and a warm browser skips
  the launch on every run after the first.
- **Baselines live in your repo.** Approving a change is a diff in the pull
  request that caused it. No account, no bucket, no service.
- **No Playwright to install.** jux drives a pinned Chrome for Testing build
  directly over the DevTools protocol, and one command downloads it and
  verifies its checksum.

## Get started with an agent

The MCP server is the best way for an agent to evaluate UI changes. The agent
gets the snap, diff and review steps as tools, and one browser stays warm for
the whole session.

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

```yaml
- run: npx storybook build --quiet --disable-telemetry --loglevel error
- run: npx -p @juxtapose/cli jux run --comment --html
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The Storybook flags keep the build output short and turn off telemetry. Errors still print, so a failing build shows its cause.

`jux run` fails the job when a story changed, is new, or has a stale baseline,
and `--comment` posts the results on the pull request. See [CI](docs/ci.md).

## Documentation

- [MCP server](docs/mcp.md): setup for each client, and every tool
- [Agents](docs/agents.md): the CLI loop, the verdict, crops, groups and cause
- [Commands](docs/cli.md): every `jux` command
- [Configuration](docs/configuration.md): config file, masks, dynamic content
- [Browser](docs/browser.md): install, your own Chromium, the warm browser
- [Field tests](docs/field-tests.md): stability on three public Storybooks, and how to reproduce it
- [CI](docs/ci.md): pull request comments and the HTML report
- [Hosted uploads](docs/hosted-uploads.md): opt-in hosted review and upload retries
- [Watch mode](docs/watch-mode.md): the Storybook addon
- [Packages](docs/packages.md): what each package is for

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and
[ARCHITECTURE.md](ARCHITECTURE.md) for the design and the reasoning behind it.

## License

MIT © Magic Factory LLC. See [LICENSE](LICENSE).

For hosted PR approval, see [GitHub PR review](docs/github-pr-review.md): canonical CI rendering, inline evidence, and a required GitHub App check.
