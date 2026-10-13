// Kept apart from browser.ts so `jux --help` can show it without loading core.
export const BROWSER_HELP = `browser
  jux browser install            download the pinned chrome-headless-shell once (~100 MB); no-op if present
                                 (first run: npx -p @juxtapose/cli jux browser install)
    --force                      reinstall even if a usable browser exists
    --chrome <path>              use this binary instead (or set JUX_CHROME=<path>); nothing is downloaded
  jux browser path               print the browser path jux will use
  jux browser status             which browser jux will use, where it came from, and whether the
                                 warm browser is running (pid, started, idle timeout, socket)
  jux browser start|stop         keep one browser warm between runs (on by default; JUX_NO_DAEMON=1,
                                 --no-daemon on snap/run/init, or any CI variable turns it off).
                                 start reports the running one; stop does nothing if none is running.
                                 It exits after JUX_BROWSER_IDLE_MINUTES (default 10) idle; its socket
                                 lives in JUX_STATE_DIR (default: the cache dir, JUX_CACHE_DIR)
  --json                         one JSON object: {path, source, version, pinned} (+ installed for install; status adds daemon; start and stop report started/stopped and daemon)
  exit 0 ok · 2 usage · 3 failure (no browser, download failed)
`;
