// Which flags and how many positionals each command takes. `parseArgs` runs
// with strict: false so one table-free parse serves every command; this is
// where an argument a command does not take is rejected instead of ignored.

const SETTLE = [
  'settle-timeout',
  'settle-ready',
  'no-settle-ready',
  'settle-ignore',
  'settle-require',
  'network-external',
] as const;
const CONTEXT = ['project', 'build-dir', 'origin', 'platform', 'concurrency'] as const;

interface Spec {
  flags: readonly string[];
  /** Positionals accepted; Infinity for a list. */
  max: number;
}

export const SPECS: Record<string, Spec> = {
  init: { flags: ['json', ...CONTEXT, 'chrome', 'no-daemon'], max: 0 },
  run: {
    flags: [
      'json',
      ...CONTEXT,
      'since',
      'all',
      'comment',
      'html',
      'story',
      'chrome',
      'no-daemon',
      ...SETTLE,
    ],
    max: 0,
  },
  approve: { flags: ['json', ...CONTEXT, 'all', 'story', 'run'], max: 0 },
  check: { flags: ['json', ...CONTEXT, 'run'], max: 0 },
  handoff: { flags: ['json', ...CONTEXT, 'run'], max: 1 },
  snap: {
    flags: [
      'json',
      'project',
      'as',
      'as-prefix',
      'viewport',
      'wait-for',
      'delay',
      'mask',
      'chrome',
      'no-daemon',
      ...SETTLE,
    ],
    max: Infinity,
  },
  diff: { flags: ['json', 'project', 'prefix', 'runs', 'crops'], max: 2 },
  mcp: { flags: ['project', 'concurrency', 'chrome', 'no-daemon'], max: 0 },
};

/** Flags whose value is a string, so a bare `--story` is an error. */
const TAKES_VALUE = new Set([
  ...CONTEXT,
  'since',
  'story',
  'chrome',
  'run',
  'as',
  'as-prefix',
  'viewport',
  'wait-for',
  'delay',
  'mask',
  'settle-timeout',
  'settle-ignore',
  'settle-require',
  'network-external',
]);

/** The one-line usage error for this command's arguments, or undefined if fine. */
export function checkArgs(
  command: string,
  values: Record<string, unknown>,
  positionals: string[],
): string | undefined {
  const spec = SPECS[command];
  if (!spec) return undefined;
  const hint = `Try \`jux ${command} --help\`.`;
  for (const key of Object.keys(values)) {
    // parseArgs fills declared booleans with false; only passed flags count.
    if (key === 'help' || values[key] === false) continue;
    const flag = key.length === 1 ? `-${key}` : `--${key}`;
    if (!spec.flags.includes(key))
      return `jux ${command}: unknown option ${flag}. ${hint}`;
    if (
      TAKES_VALUE.has(key) &&
      (values[key] === true || (Array.isArray(values[key]) && values[key].includes(true)))
    )
      return `jux ${command}: ${flag} needs a value. ${hint}`;
  }
  if (positionals.length > spec.max) {
    const extra = positionals[spec.max]!;
    const did =
      command === 'run' || command === 'approve' ? ` Did you mean --story ${extra}?` : '';
    return `jux ${command}: unexpected argument '${extra}'.${did} ${hint}`;
  }
  return undefined;
}
