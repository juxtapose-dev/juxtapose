# Structure capture and diff evidence

Contributor reference for the implemented structure pipeline. For commands and
agent workflows, use [agents](../agents.md) and [MCP](../mcp.md). Configuration is
covered in [configuration](../configuration.md). This reference describes
invariants, not proposed features or an efficiency benchmark.

## Capture boundary

[Structure capture](../../packages/core/src/capture/structure.ts) normalizes a
Chrome DOM snapshot into `juxtapose.structure/v1`. Collection runs alongside the
screenshot pipeline and records selected computed styles, geometry, hierarchy,
accessible labels and resource evidence. It is bounded; truncation or missing
structure must remain visible to callers rather than imply a complete review.

Masking applies to structural evidence as well as pixels. Hidden and offscreen
content needs the collector's explicit visibility rules; changing them can affect
both evidence coverage and capture cost. The collector's property list, element
bounds and normalization tests are the source of truth for these details.

The canonical structure hash describes the normalized semantic structure. It is
separate from an image hash and from a checksum of the stored sidecar bytes.
Changing storage formatting must not silently change semantic identity. Baseline
storage supports compact structures and legacy readers; see the reviewed
[storage reference](../performance/2026-10-16-compact-structures.md).

## Interpretation

[Structural comparison](../../packages/core/src/diff/structural/) matches elements
and reports observed additions, removals, text/style/attribute changes and geometry.
Stable identity, hierarchy and matching ambiguity matter: a path alone does not
prove that two elements are the same after an insertion or reorder.

The image comparison policy determines the visual verdict. Structure explains
observed changes; equal structural hashes do not prove equal pixels, correct
intent or harmless rendering noise. Explicit visual-equivalence comparison
retains its own image/hash/ancestry checks and does not update approved baselines.

DOM changes and import-graph associations are diagnostic evidence. They do not
prove a CSS root cause. Missing, truncated or ambiguous evidence must be reported
as such, without inventing a cause or implying full coverage.

## Maintenance checks

Use the real Chromium fixtures and tests beside the collector and structural
comparison code. Preserve mask behavior, stable ordering, semantic hash checks,
parent relationships and explicit incomplete evidence. Capture changes require
both fresh and daemon determinism checks described in [contributing](../../CONTRIBUTING.md).
Do not infer a performance or agent-token benefit from unit tests alone.
