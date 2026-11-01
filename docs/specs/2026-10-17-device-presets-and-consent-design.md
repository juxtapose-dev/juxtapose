# Device emulation boundaries

Contributor reference for implemented device presets.
See [configuration](../configuration.md), [CLI](../cli.md) and [MCP](../mcp.md)
for supported inputs. The registry and checks live in
[devices.ts](../../packages/core/src/browser/devices.ts) and its adjacent tests.

## Emulation boundary

A device preset combines viewport, mobile layout mode, touch/pointer behavior,
user agent and client-hint settings. A narrow viewport alone is a desktop-sized
layout change, not complete mobile emulation. Device scale factor remains one:
presets emulate supported behavior, not native hardware pixel density.

An iPhone-named preset still runs Chrome, not Safari/WebKit. It cannot establish
native-device rendering, operating-system fonts, browser chrome or hardware
behavior. Reports and documentation must preserve that distinction.

Built-in and project device definitions resolve through the registry. Overrides,
extension chains and viewport/device precedence require explicit validation;
invalid names and incompatible settings must not silently select a fallback.
Presets do not create a capture matrix by default. Additional captures require
explicit variants or other supported selection.

Apply and reset device state for every capture. Warm pages must not retain the
previous story's user agent, touch, media or viewport state. A device setting
that changes capture identity must remain observable in the report/environment.

## Verification

Changes require registry/schema tests, pooled-page reset checks and actual device
captures. Default-policy changes require fresh and daemon determinism checks.
Keep hardware/browser limitations in the public docs; a successful fixture does
not establish native-device or universal site compatibility.
