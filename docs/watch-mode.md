# Watch mode

```bash
pnpm add -D @juxtapose/storybook   # then add it to .storybook/main.js addons
```

The addon uses Storybook's hot reload to recapture stories when you edit a
component. A burst of saves is combined into one capture.

Scope is every story sharing the component you edited. If a `storybook build`
exists, that widens to everything importing it, since the
dev server has no bundler graph of its own to consult. Set
`liveCapture: false` on stories you prefer to capture on demand, such as those
with slow play functions. They still capture on a normal run.

To run the whole suite on demand, use Storybook's **Run tests** button. The
addon registers as a test provider, so the visual suite runs alongside your
other tests. The test provider needs Storybook 8.5 or later and is checked
against 8.6 and 10.6.

Juxtapose waits for network requests, DOM changes, fonts, images and short
timers. Content scheduled beyond the settle window can still appear after a
capture. Use `waitForSelector` for a specific element, or a
[ready signal](configuration.md#ready-signal) when the page can report readiness.
