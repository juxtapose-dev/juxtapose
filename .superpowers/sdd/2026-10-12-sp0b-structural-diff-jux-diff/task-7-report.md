# Task 7 report

## Corpus output (node scripts/structural-corpus.mjs)
```
ok   noop            identical          376 chars 
ok   color           style-only         547 chars 
ok   background      style-only         597 chars 
ok   padding         style-only        1211 chars 
ok   margin          style-only         740 chars 
ok   font-size       style-only         933 chars 
ok   font-weight     style-only         750 chars 
ok   line-height     style-only         939 chars 
ok   letter-spacing  style-only         751 chars 
ok   border-radius   style-only         866 chars 
ok   border-color    style-only         942 chars 
ok   box-shadow      style-only         594 chars 
ok   opacity         style-only         515 chars 
ok   text            text-only          729 chars 
ok   removed         element-removed    698 chars 
ok   inserted        element-added      826 chars 
ok   img-src         attr-only          511 chars 
ok   canvas          unknown            539 chars 
tier-0 JSON chars: min 376  median 740  max 1211  (budget 1500; ~303 tokens max)
ok   18 of 18 operators
```

## Green path (examples/storybook, run --all x3, all 15 pass, 2 skip, 0 structural)
```
15 pass (1.0s) enumerate 4ms | launch 64ms | baselines 1ms | capture 952ms
15 pass (0.9s) enumerate 5ms | launch 74ms | capture 938ms
15 pass (0.9s) enumerate 4ms | launch 64ms | capture 923ms
```
No diff phase appears. Not compared against 966f6e7 (brief allowed branch-only numbers).

## Notes
- Changeset also lists @juxtapose/storybook (packages/storybook changed vs origin/main).
- README: 'explained' is a top-level verdict field (the brief draft nested it under coverage); documented as its own row.
- --crops is a stub in this PR; README says so.
- Gate: build, typecheck, lint, format:check, test (353), check:determinism, check-snap, check-diff, corpus all green.
