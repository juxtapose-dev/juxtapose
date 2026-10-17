# Consent Dismissal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in `dismissConsent` option (`--dismiss-consent`) that runs DuckDuckGo's autoconsent in the page to reject and close a cookie-consent popup before capture, flagging captures where it can't.

**Architecture:** `capture/consent.ts` injects autoconsent's Playwright bundle as a per-capture init script (the `freeze.ts` pattern) and talks to it over a `Runtime.addBinding` channel. The option layers like `network`. Results and baselines record what dismissal did, so a change in consent handling is reported as such.

**Tech Stack:** TypeScript, CDP (`Page.addScriptToEvaluateOnNewDocument`, `Runtime.addBinding`, `Runtime.bindingCalled`), `@duckduckgo/autoconsent` (MPL-2.0), vitest with real Chrome.

**Spec:** `docs/specs/2026-10-17-device-presets-and-consent-design.md` (section "Consent dismissal"). Device presets are a separate plan; if both land, Task 3 here shares the baseline record shape with device presets' Task 7.

## Global Constraints

- Off by default. With `dismissConsent` unset or false, no script, binding or CDP call is added and captures are byte-identical to today (fresh and daemon).
- Always reject (`optOut`), never accept.
- `@duckduckgo/autoconsent` pinned to an exact version (16.55.0 at time of writing, the latest on 2026-10-17); bumping it is a deliberate change, like the Chrome pin.
- Never throws on a popup it can't dismiss: the capture is taken and flagged `settle-timeout`-style, naming the consent platform.
- Runs before the full-page scroll-through (`scrollThrough` in `capture/settle.ts`).

## Review Focus

1. Page with no consent popup and `dismissConsent: true`: image hash identical to the same page without the option. Test in Task 2.
2. Popup autoconsent detects but cannot opt out of within the cap: capture taken, `snapshot.settle` flagged with the platform name. Test in Task 2.
3. Pooled page: a capture with dismissal then one without: the second gets no script and no binding traffic (consent cookies from the first are cleared by the existing per-capture origin reset). Test in Task 2.
4. `warmSwitch: true` with the setting changing between two stories: the second is navigated, not switched. Test in Task 2.
5. A page that navigates (redirect) after the script is injected: dismissal still runs in the final document or reports none found, never hangs past the cap. Test in Task 2.

---

### Task 1: Dependency and option plumbing

**Files:**

- Modify: `packages/core/package.json` (dependency `"@duckduckgo/autoconsent": "16.55.0"`), `pnpm-lock.yaml`
- Modify: `packages/core/src/types.ts` (`StoryParams.dismissConsent?: boolean`; `SettleLayer.dismissConsent?: boolean`)
- Modify: `packages/core/src/config/schema.ts` (`dismissConsent` in `captureOptions` so project, `stories` overrides, story params and variants accept it; runtime checks), `packages/core/schema.json`
- Modify: `packages/core/src/capture/layers.ts` (new `layerConsent`)
- Test: `packages/core/src/config/validate.test.ts`, `packages/core/src/capture/layers.test.ts`

**Interfaces:**

- Produces: `layerConsent(layers: CaptureLayers | undefined, params: StoryParams): boolean` — command > story/variant > `stories` override > project, default false.

- [ ] **Step 1: Write the failing tests:** `dismissConsent: 'yes'` rejected; `stories: { '*': { dismissConsent: true } }` accepted; `layerConsent({ project: { dismissConsent: true }, call: { dismissConsent: false } }, {})` is false; `layerConsent({ project: { dismissConsent: true } }, {})` is true; nothing set is false.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**; `pnpm add --filter @juxtapose/core @duckduckgo/autoconsent@16.55.0 --save-exact`.
- [ ] **Step 4: Run** tests and `pnpm build` (schema.json gains `dismissConsent`) — expect PASS.
- [ ] **Step 5: Commit** `feat(config): dismissConsent option`.

### Task 2: Run autoconsent during capture

**Files:**

- Create: `packages/core/src/capture/consent.ts`
- Modify: `packages/core/src/capture/capture.ts` (install next to `applyFreeze` ~:318 before `showStory`; refuse warm switch when it changed, like `freezeChanged` ~:248; await the outcome after the first idle wait and before `scrollThrough`; flag; record)
- Modify: `packages/core/src/types.ts` (`Snapshot.consent?: ConsentOutcome`, mirrored on `DiffResult`)
- Test: `packages/core/src/capture/consent-capture.test.ts` (new, real Chrome, local server)

**Interfaces:**

- Produces:
  - `type ConsentOutcome = { status: 'dismissed' | 'none' | 'failed'; cmp?: string; version: string }`
  - `applyConsent(page: Page, enabled: boolean): Promise<boolean>` — install or remove the bundle script and binding for the page's next document; returns whether it changed (for the warm-switch check).
  - `consentChanged(page: Page, enabled: boolean): boolean`
  - `awaitConsent(page: Page, capMs: number): Promise<ConsentOutcome>` — resolves on autoconsent's opt-out result, on "no CMP found", or `failed` at the cap.

Approach: read `dist/autoconsent.playwright.js` once via `createRequire(import.meta.url).resolve`; follow the package's `docs/api.md` message protocol (`init` → reply with config `{ enabled: true, autoAction: 'optOut', … }` and the bundled rules; collect `cmpDetected`/`optOutResult`/`autoconsentDone`/`autoconsentError`). Replies go back with `page.evaluate`. The binding name is jux-specific so a page can't spoof it from an unrelated global. A `failed` outcome sets the capture's `flagged` (as the still-frames cap does) with pending text `consent popup '<cmp>' not dismissed within <cap> ms`.

- [ ] **Step 1: Write the failing tests** (fixture HTML served locally that mimics a CMP autoconsent detects by DOM alone; pick one from autoconsent's rule list whose detection and opt-out are pure selectors, and note which in the test):
  - with `dismissConsent: true`: `snapshot.consent` is `{ status: 'dismissed', cmp: '<name>', version: '16.55.0' }` and the popup element is absent from `snapshot.structure`.
  - fixture whose reject button never closes the popup, with `settle: { timeout: 500 }`: `snapshot.consent.status === 'failed'` and `snapshot.settle.pending[0]` names the cmp.
  - plain page, with and without the option: equal image hashes; `consent.status === 'none'` with it, `consent` absent without it.
  - pooled page: dismissal capture then a capture without: the second's page receives no `Runtime.bindingCalled` events.
  - `warmSwitch: true`, two stories differing only in `dismissConsent`: the second navigates.
  - fixture that redirects once after load: outcome resolves (`dismissed` or `none`) within the cap.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/src/capture/consent-capture.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file and `pnpm vitest run packages/core/src/capture` — expect PASS.
- [ ] **Step 5: Commit** `feat(capture): opt-in consent dismissal with autoconsent`.

### Task 3: Record consent handling in baselines

**Files:**

- Modify: `packages/core/src/types.ts` (`ApprovalMeta.consent?: string`, `DiffResult.baselineConsent?: { from: string; to: string }`), `packages/core/src/capture/env.ts` (`consentChange`), `packages/core/src/run/run.ts` (~~:546), `packages/cli/src/commands/approve.ts` (~~:155), `packages/cli/src/commands/init.ts` (~~:267), `packages/cli/src/commands/run.ts` (~~:602)
- Test: `packages/core/src/capture/env.test.ts`, approve/run tests

**Interfaces:**

- Produces: `consentRecord(o: ConsentOutcome | undefined): string | undefined` → `` `${status}:${cmp ?? '-'}@${version}` `` or undefined when dismissal was off; `consentChange(entry: { consent?: string } | undefined, current: string | undefined): { from: string; to: string } | undefined` (absent reads as `'off'`).

- [ ] **Step 1: Write the failing tests:** approving a dismissal capture writes `consent: 'dismissed:<cmp>@16.55.0'`; a re-run with the option off and a hash mismatch reports `baselineConsent: { from: 'dismissed:<cmp>@16.55.0', to: 'off' }` and the CLI line ends ` (previous consent handling)`; entries without the key are unchanged in the manifest.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat: record consent handling in baselines`.

### Task 4: CLI, MCP, docs, changeset, verification

**Files:**

- Modify: `packages/cli/src/cli-args.ts`, `packages/cli/src/index.ts` (help for snap and run), `packages/cli/src/commands/snap.ts` (call layer `dismissConsent`, printed command), `packages/cli/src/commands/run.ts` (call layer), `packages/cli/src/commands/mcp.ts` (snap `dismissConsent`)
- Modify: `docs/configuration.md` (a "Cookie consent" section next to "Network requests": opt-in, rejects, what is recorded, the `network` block-rule alternative), `docs/cli.md`, `docs/mcp.md`, `THIRD_PARTY_NOTICES` or README credits (MPL-2.0 notice for autoconsent)
- Create: `.changeset/consent-dismissal.md` (minor: core, cli)
- Test: CLI and MCP tests

- [ ] **Step 1: Write the failing tests:** `jux snap <url> --dismiss-consent` sets the call layer; the printed re-run includes the flag; MCP `snap({ url, dismissConsent: true })` forwards it; help lists the flag.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** flags, MCP, docs, notice, changeset.
- [ ] **Step 4: Run** CLI tests — expect PASS.
- [ ] **Step 5:** `pnpm build && pnpm typecheck && pnpm lint && pnpm exec prettier --check .`; `jux browser stop; pnpm test`; `pnpm check:determinism` and `env -u CI pnpm check:determinism --daemon` — all pass.
- [ ] **Step 6:** Manual: `jux snap https://www.formhealth.co --full-page --dismiss-consent` has no Cookiebot dialog and prints the consent outcome; without the flag the dialog is there.
- [ ] **Step 7: Commit** `feat(cli): --dismiss-consent`; push the branch.
