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

PNG-produced evidence has no text field. The converter preserves captured DOM
text and typography; it does not infer those values from pixels or establish
matches between target text and current elements. It does not import Figma or
add text evidence to default MCP responses. The layout matcher uses geometry
and paint, with explicit provenance for each observation.
