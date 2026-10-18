# Device Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `device` and `orientation` options (and `--device`/`--orientation` on `jux snap`) that set the viewport and emulate a phone, tablet or desktop: mobile metrics, touch, user agent and client hints, at device scale factor 1.

**Architecture:** A device registry (built-ins in `browser/devices.ts` plus project `devices`) resolves a name to a descriptor. A pure resolver turns merged story params (`device`, `orientation`, `viewport`) into a final viewport plus an optional emulation. `CdpPage` applies emulation per page via CDP, memoized like color scheme, before navigation. Snapshots and baselines record an emulation fingerprint so a device change is reported as such.

**Tech Stack:** TypeScript, Chrome DevTools Protocol (`Emulation.*`), TypeBox config schema, vitest with real Chrome (`chromeForTests`).

**Spec:** `docs/specs/2026-10-17-device-presets-and-consent-design.md` (sections "Device presets" and "Orientation"; consent dismissal is a separate plan).

## Global Constraints

- Device scale factor is always 1. No `deviceScaleFactor` field on devices.
- With no `device` and no `orientation` anywhere, every capture is byte-identical to today, fresh launch and daemon. Today's metrics override (`mobile: false`, `screenOrientation: { angle: 0, type: 'landscapePrimary' }`) stays exactly as is in that case, even for tall viewports.
- No changes to Chrome launch flags (`browser/flags.ts`) or the daemon key. Verified 2026-10-17 on Chrome 151: per-page `Emulation.setTouchEmulationEnabled` overrides the pinned `--blink-settings` hover/pointer types (`(pointer: coarse)`, `(hover: none)`, `maxTouchPoints` 5, `ontouchstart` all true), and `setUserAgentOverride({ userAgent: '' })` restores the default UA.
- Device keys are lowercase kebab-case. Aliases: `mobile` → `iphone-15`, `tablet` → `ipad`, `desktop` → 1280x800 landscape, no UA override, `mobile: false`, `touch: false`.
- Android UA strings name the pinned Chrome major from `browser/pins.ts`, computed, not hard-coded.
- Default orientation is the listed shape: taller than wide is portrait, otherwise landscape. Rotating to landscape on a mobile/tablet device reports `landscapePrimary` angle 90; desktop landscape reports angle 0.
- `device` is accepted where `viewport` is (snap flag, MCP snap, project default, story params, URL entry `params`, variants), not in `stories` overrides.
- `jux snap` keeps ignoring project `viewport`/`variants`; it does read project `devices`.
- Comments explain why, with measurements (repo CLAUDE.md).

## Review Focus

1. Unknown device name (typo in `--device` or story params): fail that capture/config with a message naming the closest known keys, never fall back silently. Test in Task 2.
2. A story's own `viewport` under a variant's `device`: the variant's device decides the size; a story `viewport` must not shrink the mobile variant. Test in Task 3.
3. A pooled page captures a device story, then a plain story: the plain capture is byte-identical to one on a fresh page (UA, touch and metrics reset). Test in Task 5.
4. `warmSwitch: true` and a story whose device differs from the page's current one: the UA must reach the navigation request, so warm switching is refused for that capture. Test in Task 5.
5. `orientation` with no `device`: swaps the effective viewport and reports the matching `screen.orientation`; a no-op orientation (`landscape` on 1280x800) still produces an emulation record, not today's default path. Test in Task 2.

---

### Task 1: Device registry

**Files:**

- Create: `packages/core/src/browser/devices.ts`
- Test: `packages/core/src/browser/devices.test.ts`
- Modify: `packages/core/src/browser/types.ts` (export the types), `packages/core/src/browser/index.ts` (re-export)

**Interfaces:**

- Produces:
  - `type Orientation = 'portrait' | 'landscape'`
  - `interface UserAgentMetadata` (the CDP `Emulation.UserAgentMetadata` shape: `platform`, `platformVersion`, `architecture`, `model`, `mobile`, optional `brands`)
  - `interface DeviceDescriptor { width: number; height: number; mobile: boolean; touch: boolean; userAgent?: string; userAgentMetadata?: UserAgentMetadata }`
  - `interface DeviceEmulation { mobile: boolean; touch: boolean; orientation: Orientation; angle: 0 | 90; userAgent?: string; userAgentMetadata?: UserAgentMetadata }` — in `browser/types.ts`, because the browser layer imports nothing else from core (lint-enforced) and Task 4 needs it there.
  - `interface UserDeviceSpec extends Partial<DeviceDescriptor> { extends?: string }`
  - `const BUILTIN_DEVICES: Readonly<Record<string, DeviceDescriptor>>` (includes the three aliases as entries)
  - `type DeviceRegistry = ReadonlyMap<string, DeviceDescriptor>`
  - `function resolveDevices(user?: Record<string, UserDeviceSpec>): DeviceRegistry`, throwing `Error` with the chain for cycles and unknown `extends`, and for a user device that ends up without width/height.
  - `function defaultOrientation(d: { width: number; height: number }): Orientation`

- [ ] **Step 1: Write the failing tests**

```ts
it('has the aliases', () => {
  const r = resolveDevices();
  expect(r.get('mobile')).toEqual(r.get('iphone-15'));
  expect(r.get('tablet')).toEqual(r.get('ipad'));
  expect(r.get('desktop')).toEqual({
    width: 1280,
    height: 800,
    mobile: false,
    touch: false,
  });
});
it('names the pinned Chrome major in Android UAs', () => {
  expect(resolveDevices().get('pixel-8')!.userAgent).toContain(
    `Chrome/${CHROME_PIN_MAJOR}.0.0.0`,
  );
});
it('lets a user device extend and replace built-ins', () => {
  const r = resolveDevices({
    mobile: { extends: 'pixel-8' },
    kiosk: { width: 1080, height: 1920 },
  });
  expect(r.get('mobile')).toEqual(r.get('pixel-8'));
  expect(r.get('kiosk')).toMatchObject({
    width: 1080,
    height: 1920,
    mobile: false,
    touch: false,
  });
});
it('rejects cycles and unknown parents with the chain', () => {
  expect(() => resolveDevices({ a: { extends: 'b' }, b: { extends: 'a' } })).toThrow(
    'a -> b -> a',
  );
  expect(() => resolveDevices({ a: { extends: 'nope' } })).toThrow("'nope'");
});
it('keys are kebab-case and every built-in is listed in its default orientation', () => {
  for (const [k, d] of Object.entries(BUILTIN_DEVICES)) {
    expect(k).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(defaultOrientation(d)).toBe(d.mobile ? 'portrait' : 'landscape');
  }
});
```

(`CHROME_PIN_MAJOR` is derived in the test from `browser/pins.ts` the same way `devices.ts` derives it.)

- [ ] **Step 2: Run** `pnpm vitest run packages/core/src/browser/devices.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement `devices.ts`.** About 15 built-ins: `iphone-se`, `iphone-15`, `iphone-15-pro-max`, `iphone-16`, `iphone-16-pro-max`, `pixel-7`, `pixel-8`, `pixel-8-pro`, `galaxy-s24`, `galaxy-a55`, `ipad`, `ipad-mini`, `ipad-pro-13`, `galaxy-tab-s9`, plus aliases. Sizes and UA strings from current device specs (Playwright's Apache-2.0 descriptor list is an acceptable source; add an attribution comment). iOS UAs are Safari strings; Android UAs are Chrome Mobile with the pinned major. Unknown user fields default to `mobile: false, touch: false`. Comment why DPR is absent (spec: 1x).
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** `feat(core): built-in device registry`.

### Task 2: Resolve device, orientation and viewport

**Files:**

- Create: `packages/core/src/capture/device.ts`
- Test: `packages/core/src/capture/device.test.ts`
- Modify: `packages/core/src/types.ts` (`StoryParams`: `device?: string; orientation?: Orientation`)

**Interfaces:**

- Consumes: Task 1 types.
- Produces:
  - `interface ResolvedDevice { viewport: Viewport; emulation?: DeviceEmulation; device?: string; fingerprint?: string }` — `emulation`/`fingerprint` are undefined exactly when neither `device` nor `orientation` is set.
  - `function resolveDevice(params: Pick<StoryParams, 'device' | 'orientation' | 'viewport'>, registry: DeviceRegistry, fallback: Viewport, defaultDevice?: string): ResolvedDevice` — throws `UnknownDeviceError` (exported, `name = 'UnknownDeviceError'`) with up to 3 closest keys.
  - `function emulationFingerprint(device: string | undefined, e: DeviceEmulation): string` — `` `${device ?? 'custom'}|${orientation}|m${0|1}t${0|1}|ua:${sha256(ua + JSON(meta)).slice(0, 8) or 'none'}` ``.

Rules (from the spec): size comes from `viewport` if set, else the device (rotated per `orientation`), else `fallback`. `orientation` without `viewport` rotates the device or fallback size; with an explicit `viewport` the reported orientation follows its aspect. Angle 90 only for a landscape mobile/tablet device. `params.device` wins over `defaultDevice` (project default).

- [ ] **Step 1: Write the failing tests**

```ts
const r = resolveDevices();
it('no device, no orientation is today', () => {
  expect(resolveDevice({}, r, { width: 1280, height: 800 })).toEqual({
    viewport: { width: 1280, height: 800 },
  });
  expect(
    resolveDevice({ viewport: { width: 375, height: 812 } }, r, D).emulation,
  ).toBeUndefined();
});
it('mobile is portrait iphone-15', () => {
  const x = resolveDevice({ device: 'mobile' }, r, D);
  expect(x.viewport).toEqual({ width: 393, height: 852 });
  expect(x.emulation).toMatchObject({
    mobile: true,
    touch: true,
    orientation: 'portrait',
    angle: 0,
  });
});
it('landscape rotates a phone to angle 90, desktop to angle 0', () => {
  expect(
    resolveDevice({ device: 'mobile', orientation: 'landscape' }, r, D),
  ).toMatchObject({
    viewport: { width: 852, height: 393 },
    emulation: { orientation: 'landscape', angle: 90 },
  });
  expect(
    resolveDevice({ device: 'desktop', orientation: 'portrait' }, r, D),
  ).toMatchObject({
    viewport: { width: 800, height: 1280 },
    emulation: { orientation: 'portrait', angle: 0 },
  });
});
it('explicit viewport keeps device emulation; orientation follows its aspect', () => {
  expect(
    resolveDevice({ device: 'pixel-8', viewport: { width: 412, height: 600 } }, r, D),
  ).toMatchObject({
    viewport: { width: 412, height: 600 },
    emulation: { mobile: true, orientation: 'portrait' },
  });
});
it('orientation alone rotates the fallback and records emulation', () => {
  const x = resolveDevice({ orientation: 'portrait' }, r, { width: 1280, height: 800 });
  expect(x.viewport).toEqual({ width: 800, height: 1280 });
  expect(x.emulation).toMatchObject({
    mobile: false,
    touch: false,
    orientation: 'portrait',
  });
  expect(
    resolveDevice({ orientation: 'landscape' }, r, { width: 1280, height: 800 })
      .fingerprint,
  ).toBeDefined();
});
it('unknown device names the closest keys', () => {
  expect(() => resolveDevice({ device: 'iphone15' }, r, D)).toThrow(
    /unknown device 'iphone15'.*iphone-15/,
  );
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/core/src/capture/device.test.ts` — expect FAIL.
- [ ] **Step 3: Implement `device.ts`** (closest keys by edit distance with a small Levenshtein here; core cannot import `packages/cli/src/suggest.ts`).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(core): resolve device, orientation and viewport`.

### Task 3: Config schema, layering and explain

**Files:**

- Modify: `packages/core/src/config/schema.ts` (`storyOnlyOptions` ~:506 gains `device`, `orientation`; project config ~:895 gains `devices`, `device`, `orientation`; `projectChecked` ~:715 and `VariantRuntimeSchema` ~:589 check them), `packages/core/schema.json` (regenerated by `pnpm build`)
- Modify: `packages/core/src/capture/variants.ts` (variant merge ~:124 and `mergeLiveParams` ~:293)
- Modify: `packages/core/src/config/explain.ts` (~:268, show resolved device and its layer)
- Test: `packages/core/src/config/validate.test.ts`, `packages/core/src/capture/variants.test.ts`, explain tests

**Interfaces:**

- Produces: `function layerDevice(under: StoryParams, over: Partial<StoryParams>): StoryParams` in `variants.ts` — a layer that sets `device` and not `viewport` drops `under.viewport`; otherwise a plain assign. Used at both merge sites. `RunConfig`/`ProjectConfig` types gain `devices?: Record<string, UserDeviceSpec>; device?: string; orientation?: Orientation`.

- [ ] **Step 1: Write the failing tests**
  - validate: `devices: { kiosk: { width: 1080, height: 1920 } }` passes; `devices: { a: { widht: 1 } }` fails naming `widht`; `orientation: 'sideways'` fails; `stories: { x: { device: 'mobile' } }` fails as an unknown option (same message style as `dely`).
  - variants: story params `{ viewport: { width: 800, height: 600 } }` with variant `mobile: { device: 'mobile' }` → variant params have `device: 'mobile'` and no `viewport`; variant `{ device: 'mobile', viewport: { width: 400, height: 700 } }` keeps both; live params `{ viewport: … }` under a variant `{ device: 'mobile' }` → no viewport.
  - explain: `jux config --explain` for a story under variant `mobile: { device: 'mobile' }` prints `device mobile (iphone-15, 393x852 portrait) variant mobile`.
- [ ] **Step 2: Run** the three test files — expect FAIL.
- [ ] **Step 3: Implement** schema entries (descriptions say DPR is always 1 and name the aliases), `layerDevice`, explain line.
- [ ] **Step 4: Run** tests, then `pnpm build` and confirm `git diff packages/core/schema.json` shows `devices`, `device`, `orientation`.
- [ ] **Step 5: Commit** `feat(config): device, orientation and devices options`.

### Task 4: Apply emulation in the browser driver

**Files:**

- Modify: `packages/core/src/browser/page.ts` (`metricsOverride` ~:270, `Page` interface ~:77, `CdpPage.setViewportSize` ~:705, new method)
- Test: `packages/core/src/browser/page.test.ts`

**Interfaces:**

- Consumes: `DeviceEmulation` (Task 1, `browser/types.ts`).
- Produces: `Page.setEmulation?(viewport: Viewport, emulation: DeviceEmulation | undefined): Promise<void>` on the interface; `CdpPage` implements it by sending, in order: `setDeviceMetricsOverride` (`metricsOverride(viewport, emulation)`), `setTouchEmulationEnabled` (`maxTouchPoints: 5` when touch), `setEmitTouchEventsForMouse` (`configuration: 'mobile'` when touch), `setUserAgentOverride` (`userAgent: ''` to reset). Undefined emulation after a device sends the resets; undefined emulation on a page that never had one sends only today's metrics call. `setViewportSize` keeps the page's current emulation in its metrics call.

- [ ] **Step 1: Write the failing test** (real Chrome, `describe.skipIf(!chrome)`): on a `data:` page after `setEmulation({393,852}, pixel8Emulation)` and a navigation, `matchMedia('(pointer: coarse)')`, `matchMedia('(hover: none)')` true, `navigator.maxTouchPoints === 5`, `navigator.userAgentData.mobile === true`, `screen.orientation.type === 'portrait-primary'`; after `setEmulation({393,852}, undefined)` and a navigation: `(pointer: fine)` true, `maxTouchPoints === 0`, UA equals `Browser.getVersion().userAgent`, `screen.orientation.type === 'landscape-primary'`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/src/browser/page.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Comment the 2026-10-17 measurement that touch emulation overrides the pinned blink hover/pointer settings.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(browser): per-page device emulation`.

### Task 5: Capture wiring, reset, warm switch, live params, record

**Files:**

- Modify: `packages/core/src/capture/capture.ts` (`CaptureDeps` ~:45, `effectiveViewport` ~:190, `ensureViewport` ~:733, warm-switch decision ~:240-250, live block ~:385-447, snapshot ~:620-650)
- Modify: `packages/core/src/run/run.ts` (`poolSettings` ~:475 passes `devices`, `defaultDevice`, `defaultOrientation`), `packages/core/src/capture/snap.ts` (accept `devices`), `packages/core/src/types.ts` (`Snapshot.emulation?: string; Snapshot.device?: string`, mirrored on `DiffResult` ~:437 and set in `run.ts` ~:532)
- Test: `packages/core/src/capture/device-capture.test.ts` (new, modeled on `full-page-capture.test.ts`)

**Interfaces:**

- Consumes: `resolveDevice` (Task 2), `layerDevice` (Task 3), `Page.setEmulation` (Task 4).
- Produces: `CaptureDeps.devices?: DeviceRegistry` (default `resolveDevices()`), `CaptureDeps.defaultDevice?: string`, `CaptureDeps.defaultOrientation?: Orientation`; `Snapshot.emulation` = the fingerprint, `Snapshot.device` = the resolved name; both absent on the default path.

Behaviour: resolve before navigation; `ensureViewport` becomes `ensureEmulation(page, resolved)` memoized on `` `${w}x${h}|${fingerprint ?? 'default'}` `` (falls back to `setViewportSize` when the page has no `setEmulation`, throwing if an emulation is required). A capture whose fingerprint differs from the page's current one is not warm-switched (the UA must apply to the navigation). If live params change the resolved fingerprint, recapture once with `warmSwitch: false` and the existing `rendererRecaptured` guard (spec: never half-emulated).

- [ ] **Step 1: Write the failing tests** (local HTTP server that records each request's `user-agent` and `sec-ch-ua-mobile`, pages that print `navigator.maxTouchPoints`):
  - `device: 'pixel-8'` capture: server saw a UA containing `Pixel 8` and `sec-ch-ua-mobile: ?1` on the navigation; `snapshot.device === 'pixel-8'`; `snapshot.emulation` matches `/^pixel-8\|portrait\|m1t1\|ua:/`.
  - same page, next capture with no device: its image hash equals a capture of the same URL on a fresh page; server saw the default UA; `snapshot.emulation` undefined.
  - `warmSwitch: true` deps, a platform with `switchStory` and two stories with different devices: the second is navigated, not switched (the server saw a second navigation with the new UA).
  - a fake platform whose `readLiveParams` returns `{ device: 'mobile' }` for a story with no static device: the result's `snapshot.device === 'mobile'` and the server saw exactly one desktop-UA and one mobile-UA navigation.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/src/capture/device-capture.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the wiring above.
- [ ] **Step 4: Run** the new test file and `pnpm vitest run packages/core/src/capture` — expect PASS.
- [ ] **Step 5: Commit** `feat(capture): device emulation per capture`.

### Task 6: Non-responsive pages under mobile emulation

**Files:**

- Modify: `packages/core/src/browser/page.ts` (`fullPageSize` ~:720, `screenshot` clip ~:738), `packages/core/src/capture/capture.ts` (structure capture call ~:573), `packages/core/src/capture/structure.ts` (accept a scale)
- Test: extend `packages/core/src/capture/device-capture.test.ts`

**Interfaces:**

- Produces: `CdpPage.fullPageSize()` returns the image size at the page's zoom when emulation is mobile and `visualViewport.scale !== 1`; `screenshot({ fullPage })` uses that scale in its clip; `captureStructure(page, viewport, mask, timings, scale = 1)` multiplies rects by `scale`.

- [ ] **Step 1: Write the failing test:** a page with no `<meta name="viewport">` and a 980px-wide body, `device: 'iphone-15'`, `fullPage: true`: image width is 393 (±1); an element at CSS `left: 490px` has a structure rect x within 2px of `490 * 393 / 980`. The same page with a meta viewport stays at scale 1.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(capture): capture non-responsive pages as the phone shows them`.

### Task 7: Baselines record emulation; report a device change

**Files:**

- Modify: `packages/core/src/types.ts` (`ApprovalMeta.emulation?: string` ~~:606; `DiffResult.baselineEmulation?: { from: string; to: string }`), `packages/core/src/capture/env.ts` (new `emulationChange`), `packages/core/src/run/run.ts` (~~:546 next to `encoderChange`; clear it where `baselineEncoder` is cleared ~~:644), `packages/cli/src/commands/approve.ts` (~~:155), `packages/cli/src/commands/init.ts` (~~:267), `packages/cli/src/commands/run.ts` (~~:602 output)
- Test: `packages/core/src/capture/env.test.ts`, run/approve tests

**Interfaces:**

- Produces: `emulationChange(entry: { emulation?: string } | undefined, current: string | undefined): { from: string; to: string } | undefined` — absent on either side reads as `'default'`; undefined when equal or when `entry` is undefined.

- [ ] **Step 1: Write the failing tests:** `emulationChange({}, undefined)` undefined; `emulationChange({}, 'mobile|portrait|m1t1|ua:ab')` → `{ from: 'default', to: 'mobile|…' }`; a failing `DiffResult` for a story approved without emulation and captured with `device: 'mobile'` carries `baselineEmulation` and the CLI line ends with ` (previous device emulation)`; `jux approve` writes `emulation` into the manifest entry and a passing re-run has no `baselineEmulation`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** Approval passes the per-result `emulation` into `ApprovalMeta`; omit the key when undefined so existing manifests stay byte-identical.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat: record device emulation in baselines`.

### Task 8: CLI, MCP, docs, changeset

**Files:**

- Modify: `packages/cli/src/cli-args.ts` (~:70, :110), `packages/cli/src/index.ts` (snap help ~:192: add `--viewport WxH`, `--device <name>`, `--orientation portrait|landscape`), `packages/cli/src/commands/snap.ts` (flags → `params.device` / `params.orientation`; load project `devices`; `printedCommand` ~:332), `packages/cli/src/commands/mcp.ts` (snap schema ~:197 gains `device`, `orientation`; forward ~:1047-1096)
- Modify: `docs/configuration.md` (a "Devices" section: built-in table, aliases, user devices, orientation, precedence, the Chrome-not-Safari limits; the per-story option table ~~:296; a short "Variants" section with a device example), `docs/cli.md` (~~:308), `docs/mcp.md`
- Create: `.changeset/device-presets.md` (minor: core, cli)
- Test: `packages/cli/src/commands/snap*.test.ts`, `packages/cli/src/printed-commands.test.ts`, MCP tests

- [ ] **Step 1: Write the failing tests:** `jux snap <url> --device mobile --orientation landscape` passes `{ device: 'mobile', orientation: 'landscape' }` as params; `--device iphone15` exits non-zero with `did you mean iphone-15`; `--orientation sideways` is rejected; the printed re-run command includes both flags; MCP `snap({ url, device: 'pixel-8' })` forwards the device; `jux snap --help` lists `--viewport`, `--device`, `--orientation`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** flags, MCP, docs, changeset.
- [ ] **Step 4: Run** the CLI tests — expect PASS.
- [ ] **Step 5: Commit** `feat(cli): --device and --orientation`.

### Task 9: Whole-branch verification

- [ ] **Step 1:** `pnpm build && pnpm typecheck && pnpm lint && pnpm exec prettier --check .` — all exit 0.
- [ ] **Step 2:** `jux browser stop; pnpm test` — all pass (a running warm browser fails two `browser.test.ts` cases; stop it first).
- [ ] **Step 3:** `pnpm check:determinism` and `env -u CI pnpm check:determinism --daemon` — both pass unchanged (the default path must be byte-identical).
- [ ] **Step 4:** Manual, with the built CLI: `jux snap https://www.formhealth.co --device mobile --full-page` shows the mobile layout at 393px wide; `--device mobile --orientation landscape` is 852px wide; `--device desktop` matches a plain `jux snap` of the same URL at 1280x800 except for the recorded emulation.
- [ ] **Step 5:** Commit any fixes; push the branch.
