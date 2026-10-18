# Experimental target paint observations

The shipment repair prototype reached four exact target captures using independent
paint measurements and target OCR/current DOM text. Its control was capped, so
this does not establish time/token savings. Keep the feature requested-only and
experimental; do not add it to default hints or acceptance policy.

## Implemented foundation

`extractTargetEvidence` accepts an optional asynchronous paint observer. The
observer receives the already decoded RGBA and a bounded inventory of full-image
opaque, exact-color, four-neighbor connected components. One decode and run-length
component scan serves the existing layout extractor and the optional observer.
The caller should retain only bounded derived data, never the full RGBA frame.

The inventory includes component bounds, exact fill, solid area and a member-pixel
seed. A seed is necessary: disconnected same-color components can have overlapping
bounds, so the first matching pixel in a bounding box may belong to another
component. The background estimate, components below16solid pixels and bounds smaller
than24×16 are excluded. Full-image describes extraction extent, not exhaustive
coverage. Observations are sorted, capped
at256 and include omissions. Complexity exhaustion returns no partial inventory.

The current layout matcher's80% rectangular-occupancy rule is unchanged. Rounded
Ready/Delayed pills measured68–71% occupancy and were excluded by that rule; they
can be described independently without admitting them as layout/DOM matches.
An independent audit across63unique saved images verified325component extents and
areas from their seeds. Both default and observer-enabled layout outputs were
identical to the parent implementation on every image. These checks prove
extraction behavior on this corpus, not identity or OCR accuracy.

## Optional integration

The session requested-reference layout cache accepts an optional, versioned OCR
provider through the embedding-only `experimentalTargetTextProvider` option.
Normal CLI sessions do not enable it or load an OCR engine. Reuse the observer's pixels rather than decode or segment again.
Bound provider concurrency and candidate crops, memoize pending/results, evict
failed requests, and validate persisted records before reuse. Bind cache entries
to crop pixels/dimensions/fill and provider engine/language/preprocessing/settings.
A provider failure must preserve geometry and the saved-crop fallback. The core
observer is awaited and a rejection rejects extraction; the optional OCR adapter
must catch provider errors inside its observer so geometry remains available. Test
malformed records, failures and provider-version invalidation without paid trials.
Do not install or add an OCR runtime dependency during this work.
Recognition has a two-second deadline including queue time. Timed-out active
work retains its real concurrency slot until the provider settles; queued work
expires without starting. Geometry remains available, and failures are retryable.
A stalled embedding provider should be replaced by its owner rather than
starting unbounded replacement workers. Disk image evidence rejects DOM text
annotations and inconsistent recognition states; current DOM text is derived
from the current structure after loading the pixel-only image cache.

Keep target `textInside` (OCR) separate from current `elementText` (structure).
Require an OCR crop to equal a full-image-extracted component's bounds, reject
frame-touching components, and retain provenance and score rules. The selected
screen rejected six unsafe ROIs and kept three positives: a clipped Manage read
“Mana” at94, and a two-control ROI read “Active3Pending2” at96. Confidence alone
cannot establish association.

Complete component bounds do not guarantee complete or singular text. A whole
container can contain several labels, and internal text clipping can remain.
`textInside` means observed text within component **bounds**, never a complete
label, DOM identity or target/current correspondence. A member-pixel seed also
does not establish which visible text belongs semantically to the component.

Preserve existing geometry/confidence/crop navigation and the3072-byte focused
response bound. Expose full experimental detail only on demand; geometry takes
priority. Keep the legitimate mobile layout crop: the word-box prototype omitted
the requested action and mixed adjacent rows, so it did not replace that crop.

## Text projection requirement

Keep the complete validated OCR result in the derived cache, separate from its
compact response projection. Focused responses should return only a few short
observations near useful deltas, with omission counts. Omit an overlong label
whole rather than creating a misleading partial identity. An explicit MCP
request should retrieve full cached text for a selected saved region without
rerunning OCR or recapturing. Full means all text already extracted for that
region, not automatic OCR of the whole page.

With the experimental provider configured, `reference({name, detail: "layout"})`
adds at most two short observations per side when useful facts fit alongside
existing geometry. `reference({name, detail: "json"})` exposes the analyzed regions
under `states[].layout.paint.target.regions[]`, including `text.full`. This is
currently a named-target accessor, not a selected-region text API. Full JSON,
warm reads and a new session reuse validated disk entries without recognition.

Identical crop pixels at identical positions and controls already explained
by geometry are omitted from the focused paint block. Changed crop pixels rank
ahead of unchanged translated components; unexplained translations remain
available. Groups share text, fill and dimensions. The saved shipment screen
previously repeated unchanged labels ahead of the changed Ready fill; filtering
exposed target `#e8efd8` and current `#e3edf8` together with existing geometry.
Unequal multiplicities are retained. No new color evidence means no paint block.
Full cached evidence remains available regardless of this projection.

A four-state real-worker smoke made 16 unique recognition calls at concurrency
two, then zero further calls for full detail, warm reads or restart. Cold analysis
took 231 ms, warm 2.7 ms, excluding 75 ms worker startup (single observations,
not a latency benchmark). Defaults were byte-identical and made no OCR calls.
This establishes integration/cache behavior, not whole-task token savings.

Optimize whole-task tokens and calls at equal quality, rather than response
bytes alone. Extra measured context belongs together when it enables the next
edit; full cached text, DOM and analysis stay on demand. Cached model reads are
reported separately from counted tokens. No default promotion before an agent
comparison demonstrates a benefit.

Use per-call `question` notes to distinguish missing measured facts from duplicate
reads or legitimate layout crops. They guide feature selection; they are not
proof that each read was needed or that the instrumentation alone saves tokens.
