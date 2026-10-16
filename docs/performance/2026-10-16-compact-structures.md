# Readable compact baseline structures

New approvals store image hashes, approval metadata, a relative structure filename
and a file checksum in `juxtapose.manifest.json`. The manifest carries a generated
`$comment`; `juxtapose.structures/README.md` supplies shared instructions. Neither
is included in image or structure hashes. Both paths belong in Git.

Structure files use `juxtapose.structure/compact-v1`, one element per line. A
`segment` stores the exact suffix after its retained parent's path plus `>`.
It can include skipped ancestors. Roots, pseudo-element paths and anything not
representable by that rule keep a full `path`. Parent indexes remain explicit.
Expansion restores `juxtapose.structure/v1` for the existing diff engine.

Existing inline structures are still read. `jux doctor --fix` migrates inline and
matching legacy sidecars without capture, approval, or changes to image hashes,
structure hashes, approval identity or timestamps. New approvals write the new
format. Older clients still read image hashes but cannot read new structure files.

A file checksum binds the manifest to the exact structure bytes, including
external-resource evidence excluded from the semantic structure hash. Missing,
corrupt, mismatched or unsafe paths return no structure; they never affect the
image verdict. Writes replace files atomically, but a group of separate files is
not a filesystem transaction. If interrupted before manifest commit, a previous
reference can temporarily have unavailable evidence; rerun the approval or
restore both files from Git. Unreferenced files are ignored rather than deleted.

## Real-corpus measurements

Same retained Spectrum/Chakra captures as the #255 approval benchmark. No browser
or new captures involved. Decimal bytes, including the generated directory README.

| Corpus   | Stories | Elements | Previous manifest | New manifest | Structure directory |  New total | Reduction |
| -------- | ------: | -------: | ----------------: | -----------: | ------------------: | ---------: | --------: |
| Chakra   |   1,227 |   39,176 |        18,227,369 |      616,935 |          11,468,385 | 12,085,320 |     33.7% |
| Spectrum |   1,086 |    4,342 |         1,957,575 |      534,928 |           1,375,206 |  1,910,134 |      2.4% |

Every structure was deep-compared after direct compaction/expansion and again
through the store's checksum-verified reader. All elements, metadata, full paths,
external evidence and structure hashes matched. This includes omitted ancestors
and multiple roots. No gzip, field removal, style dictionary or abbreviated keys.

Approval wall time in one fresh-project replay was 1.34 seconds for Chakra and
1.04 seconds for Spectrum. The previous batched inline medians were 0.844 and
0.647 seconds: separate files add I/O, while remaining far below the original
108-second and 8.59-second approval medians. These are approval-only measurements,
not end-to-end capture timings or repeated measurements of the new format.

Reproduce after building:

```sh
node scripts/audit-compact-structures.mjs RUN_DIRECTORY
```

The script retains a temporary project for inspecting actual manifests and Git
diffs. It reports its location, sizes, counts and approval duration. Small
structures can gain little or grow due to per-file references and checksums;
this format is primarily useful for large structures and localized review.
