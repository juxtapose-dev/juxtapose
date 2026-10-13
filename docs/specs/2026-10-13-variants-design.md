# Per-story capture variants

- Status: draft for review
- Issue: #22. #23 (interaction states) and #111 (sharding) build on it.
- Prior art: storycap `variants` with `extends`, from the 2026-10-13 storycap and
  storycapture comparison.

## Goal

A story can be captured under several named settings: viewports, a dark color
scheme and, later, interaction states. Each setting gets its own baseline,
verdict and approval. You no longer duplicate a story to get a mobile or dark
capture.

## Non-goals

- Interaction states. #23 adds them later as variant fields, and this design
  leaves room for them.
- Sharding (#111).
- Removing baselines of stories that no longer exist. That's a gap today for
  stories too, and gets its own issue (see Found along the way).

## Declaring variants

On a story, use `parameters.juxtapose.variants` in Storybook and
`meta.juxtapose.variants` in Ladle. For the URL platform, use `variants` on the
URL entry:

```js
parameters: {
  juxtapose: {
    variants: {
      mobile: { viewport: { width: 375, height: 812 } },
      dark: { colorScheme: 'dark' },
      'mobile-dark': { extends: 'mobile', colorScheme: 'dark' },
    },
  },
}
```

For the whole project, `variants` in `juxtapose.config.json` applies to every
story:

```json
{ "variants": { "dark": { "colorScheme": "dark" } } }
```

Rules:

1. **Names** match `^[a-z0-9][a-z0-9-]{0,31}$`. Underscores are excluded so
   the key separator can't occur inside a name.
2. **Fields** are any per-story option (`viewport`, `delay`,
   `waitForSelector`, `mask`, `threshold`, `minDiffPercent`, `captureTimeout`,
   `animations`, `captureAfterPlay`), plus `colorScheme: 'light' | 'dark'` and
   `extends: string`. `skip` is not a field; to drop a variant, see rule 4.
3. **Resolution:** project variants are merged with the story's variants by
   name, and the story wins. A story can set a project variant to `false` to
   opt out (`variants: { dark: false }`). `extends` then resolves within the
   merged set, and fields are merged in this order: base story params, then
   the chain of extended variants, then the variant itself. A cycle or an
   unknown `extends` is a config error, which exits 2 and names the story and
   variant.
4. **The default capture** (no variant) always happens unless the story is
   skipped. A story skips one variant by setting it to `false`.
5. **Live parameters:** values read from Storybook after render
   (`readLiveParams`) merge under the variant, so a variant's `viewport` and
   `colorScheme` are never overridden by the story's own live `viewport`.

## Identity

`StoryManifest` gains two optional fields, and nothing that exists changes
meaning:

```ts
interface StoryManifest {
  storyId: string; // the capture key: base id, or `${base}__${variant}`
  baseStoryId?: string; // set on variant entries: the platform's own id
  variant?: string; // set on variant entries
  // title, name, componentPath, params as today; params are the resolved variant params
}
```

- **Capture key:** `${baseStoryId}__${variant}`. It's readable as a file name
  (`button--primary__dark.webp`) and passes `encodeStoryId` and `shellQuote`
  unchanged. Storybook ids never contain `_`. A Ladle key or a URL id could,
  so after expansion any key that collides with another key is a config error
  that names both.
- **Platform calls** (`showStory`, `storyUrl`, `switchStory`, `readLiveParams`,
  `waitForRenderPhase`, URL `resolve`) always receive `baseStoryId ?? storyId`.
  The Platform interface doesn't change.
- **Everything keyed by story id** keeps using the capture key: the manifest,
  baseline files, run images, `report.json`, `check`, handoff and the server's
  image routes. No migration and no manifest version bump. Existing baselines
  are default captures, so they keep passing.
- **`DiffResult` and `Snapshot`** gain the same optional `baseStoryId` and
  `variant`, so reports and the addon can group without parsing keys.

## Capture

- Variants expand at enumeration time, after the adapter returns its stories:
  one `StoryManifest` per capture key, sorted by key with `compareCodeUnits`.
  The pool, shuffling, concurrency and warm browser all work unchanged,
  because a variant is just another job.
- Viewport goes through the existing per-capture `ensureViewport`.
- **Color scheme** needs one new call: `Page.setEmulatedMedia`, applied before
  `showStory` on every capture and memoized per page like `ensureViewport`.
  The default capture explicitly resets to `light`. A page that the pool
  reuses therefore can't carry a dark scheme into the next story, and the
  memo makes it free when nothing changes. Today's fixed emulation (light,
  reduced-motion `no-preference`, forced-colors `none`) stays the baseline.
- Determinism: each variant is checked by `check:determinism`, which gains a
  variant story in the Storybook example.

## Selection and affected analysis

- Variants inherit their story's `componentPath`, so affected analysis selects
  or drops a story together with all its variants. No change is needed there.
- `jux run --story <id>` is ignored today (see Found along the way). It's
  implemented here: a base id selects the story and all its variants, and a
  capture key selects one capture. The MCP `run` tool's `stories` argument
  gets the same meaning.
- `jux approve --story <id>` and MCP `approve` accept a base id, meaning every
  variant in the run, or a capture key. Unknown ids keep their current
  behavior: the CLI says there's nothing to approve, and MCP returns an error.

## Reporting

- **CLI output and PR comment:** one row per capture key, shown as
  `button--primary · dark`. The summary counts captures and adds "across N
  stories". Groups and verdicts are unchanged, since they're per capture.
- **HTML report:** variants nest under their story.
- **Storybook addon:**
  - The sidebar dot for a story shows the worst status across the story and
    its variants (fail, then new, then stale, then pass), because Storybook's
    status API is keyed by the real story id.
  - The panel gets a variant switcher (default plus each variant) for the
    selected story. Approve acts on the shown capture, with "Approve all
    variants" next to it.
  - Watch mode expands an affected story to its variants.
- **Server:** `affected` and `run` expand a base id to its capture keys.
  Image, handoff and approve routes already take any key.

## Agents

- MCP tool results already carry `storyId`, the capture key, and gain
  `baseStoryId` and `variant`.
- `handoff` on a variant key says which variant it is and what the variant
  sets, such as its viewport and color scheme, so an agent knows the
  conditions it's fixing.

## Found along the way

These are fixed here or filed separately:

1. `jux run --story` is parsed but ignored, and MCP `run`'s `stories` argument
   is dropped. Fixed here, since variants need selection.
2. Baselines of a removed story stay in the manifest forever, with no report
   entry. Removing a variant makes this more common. File an issue for an
   orphan report (`jux check` warns) and a `jux prune`.
3. PR comment and handoff print `jux handoff <id>` and `jux approve --story
<id>` without `shellQuote`. That's the known hardening item H, and these
   are fixed here because variant keys flow through them.
4. The server's handoff points at a baseline path nothing writes
   (`source.ts:206`). File it as a bug.

## Testing

- **Unit tests:**
  - name validation;
  - merging project and story variants, including `false` opt-out;
  - `extends` chains, cycles and unknown targets;
  - key collisions;
  - the live-parameter merge order;
  - sidebar worst-status rollup;
  - `--story` with a base id and with a key.
- **Real Chrome:**
  - a dark variant captures dark pixels; the default capture right after it
    on the same pooled page is light, and byte-identical to a capture taken
    alone;
  - a mobile variant captures at 375×812.
- **Examples:** add `mobile` and `dark` variants to one Storybook and one
  Ladle story. Byte identity of every existing default capture against
  baselines approved by main, plus `check:determinism` fresh and with
  `--daemon`.
- **MCP:** `run` with a base id returns every variant, and `approve` with a
  base id approves them all.

## Open questions

1. Should project-wide variants apply to the URL platform? Proposed: yes,
   consistently.
2. Should the default capture be optional (`default: false`) for stories that
   only make sense at mobile size? Proposed: not in v1; `skip` covers the
   whole story.
