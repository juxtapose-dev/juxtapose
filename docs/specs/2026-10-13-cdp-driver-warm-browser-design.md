# Browser driver and warm-browser boundaries

Contributor reference for the implemented browser layer. User setup and supported
options are in [browser](../browser.md). This is not a migration plan or a promise
of parity with every browser, operating system or capture environment.

## Browser ownership

The [browser module](../../packages/core/src/browser/) owns Chrome acquisition,
launch, CDP transport, contexts, pages and daemon connections. It has no adapter
knowledge. Adapters use the shared platform interface; they must not bypass this
layer to introduce a second browser configuration.

The pinned Chrome build and download verification are defined in
[pins.ts](../../packages/core/src/browser/pins.ts). A browser upgrade is a capture
compatibility change, not just a dependency refresh. Launch flags, page setup,
font defaults, media emulation and screenshot preparation can all change pixels.
Review their tests and real captures before modifying them.

## Transport and lifecycle

The driver implements the supported page/context subset over CDP. It must preserve
request ownership and bounded failure behavior: a closed browser rejects pending
work, timeouts cannot leave callers waiting indefinitely, and shutdown cleans up
owned processes and temporary profiles. Unsupported behavior must fail explicitly
rather than silently emulate a different result.

A warm daemon can reuse a browser process across invocations, while each invocation
owns its contexts. Its environment identity and liveness checks prevent a client
from silently connecting to a browser with incompatible flags or build settings.
Fresh-process and daemon paths require independent byte-stability checks.

Browser lifetime, renderer reuse and warm story switching are different controls.
Keeping Chrome alive does not prove that reusing a renderer or switching an
already-loaded story preserves cold-load pixels. See the
[renderer recovery reference](2026-10-15-renderer-reuse-retry-design.md).

## Page initialization

Viewport/device metrics, color scheme, fonts and animation policy must be applied
in the required order before capture. A setting applied only after the screenshot
cannot describe the resulting image. Reused pages need explicit resets so a
previous story's device, scheme or other state cannot leak into the next capture.

Mask selectors and wait selectors use the driver's supported CSS semantics.
Do not claim compatibility with selector syntaxes from another automation library
without an implemented translation and validation.

## Verification

The tests beside the driver exercise transport errors, resource ownership and
configuration. Real example captures and both determinism modes in
[contributing](../../CONTRIBUTING.md) guard the pixel boundary. Unit tests alone
cannot establish rendering parity or a whole-run speedup. Use the reproducible
[profiling guide](../profiling.md) when measuring a proposed optimization.
