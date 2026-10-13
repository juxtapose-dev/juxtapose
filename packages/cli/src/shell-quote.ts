// Every hint that prints a command prints one an agent can paste. A snap
// name with a space (`jux diff 'a b' x`) printed bare made the suggested
// `jux snap <url> --as a b` a different command.

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Single-quote a value for a POSIX shell unless it is plainly safe. */
export function shellQuote(v: string): string {
  return SHELL_SAFE.test(v) ? v : `'${v.replaceAll("'", "'\\''")}'`;
}
