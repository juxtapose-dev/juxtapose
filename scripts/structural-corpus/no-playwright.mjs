// NODE_OPTIONS=--import <this file>: installs an in-thread resolve hook, so
// any `import`/`import()`/`require` of the playwright package throws. A
// command that must not touch the browser driver cannot then do so silently.
// registerHooks (not the deprecated, off-thread `register`) so it also fires
// for the ESM `import('playwright')` core uses.
// Needs Node >= 22.15 (module.registerHooks).
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^playwright(-core)?(\/|$)/.test(specifier)) {
      throw new Error(`no-playwright probe: '${specifier}' was loaded`);
    }
    return nextResolve(specifier, context);
  },
});
