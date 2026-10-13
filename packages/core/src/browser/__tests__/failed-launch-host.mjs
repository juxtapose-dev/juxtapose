// Child process for the async-spawn-failure test. Launches argv[2] through the
// BUILT launchChrome with nothing else holding the event loop open, which is
// exactly a `jux snap --chrome <non-executable>` run: if the failure path only
// waits on unref'd timers the loop drains, the promise never settles, and the
// process exits 0 silently with its profile left behind.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { launchChrome } = await import(path.join(here, '../../../dist/browser/launch.js'));
try {
  await launchChrome({ executablePath: process.argv[2] });
  console.log('LAUNCHED');
} catch (e) {
  console.log(`REJECTED ${e.message}`);
  process.exitCode = 1;
}
