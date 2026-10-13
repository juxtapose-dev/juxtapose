// NODE_OPTIONS=--import <this file>: installs an in-thread resolve hook that
// throws when a command loads a browser driver or the Chrome launcher. A
// command that must not launch a browser (`jux diff`) cannot then do so
// silently. Not a monkey-patch: a module that is never loaded cannot spawn.
// The launcher (core's browser/launch.js) is the only module that spawns
// Chrome; `node:child_process` itself is not blocked because sharp and the git
// helpers load it legitimately. The check is on the RESOLVED url, since core
// imports the launcher by a relative specifier.
// registerHooks (not the deprecated, off-thread `register`) so it also fires
// for `import()` and `require`. Needs Node >= 22.15 (module.registerHooks).
import { registerHooks } from 'node:module';

const BLOCKED = [/^playwright(-core)?(\/|$)/, /\/browser\/launch\.js$/];

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    for (const candidate of [specifier, resolved.url ?? '']) {
      if (BLOCKED.some((re) => re.test(candidate))) {
        throw new Error(`no-browser probe: '${specifier}' was loaded`);
      }
    }
    return resolved;
  },
});
