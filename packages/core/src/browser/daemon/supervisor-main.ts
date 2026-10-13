// packages/core/src/browser/daemon/supervisor-main.ts
//
// Entry for the detached daemon: `node supervisor-main.js '<json>'`, json =
// { executablePath, args, cacheDir, key, idleMinutes }. The launcher (Task 13)
// detaches stdio; this process lives until it is idle, SIGTERM/SIGINT (`jux
// browser stop`), or the browser dies, and on each of those closes Chrome,
// removes the profile, clears the state and unlinks the socket.
//
// Losing the start race to another daemon (Ruling 21) exits 0: the client
// that spawned us connects to the winner.

import { startSupervisor, SupervisorLostRace } from './supervisor.js';
import { daemonPaths } from './state.js';

interface MainArgs {
  executablePath: string;
  args: string[];
  cacheDir: string;
  key: string;
  idleMinutes: number;
}

function parseArgs(raw: string | undefined): MainArgs {
  const a = JSON.parse(raw ?? '') as Partial<MainArgs>;
  if (
    typeof a.executablePath !== 'string' ||
    !Array.isArray(a.args) ||
    !a.args.every((x) => typeof x === 'string') ||
    typeof a.cacheDir !== 'string' ||
    typeof a.key !== 'string' ||
    typeof a.idleMinutes !== 'number' ||
    !(a.idleMinutes > 0)
  )
    throw new Error(`jux: supervisor-main: bad arguments ${raw ?? '(none)'}`);
  return a as MainArgs;
}

try {
  const args = parseArgs(process.argv[2]);
  const sup = await startSupervisor({
    executablePath: args.executablePath,
    args: args.args,
    paths: daemonPaths(args.cacheDir, args.key),
    key: args.key,
    idleMinutes: args.idleMinutes,
    onExit: () => process.exit(0),
  });
  for (const sig of ['SIGTERM', 'SIGINT'] as const)
    process.on(sig, () => void sup.stop());
} catch (e) {
  if (e instanceof SupervisorLostRace) process.exit(0);
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
