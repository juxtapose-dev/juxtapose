// Kept apart from browser.ts so `jux --help` can show it without loading core.
export const BROWSER_HELP = `browser
  jux browser install            download the pinned chrome-headless-shell once (~100 MB); no-op if present
                                 (first run: npx -p @juxtapose/cli jux browser install)
    --force                      reinstall even if a usable browser exists
    --chrome <path>              use this binary instead (or set JUX_CHROME=<path>); nothing is downloaded
  jux browser path               print the browser path jux will use
  jux browser status             which browser jux will use, and where it came from
  --json                         one JSON object: {path, source, version, pinned} (+ installed for install)
  exit 0 ok · 2 usage · 3 failure (no browser, download failed)
`;
