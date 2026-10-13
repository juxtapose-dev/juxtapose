---
'@juxtapose/core': minor
'@juxtapose/cli': minor
---

Keep one browser warm between `jux snap`, `jux run` and `jux init` invocations (per user and rendering environment, idle exit after 10 minutes). It is off in CI, on Windows, with `--no-daemon`, and with `JUX_NO_DAEMON=1`. Captures are byte-identical warm and cold. `jux browser start|stop|status` manage it. The daemon's socket and state live in `JUX_STATE_DIR`, which defaults to the cache dir (`JUX_CACHE_DIR`) so existing setups do not move.
