# Agent loop: snap → edit → snap → diff

An agent with MCP support gets the same loop as tools, with one warm browser for
the session: see [MCP server](mcp.md). This page covers the CLI form and the
reference for every result it returns.

Pixels say _where_ something changed. The verdict says _what_: which element,
which property, old → new, and whether that explains every changed pixel.

```bash
jux snap http://localhost:5173/settings --as before
# …edit code…
jux snap http://localhost:5173/settings --as after
jux diff before after
```

A story with `unstable` in the run report was captured twice and came out
differently. `jux approve` refuses it (exit 1, story named) until it is made
deterministic or `--allow-unstable` is passed; see [cli.md](cli.md). Its
`flake` field names the cause and the config patch to apply.

Exit 0 means identical, 1 means different, 2 is a usage error, 3 means the
tool or environment failed (no browser, an input that will not read) — never
approve on a 3. `jux diff` does not launch a browser. The outputs below are
real, from the mutation corpus (`scripts/structural-corpus.mjs`): one page, one
CSS property changed per variant.

Human form:

```
style-only (color): button[name="Save"] color #ffffff→#fef08a. Structure explains the changed region.

  button[name="Save"] color #ffffff → #fef08a

next: jux diff before after-color --crops  (opens the pixels)
```

With `--json`, the same verdict as one object, byte-identical for the same
inputs:

```json
{
  "schema": "juxtapose.verdict/v1",
  "classification": "style-only",
  "styleTags": ["color"],
  "summary": "style-only (color): button[name=\"Save\"] color #ffffff→#fef08a. Structure explains the changed region.",
  "change": "style-only (color): button color #ffffff→#fef08a",
  "deltas": [
    {
      "kind": "style",
      "el": "button[name=\"Save\"]",
      "prop": "color",
      "from": "rgb(255, 255, 255)",
      "to": "rgb(254, 240, 138)"
    }
  ],
  "deltaCount": 1,
  "coverage": 1,
  "explained": "full",
  "unexplainedRegions": [],
  "flags": [],
  "signature": "4ea08e7155e04f1e8e213dacfcc01e7aa2292ab257df85a8840def0d566632d4",
  "escalate": {
    "command": "jux diff before after-color --crops"
  }
}
```

## Why structure: a change the pixel diff cannot see

A `background-color` change from `#2563eb` to `#1d4ed8` is under the pixel
diff's tolerance: the images differ, but nothing is marked. The verdict still
names the property:

```
style-only (color): button[name="Save"] background-color #2563eb→#1d4ed8. Pixel diff below tolerance; structure explains it.

  button[name="Save"] background-color #2563eb → #1d4ed8

flags: sub-threshold

next: jux diff before after-bg --crops  (opens the pixels)
```

`flags: sub-threshold` is how you know the pixels alone would have told you
nothing; the deltas are the change.

## Several pages at once

One browser launch, one snap per page, then one verdict per page. Below, the
corpus server plays the edit: before it, `/op/color` and `/op/padding` serve
the unchanged page.

```bash
jux snap $URL/op/noop $URL/op/color $URL/op/padding --as-prefix before
# …edit code…
jux snap $URL/op/noop $URL/op/color $URL/op/padding --as-prefix after
jux diff --prefix before after
```

```
3 pages: 2 changed, 1 identical

op-color: style-only (color): button[name="Save"] color #ffffff→#fef08a. Structure explains the changed region.

  button[name="Save"] color #ffffff → #fef08a

next: jux diff before-op-color after-op-color --crops  (opens the pixels)

op-padding: style-only (spacing): button[name="Save"] padding 8px 12px→12px 16px; 6 elements after button[name="Save"] moved down 4px; main resized height +4px (+3 more). Structure explains all 9 changed regions.

  button[name="Save"]
    padding 8px 12px → 12px 16px
    resized +8×+8px, moved up 4px
  6 elements after button[name="Save"] moved down 4px
  img[name="Logo"] moved right 8px
  main resized height +4px

next: jux diff before-op-padding after-op-padding --crops  (opens the pixels)

op-noop: identical: images byte-identical, no structural change.
```

`--json` prints the page set (`juxtapose.verdict-set/v1`, below).

## The verdict (`juxtapose.verdict/v1`)

| field                | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`             | `juxtapose.verdict/v1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `classification`     | `identical` (byte-identical images and no deltas — never just "0 changed pixels"; if the pixels contradict the caller's `imagesIdentical`, the pixels win), `render-drift`, `dimension-change`, `element-added`, `element-removed`, `reflow`, `geometry`, `text-only`, `style-only`, `attr-only`, `mixed`, `unknown`                                                                                                                                                                                                                                             |
| `styleTags`          | for `style-only`/`mixed`: `color`, `typography`, `spacing`, `border`, `effects`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `summary`            | templated, ≤ 300 chars                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `change`             | the change with every element reduced to role/tag and no per-story tail, ≤ 160 chars: what stories sharing a `signature` have in common. Absent when there are no deltas                                                                                                                                                                                                                                                                                                                                                                                         |
| `deltas`             | at most 20 typed facts (`text`, `style`, `attr`, `added`, `removed`, `moved`, `resized`, `shift`), and only the prefix that keeps the verdict ≤ 1,500 chars (labels ≤ 60, values ≤ 200)                                                                                                                                                                                                                                                                                                                                                                          |
| `deltaCount`         | total deltas found, including any not listed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `coverage`           | fraction of changed-region area touching a delta's element                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `explained`          | `full` (coverage ≥ 0.98), `partial` (≥ 0.5) or `none`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `unexplainedRegions` | changed regions no delta accounts for: canvas, image content, or rendering drift (the prefix that fits the 1,500-char budget; `coverage` covers all)                                                                                                                                                                                                                                                                                                                                                                                                             |
| `flags`              | `element-removed`, `text-changed`, `large-reflow`, `unexplained-pixels`, `sub-threshold` (the images differ but the pixel diff marked nothing; the deltas are the change), `structure-truncated`, `no-baseline-structure`, `no-current-structure`, `below-fold`                                                                                                                                                                                                                                                                                                  |
| `signature`          | sha256 of the classification and the deltas with elements abstracted to role/tag — the same change on two pages shares one                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cause`              | only from `jux run --since`: `{ kind, files, partial? }`. `in-closure`: changed files this story imports (≤ 5, nearest first, paths relative to the project root, ≤ 80 chars keeping the tail); `partial: true` when the trace was not complete, so the change may come from a file not listed (absent when complete). `config`: a root lockfile, root `tsconfig*.json` or workbench config dir changed, which reaches every story. `none-in-closure`: no changed file is in the story's traced imports. `unknown`: the trace could not be completed (see below) |
| `escalate.command`   | the next command to run: `jux diff <a> <b> --crops` for a snap pair, `jux handoff <id>` for a story in a run. Arguments, `.webp` paths included, are shell-quoted when needed, so a verdict for two absolute paths names this machine's paths                                                                                                                                                                                                                                                                                                                    |

The verdict never decides pass/fail — the pixel hash does. It explains a
failure so an agent can compare the deltas with what it meant to change.
`jux run` attaches the same object to each failing story as
`results[].structural`, and `jux handoff` leads with it.

`cause` follows the Vite build manifest, which records chunks, not every
module. "Changed" means since `--since` (which must name a commit), including
uncommitted edits and untracked files, with both sides of a rename.
`none-in-closure` is claimed only when every module on the story's import
path has its own manifest entry with a source path, and every changed file is
named by some entry. A module Rollup inlined into a chunk is otherwise
invisible, and almost anything can be imported (JSON, SVG, `?raw` text,
images, `.mdx`), so the only exemptions are files no bundler imports: prose
docs (`.md`, `.rst`, `.adoc`, …), `LICENSE*`, `CHANGELOG*`, `AUTHORS*`,
`CODEOWNERS`, git and editor dotfiles, and `.github/`. In every other case the
answer is `unknown`, never a false "not your code". A Storybook build bundles
components into chunks with no source path, so there a component edit is
`unknown`; the story file itself, and modules with their own entry, are
still traced. A hit on an incomplete trace is still `in-closure`, but with
`partial: true` (and "other imports could not be traced" in the handoff): a
token edit bundled into the component chunk, beside a label edit in the
story, lists only the story file, and the token may be what changed the
pixels.

## Comparing two runs

`jux diff --runs <runA> <runB> --json` answers "did these two runs capture the
same pixels" from the `hash` on each `report.json` result, without a browser or
a pixel diff. It prints `juxtapose.run-diff/v1`
(`{ a, b, summary, different[], missing[] }`) and exits 0 only when every story
is identical. `hash` is not in the verdict text agents read, so it costs
nothing against its size budget.

## The page set (`juxtapose.verdict-set/v1`)

`jux diff --prefix before after --json` pairs `before-<slug>` with
`after-<slug>`. Slugs are path-based (path, query and fragment), so the
pairing survives a dev-server port change.

| field     | meaning                                                                                                                                                                                                                                                                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`  | `juxtapose.verdict-set/v1`                                                                                                                                                                                                                                                                                                                                                 |
| `pages`   | `{ slug, a, b, verdict }` per paired page, sorted by slug; `verdict` is a `juxtapose.verdict/v1`                                                                                                                                                                                                                                                                           |
| `missing` | `{ slug, have, want }` for a slug present under only one prefix: `want` is the snap name to take                                                                                                                                                                                                                                                                           |
| `errors`  | `{ slug, code, file }` for a pair that could not be compared. `code` is `snap-missing`, `sidecar-undecodable`, `image-undecodable` or `pair-undecodable` (both images look like WebP but one will not decode, and the decoder cannot say which); `file` is the snap file's basename (the same on every OS), or `null` for `pair-undecodable`. Never contains OS error text |
| `summary` | `{ identical, different, missing, errored }`                                                                                                                                                                                                                                                                                                                               |

## Exit codes

| code | meaning                                                                               |
| ---- | ------------------------------------------------------------------------------------- |
| 0    | identical                                                                             |
| 1    | different (for a page set: any page `different` or `missing`)                         |
| 2    | usage error: bad flags, a snap name collision, an input that cannot be a snap         |
| 3    | the tool or environment failed: no browser, an unreadable input, any `errors[]` entry |

For a page set, 3 beats 1 beats 0. One bad pair does not stop the others from
being verdicted. An unexpected crash prints one line and exits 3; set
`JUX_DEBUG=1` to also print the stack trace.

## Crops (`juxtapose.crops/v1`)

When `explained` is not `full`, the verdict's `escalate.command` is the
last step: `jux diff before after-color --crops` writes one PNG per changed region
— baseline on the left, current on the right, the region's box doubled for
context, enlarged to at most 512px a side, unexplained regions first — to
`.juxtapose/crops/before~vs~after-color/crop-N.png` and lists them. No browser.
When a side is a `.webp` path instead of a snap name, its part of the dir name is the
file's basename plus 8 hex characters of a hash of its absolute path
(`X-current.1a2b3c4d~vs~X-current.5e6f7a8b`), so same-named images from different
runs never share a dir. Read the dir from `dir` in `--json` output.

```
style-only (color): button[name="Save"] color #ffffff→#fef08a. Structure explains the changed region.

  button[name="Save"] color #ffffff → #fef08a

crops (baseline | current), unexplained first:
  /work/app/.juxtapose/crops/before~vs~after-color/crop-1.png  (35×12 at 31,84, 7×)
```

That is the real output of `jux diff before after-color --crops` on the corpus
`color` page at 1280×800, with the project path shortened to `/work/app`.

With `--json` the payload wraps the verdict: `{ schema, verdict, dir, crops[] }`
where each crop is `{ file, region, box, scale, width, height, explained }`
and `file` is a forward-slash path relative to the project root:

```json
{
  "schema": "juxtapose.crops/v1",
  "verdict": { "schema": "juxtapose.verdict/v1", "…": "as above" },
  "dir": ".juxtapose/crops/before~vs~after-color",
  "crops": [
    {
      "file": ".juxtapose/crops/before~vs~after-color/crop-1.png",
      "region": { "x": 31, "y": 84, "width": 35, "height": 12 },
      "box": { "x": 13, "y": 78, "width": 70, "height": 24 },
      "scale": 7,
      "width": 984,
      "height": 168,
      "explained": true
    }
  ]
}
```

- At most 8 crops. `explained` is `false` for a region no delta accounts
  for; those come first.
- Identical snaps write nothing, print `nothing to crop` (`"crops": []`,
  `"dir": null` with `--json`) and exit 0. A different pair exits 1.
- The pair's directory is emptied on every call, identical runs included, so
  a stale crop never sits beside a fresh one. `.juxtapose/crops/` ignores
  itself (it holds a `.gitignore`).
- With no marked region below the pixel tolerance (`sub-threshold`), each
  crop is one changed element, in delta order: the union of its old and new
  boxes, `explained: true`. With no element box either (a size change), the
  one crop is the whole overlapping frame, and its `explained` matches the
  verdict's (`true` only when that is `full`).
- It refuses, with exit 3, to write through a symlinked `.juxtapose`,
  `crops` or snaps path, or a symlinked file.
- `--crops` takes one pair; combined with `--prefix` it exits 2. Run
  `jux diff --prefix before after` first, then `--crops` on the page you want.

## Groups and cause (`jux run`)

A token bump that turns forty stories red is one decision, not forty.
`jux run` groups failing stories whose verdicts share a `signature` (and have
at least one delta), prints up to 10 groups largest first, and writes all of
them to `report.json` as `groups[]`: `{ signature, summary, storyIds }`. The
`change` line is the abstract form of the change, so it reads the same for
every story in the group.

With `--since <commit>`, each failing story's verdict also carries `cause`
(see the table above), printed before the structural summary. Here the story
file was edited (`label: 'Click me'` → `'Click me now'`):

```
  fail   button--primary 0.26%
         cause: Changed files this story imports, nearest first: `stories/Button.stories.jsx` (the story file itself).
         text-only: button[name="Click me"] text "Click me"→"Click me now"; button[name="Click me"] resized width +34.12px. Structure explains the changed region.
```

And here a shared component's padding changed (`10px 20px` → `12px 24px`).
A Storybook build bundles components into chunks without a source path, so
the cause is `unknown` and the review list prints nothing for it; the group
shows what the four stories have in common:

```
  1 change shared by several stories:
  style-only (spacing): button padding 10px 20px→12px 24px; div resized height +4px (+1 more) — 4 stories
    button--danger, button--ghost, button--primary, button--secondary
```

`jux handoff <id>` prints the cause under `## Why` (or `Cause unknown: …`)
and ends with the shell-quoted `jux diff … --crops --project …` command for
that story.

## Claude Code skill

`plugins/claude-code/` is a Claude Code plugin with one skill,
`visual-check`, that teaches the loop above: snap before editing, snap after,
read the verdict, open crops only when the verdict cannot explain the pixels,
never a full screenshot first. Load it for a session with:

```bash
claude --plugin-dir path/to/juxtapose/plugins/claude-code
```

and invoke it as `/juxtapose:visual-check`, or let Claude pick it up when you
ask it to change something that renders.
