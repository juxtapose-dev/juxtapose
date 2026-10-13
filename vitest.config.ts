import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    reporters: ['dot'],
    // A test that reaches acquireBrowser must not leave a detached warm-browser
    // daemon idling for 10 minutes after the suite (Task 13). Daemon tests
    // pass their own env or drive the client directly.
    env: { JUX_NO_DAEMON: '1' },
  },
});
