# Targeted examples and two-build comparison (#256)

Status: proposed implementation sequence; not shipped. #255's approval batching
is independent and should ship first. Comparison should not require approval.

## Findings

Current main already accepts repeatable `run --story` exact IDs and fans a base
story out to its variants. The help omits this flag. There is no listing command,
glob selection, or two-build compare command. `approve` resolves today's context
before loading the reviewed run and `confirmForApprove` enumerates that context's
build directory: the wrong-build bug is credible from the code. The report write
in `run.ts` does not visibly add source provenance; verify all producers before
assuming the issue's claimed recorded build directory is reusable metadata.

## Selection experience

```sh
jux list
jux list 'charts-*' --json
jux run charts-line--basic charts-bar--stacked
jux run 'charts-*' --dry-run
jux run 'charts-*'
jux compare --base /tmp/main-storybook --head /tmp/branch-storybook 'charts-*'
```

Positional selectors and existing repeatable `--story` are equivalent. Exact IDs
retain their existing semantics; globs match IDs, not fuzzy substrings. Listing
shows title/name alongside copyable IDs. Start with deterministic ID globs; add
explicit title/file filters only with defined matching semantics, rather than
silently interpreting ambiguous text as several namespaces.

Selectors form a union, deduplicate, and preserve discovery order. Every selector
must match: unmatched selectors fail with suggestions and never fall back to a
full capture. Explicit selection wins over affected analysis, as it does today.
A base story selects its configured variants; a full variant key selects only
that capture. Dry-run shows the exact expanded selection and count with no
screenshots. Live variant discovery may still require opening the preview: do
not promise zero browser work. MCP listing and selection use the same resolver.
Approval remains an explicit action with exact reviewed capture IDs; do not
silently broaden approval through the new run glob syntax.

## Delivery

1. Add list, positional/flag glob selection, dry-run, help and MCP parity using
   one core selector. Audit both pre-discovery and post-variant selection in
   run.ts: replacing only selectByStoryId would miss the early discovery filter.
   Test variants, overlapping selectors, unknown selectors and discovery subsets.
2. Fix approval provenance independently. Persist resolved target and relevant
   capture settings alongside each run; load before platform resolution. If a
   recorded build is gone, fail clearly and offer an explicit replacement target.
   Retain fresh hash confirmation; a changed/rebuilt directory must not silently
   approve different bytes. Specify legacy-run fallback and explicit overrides.
3. Implement compare with isolated ephemeral baseline state. Enumerate both
   builds, pair stable story/variant IDs, capture under identical settings and
   feed existing image/structure comparison paths. Keep project config and
   committed manifest byte-identical. Classify base-only/head-only captures
   explicitly; instability must block a clean result without masquerading as a
   confirmed visual change. Preserve both captures and normal explanation assets.
4. Expose the same operation through MCP. Return structured results, selection,
   source provenance and artifact links. No shell wrapper or approval necessary.
5. Add persistent base reuse only after correctness. A build-content digest alone
   is insufficient: include capture config, browser/encoder/environment identity,
   adapter/core behavior and variants. Dynamic external resources can invalidate
   static-build caching. Default conservatively; provide explicit refresh and
   report reused evidence. Do not use the old manifest as implicit compare state.

## Acceptance

Use two small builds with a known changed story, an unchanged story, one addition,
one removal, and an unstable example. Verify isolated project state, selective
capture, fresh confirmation target, cancellation, JSON and MCP parity. Then run a
selected slice of the real Chakra corpus used for #255 before a full two-build
comparison. No new browser-settle or capture pipeline is needed.
