---
'@juxtapose/storybook': minor
---

Add a pixel loupe to the compare panel

The existing modes answer "did something move". None of them answer "is this one
pixel or two", which is the question that blocks a review: a 1px border shift
and an antialiasing change look identical at 1:1 and the diff overlay marks
both.

Hovering the comparison now magnifies the pixels under the cursor at 4x, with
smoothing off so a magnified pixel reads as a pixel. Toggle it with the Loupe
button or `z`. It works in every mode, and in side-by-side each pane magnifies
its own image.
