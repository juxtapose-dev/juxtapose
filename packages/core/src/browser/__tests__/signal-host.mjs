// Child process for the real-signal tests. Launches the fake Chrome through
// the BUILT launchChrome and reports "READY <chromePid> <profile>" on stdout.
// argv[2] === "host-handler": the host owns a SIGTERM handler and must run it
// exactly once; it prints "HOST" and exits 0 itself.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { launchChrome } = await import(path.join(here, '../../../dist/browser/launch.js'));
if (process.argv[2] === 'host-handler') {
  process.on('SIGTERM', () => {
    console.log('HOST');
    process.exit(0);
  });
}
const b = await launchChrome({ executablePath: path.join(here, 'fake-chrome.mjs') });
console.log(`READY ${b.pid} ${b.userDataDir}`);
setInterval(() => {}, 1 << 30);
