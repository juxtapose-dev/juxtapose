# Browser

jux drives a pinned `chrome-headless-shell` 151.0.7922.34 from Chrome for
Testing — the same build Playwright 1.62 ships, so baselines captured with
earlier jux versions still match.

```bash
npx -p @juxtapose/cli jux browser install   # once, ~100 MB
```

It lands in `~/Library/Caches/jux` (macOS), `~/.cache/jux` (Linux) or
`%LOCALAPPDATA%\jux` (Windows); `JUX_CACHE_DIR` overrides. If Playwright's
cache already holds the same build, jux uses it and downloads nothing.
`JUX_CHROME=<path>` or `--chrome <path>` uses your own Chromium instead; the
version is recorded in each run's `env`, so a mismatch is reported rather
than silently red. Behind a proxy, set `HTTPS_PROXY` as usual — the installer
re-runs itself with Node's `--use-env-proxy`. Linux needs Chromium's shared
libraries — on Ubuntu 24.04: `sudo apt-get install libasound2t64
libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64
libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0
libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3
libxkbcommon0 libxrandr2`. linux-arm64 has no published build of this
version; use `JUX_CHROME`.

`jux browser status` shows which browser jux would use, where it came from and
whether the warm browser is running; `jux browser path` prints only the path.

## Warm browser

Outside CI, the first `jux snap`, `jux run` or `jux init` starts one background
`chrome-headless-shell` and later invocations reuse it, so each one skips the
browser launch. It exits by itself after 10 minutes with no client
(`JUX_BROWSER_IDLE_MINUTES` changes that). Every capture gets its own browser
context, so pages share no cookies or storage, and the pixels are
byte-identical to a fresh launch. If the warm browser cannot be reached, jux
launches a private one as before.

It is one browser per user and environment: the binary, its version and the
variables that affect rendering (`TZ`, `LANG`, `LC_ALL`, `FONTCONFIG_FILE`,
and similar) select it, so a run with a different `TZ` gets its own.

It is off in CI (`CI`, `GITHUB_ACTIONS`, `JENKINS_URL` and the other common CI
variables), on Windows, with `--no-daemon` on `snap`, `run` and `init`, and with
`JUX_NO_DAEMON=1`.

```bash
jux browser start    # start it now, or report the one already running
jux browser status   # pid, start time and idle timeout, or "not running"
jux browser stop     # stop every warm browser in the state dir
```

A new jux build, a Chrome update or other flags select a new warm browser, and
the previous one runs until it goes idle. `status` lists it too, and `stop`
stops it along with the current one. `stop` signals a process only after it
confirms the process is a jux warm browser; a process it cannot confirm, or
one still running 2 s after the signal, is named and `stop` exits 3.

`status --json` and `start --json` report a `daemon` object (`running`,
`enabled`, `pid`, `key`, `socket`, `startedAt`, `idleMinutes`; the last five
are `null` when it is not running). `status --json` also has `ok` and a
`daemons` array of every live warm browser, each with `current: true` for the
one this jux would use. `stop --json` reports `ok`, `stopped` and the
`stoppedPids`; on a failure it adds `error` and `notStopped`.

Its socket, state file and lock live in `<state dir>/browser/`. The state dir
is the cache dir above unless `JUX_STATE_DIR` is set, so you can move one
without the other. A long cache path can push the socket past the OS limit;
set `JUX_STATE_DIR` to a shorter one.

Security: the socket is mode 0600 in a per-user directory that jux creates
and re-checks before every connection (it must be yours and not writable by
others), and jux refuses any other socket. Only processes running as your
user can use the warm browser; it is not exposed on a network port.

Mask and `--wait-for` selectors are CSS. jux rejects Playwright-only forms
(`text=`, `>>`, `:has-text()`) with an error rather than silently matching
nothing.
