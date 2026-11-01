# Documentation

## User guides

These describe supported commands and workflows. Use the documentation for your
installed package version when behavior differs from the current repository.

- [CLI commands](cli.md) and [configuration](configuration.md)
- [Agent workflow](agents.md) and [local MCP setup](mcp.md)
- [Browser setup](browser.md), [CI](ci.md) and [watch mode](watch-mode.md)
- [Hosted uploads](hosted-uploads.md), [managed CI](managed-ci.md) and
  [GitHub PR review](github-pr-review.md)
- [Package roles](packages.md)

## Contributor references

Start with [contributing](../CONTRIBUTING.md) and
[architecture](../ARCHITECTURE.md). The implementation references below describe
current contracts and link to source and checks:

- [Structure capture and diff evidence](specs/2026-10-12-sp0-structural-diff-agent-surface-design.md)
- [Browser driver boundaries](specs/2026-10-13-cdp-driver-warm-browser-design.md)
- [Variant identity and resolution](specs/2026-10-13-variants-design.md)
- [Renderer recovery](specs/2026-10-15-renderer-reuse-retry-design.md)
- [Device emulation and consent](specs/2026-10-17-device-presets-and-consent-design.md)

For measurements, use [field-test reproduction](field-tests.md) and
[controlled profiling](profiling.md). Historical contributor notes cover
[approval batching](performance/2026-10-16-approval-batching.md) and
[compact structure storage](performance/2026-10-16-compact-structures.md).
Their reported results apply to the stated workload and method, not every release
or project. New performance claims require reviewed evidence and limitations.

See the [documentation review policy](../CONTRIBUTING.md#documentation-review)
before publishing contributor material.
