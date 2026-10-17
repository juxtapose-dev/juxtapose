# Device presets and consent dismissal

Two additions to how jux sets up a page before capture:

1. **Device presets.** A named device (`mobile`, `tablet`, `desktop`,
   `iphone-15`, `pixel-8`, or one the project defines) sets the viewport
   _and_ emulates the device: mobile layout mode, touch, user agent and
   client hints. Usable anywhere a viewport can be set today.
2. **Consent dismissal.** Opt-in: run DuckDuckGo's `autoconsent` in the page
   so a cookie-consent popup is rejected and closed before capture.

## Why

`jux snap <url> --viewport 390x844` gives a narrow desktop window. Layout
driven by width media queries comes out right, but anything that detects a
phone does not: server-side user-agent sniffing, client hints,
`(hover: none)` / `(pointer: coarse)` styles, `'ontouchstart' in window`
checks. Jer wants a mobile capture to show "anything we can" of what that
phone would show, and wants devices named once and reused instead of
repeating sizes.

Cookie banners cover the first viewport of most public sites (on
formhealth.co, Cookiebot's dialog sits over the hero). Blocking the consent
platform with a `network` rule works but is per-site manual work.

## Principles (Jer's)

- **Render what is on the page by default.** Nothing is suppressed or
  altered unless explicitly asked for. Consent dismissal is off by default.
- **Never fan out by default.** A story is captured at one viewport/device
  unless the project or story explicitly declares more (variants).
- **Device scale factor stays 1.** Presets emulate the device's behaviour,
  not its pixel density; images stay 1 image px per CSS px.

## Goals

- `--device <name>` on `jux snap` (and the MCP `snap` tool's `device`
  field), and a `device` option wherever `viewport` is accepted today: story
  params (Storybook `parameters.juxtapose`, Ladle `meta.juxtapose`), URL
  entries' `params`, project config default, and variants.
- A built-in device list: about 15 current phones and tablets plus the
  aliases `mobile`, `tablet`, `desktop`.
- User-defined devices in `juxtapose.config.json` under `devices`, from
  scratch or extending a built-in.
- A mobile/tablet device emulates as much as Chrome allows: viewport,
  `mobile: true` metrics (so `<meta name="viewport">` applies), screen size
  and orientation, touch (`maxTouchPoints`, touch events), coarse
  pointer / no hover media features, user agent string, and UA client hints
  (`Sec-CH-UA-Mobile`, platform, model) via `userAgentMetadata`.
- `--dismiss-consent` (and a `dismissConsent: true` option, layered like
  `network`) runs autoconsent's opt-out before capture.

## Non-goals

- Pixel density above 1 (Jer's call: 1x is fine).
- Real Safari/WebKit rendering. An `iphone-*` preset is Chrome emulating
  the iPhone's viewport, UA and touch; WebKit-specific rendering, the system
  font, notch/safe-area insets and browser toolbars are out of reach. Docs
  say so plainly.
- Storybook addon work: no device frame/bezel around the preview, no syncing
  the Storybook viewport toolbar to jux devices. Considered and dropped
  (Storybook's built-in viewport list already covers sizes; a frame is not
  novel or useful enough).
- Running every story at every device, or any default fan-out.
- Consent dismissal on by default, or accepting (rather than rejecting)
  consent.

## Anti-goals (would be a failure even if it works)

- **Changing any existing capture.** With no `device` and no
  `dismissConsent`, captures must stay byte-identical to today, fresh launch
  and daemon (`pnpm check:determinism`, both modes). Today's emulation
  becomes, in effect, the implicit default device, unchanged.
- **Silent changes.** A device or consent setting that changes pixels must
  be visible in results, never look like an ordinary regression.
- **Leaking emulation between captures.** Pooled and warm pages are reused;
  one story's device must never carry into the next capture.

## Device presets

### Shape

A device descriptor (built-in or user-defined):

| field               | meaning                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `width`, `height`   | CSS px viewport, portrait as listed                                     |
| `mobile`            | Chrome mobile emulation (`Emulation.setDeviceMetricsOverride` `mobile`) |
| `touch`             | touch emulation on/off (`maxTouchPoints` 5 when on)                     |
| `userAgent`         | UA string; omitted means Chrome's own                                   |
| `userAgentMetadata` | client hints for `Emulation.setUserAgentOverride`                       |
| `extends`           | user-defined only: built-in or earlier user device to start from        |

No `deviceScaleFactor` field: always 1. Orientation is portrait for
mobile/tablet; landscape is a user-defined device with width and height
swapped (my call: no separate orientation option in v1).

### Built-in list

TS constant (`packages/core/src/browser/devices.ts`), following the repo's
pattern for built-in data (`FONT_FAMILIES`, `browser/pins.ts`); no JSON
module loading in core today. About 15 entries: recent iPhones (standard
and Pro Max), a small and a large Android phone (Pixel, Galaxy), iPad, iPad
Pro, an Android tablet, plus `desktop` (1280x800 today's default
emulation, no UA override). Aliases: `mobile` → a current iPhone, `tablet` →
an iPad, `desktop` → as above. Exact device set, sizes and UA strings are
the builder's to choose from current device specs (Playwright's
Apache-2.0 descriptor list is an acceptable source with attribution).
Android UA strings must name the pinned Chrome major (`browser/pins.ts`),
so they stay true when the pin moves.

Keys are lowercase kebab-case (`iphone-15-pro-max`).

### User-defined devices

```json
{
  "devices": {
    "kiosk": { "width": 1080, "height": 1920 },
    "iphone-15-landscape": { "extends": "iphone-15", "width": 852, "height": 393 },
    "mobile": { "extends": "pixel-8" }
  }
}
```

- A user device may `extends` a built-in or another user device; fields
  override field by field. Cycles and unknown names are config errors with
  the chain in the message.
- A user device whose name equals a built-in replaces it for this project
  (that is how a team repoints `mobile`). My call: allowed, reported by
  `jux config --explain`.
- Validation lives in the config schema and the runtime check
  (`projectChecked`), so `schema.json` gains `devices`.

### Where `device` is accepted, and precedence

`device` is accepted in exactly the places `viewport` is today: the snap
flag / MCP snap, project config default (`device` next to `viewport`),
story params, URL entry `params`, and variants. Like `viewport`, not in
`stories` overrides (my call: keep the two parallel; adding both to
`stories` overrides later is one change).

Precedence follows the existing viewport layering (default → project →
story params → live params → variant). Within the merged result:

- A layer's `device` sets size and all emulation.
- A `viewport` at the same or a higher layer overrides only the size; the
  device's emulation stays. (`device: "pixel-8", viewport: 412x600` is a
  short Pixel.)
- A `device` at a higher layer replaces a lower layer's `viewport` too.

`jux config --explain` shows the resolved device and where it came from,
as it does for viewport (`explain.ts`).

Variants are the way to capture more than one device:
`variants: { mobile: { device: "mobile" } }`. Nothing fans out otherwise.

`jux snap` today ignores the project `viewport` and `variants`
(`capture/snap.ts`); that stays: snap uses its flags only (my call:
unchanged scope).

### Applying emulation

- Per capture, alongside `ensureViewport` (`capture.ts`): metrics override
  with `mobile`, screen size and orientation; `Emulation.setTouchEmulationEnabled`;
  `Emulation.setEmitTouchEventsForMouse` (so clicks in play functions still
  work as taps); `Emulation.setUserAgentOverride` with `userAgentMetadata`.
- The `ensureViewport` memo (`pageViewport`, keyed on `WxH`) and the early
  return in `CdpPage.setViewportSize` must key on the whole emulation, so a
  same-size device change re-applies, and a capture with no device resets a
  page a previous capture emulated.
- The user agent must apply to the navigation request itself (server-side
  sniffing), so it is set before `showStory`.
- **A device that only arrives in live params** (Storybook params read after
  render, when discovery did not carry them): mobile mode, the meta viewport
  and the navigation UA cannot be applied after the fact, so a live device
  that differs from the one applied before navigation triggers one
  recapture with it applied, the way a live renderer change does today
  (`rendererRecaptured` in `capture.ts`). Never a half-emulated capture.
- **Pages with no `<meta name="viewport">`**: under mobile emulation Chrome
  lays them out ~980px wide and zooms out to fit, as a phone does. Captures
  show what the phone shows. Viewport captures already clip by
  `visualViewport.scale`; full-page captures must match, scaling the
  document clip so the image is the device's width. (Follows "render what is
  on the page".)
- **Hover/pointer conflict:** `browser/flags.ts` pins
  `primaryHoverType`/`primaryPointerType` to mouse via `--blink-settings`
  for determinism. Touch devices need `(hover: none)` and
  `(pointer: coarse)`. The builder must verify what touch emulation does to
  those media features under the pinned settings and find a per-page way to
  get coarse/no-hover for touch devices without changing launch flags
  (launch flags are shared by every page and are part of the daemon key).
  If no per-page mechanism exists, stop and report back before changing
  flags.
- Per-page emulation is not part of the daemon key and does not need to be;
  fresh and daemon pages must apply it identically.

### Recording and reporting

- Snapshots and results record the resolved device name and an emulation
  fingerprint (mobile, touch, UA hash) next to `viewport`.
- The baseline entry records the same fingerprint, so a story whose device
  changed since approval is reported as "approved with a different device
  emulation" (like the encoder change in `capture/env.ts` /
  `capture/encoder.ts`), not as a plain regression. A same-device run stays
  on the hash fast path.
- Baselines without the field are treated as the implicit default device.

## Consent dismissal

### Behaviour

- Off by default. On with `--dismiss-consent` (snap and run), MCP snap
  `dismissConsent: true`, or a `dismissConsent: true` option layered like
  `network`: project, `stories` overrides, story params, variants, command
  (command wins).
- When on, autoconsent's opt-out runs during page load: it detects the
  consent platform, chooses reject/necessary-only, and the popup closes.
  The capture then proceeds through the normal settle, so whatever the
  page does after dismissal is waited on.
- No popup found: nothing happens; the capture is identical to one without
  the option.
- Popup found but not dismissed within a bound (the settle timeout): the
  capture is still taken and flagged, the way settle timeouts are, naming
  the consent platform.
- Results record whether dismissal ran and what it found (platform name, or
  none), so a reviewer can tell why a banner is absent.
- The baseline entry records the same (dismissal on/off, autoconsent
  version, platform found). Turning dismissal on or off, a different
  platform found, or an autoconsent bump since approval is reported as
  "approved with different consent handling", built like the encoder note
  (`encoderChange` in `capture/env.ts`): the story still fails on a hash
  mismatch, and the reason is stated. Can share the record with the device
  emulation fingerprint.
- Runs before the full-page scroll-through, so a dismissed banner never
  covers the first viewport.

### Mechanics

- Dependency: `@duckduckgo/autoconsent` (MPL-2.0; compatible with jux's
  MIT as an unmodified dependency), pinned to an exact version. Its rules
  change frequently and the pin keeps a run reproducible; bumping it is a
  deliberate change like the Chrome pin.
- Inject `dist/autoconsent.playwright.js` with
  `Page.addScriptToEvaluateOnNewDocument` (as `freeze.ts` does: per-capture
  replace, memoized by source), and add a `Runtime.addBinding` channel for
  its messages (`Runtime.enable` is already on; `page.on` can subscribe to
  `Runtime.bindingCalled`). No binding mechanism exists yet; this adds the
  first.
- A change in the consent setting between captures must block warm
  switching, as `freezeChanged` does today.
- The `network` block-rule approach stays documented as the manual
  alternative for platforms autoconsent does not know.

## Surfaces to update

- CLI: `--device`, `--dismiss-consent` (help text in `index.ts`; `--viewport`
  is missing from `jux snap --help` today and should be added at the same
  time).
- MCP `snap` tool: `device`, `dismissConsent`.
- Config schema + `schema.json` + runtime checks: `devices`, `device`,
  `dismissConsent`.
- Docs: `docs/configuration.md` (devices, per-story option table, network
  section cross-link), `docs/cli.md`, `docs/mcp.md`. Variants have no
  user-facing section yet; a short one with a device example belongs here.
- Changeset (minor) for core and cli.

## Verification

- Determinism: `pnpm check:determinism` fresh and `--daemon` unchanged with
  no device/consent set.
- Real-browser tests (like `capture/full-page-capture.test.ts`) for: UA
  reaching the server on navigation; `navigator.userAgent`,
  `navigator.maxTouchPoints`, `matchMedia('(pointer: coarse)')` and client
  hints inside the page for a mobile device; emulation reset when the next
  capture on the same page has no device; consent dismissal against a local
  page using a CMP autoconsent recognizes (fixture), and the no-popup case
  unchanged.
- Manual: `jux snap https://www.formhealth.co --device mobile --full-page
--dismiss-consent` shows the mobile layout without the Cookiebot dialog.

## Left to the builder

- Exact built-in device list, sizes and UA strings.
- How the emulation fingerprint is computed and stored.
- Internal module layout beyond `browser/devices.ts`.
- autoconsent configuration details (which of its rule sets to load,
  logging off), within the behaviour above.

## Calls Claude made (for Jer to check)

- `device` accepted in the same places as `viewport`, not in `stories`
  overrides.
- User devices may replace built-in names (how `mobile` gets repointed).
- `viewport` next to `device` overrides size only.
- Landscape is a user-defined device, no orientation option in v1.
- `jux snap` keeps ignoring project `viewport`/`variants`.
- Consent dismissal rejects (never accepts), and its setting layers like
  `network`, including `stories` overrides.
- Baselines record consent handling as well as device emulation; a change
  in either is reported as such, not as a plain regression.
- A device first seen in live params causes one recapture, not a warning.
- Non-responsive pages are captured as the phone shows them (zoomed out to
  the device width), in both viewport and full-page captures.
