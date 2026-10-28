# Structured target evidence

`targetEvidenceFromStructure(snapshot)` converts a captured `StructureSnapshot`
into `TargetEvidence` without a browser or image decode. Blocks retain captured
rectangles, parent/child links, and provenance. Text-bearing blocks also retain
`text.value`, `text.tag`, and captured computed typography in `text.styles`.

Keep inline blocks separate: a keyboard shortcut can use monospace while its
surrounding sentence uses a proportional font. An element's captured text may
exclude descendants; it is not a complete concatenated sentence. Child order and
rectangles do not establish character offsets, line breaks, or logical reading
order. Computed properties are observed values, not original CSS declarations.

PNG-produced evidence has no text field. This converter does not infer fonts or
DOM semantics from pixels, match target text to current elements, import Figma,
or add text evidence to default MCP responses. A future adapter must preserve
source provenance and the distinction between explicit design values and
observations. The existing layout matcher continues to use geometry and paint.

The motivating real-review diagnostic replaced a flattened sans-serif shortcut
line with captured target inline typography: Pixelmatch differences fell from
3,773 to 59 across six states, while 34 behavior checks remained green. Exact
image equality still failed. This validates retaining those facts, not agent
speed or token savings.
