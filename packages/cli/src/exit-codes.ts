// Exit codes for the agent-loop commands (`snap`, `diff`). The older commands
// keep their 0/1/2 until the hardening PR migrates them; new code uses these
// names, never bare numbers, so the meaning is greppable.
export const EXIT = {
  /** Clean, or identical. */
  clean: 0,
  /** Changes found, or something needs review. */
  review: 1,
  /** Usage error: bad or missing argument. */
  usage: 2,
  /** Tool or environment failure: browser, filesystem, unreadable input. */
  failure: 3,
} as const;
