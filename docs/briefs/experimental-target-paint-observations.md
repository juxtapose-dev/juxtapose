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

## Integration still to do

Wire an optional, versioned OCR provider into the session's requested-reference
layout cache. Reuse the observer's pixels rather than decode or segment again.
Bound provider concurrency and candidate crops, memoize pending/results, evict
failed requests, and validate persisted records before reuse. Bind cache entries
to crop pixels/dimensions/fill and provider engine/language/preprocessing/settings.
A provider failure must preserve geometry and the saved-crop fallback. The core
observer is awaited and a rejection rejects extraction; the optional OCR adapter
must catch provider errors inside its observer so geometry remains available. Test
malformed records, failures and provider-version invalidation without paid trials.
Do not install or add an OCR runtime dependency during this work.

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
region, not automatic OCR of the whole page. The accessor is not implemented yet.

Use per-call `question` notes to distinguish missing measured facts from duplicate
reads or legitimate layout crops. They guide feature selection; they are not
proof that each read was needed or that the instrumentation alone saves tokens.
