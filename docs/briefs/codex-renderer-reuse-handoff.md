# Handoff: renderer reuse with a fresh-renderer retry (for Codex)

Date: 2026-10-15. Repo: /Users/jer/Code/juxtapose (GitHub juxtapose-dev/juxtapose). Branch: `perf/warm-cache-pulse`, draft PR #231 (commits 1b20b34 pulse, 42e9fa3 tests). Work in a worktree/clone of that branch; never push to main, never force-push shared branches.

## Goal
Make reusing a page's renderer between captures (`freshRenderer: false`, ~2x faster) safe enough to become the default, by (1) running reuse captures with no pulse, (2) retrying any story that mismatches its baseline on a FRESH renderer, (3) recording that the retry resolved it and telling users how to pin that story.

## Decisions already made by Jer (Oct 15)
- Retry mismatches on a fresh renderer (authoritative; baselines are fresh captures). Keep the cache pulse only as an optional per-story tier.
- Per-story setting with values reuse / pulse / fresh, plus a config pattern list. Report ends with: N stories passed only after a fresh retry, the list, and the exact setting to add. **Names of keys and report wording are Jer's copy: use clearly temporary names and flag them; do not finalize.**
- Cap history retries (~10% of stories); above it report failures as usual.
- `jux approve` must always capture on a fresh renderer.
- Reuse becomes the default only AFTER verification below passes. Until then keep it opt-in.
- Verification is by hash equality against a fresh-renderer run, not by eye.

## Evidence (real Chrome 156 headless shell, one run at a time, concurrency 3)
- Pulse = `Network.setCacheDisabled` true then false right before navigation (capture.ts, "Same renderer reused" block). Evicts Blink's in-memory resource cache; HTTP cache kept (server served 254 KB vs 4.57 MB cold; disk-cache responses 8 vs 1).
- Hashes vs a fresh run, outside fresh-vs-fresh noise: Spectrum 1,086 stories: no pulse 24, pulse 2 (`card--slotted-heading`, `textfield--default`). Chakra 1,227: no pulse 32, pulse 5 (4 already flaky; 1 new `components-listbox--horizontal`). Primer 1,102: 1 either way (`count-down-timer`, clock).
- Median story ms: Spectrum fresh 321 / pulse 190 / no pulse 141. Chakra 469 / 276 / 220. Primer 288 / 232 / 195.
- Not fixed by anything tried: flags, HTTP-cache prewarm, deferring images, blanking. Separate unresolved effect: canvas text at fractional size taints later text layout in the same renderer (#153 font half).
- Data: /Users/jer/.claude/jobs/6ff71ac8/tmp/pulse-{chakra,primer,spectrum}/ (fresh*.json, reuse-pulse.json, reuse-nopulse.json), cacheflush/ (experiments), astra/ (Astra reports), bug-ledger.md.
- Existing code: recheck flow in packages/core/src/run/run.ts (~L116-310), run/confirm.ts (approve's confirming capture), result types in packages/core/src/types.ts (`unstable`, `unrechecked`), config schema config/schema.ts (`recheck`, `freshRenderer`), capture hop in capture/capture.ts.

## Stages (execute one at a time; stop and report at each)
1. Design note (docs, 1 page): where the retry hooks into run.ts, new result field(s), config shape, report text (temporary wording), approve behavior, interaction with `recheck` modes and the cap. Get Jer's OK on names.
2. Implement: reuse capture -> on fail, fresh-renderer retry -> pass with `historyResolved`-style field if it matches the baseline; cap; approve always fresh; per-story/pattern setting; report/PR-comment/handoff/MCP surfaces that print statuses. Tests: unit (fake page) for each branch; at least one real-Chrome pair test (card--default after badge--default style) guarded like fresh-renderer-capture.test.ts.
3. Verify (needs real Chrome; Codex's sandbox cannot run it, ask Jer to run or approve an unsandboxed run): Spectrum, Chakra, Primer with reuse default vs fresh: final pass/fail identical, retry count ~2%, run time ~ -35 to -40%. Then `pnpm check:determinism` and `env -u CI pnpm check:determinism --daemon`.
4. Flip the default only if stage 3 is clean; changeset; ask for review before merge.

## Rules
- No `pnpm install` (it has wiped node_modules). Copy node_modules and git-ignored packages/*/dist with `cp -ac` from /Users/jer/Code/juxtapose/.claude/worktrees/netrules (or warm-pulse).
- Temp `JUX_STATE_DIR` for every jux/vitest run (a live daemon exists). Vitest: `--poolOptions.forks.maxForks=2 --poolOptions.forks.minForks=1`. One jux run at a time, concurrency <= 3. Machine is shared and often heavily loaded; timings are noisy.
- Docs follow Google developer style. No bare git stash, no `git add -A`, no reset --hard. Never touch ~/Library/Caches. `examples/` never gets committed baselines. Never deploy prod.
- Commit trailers: Co-Authored-By for the model + Claude-Session if one exists.
- Hash is byte-exact; any nondeterminism is a failed build. Read CLAUDE.md first.
