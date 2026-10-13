---
name: visual-check
description: Verify that a UI edit changed what you meant and nothing else, without reading screenshots. Use before and after any change to a page, component, stylesheet or design token that a browser renders. Snap the page with jux before editing, snap again after, read the jux diff verdict (what element, what property, old → new, and whether that explains every changed pixel), and escalate to --crops only when it does not. Not for changes that render nothing (server code, tests, docs) or pages you cannot reach (behind a login you do not have).
argument-hint: [url]
---

# Visual check: snap → edit → snap → diff

Pixels say _where_ something changed. The verdict says _what_: which element,
which property, old → new, and whether that explains every changed pixel. Read
the verdict; open an image only when the verdict tells you it cannot explain
the pixels. A full-page screenshot costs thousands of tokens and misses most
fine UI changes; the verdict is a few hundred tokens and names them.

How to run `jux`: if `@juxtapose/cli` is in the project's dependencies, a
`jux` script or `pnpm exec jux …` works. Otherwise run
`npx -p @juxtapose/cli jux …`, or install it (`pnpm add -D @juxtapose/cli`).
Do not run the unscoped npm name: it is an unrelated package. Check
`package.json` once before the first call. The commands below write the bare
`jux`; prefix them the way that works here. Every command accepts `--json`;
prefer it. Exit codes: 0 identical, 1 different, 2 usage error, 3 the tool or
environment failed (no browser, unreadable input) — never treat a 3 as
"different".

**Never accept a change.** Do not run `jux approve`, and do not edit
anything under `.juxtapose/` or `juxtapose.manifest.json` to make a diff go
away. Accepting a visual change is the human's call. Your job ends at
reporting the verdict (and the crops, if you needed them).

## 1. Before you edit: snap the page

```bash
jux snap http://localhost:5173/settings --as before
```

Snap every page the edit could touch in one call when you suspect several
(a shared component, a token):

```bash
jux snap http://localhost:5173/ http://localhost:5173/settings --as-prefix before
```

If the dev server is not running, start it first. If `jux snap` exits 3
because the browser is missing, run `npx -p @juxtapose/cli jux browser install` and
retry. Do not skip the before snap: there is no way to take it after the
edit.

## 2. Edit the code

## 3. After you edit: snap again, then diff

```bash
jux snap http://localhost:5173/settings --as after
jux diff before after --json
```

or, for a set: `jux snap … --as-prefix after && jux diff --prefix before after --json`.
The set verdict (`juxtapose.verdict-set/v1`) has one verdict per page in
`pages[]`, plus `missing[]` and `errors[]`; exit 3 beats 1 beats 0.

## 4. Read the verdict, not the pixels

The JSON is `juxtapose.verdict/v1`. Check, in this order:

1. `classification` and `summary`: one line saying what kind of change it is
   and the first few deltas.
2. `deltas[]`: every typed fact (`style`, `text`, `attr`, `added`, `removed`,
   `moved`, `resized`, `shift`). Compare each against what you intended. A
   delta you did not intend is the regression; fix it before moving on. A
   `shift` ("N elements after X moved down 14px") is the layout consequence
   of the delta it names, not a separate change. `deltaCount` is the total;
   `deltas` is only the prefix that fits.
3. `explained`: `full` means the structure accounts for every changed pixel.
   `partial` or `none` means some pixels changed with no DOM or style delta
   behind them (canvas, images, rendering) — see section 5.
4. `flags[]`:
   - `element-removed`, `text-changed`: always deserve a look.
   - `large-reflow`: many elements moved; check the layout, not just the
     named delta.
   - `unexplained-pixels`: some changed pixels have no delta behind them (see
     section 5).
   - `sub-threshold`: the pixel diff marked nothing; the deltas are the whole
     change.
   - `below-fold`: the page is taller than the viewport and anything below it
     was not checked; snap with a taller `--viewport` if the edit is down
     there.
   - `structure-truncated`: the page was too large to record fully; the
     verdict may miss deltas.
   - `no-baseline-structure`, `no-current-structure`: one snap has no
     structure sidecar; re-snap.
5. `change` and `signature`: `change` is the change in abstract form, with
   every element reduced to role or tag and no per-page specifics. Two
   verdicts with equal `signature` (or a `jux run` group line
   `<change> — N stories`) are one change shared by several pages or
   stories, so it is one decision, not N.

Exit 0 with `classification: identical` means the edit changed nothing at
this viewport. That is a finding, not a pass: if you meant to change
something, you did not.

## 5. Escalate only when the verdict cannot explain the pixels

When `explained` is not `full`, or a flag surprises you, run the command in
`escalate.command`:

```bash
jux diff before after --crops
```

It writes one PNG per changed region — baseline on the left, current on the
right, unexplained regions first, enlarged, at most 512px a side, at most 8
— to `.juxtapose/crops/before~vs~after/crop-N.png` and lists the paths (with
`--json`, `crops[]` with `explained` per region and `dir`). It exits 1 when
the pair differs and writes nothing when it is identical. Under
`sub-threshold` no region was marked, so the crops are the changed elements
instead. Open those crops
with an image viewer or your Read tool. Do not open the full `.webp` snaps
first; a crop is a fraction of the tokens and shows the exact pixels in
question. `--crops` takes one pair: for a page set, pick the page and pass
its two snap names (`--prefix` with `--crops` exits 2).

## 6. Report

Say what changed in terms of the deltas (element, property, old → new),
whether it matches the intent, and what you did about any delta that did not.
Quote the verdict's `summary`. Do not paste the whole JSON.

## In a workbench project (Storybook, Ladle)

The same verdict is attached to every failing story in `jux run --json` as
`results[].structural`. With `--since <commit>` it carries `cause`, one of:

- `in-closure`: changed files this story imports, nearest first (the story
  file itself is distance 0). With `partial: true` the trace was incomplete
  ("other imports could not be traced"): a listed file is not necessarily
  the cause, so check every file you changed, not only those.
- `config`: a root lockfile, root `tsconfig*.json` or workbench config dir
  changed; it reaches every story, so expect other stories to fail the same
  way.
- `none-in-closure`: none of the changed files are in this story's fully
  traced imports, so the change likely came from outside your edit (a
  dependency, an asset, the environment, render drift).
- `unknown` ("Cause unknown"): the build does not expose enough to trace the
  story's imports (a Storybook build often cannot trace a component edit), or
  there is no manifest or `--since`. It is not evidence the edit is innocent.

`groups[]` lists
changes shared by several failing stories: one decision, not many.
`jux handoff <storyId>` prints the story's verdict as a prompt, with the cause
under `## Why`, ending with the `--crops` command for that story.

## When not to use this

- The change renders nothing: server code, tests, build config, docs.
- The page needs a login you do not have, or a backend that is not running.
- You are asked to judge taste, not change: the verdict reports facts; it has
  no opinion on whether blue is better than green.
