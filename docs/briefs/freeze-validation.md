# Clock, random and animated-image freezing

Candidate validation on 2026-10-15, rebased onto CLI/core 0.20.0.

## Defaults and compatibility

Animated images freeze on their first frame by default. This extends the existing
CSS/Web Animations freeze to GIF, animated WebP and APNG. `freeze.images: false`
opts out for the project; `animations: 'play'` does not change this browser-wide
setting. Browser start/status use the same image policy and daemon key as captures.

Clock and random freezing are opt-in. The timer-driven clock supports common
Date-based debounce code and synchronous Date polling, but it does not control
asynchronous callback ordering. Seeding random sources repeats values across
page loads and can change application initialization. These are useful fixture
controls, not proof that arbitrary applications become deterministic.

## Fast feedback checks

- 206 focused config, layering, override, flag and installation tests passed.
- Final real-Chrome freeze/daemon fixture plus installation tests: 36 passed.
  Covers first-frame GIF/WebP/APNG in img/picture/CSS, canvas drawImage,
  unfrozen control, Date/Intl, debounce, synchronous clock waits, seeded random
  sources, UUID shape, timer delay coercion and browser start/status/stop.
- Examples Storybook: 18 stories, 3 fresh runs, all exact hashes stable.
- Examples Storybook: fresh reference plus 3 daemon runs, all exact hashes stable.
- Examples Ladle: 16 captured, no errors; new baselines, not approval comparisons.
- Build, typecheck, changed-file formatting and tracked-source lint passed.
  Existing untracked `.scratch` experiments contain two lint errors and were
  excluded from the lint check; their contents were preserved.

## Chakra and Primer sample

The same locally built workbenches were used for both policies, with three
fresh-browser runs per policy, concurrency 3, no approved baselines, and exact
hashes compared across runs. Twenty evenly sampled stories per workbench include
the known Chakra re-render and Primer countdown cases. The full selections and
hashes are in [freeze-validation.json](freeze-validation.json).

| Suite  | Captures | Varying stories, native | Varying stories, all frozen | Errors |
| ------ | -------: | ----------------------: | --------------------------: | -----: |
| Chakra |      120 |                  3 / 20 |                      1 / 20 |      0 |
| Primer |      120 |                  1 / 20 |                      0 / 20 |      0 |

Chakra's re-render and line-chart reference-point stories stabilized. Its avatar
story varied under both policies; settle diagnostics recorded pending external
Dropbox images. Native had one image timeout and frozen had two, so this sample
cannot attribute that variation to clock or random handling.

Primer's countdown stabilized. Its countdown and sortable-groups table each kept
an active timer and hit the settle cap on all three runs under both policies.
No new timer-timeout story appeared.

This is a targeted compatibility sample, not a full-suite pass or performance
benchmark. The field comparison preceded the final timer-coercion correction;
the final Chrome fixture verifies that correction, including one-time `valueOf`,
BigInt rejection and infinite-delay handling. Raw local field reports are under
`/tmp/jux-freeze-field-2OTQWQ`; the compact committed evidence is sufficient to
identify selections and observed hash variation.

To repeat: use the same builds, configure each `freeze` object from the JSON,
pass each selected ID with `jux run --story <id> --json --no-daemon`, and collect
three runs using separate temporary `JUX_STATE_DIR` directories. Keep one capture
run active at a time. Do not substitute live hosted workbenches when measuring
this change.
