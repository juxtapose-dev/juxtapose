# Watch mode

```bash
pnpm add -D @juxtapose/storybook   # then add it to .storybook/main.js addons
```

With the addon installed, editing a component recaptures it while you work, so
the diff is ready before you go looking for it. Storybook's own hot
reload is the trigger — there is no file watcher to configure — and juxtapose
coalesces a burst of saves into one capture.

Scope is every story sharing the component you edited. If a `storybook build`
exists, that widens to everything importing it, since the
dev server has no bundler graph of its own to consult. Set
`liveCapture: false` on a story whose play function or delay makes constant
recapture cost more than it returns; it still captures on a normal run.

To run the whole suite on demand, use Storybook's **Run tests** button. The
addon registers as a test provider, so the visual suite runs alongside your
other tests. The test provider needs Storybook 8.5 or later and is checked
against 8.6 and 10.6.

juxtapose waits on things it can observe —
network requests, DOM changes, fonts, images. Content that appears on a bare
timer is invisible to that, so a story built on `setTimeout` can race the
capture. `waitForSelector` is the fix.
