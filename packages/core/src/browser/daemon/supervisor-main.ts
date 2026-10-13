// packages/core/src/browser/daemon/supervisor-main.ts
//
// Entry for the detached daemon: `node supervisor-main.js '<json>'`, json =
// { executablePath, args, stateDir, key, idleMinutes }. The launcher (Task 13)
// detaches stdio; this process lives until it is idle, SIGTERM/SIGINT (`jux
// browser stop`), or the browser dies, and on each of those closes Chrome,
// removes the profile, clears the state and unlinks the socket.
//
// Losing the start race to another daemon (Ruling 21) exits 0: the client
// that spawned us connects to the winner.
//
// The spawning client hands us its launch lock (handOffLock). We remove it
// once we are listening with our state written, or once start failed, so
// clients that arrive while Chrome is still starting wait for us instead of
// spawning another supervisor. If we crash, our dead pid makes it stale.

import { startSupervisor, SupervisorLostRace } from './supervisor.js';
import { daemonPaths, releaseLockHeldBy } from './state.js';
import { isRecord, isStringArray } from '../guards.js';

interface MainArgs {
  executablePath: string;
  args: string[];
  stateDir: string;
  key: string;
  idleMinutes: number;
}

function parseArgs(raw: string | undefined): MainArgs {
  const bad = () => new Error(`jux: supervisor-main: bad arguments ${raw ?? '(none)'}`);
  const a: unknown = JSON.parse(raw ?? '');
  // `null` or an array used to fail on a property read with a TypeError.
  if (!isRecord(a)) throw bad();
  const { executablePath, args, stateDir, key, idleMinutes } = a;
  if (
    typeof executablePath !== 'string' ||
    !isStringArray(args) ||
    typeof stateDir !== 'string' ||
    typeof key !== 'string' ||
    typeof idleMinutes !== 'number' ||
    !(idleMinutes > 0)
  )
    throw bad();
  return { executablePath, args, stateDir, key, idleMinutes };
}

let paths: ReturnType<typeof daemonPaths> | null = null;
try {
  const args = parseArgs(process.argv[2]);
  paths = daemonPaths(args.stateDir, args.key);
  const sup = await startSupervisor({
    executablePath: args.executablePath,
    args: args.args,
    paths,
    key: args.key,
    idleMinutes: args.idleMinutes,
    onExit: () => process.exit(0),
  });
  await releaseLockHeldBy(paths, process.pid);
  for (const sig of ['SIGTERM', 'SIGINT'] as const)
    process.on(sig, () => void sup.stop());
} catch (e) {
  if (paths) await releaseLockHeldBy(paths, process.pid).catch(() => {});
  if (e instanceof SupervisorLostRace) process.exit(0);
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
